#!/usr/bin/env node
// 实际启动宿主和两层工具进程，验证停止/退出清理及离线 npm 安装。
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, message) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (value) return value;
    await wait(100);
  }
  throw new Error(message);
}
function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

test("Linux 打包资源覆盖完整，Windows 继续包含内置 Node/npm", () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json")));
  const linux = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri/tauri.linux.conf.json")));
  assert(base.bundle.resources.includes("resources/bin/node.exe"));
  assert(base.bundle.resources.includes("resources/npm/**/*"));
  for (const resource of ["host/**/*", "runtime/**/*", "templates/**/*", "package.json"]) {
    assert(linux.bundle.resources.includes(`resources/${resource}`));
  }
  assert(!linux.bundle.resources.some((r) => /node\.exe|\/npm\//.test(r)));
  assert(linux.bundle.linux.deb.depends.includes("npm"));
});

test("真实工具进程树在停止和宿主退出后释放端口，npm 可安装本地包", {
  timeout: 90000,
}, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "platform-test-"));
  const dir = path.join(data, "toolbox/tree-tool");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    id: "tree-tool", name: "Tree", main: "app.js", html: "index.html", port: 0,
  }));
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>Tree</h1>");
  fs.writeFileSync(path.join(dir, "app.js"), `
    const http = require('http');
    require('child_process').spawn(process.execPath, [require('path').join(__dirname, 'child.js')], {
      stdio: 'ignore', windowsHide: true,
    });
    http.createServer((q,s) => s.end('parent')).listen(process.env.TOOL_PORT, '127.0.0.1');
  `);
  fs.writeFileSync(path.join(dir, "child.js"), `
    const http = require('http');
    const server = http.createServer((q,s) => s.end('child'));
    // 忽略 SIGTERM，用于确认清理确实覆盖子进程而非只给父进程发信号。
    process.on('SIGTERM', () => {});
    server.listen(0, '127.0.0.1', () => require('fs').writeFileSync(
      require('path').join(__dirname, 'child.json'),
      JSON.stringify({port: server.address().port, pid: process.pid})
    ));
  `);
  const dep = path.join(data, "local-dependency");
  fs.mkdirSync(dep);
  fs.writeFileSync(path.join(dep, "package.json"), JSON.stringify({
    name: "platform-local-dependency", version: "1.0.0", main: "index.js",
  }));
  fs.writeFileSync(path.join(dep, "index.js"), "module.exports = 'installed';");

  const args = [path.join(ROOT, "src-tauri/resources/host/host.js"), "--data-dir", data];
  // Windows 走与发行版相同的 npm-cli 模式；Linux 不传此参数，验证系统 npm。
  if (process.platform === "win32") {
    args.push("--npm-cli", path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"));
  }
  const host = spawn(process.execPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(host, "exit");
  let output = "";
  host.stdout.on("data", (d) => { output += d; });
  host.stderr.on("data", (d) => { output += d; });
  let hp;
  const children = [];
  async function api(route, body) {
    const response = await fetch(`http://127.0.0.1:${hp}${route}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}), signal: AbortSignal.timeout(30000),
    });
    const json = await response.json();
    assert.equal(json.ok, true, JSON.stringify(json));
    return json.data;
  }
  async function start() {
    fs.rmSync(path.join(dir, "child.json"), { force: true });
    const tool = await api("/tools/tree-tool/start");
    children.push(tool.pid);
    const child = await until(() => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, "child.json"))); } catch { return null; }
    }, "子进程没有启动");
    children.push(child.pid);
    assert(await listening(child.port));
    return [tool.port, child.port];
  }
  async function assertClosed(ports) {
    for (const port of ports) {
      await until(async () => !(await listening(port)), `端口 ${port} 没有释放`);
    }
  }
  try {
    hp = await until(() => {
      try { return JSON.parse(fs.readFileSync(path.join(data, "host-state.json"))).hostPort; } catch { return null; }
    }, `宿主没有启动：${output}`);
    const installed = await api("/packages/tree-tool/install", { pkg: `file:${dep.replaceAll("\\", "/")}` });
    assert(installed.some((p) => p.name === "platform-local-dependency"));
    const value = execFileSync(process.execPath, ["-p", "require('platform-local-dependency')"], {
      cwd: dir, encoding: "utf8", windowsHide: true,
    });
    assert.equal(value.trim(), "installed");
    const removed = await api("/packages/tree-tool/uninstall", { pkg: "platform-local-dependency" });
    assert(!removed.some((p) => p.name === "platform-local-dependency"));

    const first = await start();
    await api("/tools/tree-tool/stop");
    await assertClosed(first);
    const second = await start();
    assert.equal(second[0], first[0], "停止后重启必须复用原端口");
    await api("/shutdown");
    await exited;
    await assertClosed(second);
    assert(!fs.existsSync(path.join(data, "host.lock")));
  } catch (e) {
    e.message += `\n宿主输出：\n${output}`;
    throw e;
  } finally {
    // 失败时只清理本测试记录的进程，不触碰用户的 Node/工具实例。
    if (host.exitCode == null && host.signalCode == null) host.kill();
    for (const pid of children) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    await Promise.race([exited, wait(2000)]);
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
