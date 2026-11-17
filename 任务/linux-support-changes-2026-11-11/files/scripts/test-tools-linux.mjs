#!/usr/bin/env node
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createLinuxClipboard, decodeFiles, encodeFiles } = require("../example/clipboard-history/linux-clipboard");
const { createLinuxProcesses } = require("../example/close-occupied-process/linux-processes");
const { localPaths } = require("../example/quota-pool/local-paths");
const { legacyPaths } = require("../example/consciousness-stream/legacy-paths");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  for (let i = 0; i < 60; i++) { if (await check()) return; await wait(25); }
  throw new Error("等待条件超时");
}

test("Windows 保留原有路径和顺序；Linux 遵循 XDG 并支持明确的文件覆盖", () => {
  const base = path.join(os.tmpdir(), "tools-path-fixture");
  const env = { LOCALAPPDATA: path.join(base, "local"), APPDATA: path.join(base, "roaming") };
  const win = localPaths({ platform: "win32", env, home: base });
  assert(win.auth[0].startsWith(env.LOCALAPPDATA));
  assert(win.trae[0].startsWith(env.APPDATA));
  assert(legacyPaths({ platform: "win32", env })[0].startsWith(env.APPDATA));
  assert.deepEqual(legacyPaths({ platform: "win32", env: {} }), []);
  const linuxEnv = { XDG_CONFIG_HOME: path.join(base, "config"), XDG_DATA_HOME: path.join(base, "data"),
    QUOTA_POOL_WORKBUDDY_AUTH_FILE: path.join(base, "custom.info"), QUOTA_POOL_TRAE_ENV_FILE: path.join(base, "custom-env.json") };
  const linux = localPaths({ platform: "linux", env: linuxEnv, home: base });
  assert.equal(linux.auth[0], linuxEnv.QUOTA_POOL_WORKBUDDY_AUTH_FILE);
  assert.equal(linux.trae[0], linuxEnv.QUOTA_POOL_TRAE_ENV_FILE);
  assert(linux.auth.some((p) => p.startsWith(linuxEnv.XDG_CONFIG_HOME)));
  assert(linux.auth.some((p) => p.startsWith(linuxEnv.XDG_DATA_HOME)));
  assert(legacyPaths({ platform: "linux", env: linuxEnv, home: base }).every((p) => p.startsWith(linuxEnv.XDG_CONFIG_HOME)));
  assert(legacyPaths({ platform: "linux", env: {}, home: base })[0].startsWith(path.join(base, ".config")));
});

function procFixture() {
  const root = path.resolve("fixture-proc");
  const records = new Map(), links = new Map(), calls = [];
  const tables = new Map(["tcp", "tcp6", "udp", "udp6"].map((t) => [t, "header\n"]));
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  function add(pid, ppid = 1, name = "node", start = "100", state = "S") {
    const fields = [state, String(ppid), ...Array(17).fill("0"), start];
    records.set(pid, `${pid} (${name}) ${fields.join(" ")}`);
  }
  const io = {
    async readFile(file) {
      const parts = path.relative(root, file).split(path.sep);
      if (parts[0] === "net") return tables.get(parts[1]);
      if (!records.has(Number(parts[0]))) throw missing();
      return records.get(Number(parts[0]));
    },
    async readdir(file) {
      if (file === root) return [...records.keys()].map(String);
      return [...links.keys()].filter((p) => path.dirname(p) === file).map((p) => path.basename(p));
    },
    async readlink(file) { if (!links.has(file)) throw missing(); return links.get(file); },
  };
  const signal = (pid, sig) => { calls.push([pid, sig]); if (sig === "SIGKILL") records.delete(pid); };
  const api = createLinuxProcesses({ procRoot: root, io, signal, selfPid: 99999 });
  return { root, records, links, calls, tables, add, io, signal, api };
}

