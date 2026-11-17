"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { createServer } = require("../app");
const { inspectSystem } = require("../system");

function report(offsetMs = 150, kind = "ntp", canSync = true) {
  return { id: crypto.randomUUID(), measuredAt: Date.now(), elapsedMs: 20, options: { samples: 1, timeoutMs: 500 }, results: [], consensus: { kind, offsetMs, uncertaintyMs: kind === "ntp" ? 10 : 1100, canSync, usedIds: [], providerCount: 2, agreedProviders: 2 } };
}

async function fixture(t, options = {}) {
  if (options.platform === "linux" && !options.inspectHost) options.inspectHost = () => inspectSystem("linux", { linuxFacts: { root: true, gnuDate: true, datePath: "/usr/bin/date", hasTimeCapability: true } });
  const server = createServer(options);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(`${base}/api/config`)).json();
  const post = async (route, body, headers = {}) => {
    const response = await fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Tool-Token": config.token, ...headers }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { server, base, config, post };
}

test("本机接口限制 Host、Origin、令牌和公开文件白名单", async t => {
  const { base, post } = await fixture(t);
  assert.equal((await post("/api/detect", {}, { "X-Tool-Token": "wrong" })).status, 403);
  assert.equal((await post("/api/detect", {}, { Origin: "https://evil.example" })).status, 403);
  const forbiddenHost = await new Promise((resolve, reject) => {
    http.get(`${base}/api/config`, { headers: { Host: "evil.example" } }, response => { response.resume(); resolve(response.statusCode); }).on("error", reject);
  });
  assert.equal(forbiddenHost, 403);
  assert.equal((await fetch(`${base}/windows-clock.ps1`)).status, 404);
  assert.equal((await fetch(`${base}/linux-clock.js`)).status, 404);
  assert.equal((await fetch(`${base}/system.js`)).status, 404);
  assert.equal((await fetch(`${base}/app.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/sync`)).status, 405);
  assert.equal((await post("/api/detect", { samples: 999 })).status, 400);
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.ok(html.headers.get("content-security-policy").includes("script-src 'self'"));
});

test("Linux 自动识别并执行校准前后复测", async t => {
  const reports = [report(150), report(155), report(3)];
  const applied = [];
  const { config, post } = await fixture(t, { platform: "linux", detectClock: async () => reports.shift(), setClock: async (offset, system) => applied.push([offset, system.platform]) });
  assert.equal(config.canCalibrate, true); assert.equal(config.source, "runtime");
  assert.ok(config.guidance.blocks.some(b => b.command.includes("chronyc tracking")));
  const checked = await post("/api/detect", {});
  const synced = await post("/api/sync", { reportId: checked.data.report.id });
  assert.equal(synced.data.verified, true); assert.deepEqual(applied, [[155, "linux"]]);
});

test("系统无法识别时要求用户选择，确认后可检测并提供对应指引", async t => {
  let applied = false;
  const { config, post } = await fixture(t, { platform: "unknown-os", detectClock: async () => report(), setClock: async () => { applied = true; } });
  assert.equal(config.requiresSelection, true);
  assert.equal((await post("/api/detect", {})).status, 400);
  assert.equal((await post("/api/system", { system: "invalid" })).status, 400);
  const selected = await post("/api/system", { system: "linux" });
  assert.equal(selected.data.config.platform, "linux"); assert.equal(selected.data.config.source, "manual");
  assert.equal(selected.data.config.canCalibrate, false);
  assert.equal((await post("/api/detect", {})).status, 200);
  const synced = await post("/api/sync", {});
  assert.equal(synced.status, 400); assert.match(synced.data.guidance.title, /Linux/);
  assert.equal(applied, false);
});

test("不能用手动选择让已识别的 Windows 执行 Linux 命令", async t => {
  const { post } = await fixture(t, { platform: "win32" });
  assert.equal((await post("/api/system", { system: "linux" })).status, 400);
});

test("Linux 无法校准时返回原因和可执行的终端步骤", async t => {
  const { config, post } = await fixture(t, { platform: "linux", inspectHost: () => inspectSystem("linux", { linuxFacts: { wsl: true, gnuDate: true, root: true } }), setClock: async () => assert.fail("不应修改宿主时间") });
  assert.equal(config.canCalibrate, false); assert.match(config.reason, /WSL/);
  const failed = await post("/api/sync", {});
  assert.equal(failed.status, 400); assert.match(failed.data.error, /WSL/);
  assert.ok(failed.data.guidance.blocks.length > 0);
});

