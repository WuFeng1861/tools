"use strict";

const dgram = require("node:dgram");
const dns = require("node:dns").promises;
const https = require("node:https");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");

// Separate provider identities prevent several aliases from manufacturing a majority.
const SOURCES = [
  { id: "aliyun", name: "阿里云", host: "ntp.aliyun.com", provider: "alibaba", region: "中国", kind: "ntp" },
  { id: "aliyun1", name: "阿里云备用", host: "ntp1.aliyun.com", provider: "alibaba", region: "中国", kind: "ntp" },
  { id: "cloudflare", name: "Cloudflare", host: "time.cloudflare.com", provider: "cloudflare", region: "全球", kind: "ntp" },
  { id: "windows", name: "Microsoft", host: "time.windows.com", provider: "microsoft", region: "全球", kind: "ntp" },
  { id: "apple", name: "Apple", host: "time.apple.com", provider: "apple", region: "全球", kind: "ntp" },
  { id: "pool", name: "NTP Pool", host: "pool.ntp.org", provider: "pool", region: "全球", kind: "ntp" },
  { id: "https-aliyun", name: "阿里云网页", host: "www.aliyun.com", provider: "alibaba", region: "中国", kind: "https" },
  { id: "https-tencent", name: "腾讯网页", host: "www.qq.com", provider: "tencent", region: "中国", kind: "https" },
  { id: "https-microsoft", name: "Microsoft 网页", host: "www.microsoft.com", provider: "microsoft", region: "全球", kind: "https" },
  { id: "https-cloudflare", name: "Cloudflare 网页", host: "www.cloudflare.com", provider: "cloudflare", region: "全球", kind: "https" },
];
const NTP_EPOCH = 2208988800;
const ERA_SECONDS = 2 ** 32;
const monoNow = () => performance.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function writeTimestamp(buffer, offset, unixMs) {
  const seconds = unixMs / 1000 + NTP_EPOCH;
  buffer.writeUInt32BE(((Math.floor(seconds) % ERA_SECONDS) + ERA_SECONDS) % ERA_SECONDS, offset);
  buffer.writeUInt32BE(Math.floor((seconds - Math.floor(seconds)) * ERA_SECONDS), offset + 4);
}

function readTimestamp(buffer, offset, referenceMs) {
  const seconds = buffer.readUInt32BE(offset);
  const fraction = buffer.readUInt32BE(offset + 4) / ERA_SECONDS;
  const referenceSeconds = referenceMs / 1000 + NTP_EPOCH;
  const era = Math.round((referenceSeconds - seconds) / ERA_SECONDS);
  return (seconds + era * ERA_SECONDS + fraction - NTP_EPOCH) * 1000;
}

function parseNtp(packet, request, t1, t4, elapsedMs) {
  if (packet.length < 48) throw new Error("NTP 响应不足 48 字节");
  const leap = packet[0] >> 6;
  const version = (packet[0] >> 3) & 7;
  if ((packet[0] & 7) !== 4 || ![3, 4].includes(version)) throw new Error("无效的 NTP 服务端响应");
  if (packet[1] === 0) throw new Error(`服务器限流或拒绝（${packet.toString("ascii", 12, 16)}）`);
  if (leap === 3 || packet[1] > 15) throw new Error("服务器尚未同步");
  if (!packet.subarray(24, 32).equals(request.subarray(40, 48))) throw new Error("NTP 请求标识不匹配");
  if (packet.subarray(32, 40).every(v => v === 0) || packet.subarray(40, 48).every(v => v === 0)) {
    throw new Error("NTP 时间戳为空");
  }
  if (Math.abs(t4 - t1 - elapsedMs) > 100) throw new Error("检测期间系统时间发生跳变，请重新检测");
  const t2 = readTimestamp(packet, 32, t1);
  const t3 = readTimestamp(packet, 40, t1);
  const delayMs = elapsedMs - (t3 - t2);
  if (t3 < t2 || delayMs < -5 || delayMs > 3000) throw new Error("NTP 时序或网络延迟异常");
  const rootDelay = Math.max(0, packet.readInt32BE(4) / 65536 * 1000);
  const rootDispersion = packet.readUInt32BE(8) / 65536 * 1000;
  return {
    offsetMs: ((t2 - t1) + (t3 - t4)) / 2,
    rttMs: Math.max(0, delayMs),
    uncertaintyMs: Math.max(1, Math.max(0, delayMs) / 2 + rootDelay / 2 + rootDispersion + 1),
    stratum: packet[1], leap,
  };
}

