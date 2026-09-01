// =====================================================================
// 关闭占用指定端口/进程的应用 —— 后端（Node.js，零第三方依赖）
//
// 职责（Windows 平台）：
//   端口模式：netstat -ano 反查占用端口的 PID → tasklist 取应用名 →
//             taskkill /F /T 强制关闭（连带子进程树）
//   PID 模式：tasklist 校验进程存在 → 取应用名 → taskkill 直接关闭
//
// 对外 API（挂在工具自己的端口上，前端同源 fetch）：
//   GET  /api/ping   健康检查
//   POST /api/kill   关闭请求  body: { mode: "port"|"pid", value: number }
//                    成功返回 { ok:true, mode, input, killed:[{pid,name}], message }
//                    失败返回 { ok:false, error: "可读的中文错误" }
//
// 错误翻译覆盖：无效输入 / 端口未被占用 / 端口无监听进程 /
//              进程不存在 / 无权限（系统/受保护进程）/ 系统命令缺失
//
// 运行时兼容：平台注入 TOOL_RUNTIME 时使用平台运行时；本地独立调试时
// 回退到仓库 runtime.js，再回退到内置最小实现。未注入 TOOL_PORT 时
// 默认监听 3920。
// =====================================================================

const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const http = require("http");
const fs = require("fs");
const path = require("path");

// ------------------------------------------------------------------
// 工具运行时加载（与平台约定一致的三级回退）
// ------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/** 找不到平台运行时时的最小 fallback：静态服务 + 路由 + res.json */
class MinimalToolServer {
  constructor(opts = {}) {
    this.dir = path.resolve(opts.dir || ".");
    this.routes = opts.routes || {};
    this.index = opts.index || "index.html";
  }

  _serveStatic(urlPath, res) {
    let rel;
    try { rel = decodeURIComponent(urlPath || "/"); } catch { rel = urlPath; }
    if (rel === "/") rel = "/" + this.index;
    const file = path.normalize(path.join(this.dir, rel));
    if (file !== this.dir && !file.startsWith(this.dir + path.sep)) {
      res.writeHead(403); res.end("Forbidden"); return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end("Not Found"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  }

  start(port) {
    const server = http.createServer((req, res) => {
      res.json = (data, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(data));
      };
      const url = new URL(req.url, "http://localhost");
      const handler = this.routes[url.pathname];
      if (handler) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try { handler(req, res, body); } catch (e) {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(String(e && e.stack ? e.stack : e));
          }
        });
        return;
      }
      if (req.method === "GET") { this._serveStatic(url.pathname, res); return; }
      res.writeHead(404); res.end("Not Found");
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve(server.address().port));
    });
  }
}

function loadToolServer() {
  if (process.env.TOOL_RUNTIME) {
    try { return require(process.env.TOOL_RUNTIME).ToolServer; } catch { /* 忽略 */ }
  }
  const repoRuntime = path.join(
    __dirname, "..", "..", "..",
    "src-tauri", "resources", "runtime", "runtime.js",
  );
  try {
    if (fs.existsSync(repoRuntime)) return require(repoRuntime).ToolServer;
  } catch { /* 忽略 */ }
  return MinimalToolServer;
}

const ToolServer = loadToolServer();

// ------------------------------------------------------------------
// 输入校验
// ------------------------------------------------------------------

/** 端口号必须是 1-65535 的整数 */
function validatePort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return { error: "端口号必须为 1-65535 之间的整数" };
  }
  return { value: n };
}

/** PID 必须是正整数 */
function validatePid(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n < 1 || n > 99999999) {
    return { error: "PID 必须为正整数" };
  }
  return { value: n };
}

// ------------------------------------------------------------------
// Windows 系统命令封装（静默执行，不弹黑色控制台窗口）
// ------------------------------------------------------------------

/**
 * 执行系统命令。成功返回 { ok:true, stdout }；
 * 失败返回 { ok:false, error }（error 为 execFile 抛出的异常）。
 */
async function runCmd(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      windowsHide: true, // 关键：隐藏子进程窗口，避免闪黑框
      timeout: 15000,
    });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/** 系统命令不可用（非 Windows / PATH 异常）时的友好提示 */
