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
 *  --instance-id <id>  本次启动标识（Rust 生成，仅用于状态文件与日志可观测性）
 *
 * 单实例约束：同一 data-dir 只允许一个宿主存活（见 host.lock）。
 * 已有活着的宿主时，本进程会把它的端口写回 host-state.json 后立即退出，
 * 既不让 Rust 傻等超时，也避免多个宿主去绑同一批「记忆端口」而 EADDRINUSE。
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
/** 每个工具上次使用的端口（决定 origin，进而决定其 localStorage / IndexedDB 归属） */
const PORTS_FILE = path.join(DATA_DIR, "ports.json");
/** 被放弃的端口：上面的 localStorage / IndexedDB 已成残留，等端口空闲时清掉 */
const RESIDUALS_FILE = path.join(DATA_DIR, "residuals.json");
/** 清理页最多占用端口的时间，超时就释放、稍后重试 */
const CLEANUP_TIMEOUT_MS = 60 * 1000;
/** 一次清理未完成后的冷却时间，避免反复去占端口 */
const CLEANUP_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
/** 宿主单实例锁：{ pid, port, at, instanceId } —— 一个平台只准有一个宿主 */
const LOCK_FILE = path.join(DATA_DIR, "host.lock");
/** 锁里的宿主进程还在但不响应 /health 时，容忍多久再判定僵死并接管 */
const LOCK_GRACE_MS = 20 * 1000;
/** 本次启动标识（由 Rust 通过 --instance-id 传入） */
const INSTANCE_ID = String(
  ARGS["instance-id"] || `${process.pid}-${Date.now()}`,
);

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

// ---------------------------------------------- 宿主单实例锁（防多宿主抢端口）
/**
 * 背景：Rust 侧一旦因「握手文件陈旧」反复重启，就会开出多个宿主进程；
 * 它们各自 autoStart 同一批工具、去绑同一个记忆端口，只有第一个能绑上，
 * 其余 EADDRINUSE 崩溃 —— 界面上表现为「端口被占用，无法启动」。
 * 这里用 host.lock 把宿主数量收敛为 1。
 */
function pidAlive(pid) {
  const n = Number(pid) || 0;
  if (!n || n === process.pid) return false;
  try {
    process.kill(n, 0); // signal 0 只做存在性检查，Windows 同样适用
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** 探测某端口上的宿主是否真的在响应 */
function probeHealth(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = http.get(
      {
        host: "127.0.0.1",
        port: Number(port),
        path: "/health",
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        done(res.statusCode === 200);
      },
    );
    req.on("error", () => done(false));
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });
  });
}

async function readLock() {
  try {
    return JSON.parse(await fsp.readFile(LOCK_FILE, "utf8"));
  } catch {
    return null;
  }
}

/** 已有活着的宿主则返回 { pid, port }，否则 null（可安全接管） */
async function findLiveHost() {
  const info = await readLock();
  if (!info) return null;
  const pid = Number(info.pid) || 0;
  const port = Number(info.port) || 0;
  if (!pid || !port) return null;
  if (!pidAlive(pid)) {
    log(`发现残留锁（pid=${pid} 已不存在），直接接管`);
    return null;
  }
  if (await probeHealth(port)) return { pid, port };
  const age = Date.now() - (Number(info.at) || 0);
  if (age > LOCK_GRACE_MS) {
    log(
      `锁中宿主 pid=${pid} port=${port} 已僵死 ${Math.round(age / 1000)}s，接管`,
    );
    return null;
  }
  log(
    `锁中宿主 pid=${pid} port=${port} 暂未响应（${Math.round(age / 1000)}s），本进程让位`,
  );
  return { pid, port };
}

async function takeLock(port) {
  try {
    await fsp.writeFile(
      LOCK_FILE,
      JSON.stringify(
        { pid: process.pid, port, at: Date.now(), instanceId: INSTANCE_ID },
        null,
        2,
      ),
    );
  } catch (e) {
    log(`写入 host.lock 失败: ${e.message}`);
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    /* 锁文件不存在或已被清理 */
  }
}

