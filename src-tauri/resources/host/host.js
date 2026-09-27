#!/usr/bin/env node
/**
 * 工具宿主进程 —— 由 Tauri 通过 sidecar(node.exe) 启动。
 *
 * 职责：
 *  1. 扫描并注册 toolbox/ 下的工具（含 manifest.json 的目录）
 *  2. 以"独立进程 + 独立端口"运行工具，捕获日志（环形缓冲 + 落盘）
 *  3. 在工具目录执行 npm install / uninstall，维护工具依赖
 *
 * 命令行参数（由 Rust 端传入）：
 *  --data-dir  <dir>   用户数据目录（toolbox、logs、host-state.json 所在）
 *  --runtime   <dir>   resources/runtime（注入给工具进程的运行时帮助库）
 *  --npm-cli   <file>  resources/npm/bin/npm-cli.js（npm 执行入口）
 */

"use strict";

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const net = require("net");
const { spawn, execFile, execFileSync } = require("child_process");

// ------------------------------------------------------------------ args
function parseArgs(argv) {
  const out = { port: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        out[key] = val;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const DATA_DIR = path.resolve(ARGS["data-dir"] || ".");
const RUNTIME_DIR = path.resolve(ARGS["runtime"] || "");
const NPM_CLI = path.resolve(ARGS["npm-cli"] || "");
const TEMPLATES_DIR = path.resolve(ARGS["templates"] || "");

const TOOLBOX_DIR = path.join(DATA_DIR, "toolbox");
const LOGS_DIR = path.join(DATA_DIR, "logs");
const STATE_FILE = path.join(DATA_DIR, "host-state.json");

const ID_RE = /^[a-z0-9_-]+$/;
const PORT_RANGE = [30000, 40000];

// ------------------------------------------------------------------ utils
function timestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(msg) {
  process.stdout.write(`[host ${timestamp()}] ${msg}\n`);
}

/** 内存环形日志缓冲 */
function makeRingBuffer(max = 2000) {
  const buf = [];
  let total = 0;
  return {
    push(chunk) {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.length) {
          buf.push(line);
          if (buf.length > max) buf.shift();
          total++;
        }
      }
    },
    lines() {
      return buf.slice();
    },
    total,
  };
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/** 探测端口是否已在监听（短连接，成功即关） */
function isPortListening(port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port }, () => {
      try { sock.destroy(); } catch { /* 忽略 */ }
      resolve(true);
    });
    const done = (v) => {
      try { sock.destroy(); } catch { /* 忽略 */ }
      resolve(v);
    };
    sock.once("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

/** 等待工具真正开始监听（轮询 TCP，默认最多 4 秒）；进程中途退出直接返回 false */
async function waitForListen(port, proc, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode != null) return false;
    if (await isPortListening(port, 200)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (proc.exitCode != null) return false;
  return isPortListening(port, 300);
}

/** 随机端口池 */
class PortPool {
  constructor(range) {
    this.start = range[0];
    this.end = range[1];
    this.used = new Set();
  }
  async acquire(prefer) {
    if (prefer) {
      if (!this.used.has(prefer) && (await isPortFree(prefer))) {
        this.used.add(prefer);
        return prefer;
      }
      throw new Error(`端口 ${prefer} 已被占用`);
    }
    for (let i = 0; i < 200; i++) {
      const p =
        this.start + Math.floor(Math.random() * (this.end - this.start));
      if (this.used.has(p)) continue;
      this.used.add(p); // 先同步占位：await 期间别的并发分配看得到，不会撞车
      if (await isPortFree(p)) {
        return p;
      }
      this.used.delete(p);
    }
    throw new Error("无法分配空闲端口");
  }
  release(port) {
    this.used.delete(port);
  }
}

const pool = new PortPool(PORT_RANGE);

/** 终止进程树（Windows 下用 taskkill 保证子进程一并结束；隐藏控制台避免弹黑框） */
function killTree(pid, cb) {
  execFile(
    "taskkill",
    ["/pid", String(pid), "/T", "/F"],
    { windowsHide: true },
    () => cb && cb(),
  );
}

// ------------------------------------------------------------------ tools
/** 运行中的工具状态表 */
const runtimes = new Map(); // id -> { proc, port, ring, logFile, startedAt }

async function ensureDirs() {
  await fsp.mkdir(TOOLBOX_DIR, { recursive: true });
  await fsp.mkdir(LOGS_DIR, { recursive: true });
  // 让 data 目录下（含 toolbox 的用户工具）的 JS 按 CommonJS 解析，
  // 避免项目根 package.json 的 "type":"module" 影响用户工具脚本。
  const pkgFile = path.join(DATA_DIR, "package.json");
  if (!fs.existsSync(pkgFile)) {
    await fsp.writeFile(pkgFile, JSON.stringify({ type: "commonjs" }, null, 2));
  }
}

/** 读取工具排序文件 _order.json（数组，缺省空） */
async function readOrder() {
  try {
    const raw = await fsp.readFile(
      path.join(TOOLBOX_DIR, "_order.json"),
      "utf8",
    );
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 递归复制模板目录并替换 __ID__ / __NAME__ 占位符 */
async function copyTemplateDir(src, dst, id, name) {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      await copyTemplateDir(s, d, id, name);
    } else {
      let content = await fsp.readFile(s, "utf8");
      content = content.replace(/__ID__/g, id).replace(/__NAME__/g, name);
      await fsp.writeFile(d, content);
    }
  }
}

/** 首次启动时从内置模板播种示例工具。
 *  用 _seeded.json 标记保证只播种一次：删掉示例后不会再生。 */
async function seedExampleTools() {
  if (!TEMPLATES_DIR || !fs.existsSync(TEMPLATES_DIR)) return;
  const marker = path.join(TOOLBOX_DIR, "_seeded.json");
  if (fs.existsSync(marker)) return;

  const examples = [
    { id: "json-formatter", name: "JSON 格式化" },
    { id: "regex-test", name: "正则测试" },
  ];
  for (const ex of examples) {
    const src = path.join(TEMPLATES_DIR, ex.id);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(TOOLBOX_DIR, ex.id);
    if (fs.existsSync(dst)) continue;
    try {
      await copyTemplateDir(src, dst, ex.id, ex.name);
      log(`已从模板创建示例工具 ${ex.id}`);
    } catch (e) {
      log(`创建示例工具 ${ex.id} 失败: ${e.message}`);
    }
  }
  try {
    await fsp.writeFile(marker, JSON.stringify({ seededAt: timestamp() }, null, 2));
  } catch (e) {
    log(`写入播种标记失败: ${e.message}`);
  }
}

/** 读取并校验一个工具的 manifest，返回 { manifest } 或 { error } */
async function loadManifest(id) {
  const dir = path.join(TOOLBOX_DIR, id);
  const file = path.join(dir, "manifest.json");
  const raw = await fsp.readFile(file, "utf8").catch(() => null);
  if (raw == null) return { error: "缺少 manifest.json" };

  let m;
  try {
    m = JSON.parse(raw);
  } catch (e) {
    return { error: "manifest.json 解析失败: " + e.message };
  }

  const errs = [];
  if (!ID_RE.test(id)) errs.push("id 非法（仅允许小写字母/数字/-/_）");
  if (!m.name) errs.push("缺少 name");
  const mainPath = path.join(dir, m.main || "");
  const htmlPath = path.join(dir, m.html || "");
  if (!m.main || !fs.existsSync(mainPath))
    errs.push(`main 不存在: ${m.main || "(未填写)"}`);
  if (!m.html || !fs.existsSync(htmlPath))
    errs.push(`html 不存在: ${m.html || "(未填写)"}`);
  if (errs.length) return { error: errs.join("; ") };

  return {
    manifest: {
      id,
      name: m.name,
      version: m.version || "0.0.1",
      description: m.description || "",
      icon: m.icon || null,
      main: m.main,
      html: m.html,
      port: m.port || 0,
      autoStart: m.autoStart === true,
      shortcuts: Array.isArray(m.shortcuts) ? m.shortcuts : [],
      panels: Array.isArray(m.panels) ? m.panels : [],
    },
  };
}

/** 扫描 toolbox，返回工具列表（含配置错误项） */
async function scanTools() {
  let entries;
  try {
    entries = await fsp.readdir(TOOLBOX_DIR, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const list = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith("_") || e.name.startsWith("."))
      continue;
    if (!ID_RE.test(e.name)) continue;
    const loaded = await loadManifest(e.name);
    if (loaded.manifest) {
      list.push(loaded.manifest);
    } else {
      list.push({
        id: e.name,
        name: e.name,
        version: "",
        description: "",
        icon: null,
        main: "",
        html: "",
        port: 0,
        error: loaded.error,
      });
    }
  }
  // 按 _order.json 中的顺序排序（未在其中的排在后面）
  const order = await readOrder();
  list.sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  return list;
}

function getStatus(id) {
  const r = runtimes.get(id);
  const base = {
    id,
    port: r ? r.port : null,
    pid: r ? r.proc.pid : null,
  };
  return { ...base, status: r ? "running" : "stopped" };
}

async function listTools() {
  const list = await scanTools();
  return list.map((m) => {
    const r = runtimes.get(m.id);
    return {
      ...m,
      status: m.error ? "error" : r ? "running" : "stopped",
      port: r ? r.port : null,
      pid: r ? r.proc.pid : null,
    };
  });
}

async function startTool(id) {
  const loaded = await loadManifest(id);
  if (loaded.error) throw new Error(loaded.error);
  if (runtimes.has(id)) return { id, ...getStatus(id), ...loaded.manifest };

  const m = loaded.manifest;
  const toolDir = path.join(TOOLBOX_DIR, id);
  const port = await pool.acquire(m.port);

  const proc = spawn(process.execPath, [path.join(toolDir, m.main)], {
    cwd: toolDir,
    env: {
      ...process.env,
      TOOL_ID: id,
      TOOL_PORT: String(port),
      TOOL_DIR: toolDir,
      // 直接指向 runtime.js 文件，`require(process.env.TOOL_RUNTIME)` 即加载运行时
      TOOL_RUNTIME: path.join(RUNTIME_DIR, "runtime.js"),
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const ring = makeRingBuffer();
  const logFile = path.join(LOGS_DIR, `${id}.log`);
  const state = { proc, port, ring, logFile, startedAt: Date.now() };
  runtimes.set(id, state);

  const onData = (chunk) => {
    ring.push(chunk);
    fsp.appendFile(logFile, chunk).catch(() => {});
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  proc.on("exit", (code, signal) => {
    ring.push(`[host] 进程退出 code=${code} signal=${signal}`);
    pool.release(port);
    if (runtimes.get(id) === state) runtimes.delete(id);
  });
  proc.on("error", (err) => {
    ring.push(`[host] 进程错误: ${err.message}`);
  });

  // 短暂等待，检测启动即崩溃
  await new Promise((r) => setTimeout(r, 300));
  if (proc.exitCode != null) {
    runtimes.delete(id);
    pool.release(port);
    throw new Error(
      `工具启动后立即退出：\n${ring.lines().slice(-8).join("\n")}`,
    );
  }

  // 回探测：确认端口真的在监听。300ms 时进程活着不代表监听成功
  //（EADDRINUSE、启动后异步崩溃都会造成“假 running”，前端 iframe 打不开、
  // 卡在“准备就绪”直到手动重载）。失败则清理并直接报错，由前端自动重试。
  if (!(await waitForListen(port, proc, 4000))) {
    runtimes.delete(id);
    pool.release(port);
    killTree(proc.pid);
    throw new Error(
      `工具未能正常监听端口 ${port}（进程可能已退出）：\n${ring.lines().slice(-8).join("\n")}`,
    );
  }

  log(`工具已启动 id=${id} pid=${proc.pid} port=${port}`);
  return { ...m, ...getStatus(id) };
}

async function stopTool(id) {
  const state = runtimes.get(id);
  if (!state) return;
  runtimes.delete(id);
  killTree(state.proc.pid);
  pool.release(state.port);
  log(`工具已停止 id=${id}`);
}

// ------------------------------------------------------------------ npm
function runNpm(cwd, args) {
  return new Promise((resolve, reject) => {
    if (!NPM_CLI || !fs.existsSync(NPM_CLI)) {
      return reject(new Error("npm 运行时未打包（缺少 npm-cli.js）"));
    }
    log(`npm ${args.join(" ")} in ${cwd}`);
    const proc = spawn(process.execPath, [NPM_CLI, ...args], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (d) => {
      const s = String(d);
      out += s;
      process.stdout.write(s);
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`npm 退出码 ${code}\n${out.slice(-1500)}`));
    });
  });
}

/** 确保工具目录有自己的 package.json（npm 在无 package.json 的目录会向上查找
 *  最近的 package.json 作为项目根，导致包装错位置） */
async function ensureToolPackageJson(toolDir, manifest) {
  const pkgFile = path.join(toolDir, "package.json");
  if (!fs.existsSync(pkgFile)) {
    await fsp.writeFile(
      pkgFile,
      JSON.stringify(
        {
          name: manifest.id,
          version: manifest.version || "0.1.0",
          private: true,
          main: manifest.main || "app.js",
        },
        null,
        2,
      ),
    );
  }
}

async function installPackage(id, pkg, version) {
  const loaded = await loadManifest(id);
  if (loaded.error) throw new Error(loaded.error);
  const toolDir = path.join(TOOLBOX_DIR, id);
  await ensureToolPackageJson(toolDir, loaded.manifest);
  const spec = version ? `${pkg}@${version}` : pkg;
  await runNpm(toolDir, ["install", spec, "--no-audit", "--no-fund"]);
}

async function uninstallPackage(id, pkg) {
  const loaded = await loadManifest(id);
  if (loaded.error) throw new Error(loaded.error);
  const toolDir = path.join(TOOLBOX_DIR, id);
  await ensureToolPackageJson(toolDir, loaded.manifest);
  await runNpm(toolDir, ["uninstall", pkg, "--no-audit"]);
}

async function listPackages(id) {
  const pkgFile = path.join(TOOLBOX_DIR, id, "package.json");
  const raw = await fsp.readFile(pkgFile, "utf8").catch(() => "{}");
  let pkg = {};
  try {
    pkg = JSON.parse(raw);
  } catch {
    /* 忽略损坏的 package.json */
  }
  const deps = pkg.dependencies || {};
  const dev = pkg.devDependencies || {};
  return Object.entries(deps)
    .map(([name, ver]) => ({ name, version: ver, dev: false }))
    .concat(
      Object.entries(dev).map(([name, ver]) => ({
        name,
        version: ver,
        dev: true,
      })),
    );
}

// ------------------------------------------------------------------ http
function send(res, body) {
  if (res.writableEnded) return; // 防御：避免 headers already sent 导致宿主崩溃
  const text = JSON.stringify(body);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const seg = url.pathname.split("/").filter(Boolean);
  const method = req.method;

  try {
    // GET /health —— 宿主存活探针（供 Rust 端健康检查 / 自愈）
    if (method === "GET" && seg[0] === "health") {
      return send(res, { ok: true, data: { status: "up", pid: process.pid } });
    }

    // GET /tools
    if (method === "GET" && seg[0] === "tools" && seg.length === 1) {
      return send(res, { ok: true, data: await listTools() });
    }

    // GET /tools/:id
    if (method === "GET" && seg[0] === "tools" && seg.length === 2) {
      const loaded = await loadManifest(seg[1]);
      if (loaded.error) return send(res, { ok: true, data: { id: seg[1], status: "error", error: loaded.error } });
      return send(res, { ok: true, data: { ...loaded.manifest, ...getStatus(seg[1]) } });
    }

    // GET /tools/:id/logs
    if (method === "GET" && seg[0] === "tools" && seg.length === 3 && seg[2] === "logs") {
      const r = runtimes.get(seg[1]);
      return send(res, { ok: true, data: r ? r.ring.lines() : [] });
    }

    // POST /shutdown —— 宿主优雅退出（供 Rust 应用退出时调用）
    if (method === "POST" && seg[0] === "shutdown") {
      send(res, { ok: true, data: "bye" });
      setTimeout(shutdown, 100);
      return;
    }

    // POST /tools/:id/shortcut —— 平台把全局快捷键事件转发给运行中的工具进程
    if (
      method === "POST" &&
      seg[0] === "tools" &&
      seg.length === 3 &&
      seg[2] === "shortcut"
    ) {
      const r = runtimes.get(seg[1]);
      if (!r) return send(res, { ok: false, error: "工具未运行" });
      const bodyText = await new Promise((resolve) => {
        let d = "";
        req.on("data", (c) => (d += c));
        req.on("end", () => resolve(d));
      });
      let body = {};
      try {
        body = JSON.parse(bodyText || "{}");
      } catch {
        /* 忽略 */
      }
      const forward = await new Promise((resolve) => {
        const p = http.request(
          {
            host: "127.0.0.1",
            port: r.port,
            path: "/__platform/shortcut",
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (resp) => {
            let data = "";
            resp.on("data", (c) => (data += c));
            resp.on("end", () => resolve({ status: resp.statusCode, data }));
          },
        );
        p.on("error", () => resolve({ status: 0, data: "forward-failed" }));
        p.write(JSON.stringify(body));
        p.end();
      });
      return send(res, {
        ok: forward.status >= 200 && forward.status < 300,
        data: { forwarded: forward },
      });
    }

    // POST /tools/:id/start | /tools/:id/stop
    if (method === "POST" && seg[0] === "tools" && seg.length === 3) {
      const id = seg[1];
      if (seg[2] === "start") return send(res, { ok: true, data: await startTool(id) });
      if (seg[2] === "stop") {
        await stopTool(id);
        return send(res, { ok: true, data: { id, status: "stopped" } });
      }
    }

    // POST /packages/:id/install   body: { pkg, version? }
    // POST /packages/:id/uninstall body: { pkg }
    // GET  /packages/:id
    if (seg[0] === "packages" && seg.length === 2 && method === "GET") {
      return send(res, { ok: true, data: await listPackages(seg[1]) });
    }
    if (seg[0] === "packages" && seg.length === 3 && method === "POST") {
      const id = seg[1];
      const action = seg[2];
      const bodyText = await new Promise((resolve) => {
        let d = "";
        req.on("data", (c) => (d += c));
        req.on("end", () => resolve(d));
      });
      let body = {};
      try {
        body = JSON.parse(bodyText || "{}");
      } catch {
        /* 忽略 */
      }
      if (action === "install") {
        if (!body.pkg) return send(res, { ok: false, error: "缺少 pkg" });
        await installPackage(id, body.pkg, body.version);
        return send(res, { ok: true, data: await listPackages(id) });
      }
      if (action === "uninstall") {
        if (!body.pkg) return send(res, { ok: false, error: "缺少 pkg" });
        await uninstallPackage(id, body.pkg);
        return send(res, { ok: true, data: await listPackages(id) });
      }
    }

    send(res, { ok: false, error: `未支持的路由: ${method} ${url.pathname}` });
  } catch (e) {
    send(res, { ok: false, error: e.message });
  }
}

// ------------------------------------------------------------------ main
async function main() {
  await ensureDirs();
  await seedExampleTools();

  // 自拉起 autoStart 标记的后台常驻工具（best-effort，失败仅记录日志）
  const all = await scanTools();
  for (const m of all) {
    if (m.autoStart) {
      try {
        await startTool(m.id);
      } catch (e) {
        log(`自启动工具 ${m.id} 失败: ${e.message}`);
      }
    }
  }

  const server = http.createServer(handle);
  await new Promise((r) => server.listen(ARGS.port || 0, "127.0.0.1", r));
  const hostPort = server.address().port;

  await fsp.writeFile(
    STATE_FILE,
    JSON.stringify(
      { pid: process.pid, hostPort, nodeVersion: process.version, startedAt: timestamp() },
      null,
      2,
    ),
  );

  log(`宿主已启动 pid=${process.pid} port=${hostPort}`);
  log(`toolbox=${TOOLBOX_DIR}`);
  log(`runtime=${RUNTIME_DIR}`);
  log(`npm-cli=${NPM_CLI}`);

  const shutdown = () => {
    log("正在关闭，终止全部工具进程...");
    for (const [, state] of runtimes) {
      try {
        execFileSync("taskkill", ["/pid", String(state.proc.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        /* 进程已不存在 */
      }
      pool.release(state.port);
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error("[host] 启动失败:", e);
  process.exit(1);
});
