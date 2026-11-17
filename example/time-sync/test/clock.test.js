"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const { SOURCES, writeTimestamp, readTimestamp, parseNtp, parseHttpTime, chooseConsensus, detect, queryNtpAddress } = require("../clock");

function exchange(offset = 120) {
  const t1 = Date.UTC(2026, 10, 11), t4 = t1 + 80;
  const request = Buffer.alloc(48), reply = Buffer.alloc(48);
  request[0] = 0x23; writeTimestamp(request, 40, t1);
  reply[0] = 0x24; reply[1] = 2;
  request.copy(reply, 24, 40, 48);
  writeTimestamp(reply, 32, t1 + 30 + offset);
  writeTimestamp(reply, 40, t1 + 50 + offset);
  return { request, reply, t1, t4 };
}
function row(id, provider, offsetMs, uncertaintyMs = 10, kind = "ntp") {
  return { id, provider, offsetMs, uncertaintyMs, kind, ok: true, rttMs: uncertaintyMs * 2 };
}

test("NTP 四时间戳正确区分快慢并扣除服务器处理时间", () => {
  for (const offset of [120, -350, 0, 24 * 3600 * 1000]) {
    const { request, reply, t1, t4 } = exchange(offset);
    const parsed = parseNtp(reply, request, t1, t4, 80);
    assert.ok(Math.abs(parsed.offsetMs - offset) < 0.001);
    assert.ok(Math.abs(parsed.rttMs - 60) < 0.001);
  }
});

test("2036 年 NTP era 回绕仍能解析未来时间", () => {
  for (const year of [2026, 2037, 2055]) {
    const buffer = Buffer.alloc(8), expected = Date.UTC(year, 0, 1, 0, 0, 0, 125);
    writeTimestamp(buffer, 0, expected);
    assert.equal(readTimestamp(buffer, 0, expected), expected);
  }
});

test("拒绝伪造标识、未同步、错误模式、KoD、截断及系统跳时响应", () => {
  const { request, reply, t1, t4 } = exchange();
  const malformed = [
    packet => { packet[24] ^= 1; },
    packet => { packet[0] = 0xe4; },
    packet => { packet[0] = 0x23; },
    packet => { packet[1] = 0; packet.write("RATE", 12); },
    packet => { packet[1] = 16; },
    packet => { packet.fill(0, 40, 48); },
  ];
  for (const alter of malformed) {
    const packet = Buffer.from(reply); alter(packet);
    assert.throws(() => parseNtp(packet, request, t1, t4, 80));
  }
  assert.throws(() => parseNtp(reply.subarray(0, 32), request, t1, t4, 80));
  assert.throws(() => parseNtp(reply, request, t1, t4 + 1000, 80), /跳变/);
});