function friendlySysError(err, cmd) {
  if (err && err.code === "ENOENT") {
    return `系统命令 ${cmd} 不可用，请确认在 Windows 环境运行`;
  }
  return `执行 ${cmd} 失败：${String(err && err.message || err).slice(0, 200)}`;
}

// ------------------------------------------------------------------
// 端口反查 PID（netstat -ano）
// ------------------------------------------------------------------

/**
 * 用 netstat -ano 反查端口对应的进程。
 * TCP 行格式：TCP  本地地址  外部地址  状态  PID
 * UDP 行格式：UDP  本地地址  *:*  PID（无状态列）
 * 返回 [{ pid, proto, state }]；端口未出现时返回空数组。
 */
async function findPidsByPort(port) {
  const r = await runCmd("netstat", ["-ano"]);
  if (!r.ok) throw new Error(friendlySysError(r.error, "netstat"));

  const matches = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue; // 跳过标题行/空行
    const proto = parts[0].toUpperCase();
    if (proto !== "TCP" && proto !== "UDP") continue;

    // 本地地址形如 0.0.0.0:8080 或 [::]:8080，取末尾端口
    const m = parts[1].match(/:(\d+)$/);
    if (!m || Number(m[1]) !== port) continue;

    const isTcp = proto === "TCP";
    if (isTcp && parts.length < 5) continue; // TCP 行必须含状态与 PID
    const state = isTcp ? (parts[3] || "").toUpperCase() : "UDP";
    const pid = parseInt(isTcp ? parts[4] : parts[3], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;

    matches.push({ pid, proto, state });
  }
  return matches;
}

// ------------------------------------------------------------------
// PID ↔ 应用名（tasklist）
// ------------------------------------------------------------------

/**
 * 查询单个 PID 对应的应用名（映像名称，如 node.exe）。
 * 返回 null 表示该 PID 不存在。
 */
async function getProcessName(pid) {
  const r = await runCmd("tasklist", ["/FO", "CSV", "/NH", "/FI", `PID eq ${pid}`]);
  if (!r.ok) throw new Error(friendlySysError(r.error, "tasklist"));
  // CSV 首字段即映像名称，如 "chrome.exe","1234","Console",...
  const m = r.stdout.match(/"([^"]*)"/);
  return m ? m[1] : null;
}

/**
 * 一次性构建 PID → 应用名 映射（端口占用可能对应多个 PID 时只调一次 tasklist）。
 */
async function getProcessNameMap() {
  const r = await runCmd("tasklist", ["/FO", "CSV", "/NH"]);
  if (!r.ok) throw new Error(friendlySysError(r.error, "tasklist"));
  const map = new Map();
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/"([^"]*)","(\d+)"/);
    if (m) map.set(Number(m[2]), m[1]);
  }
  return map;
}

// ------------------------------------------------------------------
// 终止进程（taskkill /F /T）+ 复核
// ------------------------------------------------------------------

/**
 * 强制终止指定 PID 并复核。
 * /F 强制结束，/T 同时结束其子进程树。
 * 成功返回 { pid, name }；失败抛出带中文信息的 Error。
 */
async function killProcess(pid, name) {
  const r = await runCmd("taskkill", ["/PID", String(pid), "/F", "/T"]);
  if (!r.ok) {
    // taskkill 失败：execFile 下通常拿不到 stderr（stdout/stderr 为 undefined），
    // 因此先尝试文本匹配，再按「进程是否仍存在」区分权限问题与进程不存在。
    const err = r.error;
    const stderr = String((err && err.stderr) || "");
    const stillAlive = await getProcessName(pid); // 复核进程是否仍在
    if (/拒绝访问|拒绝|关键系统进程|无法结束|cannot terminate|access is denied|access denied|permission denied/i.test(stderr)) {
      throw new Error(`无权限终止进程 PID ${pid}（可能是系统进程或受保护进程），请尝试以管理员身份运行平台`);
    }
    if (stillAlive != null) {
      throw new Error(`无法终止进程 ${name}（PID ${pid}）：可能是系统/受保护进程或权限不足，请尝试以管理员身份运行平台`);
    }
    throw new Error(`进程 PID ${pid} 不存在或已退出`);
  }

  // 复核：确认进程已退出（个别进程结束较慢）
  const after = await getProcessName(pid);
  if (after != null) {
    throw new Error(`进程 ${after}（PID ${pid}）仍在退出中，请稍后重试或检查其状态`);
  }
  return { pid, name };
}

