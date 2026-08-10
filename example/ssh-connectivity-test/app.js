// =====================================================================
// SSH 连通性测试工具 —— 后端（Node.js）
//
// 依赖：ssh2（纯 JS 的 SSH 客户端库，无需编译原生模块）
//   · 在平台「依赖管理」页为本工具安装 ssh2
//   · 或在本目录执行 npm install
//
// 提供的 API（挂在工具自己的端口上，前端同源 fetch）：
//   POST /api/test       执行 SSH 连通性测试
//   GET  /api/list-keys  列出工具目录下的候选私钥文件（替代桌面文件对话框）
//   GET  /api/ping       健康检查
//
// 测试分三个阶段（与 sshTest 项目保持一致）：
//   1. TCP 连接        —— net 模块，独立计时与超时
//   2. SSH 握手        —— 协议版本协商 / 密钥交换，记录主机密钥指纹
//   3. 登录认证        —— 勾选“验证登录”时执行（密码 / 私钥）
//
// 运行时兼容：在平台里由 TOOL_RUNTIME 注入运行时；本地独立调试时
// 自动回退到仓库 runtime.js，再回退到内置最小实现。
// =====================================================================

const net = require("net");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ssh2 未安装时给出友好提示（而不是裸报错）
let Client;
try {
  ({ Client } = require("ssh2"));
} catch (err) {
  console.error(
    "[ssh-connectivity-test] 缺少依赖 ssh2，请在平台「依赖管理」页为本工具安装 ssh2，或在本目录执行 npm install。",
  );
  process.exit(1);
}

// ------------------------------------------------------------------
// 工具运行时加载
// ------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** 找不到运行时时的最小 fallback：静态服务 + 路由 + res.json */
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
  // 平台运行时会注入 TOOL_RUNTIME，优先使用
  if (process.env.TOOL_RUNTIME) {
    try { return require(process.env.TOOL_RUNTIME).ToolServer; } catch { /* 忽略 */ }
  }
  // 本地独立调试：回退到平台仓库里的运行时
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
// 工具函数
// ------------------------------------------------------------------

/** 计算主机密钥的 OpenSSH 风格指纹：SHA256:<base64> */
function fingerprintOf(derKey) {
  const hash = crypto.createHash("sha256").update(derKey).digest("base64");
  return "SHA256:" + hash.replace(/=+$/g, "");
}

/** 阶段 1：TCP 连接（独立计时与超时） */
function tcpConnect(host, port, timeoutSecs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(Object.assign(new Error("连接超时"), { code: "ETIMEDOUT" }));
    }, timeoutSecs * 1000);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.end();
      resolve(Date.now() - started);
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** TCP 连接错误 → 友好中文提示 */
function friendlyTcpError(err) {
  switch (err.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "无法解析主机名（请检查主机地址拼写是否正确）";
    case "ECONNREFUSED":
      return "连接被拒绝（该端口未开放，或服务未启动 / 被防火墙屏蔽）";
    case "ECONNRESET":
      return "连接被重置（可能是防火墙拦截或服务异常）";
    case "ETIMEDOUT":
      return "连接超时（目标主机不可达，或防火墙丢弃数据包）";
    case "EHOSTUNREACH":
      return "主机不可达";
    case "ENETUNREACH":
      return "网络不可达";
    case "EPERM":
      return "无权限连接";
    default:
      return `连接失败：${err.message || String(err)}`;
  }
}

/** 读取私钥文件（支持绝对路径或工具目录相对路径） */
function loadPrivateKey(keyPath) {
  const abs = path.isAbsolute(keyPath) ? keyPath : path.join(__dirname, keyPath);
  return fs.readFileSync(abs);
}

/** 私钥读取错误 → 友好提示 */
function friendlyKeyError(err, keyPath) {
  if (err.code === "ENOENT")
    return `无法读取私钥文件：${keyPath} 不存在（请检查路径是否正确）`;
  if (err.code === "EACCES") return "无法读取私钥文件：没有访问权限";
  return `无法读取私钥文件：${err.message || err}`;
}

/** SSH 握手 / 私钥解析错误 → 友好提示 */
function friendlySshError(err) {
  const msg = (err && err.message) || String(err);
  if (/version|protocol/i.test(msg))
    return "目标端口不是 SSH 服务，或返回的 SSH 版本协议不受支持";
  if (/private key|parse/i.test(msg))
    return "私钥解析失败：文件格式不受支持，或口令错误（加密私钥需填写口令）";
  if (/encryption|cipher|algorithm|kex|exchange/i.test(msg))
    return "密钥交换 / 加密算法协商失败（双方没有共同支持的算法）";
  if (/timed out|timeout|handshake/i.test(msg))
    return "SSH 握手超时（服务器响应过慢，或网络不稳定）";
  if (/closed|destroy|hang|eof/i.test(msg))
    return "连接被服务器关闭（该端口可能不是 SSH 服务）";
  return `SSH 握手失败：${msg}`;
}