async function resolveAddresses(host, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      dns.lookup(host, { all: true, verbatim: false }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("DNS 解析超时")), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function queryNtpAddress(address, timeoutMs, port = 123) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(address.family === 6 ? "udp6" : "udp4");
    let timer, finished = false, request, t1, start;
    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* Already closed. */ }
      if (error) reject(error); else resolve(value);
    }
    timer = setTimeout(() => finish(new Error("NTP 超时（可能被网络屏蔽 UDP 123）")), timeoutMs);
    socket.on("error", error => finish(error));
    socket.on("message", packet => {
      const end = monoNow(), t4 = Date.now();
      try { finish(null, parseNtp(packet, request, t1, t4, end - start)); }
      catch (error) { finish(error); }
    });
    // Connected UDP restricts replies to the resolved server address and port.
    socket.connect(port, address.address, () => {
      request = Buffer.alloc(48);
      request[0] = 0x23;
      t1 = Date.now();
      writeTimestamp(request, 40, t1);
      // Random low fraction bits act as a nonce (less than 0.016 ms).
      crypto.randomBytes(2).copy(request, 46);
      start = monoNow();
      socket.send(request, error => { if (error) finish(error); });
    });
  });
}

async function queryNtp(source, timeoutMs) {
  const deadline = monoNow() + timeoutMs;
  const addresses = await resolveAddresses(source.host, timeoutMs);
  if (!addresses.length) throw new Error("DNS 未返回地址");
  // Try both IP families within one deadline instead of failing on unusable IPv6.
  const candidates = [];
  for (const family of [4, 6]) {
    const address = addresses.find(a => a.family === family);
    if (address) candidates.push(address);
  }
  return Promise.any(candidates.map(address => queryNtpAddress(address, Math.max(1, deadline - monoNow()))))
    .catch(error => { throw error.errors?.[0] || error; });
}

function parseHttpTime(headers, t1, t4, elapsedMs, statusCode) {
  if (statusCode < 200 || statusCode >= 400) throw new Error(`HTTPS 状态码 ${statusCode}`);
  if (headers.age && Number(headers.age) > 0) throw new Error("网页返回了缓存时间，已排除");
  const serverMs = Date.parse(headers.date);
  if (!Number.isFinite(serverMs)) throw new Error("HTTPS 响应没有有效 Date 时间");
  if (Math.abs(t4 - t1 - elapsedMs) > 100) throw new Error("检测期间系统时间发生跳变，请重新检测");
  // HTTP Date is second-resolution; use the middle of its one-second bucket.
  return { offsetMs: serverMs + 500 - (t1 + t4) / 2, rttMs: elapsedMs, uncertaintyMs: 1000 + elapsedMs / 2 };
}

function queryHttps(source, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t1 = Date.now(), start = monoNow();
    const request = https.request({
      hostname: source.host, port: 443, method: "HEAD",
      path: `/?clock_probe=${crypto.randomBytes(10).toString("hex")}`,
      agent: false,
      headers: { "Cache-Control": "no-cache, no-store", Pragma: "no-cache", "User-Agent": "Toolbox-TimeSync/1.0" },
      // Certificate verification is deliberately kept enabled.
    }, response => {
      const end = monoNow(), t4 = Date.now();
      response.resume();
      clearTimeout(timer);
      try { resolve(parseHttpTime(response.headers, t1, t4, end - start, response.statusCode)); }
      catch (error) { reject(error); }
    });
    const timer = setTimeout(() => request.destroy(new Error("HTTPS 连接超时")), timeoutMs);
    request.on("error", error => { clearTimeout(timer); reject(error); });
    request.end();
  });
}