test("Linux 匹配 IPv4/IPv6、TCP/UDP 的本地端口，区分 TIME_WAIT", async () => {
  const f = procFixture(); f.add(30, 1, "server) with spaces");
  const row = (port, state, inode) => `0: 00000000:${port.toString(16)} 00000000:0000 ${state} 0:0 0:0 0 1000 0 ${inode}\n`;
  f.tables.set("tcp", "header\n" + row(8080, "0A", "500") + row(80, "0A", "501") + row(8080, "06", "0"));
  f.tables.set("udp6", "header\n" + row(8080, "07", "502"));
  f.links.set(path.join(f.root, "30/fd/3"), "socket:[500]");
  f.links.set(path.join(f.root, "30/fd/4"), "socket:[502]");
  const matches = await f.api.findPidsByPort(8080);
  assert(matches.some((m) => m.pid === 30 && m.state === "LISTENING"));
  assert(matches.some((m) => m.pid === 30 && m.proto === "UDP"));
  assert(matches.some((m) => m.pid === 0 && m.state === "TCP_06"));
  assert.equal(await f.api.getProcessName(30), "server) with spaces");
  assert.deepEqual(await f.api.findPidsByPort(9999), []);
});

test("Linux 不把无法读取进程的占用端口误报为空闲", async () => {
  const f = procFixture();
  f.tables.set("tcp6", "header\n0: 00000000:1f90 00000000:0 0A 0:0 0:0 0 1000 0 555\n");
  await assert.rejects(f.api.findPidsByPort(8080), /已被占用.*无法读取/);
});

test("Linux 终止整棵目标树，保留不相关进程，保护工具与宿主", async () => {
  const f = procFixture();
  f.add(30); f.add(31, 30); f.add(32, 31); f.add(40);
  assert.deepEqual(await f.api.killProcess(30, "node"), { pid: 30, name: "node" });
  assert.deepEqual(f.calls.filter(([, s]) => s === "SIGKILL").map(([pid]) => pid), [32, 31, 30]);
  assert(f.records.has(40));
  await assert.rejects(f.api.killProcess(1, "init"), /不能终止/);
  await assert.rejects(f.api.killProcess(99999, "self"), /不能终止/);
});

test("Linux 权限不足时返回原因，不先杀子进程", async () => {
  const f = procFixture(); f.add(30); f.add(31, 30);
  const api = createLinuxProcesses({ procRoot: f.root, io: f.io, selfPid: 99999,
    signal: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); } });
  await assert.rejects(api.killProcess(30, "server"), /无权限/);
  assert(f.records.has(31));
});