// ------------------------------------------------------------------
// 阶段 2+3：SSH 握手与认证
// ------------------------------------------------------------------

/**
 * 用 ssh2 完成握手 + 认证。
 * 返回 { status, fingerprint, handshakeMs, authMs, error }
 *   status: "auth-ok"       认证成功（ready 事件）
 *          "auth-fail"      认证被拒绝（握手已完成）
 *          "reachable"      握手成功但未验证登录（verifyLogin=false 时认证失败也归此类）
 *          "handshake-fail" 握手阶段就失败（连接/协议/密钥问题）
 */
function sshHandshake(opts) {
  const {
    host, port, username, password, privateKey, passphrase, verifyLogin, timeoutSecs,
  } = opts;
  const started = Date.now();
  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;
    let fingerprint = null;
    let handshakeMs = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch { /* ignore */ }
      resolve(payload);
    };

    conn.on("ready", () => {
      finish({
        status: "auth-ok",
        fingerprint,
        handshakeMs,
        authMs: Date.now() - started,
      });
    });

    conn.on("error", (err) => {
      if (fingerprint) {
        // 握手已成功；未勾选“验证登录”时，认证失败也算连通性通过
        finish({
          status: verifyLogin ? "auth-fail" : "reachable",
          fingerprint,
          handshakeMs,
          authMs: Date.now() - started,
          error: err,
        });
      } else {
        finish({ status: "handshake-fail", fingerprint: null, handshakeMs, error: err });
      }
    });

    const config = {
      host,
      port,
      username,
      readyTimeout: timeoutSecs * 1000,
      // 连通性测试：接受任意主机密钥，同时记录其指纹供展示
      hostVerifier: (derKey) => {
        fingerprint = fingerprintOf(derKey);
        handshakeMs = Date.now() - started;
        return true;
      },
    };
    if (password) config.password = password;
    if (privateKey) config.privateKey = privateKey;
    if (passphrase) config.passphrase = passphrase;

    conn.connect(config);
  });
}

// ------------------------------------------------------------------
// 主测试流程
// ------------------------------------------------------------------

function runSshTest(input) {
  return new Promise((resolve) => {
    const started = Date.now();
    const steps = [];
    const addStep = (text, ok, elapsedMs) =>
      steps.push({ text, ok, time: `${elapsedMs} ms` });

    const result = (over) =>
      resolve({
        success: over.success,
        message: over.message,
        reason: over.reason,
        steps,
        serverKeyFingerprint: over.fingerprint || null,
        elapsedMs: Date.now() - started,
      });

    const host = (input.host || "").trim();
    const username = (input.username || "").trim();
    const port = Number(input.port) || 22;
    const timeoutSecs = Math.min(Math.max(Number(input.timeoutSecs) || 10, 1), 300);
    const verifyLogin = !!input.verifyLogin;

    // 阶段 0：输入校验（后端也做一遍，前端同样校验）
    if (!host) return result({ success: false, message: "无法开始测试", reason: "请填写主机地址。" });
    if (!username) return result({ success: false, message: "无法开始测试", reason: "请填写用户名。" });
    if (verifyLogin) {
      if (input.authMethod === "password" && !input.password)
        return result({ success: false, message: "无法开始测试", reason: "请填写登录密码。" });
      if (input.authMethod === "key" && !input.keyPath)
        return result({ success: false, message: "无法开始测试", reason: "请填写私钥文件路径。" });
    }

    // 阶段 1：TCP 连接
    const tcpStart = Date.now();
    tcpConnect(host, port, timeoutSecs)
      .then((tcpMs) => {
        addStep(`TCP 连接成功（${host}:${port}）`, true, tcpMs);
        doSsh();
      })
      .catch((err) => {
        addStep("TCP 连接", false, Date.now() - tcpStart);
        result({ success: false, message: "TCP 连接失败", reason: friendlyTcpError(err) });
      });

    // 阶段 2+3：SSH 握手 + 认证
    function doSsh() {
      // 只有需要验证登录时才加载私钥（纯连通性测试不需要凭据）
      let privateKey = null;
      if (input.authMethod === "key" && verifyLogin) {
        try {
          privateKey = loadPrivateKey(input.keyPath);
        } catch (err) {
          addStep("加载私钥", false, 0);
          return result({
            success: false,
            message: "无法读取私钥",
            reason: friendlyKeyError(err, input.keyPath),
          });
        }
      }

      const sshStart = Date.now();
      sshHandshake({
        host,
        port,
        username,
        password: input.authMethod === "password" && verifyLogin ? input.password : undefined,
        privateKey,
        passphrase: input.keyPassphrase || undefined,
        verifyLogin,
        timeoutSecs,
      }).then((r) => {
        if (r.handshakeMs != null)
          addStep("SSH 握手成功（服务端已响应，协议版本协商完成）", true, r.handshakeMs);
        else addStep("SSH 握手", false, Date.now() - sshStart);

        switch (r.status) {
          case "auth-ok":
            addStep("认证成功（用户名与凭据正确）", true, r.authMs);
            return result({
              success: true,
              message: "SSH 连接成功，登录验证通过",
              reason: "TCP 连接、SSH 握手与登录认证均已通过。",
              fingerprint: r.fingerprint,
            });
          case "auth-fail":
            addStep("认证", false, r.authMs);
            return result({
              success: false,
              message: "认证失败",
              reason: "用户名或密码/密钥不正确（服务器拒绝了认证）。",
              fingerprint: r.fingerprint,
            });
          case "reachable":
            return result({
              success: true,
              message: "SSH 服务连接成功",
              reason: "TCP 连接与 SSH 握手均正常，SSH 服务可访问。（未验证登录）",
              fingerprint: r.fingerprint,
            });
          case "handshake-fail":
          default:
            return result({
              success: false,
              message: "SSH 握手失败",
              reason: friendlySshError(r.error),
            });
        }
      });
    }
  });
}