const median = numbers => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function chooseConsensus(results) {
  const good = results.filter(r => r.ok && Number.isFinite(r.offsetMs) && Number.isFinite(r.uncertaintyMs));
  const kind = good.some(r => r.kind === "ntp") ? "ntp" : "https";
  const representatives = new Map();
  for (const row of good.filter(r => r.kind === kind)) {
    if (!representatives.has(row.provider) || row.uncertaintyMs < representatives.get(row.provider).uncertaintyMs) {
      representatives.set(row.provider, row);
    }
  }
  const candidates = [...representatives.values()];
  if (!candidates.length) return { kind: null, offsetMs: null, uncertaintyMs: null, canSync: false, usedIds: [], reason: "所有时间源均不可达，请检查网络、DNS 或防火墙后重试。" };
  const eligible = candidates.filter(r => r.uncertaintyMs <= (kind === "ntp" ? 250 : 2500));
  const tolerance = kind === "ntp" ? 20 : 100;
  // Find the greatest intersection of measurement intervals, requiring a strict
  // majority of independent providers. A two-versus-two split cannot calibrate.
  let cluster = [];
  for (const row of eligible) {
    for (const point of [row.offsetMs - row.uncertaintyMs - tolerance, row.offsetMs + row.uncertaintyMs + tolerance]) {
      const members = eligible.filter(r => Math.abs(r.offsetMs - point) <= r.uncertaintyMs + tolerance + 0.001);
      if (members.length > cluster.length) cluster = members;
    }
  }
  const agreed = cluster.length >= 2 && cluster.length > candidates.length / 2;
  const used = agreed ? cluster : candidates;
  const offsetMs = median(used.map(r => r.offsetMs));
  const uncertaintyMs = Math.max(...used.map(r => Math.abs(r.offsetMs - offsetMs) + r.uncertaintyMs));
  return {
    kind, offsetMs, uncertaintyMs, canSync: agreed,
    providerCount: candidates.length, agreedProviders: agreed ? cluster.length : 0,
    usedIds: agreed ? cluster.map(r => r.id) : [],
    reason: agreed
      ? (kind === "ntp" ? "多个独立 NTP 时间源一致，可执行校准。" : "NTP 不足以形成共识，HTTPS 仅提供秒级估计；可显式允许粗略校准。")
      : "可用的独立时间源不足，或源之间存在分歧；当前结果仅供参考，不能执行校准。",
  };
}

async function probeSource(source, { samples, timeoutMs }, query) {
  const measurements = [], errors = [];
  for (let i = 0; i < samples; i++) {
    if (i) await sleep(1100);
    try { measurements.push(await query(source, timeoutMs)); }
    catch (error) { errors.push(error.message); }
  }
  if (!measurements.length) return { ...source, ok: false, error: errors.at(-1), samplesOk: 0 };
  const best = measurements.reduce((a, b) => a.uncertaintyMs < b.uncertaintyMs ? a : b);
  const spreadMs = Math.max(...measurements.map(m => Math.abs(m.offsetMs - best.offsetMs)));
  return { ...source, ok: true, ...best, uncertaintyMs: best.uncertaintyMs + spreadMs, spreadMs, samplesOk: measurements.length, samplesRequested: samples, warnings: errors };
}

function validateOptions(options = {}) {
  const { samples = 2, timeoutMs = 2500, sourceIds = SOURCES.map(s => s.id), httpsFallback = true } = options;
  if (!Number.isInteger(samples) || samples < 1 || samples > 3) throw new Error("采样次数应为 1–3");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 5000) throw new Error("超时应为 500–5000 毫秒");
  if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > SOURCES.length || sourceIds.some(id => !SOURCES.some(s => s.id === id))) throw new Error("请选择内置时间源");
  if (typeof httpsFallback !== "boolean") throw new Error("HTTPS 兜底选项无效");
  if (!httpsFallback && !SOURCES.some(s => s.kind === "ntp" && sourceIds.includes(s.id))) throw new Error("请选择至少一个 NTP 时间源，或启用 HTTPS 兜底");
  return { samples, timeoutMs, sourceIds: [...new Set(sourceIds)], httpsFallback };
}

async function detect(options, queries = {}) {
  const settings = validateOptions(options);
  const startWall = Date.now(), startMono = monoNow();
  const selected = SOURCES.filter(s => settings.sourceIds.includes(s.id));
  const results = await Promise.all(selected.filter(s => s.kind === "ntp").map(s => probeSource(s, settings, queries.ntp || queryNtp)));
  const ntpConsensus = chooseConsensus(results);
  if (settings.httpsFallback && !ntpConsensus.canSync) {
    results.push(...await Promise.all(selected.filter(s => s.kind === "https").map(s => probeSource(s, { ...settings, samples: 1 }, queries.https || queryHttps))));
  }
  let consensus = chooseConsensus(results);
  // Keep NTP and HTTP estimates separate. Never average different protocols.
  if (!consensus.canSync) {
    const httpConsensus = chooseConsensus(results.filter(r => r.kind === "https"));
    if (httpConsensus.canSync) consensus = httpConsensus;
  }
  const elapsedMs = monoNow() - startMono;
  const clockJumped = Math.abs(Date.now() - startWall - elapsedMs) > 100;
  if (clockJumped) consensus = { ...consensus, canSync: false, reason: "检测过程中系统时间发生变化，请重新检测。" };
  const measuredAt = Date.now();
  return { id: crypto.randomUUID(), measuredAt, elapsedMs, options: settings, results, consensus, clockJumped };
}

module.exports = { SOURCES, detect, validateOptions, chooseConsensus, parseNtp, parseHttpTime, writeTimestamp, readTimestamp, queryNtpAddress, queryHttps };