// ------------------------------------------------------------------
// 两种模式的关闭流程
// ------------------------------------------------------------------

/** 端口模式：反查占用进程 → 逐个关闭，返回汇总结果 */
async function killByPort(port) {
  const matches = await findPidsByPort(port);
  if (!matches.length) {
    return { ok: false, error: `端口 ${port} 未被任何进程占用` };
  }

  // 只关闭真正“占用”端口的目标：TCP 处于 LISTENING，或 UDP 绑定
  const targets = matches.filter((m) => m.state === "LISTENING" || m.proto === "UDP");
  if (!targets.length) {
    const states = [...new Set(matches.map((m) => m.state))].join("/");
    return {
      ok: false,
      error: `端口 ${port} 没有监听中的进程（当前仅有 ${states} 状态的连接），无需关闭`,
    };
  }

  // 去重后一次取回所有应用名
  const pidSet = [...new Set(targets.map((t) => t.pid))];
  const nameMap = await getProcessNameMap();

  const killed = [];
  const failures = [];
  for (const pid of pidSet) {
    try {
      killed.push(await killProcess(pid, nameMap.get(pid) || "未知应用"));
    } catch (e) {
      failures.push({ pid, error: e.message });
    }
  }

  return buildResult("port", port, killed, failures);
}

/** PID 模式：校验存在 → 关闭 */
async function killByPid(pid) {
  const name = await getProcessName(pid);
  if (name == null) {
    return { ok: false, error: `PID ${pid} 对应的进程不存在或已退出` };
  }
  try {
    const killed = [await killProcess(pid, name)];
    return buildResult("pid", pid, killed, []);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 汇总成功/部分失败的结果，给出明确的成功或失败反馈 */
function buildResult(mode, input, killed, failures) {
  const names = killed.map((k) => `${k.name}（PID ${k.pid}）`).join("、");

  if (killed.length && !failures.length) {
    return {
      ok: true,
      mode,
      input,
      killed,
      message: `已成功关闭：${names}`,
    };
  }
  if (!killed.length) {
    return {
      ok: false,
      error: failures.map((f) => f.error).join("；") || "未能关闭任何进程",
    };
  }
  // 部分成功（端口占用多进程时可能个别失败）
  return {
    ok: true,
    partial: true,
    mode,
    input,
    killed,
    failures,
    message: `已成功关闭：${names}；另有 ${failures.length} 个进程未能关闭`,
  };
}

/** 入口分发：按 mode 走端口或 PID 流程 */
async function handleKill(payload) {
  const mode = payload && payload.mode === "pid" ? "pid" : "port";
  if (mode === "port") {
    const v = validatePort(payload && payload.value);
    if (v.error) return { ok: false, error: v.error };
    return killByPort(v.value);
  }
  const v = validatePid(payload && payload.value);
  if (v.error) return { ok: false, error: v.error };
  return killByPid(v.value);
}

// ------------------------------------------------------------------
// HTTP 服务（工具运行时）
// ------------------------------------------------------------------

/** 异步路由包装：任何抛错都返回可读 JSON，保证前端拿到明确反馈 */
function asyncRoute(fn) {
  return (req, res, body) => {
    Promise.resolve()
      .then(() => fn(req, res, body))
      .catch((err) => {
        console.error("[close-occupied-process] 请求处理失败:", err && err.stack ? err.stack : err);
        try { res.json({ ok: false, error: String((err && err.message) || err) }); } catch { /* 响应已发出 */ }
      });
  };
}

const server = new ToolServer({
  dir: __dirname,
  routes: {
    "/api/ping": (req, res) => res.json({ ok: true, msg: "pong" }),

    // 关闭请求：{ mode: "port"|"pid", value: number }
    "/api/kill": asyncRoute((req, res, body) => {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch { /* ignore */ }
      return handleKill(payload).then((result) => res.json(result));
    }),
  },
});

// 平台会注入 TOOL_PORT；未注入时（本地独立调试）默认监听 3920
const port = Number(process.env.TOOL_PORT) || 3920;
server.start(port).then((actual) => {
  console.log(`[close-occupied-process] listening on http://127.0.0.1:${actual}`);
});