// ------------------------------------------------------------------
// 历史测试记录（持久化到工具目录 history.json）
// ------------------------------------------------------------------

const HISTORY_FILE = path.join(__dirname, "history.json");

function readHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { /* 文件不存在或损坏 → 视为空 */ }
  return [];
}

function writeHistory(list) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (err) {
    console.error("[ssh-connectivity-test] 保存历史记录失败:", err.message);
  }
}

/** 规范化一条历史记录（补齐字段、限定范围、重新打时间戳） */
function normalizeRecord(rec, id) {
  return {
    id,
    host: (rec.host || "").trim(),
    port: Number(rec.port) || 22,
    username: (rec.username || "").trim(),
    authMethod: rec.authMethod === "key" ? "key" : "password",
    password: rec.password || "",
    keyPath: rec.keyPath || "",
    keyPassphrase: rec.keyPassphrase || "",
    verifyLogin: !!rec.verifyLogin,
    timeoutSecs: Math.min(Math.max(Number(rec.timeoutSecs) || 10, 1), 300),
    savedAt: Date.now(),
  };
}

// ------------------------------------------------------------------
// HTTP 服务（工具运行时）
// ------------------------------------------------------------------

const server = new ToolServer({
  dir: __dirname,
  routes: {
    "/api/ping": (req, res) => res.json({ ok: true, msg: "pong" }),

    // 历史记录 CRUD（单一路径，按 method + body.id 区分）
    //   GET    → 列表
    //   POST   { record }                → 新增
    //   PUT    { id, ...record }         → 更新指定记录
    //   DELETE { id }                    → 删除指定记录（无 id 则清空全部）
    "/api/history": (req, res, body) => {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch { /* ignore */ }

      if (req.method === "GET") {
        return res.json({ ok: true, records: readHistory() });
      }

      if (req.method === "POST") {
        const rec = payload.record || payload;
        if (!(rec.host || "").trim() || !(rec.username || "").trim())
          return res.json({ ok: false, error: "请填写主机地址和用户名" });
        const entry = normalizeRecord(rec, crypto.randomUUID());
        const list = readHistory();
        list.unshift(entry);
        writeHistory(list);
        return res.json({ ok: true, record: entry });
      }

      if (req.method === "PUT") {
        const id = payload.id;
        if (!id) return res.json({ ok: false, error: "缺少记录 id" });
        const list = readHistory();
        const idx = list.findIndex((r) => r.id === id);
        if (idx === -1) return res.json({ ok: false, error: "记录不存在（可能已被删除）" });
        const entry = normalizeRecord(payload, id);
        list[idx] = entry;
        writeHistory(list);
        return res.json({ ok: true, record: entry });
      }

      if (req.method === "DELETE") {
        if (payload.id) {
          writeHistory(readHistory().filter((r) => r.id !== payload.id));
        } else {
          writeHistory([]);
        }
        return res.json({ ok: true });
      }

      res.json({ ok: false, error: `不支持的方法 ${req.method}` });
    },

    // 列出工具目录下的候选私钥文件（替代桌面端文件对话框）
    "/api/list-keys": (req, res) => {
      const keys = [];
      const re = /^(id_(rsa|ed25519|ecdsa|dsa)|.*\.(pem|key|ppk|openssh))$/i;
      try {
        for (const name of fs.readdirSync(__dirname)) {
          const full = path.join(__dirname, name);
          try {
            if (fs.statSync(full).isFile() && re.test(name)) keys.push(name);
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      res.json({ ok: true, keys, dir: __dirname });
    },

    // 执行 SSH 连通性测试
    "/api/test": (req, res, body) => {
      let input = {};
      try { input = JSON.parse(body || "{}"); } catch { /* ignore */ }
      runSshTest(input).then((r) => res.json(r));
    },
  },
});

// 平台会注入 TOOL_PORT；未注入时（本地独立调试）默认监听 3900
const port = Number(process.env.TOOL_PORT) || 3900;
server.start(port);