function fakeClipboard({ wayland = false, missing = false } = {}) {
  let values = new Map();
  const calls = [], children = [];
  const spawnProcess = (cmd, args) => {
    calls.push([cmd, args]);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let data = [];
    child.stdin = new Writable({ write(chunk, enc, done) { data.push(Buffer.from(chunk)); done(); } });
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit("close", 0)); return true; };
    children.push(child);
    const writing = cmd === "wl-copy" || args.includes("-in");
    child.watching = args.includes("--watch");
    const typeIndex = args.indexOf(wayland ? "--type" : "-target");
    const type = typeIndex >= 0 ? args[typeIndex + 1] : null;
    if (writing) child.stdin.on("finish", () => { values = new Map([[type, Buffer.concat(data)]]); });
    setImmediate(() => {
      if (missing) {
        child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
        child.emit("close", -2); return;
      }
      if (child.watching) { child.stdout.write("changed\n"); }
      else if (!writing) {
        const result = !type || type === "TARGETS" ? Buffer.from([...values.keys()].join("\n")) : values.get(type);
        if (result) { child.stdout.end(result); child.emit("close", 0); }
        else { child.stderr.end("target requested not available"); child.emit("close", 1); }
      }
    });
    return child;
  };
  const backend = createLinuxClipboard({ env: wayland ? { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" } : { DISPLAY: ":0" }, spawnProcess });
  return { backend, calls, children, set: (type, data) => {
    values = new Map([[type, Buffer.from(data)]]);
    for (const child of children.filter((c) => c.watching && !c.killed)) child.stdout.write("changed\n");
  } };
}

for (const wayland of [false, true]) {
  test(`${wayland ? "Wayland" : "X11"}：文字保留空白和 Unicode，图片按字节读取，文件 URI 正确解码`, async () => {
    const f = fakeClipboard({ wayland });
    try {
      f.set("text/plain;charset=utf-8", "  中文\n\n");
      assert.equal((await f.backend.readSnapshot()).text, "  中文\n\n");
      const png = Buffer.alloc(25); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(5, 16); png.writeUInt32BE(8, 20); png[24] = 255;
      f.set("image/png", png);
      const snap = await f.backend.readSnapshot();
      assert.equal(snap.width, 5); assert.equal(snap.height, 8); assert.deepEqual(snap.imageData, png);
      f.set("x-special/gnome-copied-files", "copy\nfile:///home/u/a%20b.txt\nfile:///home/u/%E4%B8%AD%E6%96%87\nhttps://example.com/a");
      assert.deepEqual((await f.backend.readSnapshot()).files, ["/home/u/a b.txt", "/home/u/中文"]);
      assert.equal(f.backend.status().backend, wayland ? "wayland" : "x11");
    } finally { f.backend.dispose(); }
  });
  test(`${wayland ? "Wayland" : "X11"}：回读确认写入，持有选择并在关闭时回收所有者`, async () => {
    const f = fakeClipboard({ wayland });
    try {
      assert.equal((await f.backend.write({ type: "text", text: " --中文\n" })).out, "ok");
      assert.equal((await f.backend.readSnapshot()).text, " --中文\n");
      await f.backend.write({ type: "files", files: ["/home/u/a #%.txt"] });
      assert.deepEqual((await f.backend.readSnapshot()).files, ["/home/u/a #%.txt"]);
      const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
      await f.backend.write({ type: "image" }, png);
      assert.deepEqual((await f.backend.readSnapshot()).imageData, png);
      assert(f.calls.some(([cmd, args]) => wayland ? cmd === "wl-copy" && args.includes("--foreground") : cmd === "xclip" && args.includes("-quiet")));
    } finally { f.backend.dispose(); }
    assert(f.children.filter((c) => !c.stdout.readableEnded).every((c) => c.killed));
  });
}

test("文件剪贴板拒绝远程 URI 和 Windows 路径，不误执行剪切操作", () => {
  assert.deepEqual(decodeFiles("cut\nfile://remote/a\nfile:///home/u/a\n# comment"), ["/home/u/a"]);
  assert.throws(() => encodeFiles(["C:\\file.txt"]), /Linux 绝对路径/);
});

test("缺少命令和图形会话时显示可操作的错误；监控不重复收录未变化内容", async () => {
  const noSession = createLinuxClipboard({ env: {} });
  await assert.rejects(noSession.readSnapshot(), /图形会话/); noSession.dispose();
  const missing = fakeClipboard({ missing: true });
  await assert.rejects(missing.backend.readSnapshot(), /缺少 xclip/); missing.backend.dispose();
  const f = fakeClipboard(); f.set("UTF8_STRING", "hello");
  const snapshots = [];
  const watcher = f.backend.start(() => 100, (s) => snapshots.push(s), () => {});
  try {
    await until(() => snapshots.length === 1); await wait(240);
    assert.equal(snapshots.length, 1);
    f.set("UTF8_STRING", "changed"); await until(() => snapshots.length === 2);
    watcher.kill(); f.set("UTF8_STRING", "after stop"); await wait(200);
    assert.equal(snapshots.length, 2);
  } finally { watcher.kill(); f.backend.dispose(); }
});

test("Wayland 用事件监控而非轮询，桌面不支持 data-control 时明确提示", async () => {
  const f = fakeClipboard({ wayland: true }); f.set("text/plain", "one");
  const snapshots = [];
  const watcher = f.backend.start(() => 100, (snap) => snapshots.push(snap), () => {});
  try {
    await until(() => snapshots.length === 1);
    const reads = f.calls.length;
    await wait(230); assert.equal(f.calls.length, reads, "未变化时不应轮询 Wayland");
    f.set("text/plain", "two"); await until(() => snapshots.length === 2);
    const command = f.children.find((c) => c.watching);
    command.stderr.write("Watch mode requires data-control"); command.emit("close", 1);
    assert.match(f.backend.status().error, /data-control/);
  } finally { watcher.kill(); f.backend.dispose(); }
});

// 在隔离目录中执行工具代码，通过真实路由函数检查持久化；不读取用户账号或剪贴板。
async function toolFixture(name, { platform = process.platform, env = {}, deps = {}, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-adapter-test-"));
  const routes = {};
  class Server {
    constructor(opts) { Object.assign(routes, opts.routes); }
    route(p, handler) { routes[p] = handler; }
    start() { return Promise.resolve(0); }
    stop() {}
  }
  if (name === "clipboard-history") fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ monitoringEnabled: false }));
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
  const nativeRequire = createRequire(path.join(ROOT, "example", name, "app.js"));
  const proc = new EventEmitter();
  Object.assign(proc, { platform, env: { TOOL_RUNTIME: "test-runtime", ...env }, pid: process.pid, exit() {} });
  const context = {
    require: (id) => {
      if (id === "test-runtime") return { ToolServer: Server };
      if (id === "./local-paths") return { localPaths: () => localPaths({ platform, env, home: dir }) };
      if (id === "./legacy-paths") return { legacyPaths: () => legacyPaths({ platform, env, home: dir }) };
      return deps[id] || nativeRequire(id);
    },
    __dirname: dir, process: proc, console: { log() {}, warn() {}, error() {} },
    Buffer, URL, URLSearchParams, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "example", name, "app.js"), "utf8"), context);
  await wait(0);
  return { dir, routes, async request(route, body = {}, method = "POST") {
    return new Promise((resolve, reject) => {
      const response = { json: resolve };
      try { const result = routes[route]({ method, url: route }, response, JSON.stringify(body)); if (result?.catch) result.catch(reject); }
      catch (e) { reject(e); }
    });
  }, close() { proc.emit("SIGTERM"); fs.rmSync(dir, { force: true, recursive: true }); } };
}