/** 写握手文件；pid 可显式指定（让位场景写的是在跑宿主的 pid） */
async function writeState(port, pid) {
  try {
    await fsp.writeFile(
      STATE_FILE,
      JSON.stringify(
        {
          pid: pid || process.pid,
          hostPort: port,
          nodeVersion: process.version,
          instanceId: INSTANCE_ID,
          startedAt: timestamp(),
        },
        null,
        2,
      ),
    );
  } catch (e) {
    log(`写入 host-state.json 失败: ${e.message}`);
  }
}

/** 随机端口池 */
class PortPool {
  constructor(range) {
    this.start = range[0];
    this.end = range[1];
    this.used = new Set();
    /**
     * 已被其它工具「记住」的端口。随机分配时必须避开：
     * 否则 A 停止后它记住的端口会被 B 抢走，A 下次启动就只能换端口，
     * 进而换掉 origin —— 表现为 A 的本地存储"突然清空"。
     */
    this.reserved = new Set();
  }
  /** 刷新保留集合（由 portMap 驱动） */
  reserve(ports) {
    this.reserved = new Set(ports);
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
      if (this.reserved.has(p)) continue; // 留给记住它的那个工具
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
  /** 该端口是否正被平台上运行中的工具占用 */
  isUsed(port) {
    return this.used.has(port);
  }
}

const pool = new PortPool(PORT_RANGE);

/** 让端口池避开所有已被记住的端口（每次读写 ports.json 后调用） */
function syncReserved() {
  const ports = Object.values(portMap).map(Number).filter(Number.isFinite);
  // 正在清理的残留端口也一并避开，别把新工具分配到那儿去
  for (const p of claiming.keys()) ports.push(Number(p));
  pool.reserve(ports);
}

// ------------------------------------------------ 残留数据清理（被放弃的端口）
/**
 * 工具换了端口（用户确认「重新分配」）或被删除后，旧端口上的
 * localStorage / IndexedDB 就成了残留 —— 同源策略不允许从外部删除它。
 *
 * 办法是「把那个端口重新占下来」：一旦由我们自己监听该端口，
 * 就取得了那个 origin 的同源身份，可以在页面里清掉自己的数据。
 * 前提是该端口此刻空闲；被占用就先记下来，等以后空闲了再清。
 */
let residuals = []; // [{ toolId, port, at, retryAfter? }]
const claiming = new Map(); // port -> server（正在清理中的端口）

async function loadResiduals() {
  try {
    const raw = await fsp.readFile(RESIDUALS_FILE, "utf8");
    const arr = JSON.parse(raw);
    residuals = Array.isArray(arr) ? arr.filter((r) => Number(r.port)) : [];
  } catch {
    residuals = [];
  }
}

async function saveResiduals() {
  try {
    await fsp.writeFile(RESIDUALS_FILE, JSON.stringify(residuals, null, 2));
  } catch (e) {
    log(`写入 residuals.json 失败: ${e.message}`);
  }
}

/** 登记一个被放弃的端口（按端口去重） */
async function addResidual(toolId, port) {
  const p = Number(port) || 0;
  if (!p) return;
  if (residuals.some((r) => Number(r.port) === p)) return;
  residuals.push({ toolId: toolId || "", port: p, at: Date.now() });
  await saveResiduals();
  log(`已登记残留端口 ${p}（来自工具 ${toolId || "未知"}），等它空闲后清理`);
}

/**
 * 清理页：运行在那个「被放弃的 origin」下，因此有权限删掉自己的数据。
 * 清完回报宿主，宿主随即关闭这个临时服务。
 */
const CLEANUP_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>清理残留数据</title></head>
<body>
<script>
(async () => {
  const report = {};
  try { localStorage.clear(); report.localStorage = "cleared"; } catch (e) { report.localStorage = String(e); }
  try { sessionStorage.clear(); } catch (e) { /* 忽略 */ }
  try {
    if (self.indexedDB && indexedDB.databases) {
      const dbs = await indexedDB.databases();
      report.indexedDB = dbs.length;
      await Promise.all(dbs.map((d) => new Promise((res) => {
        if (!d || !d.name) return res();
        const q = indexedDB.deleteDatabase(d.name);
        q.onsuccess = q.onerror = q.onblocked = () => res();
      })));
    }
  } catch (e) { report.indexedDB = String(e); }
  try {
    if (self.caches) {
      const keys = await caches.keys();
      report.caches = keys.length;
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (e) { /* 忽略 */ }
  try {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch (e) { /* 忽略 */ }
  try {
    await fetch("/__residual-done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
  } catch (e) { /* 宿主可能已关闭，忽略 */ }
})();
<\/script>
</body></html>`;

/** 结束一次清理：关闭临时服务；成功则从残留名单移除，失败则进入冷却 */
function finishCleanup(port, server, ok) {
  const p = Number(port);
  clearTimeout(server._cleanupTimer);
  claiming.delete(p);
  try {
    server.close();
  } catch {
    /* 忽略 */
  }
  if (ok) {
    residuals = residuals.filter((r) => Number(r.port) !== p);
    saveResiduals();
    log(`已清理端口 ${p} 上的残留数据`);
  } else {
    const r = residuals.find((x) => Number(x.port) === p);
    if (r) {
      r.retryAfter = Date.now() + CLEANUP_RETRY_COOLDOWN_MS;
      saveResiduals();
    }
    log(`端口 ${p} 的残留清理未完成，${CLEANUP_RETRY_COOLDOWN_MS / 60000} 分钟后再试`);
  }
  syncReserved();
}

/** 占下一个空闲端口并用它托管清理页 */
function claimPortForCleanup(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let pathname = "/";
      try {
        pathname = new URL(req.url, "http://localhost").pathname;
      } catch {
        /* 忽略 */
      }
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(CLEANUP_HTML);
        return;
      }
      if (req.method === "POST" && pathname === "/__residual-done") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        setTimeout(() => finishCleanup(port, server, true), 50);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      claiming.set(port, server);
      // 兜底：页面万一没能回报，也不能让这个端口被长期占住
      server._cleanupTimer = setTimeout(
        () => finishCleanup(port, server, false),
        CLEANUP_TIMEOUT_MS,
      );
      syncReserved();
      resolve();
    });
  });
}

/**
 * 残留清单的可视化视图：为每条记录附上「当前状态」，
 * 界面据此说明它大概什么时候会被清理。
 */
async function residualsView() {
  const now = Date.now();
  const out = [];
  for (const r of residuals) {
    const p = Number(r.port) || 0;
    let state;
    if (claiming.has(p)) state = "cleaning";
    else if (pool.isUsed(p)) state = "busy-tool"; // 被运行中的工具占用
    else if (r.retryAfter && r.retryAfter > now) state = "cooldown";
    else if (await isPortFree(p)) state = "ready"; // 下次扫描就能清
    else state = "busy-external"; // 被平台外的程序占用
    out.push({
      toolId: r.toolId || "",
      port: p,
      at: r.at || 0,
      state,
      retryAfter: r.retryAfter || 0,
    });
  }
  return out;
}

/**
 * 挑出「此刻空闲」的残留端口占下来，返回需要界面加载清理页的端口列表。
 * 界面必须为每个端口渲染一次隐藏 iframe —— 清理页得真正在那个 origin 下执行。
 * force=true 时忽略冷却时间（用户手动点了「立即清理」）。
 */
async function sweepResiduals(force) {
  const claimed = [];
  const now = Date.now();
  for (const r of [...residuals]) {
    const p = Number(r.port) || 0;
    if (!p) continue;
    if (!force && r.retryAfter && r.retryAfter > now) continue;
    if (claiming.has(p)) {
      claimed.push(p); // 上一轮已占下、还没清完
      continue;
    }
    if (pool.isUsed(p)) continue; // 正被运行中的工具占用
    if (!(await isPortFree(p))) continue; // 被平台外的程序占用
    try {
      await claimPortForCleanup(p);
      claimed.push(p);
    } catch {
      // 刚好被别人抢先，下次再试
    }
  }
  return claimed;
}

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

/**
 * 优雅退出：先终止全部工具进程再退出。
 * 必须定义在模块作用域 —— HTTP 路由 handle() 与信号处理都要用，
 * 之前定义在 main() 内部导致 POST /shutdown 抛 ReferenceError、宿主杀不掉。
 */
function shutdown() {
  log("正在关闭，终止全部工具进程...");
  for (const [, state] of runtimes) {
    if (state.server) {
      // 静态工具：服务跑在宿主进程内，随进程一起退出，显式 close 更干净
      try {
        state.server.close();
      } catch {
        /* 忽略 */
      }
    } else if (state.proc) {
      try {
        execFileSync("taskkill", ["/pid", String(state.proc.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        /* 进程已不存在 */
      }
    }
    pool.release(state.port);
  }
  releaseLock(); // 释放单实例锁，让下一次启动能正常接管
  process.exit(0);
}

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

// ------------------------------------------------------- 端口记忆（存储归属）
/**
 * 端口决定工具页面的 origin（http://127.0.0.1:<port>），而 origin 决定浏览器
 * 把 localStorage / IndexedDB 放在哪个桶里。所以端口必须跨重启保持稳定，
 * 否则每次启动工具都"看不到"上次的数据。
 */
let portMap = {};

async function loadPorts() {
  try {
    const raw = await fsp.readFile(PORTS_FILE, "utf8");
    const obj = JSON.parse(raw);
    portMap = obj && typeof obj === "object" ? obj : {};
  } catch {
    portMap = {};
  }
  syncReserved();
}

async function savePorts() {
  try {
    await fsp.writeFile(PORTS_FILE, JSON.stringify(portMap, null, 2));
  } catch (e) {
    log(`写入 ports.json 失败: ${e.message}`);
  }
  syncReserved();
}

// ------------------------------------------------------- URL 工具（type: "url"）
/**
 * 校验 URL 工具地址：允许 https:// 任意主机；
 * http:// 仅限本机回环地址（127.0.0.1 / localhost / [::1]）。
 * @returns {string|null} 错误信息，null 表示通过
 */
function validateToolUrl(url) {
  if (typeof url !== "string" || !url.trim()) return "缺少 url";
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return `url 格式非法: ${url}`;
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
      return null;
    }
    return "http:// 仅允许本机回环地址（127.0.0.1 / localhost）";
  }
  return "仅支持 http:// 或 https:// 地址";
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

/**
 * 目录里没有 manifest.json 时的兜底。
 *
 * 直接把网页文件夹丢进 toolbox/ 是很自然的用法，不该只报一个看不懂的错。
 * 只要目录里有 index.html，就自动按「本地网页工具」接管，并把生成的
 * manifest.json 落盘 —— 这样它同时也是显式的、可以在编辑器里改的。
 */
async function adoptAsStaticTool(id, dir) {
  if (!fs.existsSync(path.join(dir, "index.html"))) return null;

  const manifest = {
    id,
    name: id,
    version: "1.0.0",
    description: "自动识别：目录内含 index.html，已按本地网页工具接管",
    icon: "📄",
    type: "static",
    html: "index.html",
    port: 0,
  };
  try {
    await fsp.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    log(`工具 ${id} 没有 manifest.json，已按本地网页工具自动接管并生成清单`);
  } catch (e) {
    log(`为 ${id} 自动生成 manifest.json 失败: ${e.message}`);
  }

  return {
    ...manifest,
    url: null,
    main: "",
    autoStart: false,
    shortcuts: [],
    panels: [],
  };
}

/** 读取并校验一个工具的 manifest，返回 { manifest } 或 { error } */
async function loadManifest(id) {
  const dir = path.join(TOOLBOX_DIR, id);
  const file = path.join(dir, "manifest.json");
  const raw = await fsp.readFile(file, "utf8").catch(() => null);

  if (raw == null) {
    const adopted = await adoptAsStaticTool(id, dir);
    if (adopted) return { manifest: adopted };
    return {
      error:
        "缺少 manifest.json（目录里也没有 index.html，无法自动识别为网页工具；" +
        "可以用「添加工具 → 本地网页」导入）",
      type: "local",
      name: id,
    };
  }

  let m;
  try {
    m = JSON.parse(raw);
  } catch (e) {
    return { error: "manifest.json 解析失败: " + e.message };
  }

  const errs = [];
  if (!ID_RE.test(id)) errs.push("id 非法（仅允许小写字母/数字/-/_）");
  if (!m.name) errs.push("缺少 name");

  const type = m.type === "url" ? "url" : m.type === "static" ? "static" : "local";
  const base = {
    id,
    name: m.name,
    version: m.version || "0.0.1",
    description: m.description || "",
    icon: m.icon || null,
    type,
  };

  // URL 工具：没有 main / html，只校验地址本身
  if (type === "url") {
    const urlErr = validateToolUrl(m.url);
    if (urlErr) errs.push(urlErr);
    if (errs.length)
      return { error: errs.join("; "), type, url: m.url || null, name: m.name || "" };
    return {
      manifest: {
        ...base,
        url: m.url.trim(),
        main: "",
        html: "",
        port: 0,
        autoStart: false,
        shortcuts: [],
        panels: [],
      },
    };
  }

  // 本地网页工具：没有 Node 后端，只要有一个入口页面，
  // 由宿主用内置静态服务在分配到的端口上托管。
  if (type === "static") {
    const entry = (m.html || "index.html").trim();
    if (entry.includes("..") || path.isAbsolute(entry)) {
      errs.push("html 必须是工具目录内的相对路径");
    } else if (!fs.existsSync(path.join(dir, entry))) {
      errs.push(`入口页面不存在: ${entry}`);
    }
    if (errs.length)
      return { error: errs.join("; "), type, url: null, name: m.name || "" };
    return {
      manifest: {
        ...base,
        url: null,
        main: "",
        html: entry,
        port: m.port || 0,
        autoStart: m.autoStart === true,
        shortcuts: [],
        panels: [],
      },
    };
  }

  const mainPath = path.join(dir, m.main || "");
  const htmlPath = path.join(dir, m.html || "");
  if (!m.main || !fs.existsSync(mainPath))
    errs.push(`main 不存在: ${m.main || "(未填写)"}`);
  if (!m.html || !fs.existsSync(htmlPath))
    errs.push(`html 不存在: ${m.html || "(未填写)"}`);
  if (errs.length)
    return { error: errs.join("; "), type, url: null, name: m.name || "" };

  return {
    manifest: {
      ...base,
      url: null,
      main: m.main,
      html: m.html,
      port: m.port || 0,
      autoStart: m.autoStart === true,
      shortcuts: Array.isArray(m.shortcuts) ? m.shortcuts : [],
      panels: Array.isArray(m.panels) ? m.panels : [],
    },
  };
}

/** 统一计算工具运行状态：URL 工具不跑进程，恒定可用 */
function statusOf(m) {
  if (m.type === "url") {
    return { id: m.id, port: null, pid: null, status: "running" };
  }
  const r = runtimes.get(m.id);
  return {
    id: m.id,
    port: r ? r.port : null,
    // 静态工具没有子进程（服务跑在宿主进程内），pid 为 null
    pid: r && r.proc ? r.proc.pid : null,
    status: r ? "running" : "stopped",
  };
}

// ------------------------------------------------ 静态工具（type: "static"）
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
};

/**
 * 为静态工具建一个只读静态文件服务（跑在宿主进程内，不 spawn 子进程）。
 * 监听端口由端口池分配，因此 origin 固定 → 工具的 localStorage / IndexedDB 可持久。
 */
function createStaticServer(toolDir, entry) {
  const root = path.resolve(toolDir);
  return http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }
    if (rel === "/" || rel.endsWith("/")) rel += entry;
    const target = path.resolve(root, "." + rel);
    // 防目录穿越
    if (target !== root && !target.startsWith(root + path.sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.readFile(target, (err, buf) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 Not Found");
        return;
      }
      res.writeHead(200, {
        "Content-Type":
          MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
        // 不缓存：改了工具目录里的文件，刷新页面即可生效
        "Cache-Control": "no-store",
      });
      res.end(buf);
    });
  });
}

/**
 * 端口决策（URL 工具以外的所有工具共用）。
 * 返回 { port } 或 { pending: "portBusy", ... }。
 */
async function resolveToolPort(id, m, reassignPort) {
  // manifest 显式指定的端口：语义就是"必须用这个"，占用则直接报错
  if (m.port) return { port: await pool.acquire(m.port) };

  const remembered = Number(portMap[id]) || 0;
  if (remembered && !reassignPort) {
    const byTool = pool.isUsed(remembered);
    if (byTool || !(await isPortFree(remembered))) {
      log(
        `工具 ${id} 的记忆端口 ${remembered} 被占用` +
          `（${byTool ? "另一个运行中的工具" : "系统上的其它程序"}），等待用户决定`,
      );
      return {
        pending: "portBusy",
        id,
        name: m.name,
        port: remembered,
        occupiedBy: byTool ? "tool" : "other",
      };
    }
    return { port: await pool.acquire(remembered) };
  }
  return { port: await pool.acquire() };
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
        name: loaded.name || e.name,
        version: "",
        description: "",
        icon: null,
        type: loaded.type || "local",
        url: loaded.url || null,
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
    // 静态工具没有子进程（服务跑在宿主进程内），pid 为 null
    pid: r && r.proc ? r.proc.pid : null,
  };
  return { ...base, status: r ? "running" : "stopped" };
}

async function listTools() {
  const list = await scanTools();
  return list.map((m) =>
    m.error
      ? { ...m, status: "error", port: null, pid: null }
      : { ...m, ...statusOf(m) },
  );
}

async function startTool(id, opts = {}) {
  const { reassignPort = false } = opts;
  const loaded = await loadManifest(id);
  if (loaded.error) throw new Error(loaded.error);
  const m = loaded.manifest;

  // URL 工具不跑任何进程，恒为可用状态
  if (m.type === "url") {
    return { ...m, status: "running", port: null, pid: null };
  }

  // 已在运行时直接回当前状态。注意展开顺序：getStatus 必须在 m 之后，
  // 否则 manifest 里的 port（自动分配时为 0）会盖掉真实运行端口。
  if (runtimes.has(id)) return { ...m, ...getStatus(id) };

  const toolDir = path.join(TOOLBOX_DIR, id);

  // 端口 → origin → localStorage / IndexedDB 归属。
  // 记忆端口被占用时【绝不擅自换端口】：换端口就是换 origin，
  // 该工具此前写入的数据就访问不到了。这里停下来交回界面，由用户决定
  // 是「重新分配端口」还是「先不启动」。
  const previousPort = Number(portMap[id]) || 0;
  const got = await resolveToolPort(id, m, reassignPort);
  if (got.pending) return got;
  const port = got.port;
  // 用户确认「重新分配」后，旧端口上的存储就成了残留：先登记下来，
  // 等那个端口空闲时再占回来清理（此刻它正被别人占着，清不了）。
  if (reassignPort && previousPort && previousPort !== port) {
    await addResidual(id, previousPort);
  }
  if (Number(portMap[id]) !== port) {
    portMap[id] = port;
    await savePorts();
  }

  // 静态工具：没有 Node 后端，在宿主进程内起一个只读静态服务即可。
  // 照样持有固定端口，因此 origin 稳定、存储可持久。
  if (m.type === "static") {
    const server = createStaticServer(toolDir, m.html);
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
    } catch (e) {
      pool.release(port);
      throw new Error(`静态服务无法监听端口 ${port}: ${e.message}`);
    }
    const state = {
      kind: "static",
      proc: null,
      server,
      port,
      ring: makeRingBuffer(),
      startedAt: Date.now(),
    };
    runtimes.set(id, state);
    server.on("error", (err) => state.ring.push(`[host] 静态服务错误: ${err.message}`));
    log(`静态工具已启动 id=${id} port=${port}`);
    return { ...m, ...getStatus(id) };
  }

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
  if (state.server) {
    // 静态工具：关掉宿主进程内的静态服务即可
    try {
      state.server.close();
    } catch {
      /* 忽略 */
    }
  } else if (state.proc) {
    killTree(state.proc.pid);
  }
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

/** 读取并解析请求体 JSON；无 body 或解析失败一律返回 {} */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try {
        const v = JSON.parse(d || "{}");
        resolve(v && typeof v === "object" ? v : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
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
      if (loaded.error)
        return send(res, {
          ok: true,
          data: {
            id: seg[1],
            name: loaded.name || seg[1],
            version: "",
            description: "",
            icon: null,
            type: loaded.type || "local",
            url: loaded.url || null,
            main: "",
            html: "",
            port: null,
            pid: null,
            status: "error",
            error: loaded.error,
          },
        });
      return send(res, {
        ok: true,
        data: { ...loaded.manifest, ...statusOf(loaded.manifest) },
      });
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
    // start 支持 body { reassignPort: true }：记忆端口被占用时，
    // 由界面确认后主动要求重新分配端口（会换掉该工具的存储位置）。
    if (method === "POST" && seg[0] === "tools" && seg.length === 3) {
      const id = seg[1];
      if (seg[2] === "start") {
        const body = await readJsonBody(req);
        return send(res, {
          ok: true,
          data: await startTool(id, { reassignPort: body.reassignPort === true }),
        });
      }
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

    // ---- 残留数据清理（被放弃端口的 localStorage / IndexedDB）----
    // GET  /residuals            残留清单（含当前状态，供界面展示）
    // POST /residuals            登记一个被放弃的端口（工具被删除时由 Rust 调用）
    // POST /residuals/sweep      占下此刻空闲的残留端口，返回需要加载清理页的端口列表
    // POST /residuals/ignore     放弃清理某个端口（数据继续留在磁盘上）
    if (seg[0] === "residuals") {
      if (method === "GET" && seg.length === 1) {
        return send(res, { ok: true, data: await residualsView() });
      }
      if (method === "POST" && seg.length === 1) {
        const body = await readJsonBody(req);
        await addResidual(body.toolId, body.port);
        return send(res, { ok: true, data: await residualsView() });
      }
      if (method === "POST" && seg.length === 2 && seg[1] === "sweep") {
        const body = await readJsonBody(req);
        // force：用户手动点了「立即清理」，忽略冷却时间
        return send(res, { ok: true, data: await sweepResiduals(body.force === true) });
      }
      if (method === "POST" && seg.length === 2 && seg[1] === "ignore") {
        const body = await readJsonBody(req);
        const p = Number(body.port) || 0;
        residuals = residuals.filter((r) => Number(r.port) !== p);
        await saveResiduals();
        log(`已放弃清理端口 ${p} 上的残留数据`);
        return send(res, { ok: true, data: await residualsView() });
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
  await loadPorts();
  await loadResiduals();
  await seedExampleTools();

  // 单实例闸门：已有活着的宿主就让位，绝不开出第二个去抢同一批工具端口。
  // 让位前把它真实的 pid/port 写回 host-state.json，Rust 端就能立刻握手成功。
  const live = await findLiveHost();
  if (live) {
    await writeState(live.port, live.pid);
    log(`已有宿主在运行 pid=${live.pid} port=${live.port}，本进程退出`);
    process.exit(0);
  }

  const server = http.createServer(handle);
  await new Promise((r) => server.listen(ARGS.port || 0, "127.0.0.1", r));
  const hostPort = server.address().port;

  // 先握手、后自拉起。老顺序是先 autoStart 再写文件，窗口期内 Rust 会读到
  // 上一次运行留下的陈旧端口，误判为启动成功 —— 新宿主就此沦为孤儿。
  await takeLock(hostPort);
  await writeState(hostPort);

  log(`宿主已启动 pid=${process.pid} port=${hostPort}`);
  log(`toolbox=${TOOLBOX_DIR}`);
  log(`runtime=${RUNTIME_DIR}`);
  log(`npm-cli=${NPM_CLI}`);

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("exit", releaseLock);

  // 自拉起 autoStart 标记的后台常驻工具（best-effort，失败仅记录日志）
  const all = await scanTools();
  for (const m of all) {
    if (m.autoStart) {
      try {
        const out = await startTool(m.id);
        // 记忆端口被占用时不自作主张换端口（会丢掉该工具已有的本地存储），
        // 只记日志跳过，等用户进界面时再决定。
        if (out && out.pending === "portBusy") {
          log(
            `自启动工具 ${m.id} 已跳过：记忆端口 ${out.port} 被占用，` +
              `需在界面中确认是否重新分配`,
          );
        }
      } catch (e) {
        log(`自启动工具 ${m.id} 失败: ${e.message}`);
      }
    }
  }
}

main().catch((e) => {
  console.error("[host] 启动失败:", e);
  process.exit(1);
});