test("真实本地 UDP 请求 / 响应与超时清理", async t => {
  const server = dgram.createSocket("udp4");
  await new Promise(resolve => server.bind(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  server.on("message", (request, remote) => {
    const packet = Buffer.alloc(48); packet[0] = 0x24; packet[1] = 2;
    request.copy(packet, 24, 40, 48);
    writeTimestamp(packet, 32, Date.now() + 150);
    writeTimestamp(packet, 40, Date.now() + 150);
    server.send(packet, remote.port, remote.address);
  });
  const result = await queryNtpAddress({ family: 4, address: "127.0.0.1" }, 500, server.address().port);
  assert.ok(Math.abs(result.offsetMs - 150) < 30);
  const silent = dgram.createSocket("udp4");
  await new Promise(resolve => silent.bind(0, "127.0.0.1", resolve));
  t.after(() => silent.close());
  await assert.rejects(queryNtpAddress({ family: 4, address: "127.0.0.1" }, 40, silent.address().port), /超时/);
});

test("多源共识排除离群值，同一服务商备用源不重复计票", () => {
  const result = chooseConsensus([row("a", "a", 100), row("backup", "a", 102), row("b", "b", 105), row("c", "c", 9000)]);
  assert.equal(result.canSync, true);
  assert.equal(result.agreedProviders, 2);
  assert.equal(result.providerCount, 3);
  assert.ok(result.offsetMs >= 100 && result.offsetMs <= 105);
  assert.ok(!result.usedIds.includes("c"));
  assert.equal(chooseConsensus([row("a", "a", 100), row("backup", "a", 102)]).canSync, false);
});

test("一对一和二对二分歧不会被错误当成共识", () => {
  assert.equal(chooseConsensus([row("a", "a", 0), row("b", "b", 1000)]).canSync, false);
  assert.equal(chooseConsensus([row("a", "a", 0), row("b", "b", 5), row("c", "c", 1000), row("d", "d", 1005)]).canSync, false);
  assert.equal(chooseConsensus([]).offsetMs, null);
  assert.equal(chooseConsensus([row("a", "a", 0, 2000), row("b", "b", 0, 2000)]).canSync, false);
});

test("HTTPS 不与 NTP 混算，HTTP Date 粗略估计拒绝缓存和错误状态", () => {
  assert.equal(chooseConsensus([row("n", "n", 0), row("h1", "h1", 500, 1000, "https"), row("h2", "h2", 500, 1000, "https")]).kind, "ntp");
  const t1 = Date.UTC(2026, 10, 11);
  const parsed = parseHttpTime({ date: new Date(t1 + 2000).toUTCString() }, t1, t1 + 100, 100, 200);
  assert.equal(parsed.offsetMs, 2450);
  assert.ok(parsed.uncertaintyMs >= 1000);
  assert.throws(() => parseHttpTime({ date: new Date(t1).toUTCString(), age: "60" }, t1, t1, 0, 200), /缓存/);
  assert.throws(() => parseHttpTime({}, t1, t1, 0, 200), /Date/);
  assert.throws(() => parseHttpTime({ date: new Date(t1).toUTCString() }, t1, t1, 0, 503), /503/);
});

test("NTP 受阻时自动使用独立的 HTTPS 共识，禁用兜底则不请求 HTTPS", async () => {
  let httpsCalls = 0;
  const queries = {
    ntp: async () => { throw new Error("UDP blocked"); },
    https: async () => { httpsCalls++; return { offsetMs: 100, rttMs: 10, uncertaintyMs: 1005 }; },
  };
  const options = { samples: 1, timeoutMs: 500, sourceIds: ["aliyun", "https-aliyun", "https-tencent"] };
  const result = await detect(options, queries);
  assert.equal(result.consensus.kind, "https"); assert.equal(result.consensus.canSync, true); assert.equal(httpsCalls, 2);
  await detect({ ...options, httpsFallback: false }, queries);
  assert.equal(httpsCalls, 2);
});

test("NTP 只有一个可用提供者时也能降级 HTTPS，不掩盖 NTP 状态", async () => {
  const result = await detect({ samples: 1, timeoutMs: 500, sourceIds: ["aliyun", "https-aliyun", "https-tencent"] }, {
    ntp: async () => ({ offsetMs: 100, rttMs: 10, uncertaintyMs: 6 }),
    https: async () => ({ offsetMs: 200, rttMs: 10, uncertaintyMs: 1005 }),
  });
  assert.equal(result.consensus.kind, "https"); assert.equal(result.consensus.canSync, true);
  assert.equal(result.results.find(r => r.kind === "ntp").ok, true);
});

test("拒绝任意外部地址与越界采样参数", async () => {
  await assert.rejects(detect({ sourceIds: ["http://127.0.0.1"] }), /内置/);
  await assert.rejects(detect({ samples: 50 }), /采样/);
  await assert.rejects(detect({ timeoutMs: 1 }), /超时/);
  await assert.rejects(detect({ sourceIds: ["https-aliyun"], httpsFallback: false }), /至少一个 NTP/);
  assert.equal(SOURCES.filter(s => s.kind === "ntp").length, 6);
});