test("额度池自动导入、自选文件导入和设备 ID 覆盖都实际进入原有路由", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quota-auth-test-"));
  const authFile = path.join(root, "auth.info"), deviceFile = path.join(root, "env.json");
  const document = { auth: { accessToken: "test-only-access", refreshToken: "test-only-refresh" }, account: { uid: "fixture-user" } };
  fs.writeFileSync(authFile, JSON.stringify(document)); fs.writeFileSync(deviceFile, JSON.stringify({ device_id: "fixture-device" }));
  const app = await toolFixture("quota-pool", { platform: "linux", env: { QUOTA_POOL_WORKBUDDY_AUTH_FILE: authFile, QUOTA_POOL_TRAE_ENV_FILE: deviceFile } });
  try {
    assert.equal((await app.request("/api/accounts/import-local")).ok, true);
    assert.equal((await app.request("/api/accounts/import-local", { document })).ok, true);
    const stored = JSON.parse(fs.readFileSync(path.join(app.dir, "accounts.json"))).accounts;
    assert.equal(stored.length, 1); assert.equal(stored[0].accessToken, document.auth.accessToken);
    assert.equal((await app.request("/api/accounts/import-local", { document: { auth: {} } })).ok, false);
    assert.equal((await app.request("/api/accounts/import-local", { document: null })).ok, false, "选择了无效文件时不能悄悄导入其他账号");
    assert.equal((await app.request("/api/trae/login-url")).data.deviceId, "fixture-device");
    assert.equal((await app.request("/api/trae/login-url", { deviceId: "file-picked-device" })).data.deviceId, "file-picked-device");
  } finally { app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("意识流可以发现并导出 Linux 原版数据源", async () => {
  const file = path.join(os.tmpdir(), `legacy-source-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ sessions: [] }));
  const app = await toolFixture("consciousness-stream", { platform: "linux", env: { CONSCIOUSNESS_STREAM_LEGACY_FILE: file } });
  try {
    const status = await app.request("/api/legacy/status");
    assert(status.data.sources.some((s) => s.path === file && s.exists));
    assert.equal((await app.request("/api/legacy/export")).ok, true);
  } finally { app.close(); fs.rmSync(file, { force: true }); }
});

test("剪贴板 Windows 路由仍调用原有 PowerShell 参数，启动失败返回明确错误", async () => {
  const calls = [];
  const childProcess = { spawn(cmd, args) {
    calls.push([cmd, args]);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setImmediate(() => { child.emit("error", new Error("PowerShell unavailable")); child.emit("close", -2); });
    return child;
  } };
  const app = await toolFixture("clipboard-history", { platform: "win32", deps: { child_process: childProcess },
    files: { "history.json": JSON.stringify([{ id: "text-1", type: "text", text: "fixture" }]) } });
  try {
    assert.equal(calls.length, 0, "监控关闭时不应启动 PowerShell");
    const result = await app.request("/api/paste", { id: "text-1" });
    assert.equal(result.ok, false);
    assert.match(result.error, /PowerShell unavailable/);
    assert.equal(calls[0][0], "powershell");
    assert.deepEqual(Array.from(calls[0][1].slice(0, 5)), ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command"]);
  } finally { app.close(); }
});

test("Linux 剪贴板路由保存 PNG、返回监控状态并完成再复制，不调用 PowerShell", async () => {
  const f = fakeClipboard();
  const png = Buffer.alloc(25); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png[24] = 255;
  f.set("image/png", png);
  const app = await toolFixture("clipboard-history", { platform: "linux", deps: {
    "./linux-clipboard": { createLinuxClipboard: () => f.backend },
    child_process: { spawn() { throw new Error("Linux 不应调用 PowerShell"); } },
  }, files: { "settings.json": JSON.stringify({ monitoringEnabled: true, pollIntervalMs: 100 }) } });
  try {
    let history;
    await until(async () => { history = await app.request("/api/history", {}, "GET"); return history.data.items.length; });
    const item = history.data.items[0];
    assert.deepEqual(fs.readFileSync(path.join(app.dir, "images", item.imageFile)), png);
    assert.equal(history.data.clipboard.backend, "x11");
    assert.equal((await app.request("/api/paste", { id: item.id })).ok, true);
  } finally { app.close(); f.backend.dispose(); }
});

test("Windows 关闭占用进程仍按 netstat → tasklist → taskkill /F /T 执行", async () => {
  const calls = []; let alive = true;
  const exec = () => {};
  exec[promisify.custom] = async (cmd, args) => {
    calls.push([cmd, Array.from(args)]);
    if (cmd === "netstat") return { stdout: "TCP  0.0.0.0:8080  0.0.0.0:0  LISTENING  30" };
    if (cmd === "tasklist") return { stdout: alive ? '"node.exe","30","Console"' : "INFO: No tasks are running" };
    if (cmd === "taskkill") { alive = false; return { stdout: "SUCCESS" }; }
    throw new Error(cmd);
  };
  const app = await toolFixture("close-occupied-process", { platform: "win32", deps: { child_process: { execFile: exec } } });
  try {
    assert.equal((await app.request("/api/kill", { mode: "port", value: 8080 })).ok, true);
    assert.deepEqual(calls.find(([cmd]) => cmd === "taskkill")[1], ["/PID", "30", "/F", "/T"]);
  } finally { app.close(); }
});

test("Linux 实机：按端口查找并结束测试专用父子进程", { skip: process.platform !== "linux", timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ["-e", `
    const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const s=require('net').createServer(); s.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:s.address().port,child:c.pid})));
    process.on('SIGTERM',()=>{});
  `], { stdio: ["ignore", "pipe", "inherit"] });
  let info;
  child.stdout.on("data", (d) => { try { info = JSON.parse(d.toString()); } catch {} });
  const api = createLinuxProcesses();
  try {
    await until(() => info);
    assert((await api.findPidsByPort(info.port)).some((m) => m.pid === child.pid));
    await api.killProcess(child.pid, "test-node");
    assert.equal(await api.getProcessName(info.child), null);
  } finally { try { child.kill("SIGKILL"); } catch {} if (info) { try { process.kill(info.child, "SIGKILL"); } catch {} } }
});

test("Windows 实机：通过工具 HTTP 接口结束测试专用进程树", { skip: process.platform !== "win32", timeout: 30000 }, async () => {
  const listener = spawn(process.execPath, ["-e", `
    const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:s.address().port,child:c.pid})));
  `], { windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
  let target, port;
  listener.stdout.on("data", (data) => { try { target = JSON.parse(data.toString()); } catch {} });
  // 使用本机空闲端口，只启动当前测试的工具实例。
  const net = await import("node:net");
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const toolPort = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const tool = spawn(process.execPath, [path.join(ROOT, "example/close-occupied-process/app.js")], {
    env: { ...process.env, TOOL_PORT: String(toolPort), TOOL_RUNTIME: path.join(ROOT, "src-tauri/resources/runtime/runtime.js") },
    windowsHide: true, stdio: ["ignore", "pipe", "inherit"],
  });
  tool.stdout.on("data", (data) => { if (data.toString().includes("listening")) port = toolPort; });
  try {
    await until(() => target && port);
    const response = await fetch(`http://127.0.0.1:${port}/api/kill`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "port", value: target.port }), signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert(result.killed.some((p) => p.pid === listener.pid));
    for (const pid of [listener.pid, target.child]) {
      await until(() => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === "ESRCH"; } });
    }
  } finally {
    tool.kill();
    try { listener.kill(); } catch {}
    if (target) { try { process.kill(target.child, "SIGKILL"); } catch {} }
  }
});