test("系统识别异常也能手动确认，重新识别会清除已有检测报告", async t => {
  let identifyCalls = 0;
  const { config, post } = await fixture(t, { platform: "win32", inspectHost: async () => { if (++identifyCalls === 1) throw new Error("识别错误"); return inspectSystem("win32"); }, detectClock: async () => report(), setClock: async () => assert.fail("旧报告不可使用") });
  assert.equal(config.requiresSelection, true);
  assert.equal((await post("/api/system", { system: "win32" })).data.config.canCalibrate, false);
  const first = await post("/api/detect", {});
  const identified = await post("/api/system", { redetect: true });
  assert.equal(identified.data.config.canCalibrate, true);
  assert.equal((await post("/api/sync", { reportId: first.data.report.id })).status, 409);
});

test("检测失败或来源未达共识时，按已确认系统附带排查指引", async t => {
  const { post } = await fixture(t, { platform: "linux", detectClock: async () => report(0, "ntp", false) });
  const result = await post("/api/detect", {});
  assert.match(result.data.guidance.title, /Linux/);
  assert.ok(result.data.guidance.blocks[0].command.includes("UDP 123"));
  const other = await fixture(t, { platform: "win32", detectClock: async () => { throw new Error("无法连接时间源"); } });
  const failed = await other.post("/api/detect", {});
  assert.equal(failed.status, 500); assert.match(failed.data.guidance.title, /Windows/);
});

test("Windows 校准使用服务端复测的偏差，忽略客户端偏差，并在校准后验证", async t => {
  const reports = [report(150), report(160), report(2)];
  const applied = [];
  const { post } = await fixture(t, { platform: "win32", detectClock: async () => reports.shift(), setClock: async offset => applied.push(offset) });
  const first = await post("/api/detect", {});
  const synced = await post("/api/sync", { reportId: first.data.report.id, offsetMs: 999999999 });
  assert.equal(synced.status, 200); assert.equal(synced.data.verified, true);
  assert.deepEqual(applied, [160]);
  assert.equal((await post("/api/sync", { reportId: first.data.report.id })).status, 409);
});

test("无报告、过时报告 ID 和无共识时禁止修改系统时间", async t => {
  const { post } = await fixture(t, { platform: "win32", detectClock: async () => report(100, "ntp", false), setClock: async () => assert.fail("不应执行校准") });
  assert.equal((await post("/api/sync", { reportId: "unknown" })).status, 409);
  const checked = await post("/api/detect", {});
  assert.equal((await post("/api/sync", { reportId: checked.data.report.id })).status, 409);
});

test("HTTPS 粗略校准必须显式允许，复测不能偷偷从 NTP 降级", async t => {
  const { post } = await fixture(t, { platform: "win32", detectClock: async () => report(100, "https"), setClock: async () => {} });
  const checked = await post("/api/detect", {});
  assert.equal((await post("/api/sync", { reportId: checked.data.report.id })).status, 409);
  assert.equal((await post("/api/sync", { reportId: checked.data.report.id, allowCoarse: true })).status, 200);
  const reports = [report(), report(150, "https")];
  const another = await fixture(t, { platform: "win32", detectClock: async () => reports.shift(), setClock: async () => assert.fail("不应降级校准") });
  const ntp = await another.post("/api/detect", {});
  assert.equal((await another.post("/api/sync", { reportId: ntp.data.report.id })).status, 409);
});

test("复测时间源失去共识或偏差突变时中止", async t => {
  for (const fresh of [report(100, "ntp", false), report(10000)]) {
    const reports = [report(), fresh];
    const { post } = await fixture(t, { platform: "win32", detectClock: async () => reports.shift(), setClock: async () => assert.fail("不应执行校准") });
    const checked = await post("/api/detect", {});
    assert.equal((await post("/api/sync", { reportId: checked.data.report.id })).status, 409);
  }
});

test("校准执行成功与校后复测失败分别报告", async t => {
  let calls = 0;
  const { post } = await fixture(t, { platform: "win32", detectClock: async () => { if (++calls > 2) throw new Error("断网"); return report(); }, setClock: async () => {} });
  const checked = await post("/api/detect", {});
  const synced = await post("/api/sync", { reportId: checked.data.report.id });
  assert.equal(synced.data.applied, true); assert.equal(synced.data.verified, false);
});

test("管理员取消授权不报告校准成功，报告失效防止重放", async t => {
  const { post } = await fixture(t, { platform: "win32", detectClock: async () => report(), setClock: async () => { throw new Error("已取消管理员授权"); } });
  const checked = await post("/api/detect", {});
  const result = await post("/api/sync", { reportId: checked.data.report.id });
  assert.equal(result.status, 500); assert.match(result.data.error, /取消/);
  assert.equal((await post("/api/sync", { reportId: checked.data.report.id })).status, 409);
});

test("长检测期间拒绝并发操作", async t => {
  let release;
  const { post } = await fixture(t, { detectClock: () => new Promise(resolve => { release = () => resolve(report()); }) });
  const first = post("/api/detect", {});
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await post("/api/detect", {})).status, 409);
  release(); assert.equal((await first).status, 200);
});
