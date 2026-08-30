// =====================================================================
// Clash 远程控制器 —— 后端（Node.js，零第三方依赖）
//
// 职责：
//   1. 控制器配置管理：多条 Clash External Controller 连接配置的
//      新增 / 编辑 / 删除 / 切换，持久化到工具目录 profiles.json；
//   2. Clash API 网关：前端把 action 发给本后端，由后端携带
//      Bearer Secret 请求 Clash 控制器（前端不直连 Clash，
//      因而没有 CORS 问题），并把网络层 / HTTP 层错误翻译成可读中文。
//
// 对外 API（挂在工具自己的端口上，前端同源 fetch）：
//   GET    /api/profiles            读取全部配置 + 激活项 + 测速设置
//   POST   /api/profiles            新增配置     body: {name,protocol,host,port,secret}
//   PUT    /api/profiles            编辑配置     body: {id, ...同上}
//   DELETE /api/profiles            删除配置     body: {id}
//   POST   /api/profiles/activate   切换激活配置 body: {id}
//   PUT    /api/settings            保存测速设置 body: {testUrl,testTimeout}
//   POST   /api/clash               Clash 网关   body: {action, ...params, profileId?/conn?}
//
// /api/clash 支持的 action（对应 Clash External Controller 接口）：
//   version    GET   /version                内核版本（用于连接测试）
//   configs    GET   /configs                运行配置（含 mode）
//   setMode    PATCH /configs                切换运行模式 rule/global/direct
//   proxies    GET   /proxies                全部代理组与节点
//   select     PUT   /proxies/:group         组内选择节点（body {name}）
//   delay      GET   /proxies/:name/delay    单节点延迟测试
//   groupDelay GET   /group/:name/delay      组测速（内核不支持时回退为逐节点测）
//   reload     PUT   /configs?force=true     重载订阅配置文件
//
// 运行时兼容：平台注入 TOOL_RUNTIME 时使用平台运行时；本地独立调试时
// 回退到仓库 runtime.js，再回退到内置最小实现。未注入 TOOL_PORT 时
// 默认监听 3910。
// =====================================================================

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ------------------------------------------------------------------
// 工具运行时加载（与平台约定一致的三级回退）
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
// 配置存储（profiles.json：连接配置 + 测速设置）
// ------------------------------------------------------------------

const STORE_FILE = path.join(__dirname, "profiles.json");
const DEFAULT_SETTINGS = {
  testUrl: "http://www.gstatic.com/generate_204", // Clash 生态惯用的连通性测试地址
  testTimeout: 5000,                               // 单节点测速超时（ms）
};

/** 规范化测速设置：URL 必须 http(s) 开头，超时收敛到 [500, 30000] */
function normalizeSettings(s = {}) {
  const url = typeof s.testUrl === "string" && /^https?:\/\/.+/.test(s.testUrl.trim())
    ? s.testUrl.trim()
    : DEFAULT_SETTINGS.testUrl;
  const t = Number(s.testTimeout);
  const testTimeout = Number.isFinite(t)
    ? Math.min(Math.max(Math.round(t), 500), 30000)
    : DEFAULT_SETTINGS.testTimeout;
  return { testUrl: url, testTimeout };
}

/** 规范化一条连接配置（补齐字段、收敛取值范围） */
function normalizeProfile(p = {}) {
  return {
    id: typeof p.id === "string" && p.id ? p.id : crypto.randomUUID(),
    name: String(p.name || "").trim().slice(0, 40),
    protocol: p.protocol === "https" ? "https" : "http",
    host: String(p.host || "").trim().slice(0, 255),
    port: Number(p.port) || 0,
    secret: String(p.secret || "").slice(0, 512),
    createdAt: Number(p.createdAt) || Date.now(),
    updatedAt: Number(p.updatedAt) || Date.now(),
  };
}

function readStore() {
  try {
    const obj = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    const profiles = Array.isArray(obj.profiles) ? obj.profiles.map((p) => normalizeProfile(p)) : [];
    let activeId = typeof obj.activeId === "string" ? obj.activeId : null;
    // 激活项失效时自动回退到第一条，保证始终有可用目标
    if (!activeId || !profiles.some((p) => p.id === activeId)) {
      activeId = profiles.length ? profiles[0].id : null;
    }
    return { activeId, settings: normalizeSettings(obj.settings), profiles };
  } catch {
    // 文件不存在或损坏 → 视为空存储
    return { activeId: null, settings: normalizeSettings(), profiles: [] };
  }
}

function writeStore(store) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
  } catch (err) {
    console.error("[clash-controller] 保存配置失败:", err.message);
  }
}

// ------------------------------------------------------------------
// 表单校验（后端兜底，前端也做同样校验）
// ------------------------------------------------------------------

/** 地址校验：IPv4 / 域名 / IPv6 字面量 */
function validateHost(host) {
  if (!host) return "请填写控制器地址";
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split(".").every((n) => Number(n) <= 255) ? null : "IPv4 地址不合法";
  }
  // IPv6（至少两个冒号，字符只允许十六进制与冒号/点）
  if (/^[0-9a-fA-F:.]+$/.test(host) && (host.match(/:/g) || []).length >= 2) return null;
  // 域名 / 单标签主机名（含 localhost）
  if (/^[a-zA-Z0-9]([a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/.test(host)) return null;
  return "地址格式不正确（应为 IP、域名或 IPv6）";
}

/** 校验一条配置输入，返回 { error } 或 { value } */
function validateProfileInput(input) {
  const name = String(input.name || "").trim();
  if (!name) return { error: "请填写配置名称" };
  if (name.length > 40) return { error: "配置名称过长（最多 40 字符）" };
  const host = String(input.host || "").trim();
  const hostErr = validateHost(host);
  if (hostErr) return { error: hostErr };
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: "端口应为 1-65535 的整数" };
  }
  const secret = String(input.secret || "");
  if (secret.length > 512) return { error: "Secret 过长" };
  return {
    value: {
      name,
      protocol: input.protocol === "https" ? "https" : "http",
      host,
      port,
      secret,
    },
  };
}

// ------------------------------------------------------------------
// Clash HTTP 客户端（内置 http/https 模块，带超时与错误翻译）
// ------------------------------------------------------------------

/** 标记「控制器返回了非 2xx」的错误，便于 friendlyError 区分网络层/HTTP 层 */
function httpError(status, message) {
  const e = new Error(String(message || `HTTP ${status}`));
  e.kind = "http";
  e.status = status;
  return e;
}

/**
 * 向 Clash External Controller 发一次请求。
 * @param {object} conn     {protocol, host, port, secret}
 * @param {object} opts     {method, apiPath, query, data, timeoutMs}
 * @returns {Promise<{status:number, data:object|null, text:string}>}
 */
function clashRequest(conn, opts = {}) {
  return new Promise((resolve, reject) => {
    const { method = "GET", apiPath, query = null, data = null, timeoutMs = 10000 } = opts;

    // 拼接 URL；IPv6 字面量需要包上方括号
    let hostPart = conn.host.includes(":") && !conn.host.startsWith("[")
      ? `[${conn.host}]`
      : conn.host;
    let url;
    try {
      const qs = query ? "?" + new URLSearchParams(query).toString() : "";
      url = new URL(`${conn.protocol}://${hostPart}:${conn.port}${apiPath}${qs}`);
    } catch (e) {
      return reject(new Error("控制器地址无法解析：" + (e.message || e)));
    }

    const mod = url.protocol === "https:" ? https : http;
    const payload = data != null ? JSON.stringify(data) : null;
    const headers = { Accept: "application/json" };
    if (conn.secret) headers.Authorization = "Bearer " + conn.secret; // Clash 标准鉴权方式
    if (payload != null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const reqOut = mod.request(url, { method, headers }, (resp) => {
      let buf = "";
      resp.setEncoding("utf8");
      resp.on("data", (c) => {
        buf += c;
        if (buf.length > 8 * 1024 * 1024) reqOut.destroy(); // 响应体过大保护
      });
      resp.on("end", () => {
        const text = (buf || "").trim();
        let json = null;
        if (text) {
          try { json = JSON.parse(text); } catch { json = null; }
        }
        const status = resp.statusCode || 0;
        if (status >= 200 && status < 300) {
          resolve({ status, data: json, text }); // 204 无内容时 data 为 null，属正常
        } else {
          const message = (json && (json.message || json.error)) || text.slice(0, 200) || `HTTP ${status}`;
          reject(httpError(status, message));
        }
      });
    });

    // 空闲超时：销毁连接并抛错（destroy(err) 会触发 error 事件）
    reqOut.setTimeout(timeoutMs, () => reqOut.destroy(new Error(`请求超时（${timeoutMs} ms）`)));
    reqOut.on("error", (err) => reject(err));
    if (payload != null) reqOut.write(payload);
    reqOut.end();
  });
}

/** 并发受限地执行任务列表（用于组测速回退） */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function runner() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i).catch((e) => ({ __error: e }));
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
  return results;
}

/** 组测速回退：内核没有 /group/:name/delay 时，逐节点并发测速 */
async function groupDelayFallback(conn, group, settings) {
  const r = await clashRequest(conn, { apiPath: "/proxies", timeoutMs: 15000 });
  const proxies = (r.data && r.data.proxies) || {};
  const all = Array.isArray(proxies[group] && proxies[group].all) ? proxies[group].all : [];
  const delays = {};
  await mapLimit(all, 6, async (name) => {
    try {
      const d = await clashRequest(conn, {
        apiPath: `/proxies/${encodeURIComponent(name)}/delay`,
        query: { url: settings.testUrl, timeout: settings.testTimeout },
        timeoutMs: settings.testTimeout + 5000,
      });
      if (d.data && typeof d.data.delay === "number") delays[name] = d.data.delay;
    } catch {
      // 单节点失败：不出现在结果里，前端按「超时」展示
    }
  });
  return delays;
}

// ------------------------------------------------------------------
// 错误翻译：把底层错误映射成可读中文（需求 4 的核心）
// ------------------------------------------------------------------

function friendlyError(err) {
  if (!err) return "未知错误";

  // HTTP 层：控制器有响应但返回错误状态码
  if (err.kind === "http") {
    switch (err.status) {
      case 400: return `请求被拒绝（HTTP 400）：${err.message || "参数不正确，或该代理组类型不支持手动切换"}`;
      case 401: return "鉴权失败（HTTP 401）：Secret 不正确";
      case 403: return "鉴权失败（HTTP 403）：无权访问该接口";
      case 404: return `接口不存在（HTTP 404）：${err.message || "该内核可能不支持此功能"}`;
      case 408: return "请求超时（HTTP 408）";
      case 504: return "网关超时（HTTP 504），请稍后重试";
      case 429: return "请求过于频繁（HTTP 429），请稍后再试";
      default: return `Clash 控制器返回错误（HTTP ${err.status}）：${err.message}`;
    }
  }

  // 网络层：按 Node 错误码翻译
  switch (err.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "无法解析主机名：请检查地址拼写是否正确";
    case "ECONNREFUSED":
      return "连接被拒绝：控制器未启动、端口不正确或被防火墙拦截";
    case "ETIMEDOUT":
      return "连接超时：目标主机不可达或响应过慢";
    case "ECONNRESET":
      return "连接被重置：协议可能不匹配（HTTP/HTTPS 选错）或目标不是 Clash 控制器";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "网络不可达：目标主机无法到达";
    case "EPROTO":
      return "TLS 握手失败：目标可能是 HTTP 控制器，请把协议改为 HTTP";
    default:
      break;
  }

  const msg = err.message || String(err);
  // 常见的协议不匹配 / 非控制器端口场景
  if (/wrong version number|ERR_SSL|certificate/i.test(msg)) {
    return `TLS 握手失败：目标可能是 HTTP 控制器，请检查协议设置（${msg.slice(0, 120)}）`;
  }
  if (/socket hang up/i.test(msg)) {
    return "连接被挂起：协议可能不匹配（HTTPS 控制器请选择 HTTPS 协议）";
  }
  if (/timeout|超时/i.test(msg)) {
    return msg.startsWith("请求超时") ? msg : `请求超时：${msg}`;
  }
  return msg || "请求失败";
}

// ------------------------------------------------------------------
// /api/clash 网关：action 分发
// ------------------------------------------------------------------

async function handleClashAction(payload) {
  const store = readStore();
  const settings = store.settings;

  // 解析目标连接：优先显式 conn（保存前的「测试连接」），其次 profileId，最后激活配置
  let conn;
  if (payload && payload.conn && typeof payload.conn === "object") {
    const v = validateProfileInput({ name: "ad-hoc", ...payload.conn });
    if (v.error) throw new Error("连接参数不合法：" + v.error);
    conn = v.value;
  } else {
    const id = (payload && payload.profileId) || store.activeId;
    const profile = store.profiles.find((p) => p.id === id);
    if (!profile) throw new Error("尚未选择控制器配置，请先在「控制器配置」中添加并启用一个");
    conn = profile;
  }

  const action = payload && payload.action;

  switch (action) {
    // 内核版本 —— 用于连接测试与状态栏展示
    case "version": {
      const r = await clashRequest(conn, { apiPath: "/version", timeoutMs: 8000 });
      if (r.data == null) {
        throw new Error("目标端口有响应但未返回 JSON，可能不是 Clash 外部控制器");
      }
      return {
        version: r.data.version || "unknown",
        meta: !!r.data.meta,       // mihomo / Clash.Meta
        premium: !!r.data.premium, // Clash Premium
      };
    }

    // 运行配置（含 mode）
    case "configs": {
      const r = await clashRequest(conn, { apiPath: "/configs", timeoutMs: 8000 });
      if (!r.data || typeof r.data !== "object") throw new Error("控制器未返回有效配置");
      return r.data;
    }

    // 切换运行模式：rule / global / direct
    case "setMode": {
      const mode = payload.mode;
      if (!["rule", "global", "direct"].includes(mode)) throw new Error("无效的运行模式");
      await clashRequest(conn, { method: "PATCH", apiPath: "/configs", data: { mode }, timeoutMs: 8000 });
      return { mode };
    }

    // 全部代理（组 + 节点）
    case "proxies": {
      const r = await clashRequest(conn, { apiPath: "/proxies", timeoutMs: 15000 });
      if (!r.data || !r.data.proxies) throw new Error("控制器未返回代理数据");
      return r.data;
    }

    // 组内选择节点：PUT /proxies/:group  body {name}
    case "select": {
      const group = String(payload.group || "");
      const name = String(payload.name || "");
      if (!group || !name) throw new Error("缺少组名或节点名");
      await clashRequest(conn, {
        method: "PUT",
        apiPath: `/proxies/${encodeURIComponent(group)}`,
        data: { name },
        timeoutMs: 8000,
      });
      return { group, now: name };
    }

    // 单节点延迟测试：GET /proxies/:name/delay
    case "delay": {
      const name = String(payload.name || "");
      if (!name) throw new Error("缺少节点名");
      try {
        const r = await clashRequest(conn, {
          apiPath: `/proxies/${encodeURIComponent(name)}/delay`,
          query: { url: settings.testUrl, timeout: settings.testTimeout },
          timeoutMs: settings.testTimeout + 5000,
        });
        const delay = r.data && typeof r.data.delay === "number" ? r.data.delay : null;
        if (delay == null) throw new Error("测速结果异常");
        return { name, delay };
      } catch (err) {
        // 控制器对测速超时通常返回 408 / 504，统一翻译
        if (err && err.kind === "http" && (err.status === 408 || err.status === 504)) {
          throw new Error(`测速超时（${settings.testTimeout} ms）`);
        }
        throw err;
      }
    }

    // 组延迟测试：优先 GET /group/:name/delay（mihomo 支持），
    // 内核不支持（404 等）时回退为逐节点并发测速
    case "groupDelay": {
      const group = String(payload.group || "");
      if (!group) throw new Error("缺少组名");
      let delays = null;
      let source = "group-api";
      try {
        const r = await clashRequest(conn, {
          apiPath: `/group/${encodeURIComponent(group)}/delay`,
          query: { url: settings.testUrl, timeout: settings.testTimeout },
          timeoutMs: settings.testTimeout + 15000,
        });
        if (r.data && typeof r.data === "object") delays = r.data;
      } catch {
        delays = null; // 交给回退逻辑
      }
      if (!delays) {
        source = "fallback";
        delays = await groupDelayFallback(conn, group, settings);
      }
      // 只保留数值结果
      for (const k of Object.keys(delays)) {
        if (typeof delays[k] !== "number") delete delays[k];
      }
      return { group, delays, source };
    }

    // 重载订阅配置：PUT /configs?force=true（path 为空 = 重载当前配置文件）
    case "reload": {
      await clashRequest(conn, {
        method: "PUT",
        apiPath: "/configs",
        query: { force: "true" },
        data: { path: "", payload: "" },
        timeoutMs: 20000,
      });
      return { reloaded: true };
    }

    default:
      throw new Error(`未知的 action：${action}`);
  }
}

/** 异步路由包装：任何抛错都翻译成 {ok:false, error}，保证前端拿到可读反馈 */
function asyncRoute(fn) {
  return (req, res, body) => {
    Promise.resolve()
      .then(() => fn(req, res, body))
      .catch((err) => {
        console.error("[clash-controller] 请求处理失败:", err && err.stack ? err.stack : err);
        try { res.json({ ok: false, error: friendlyError(err) }); } catch { /* 响应已发出 */ }
      });
  };
}

// ------------------------------------------------------------------
// HTTP 服务（工具运行时）
// ------------------------------------------------------------------

const server = new ToolServer({
  dir: __dirname,
  routes: {
    "/api/ping": (req, res) => res.json({ ok: true, msg: "pong" }),

    // 连接配置 CRUD（单一路径，按 method + body.id 区分）
    "/api/profiles": asyncRoute((req, res, body) => {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch { /* ignore */ }

      if (req.method === "GET") {
        const store = readStore();
        return res.json({ ok: true, ...store });
      }

      if (req.method === "POST") {
        const v = validateProfileInput(payload);
        if (v.error) return res.json({ ok: false, error: v.error });
        const store = readStore();
        if (store.profiles.some((p) => p.name.toLowerCase() === v.value.name.toLowerCase())) {
          return res.json({ ok: false, error: "已存在同名配置，请换一个名称" });
        }
        const profile = {
          ...v.value,
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        store.profiles.push(profile);
        if (!store.activeId) store.activeId = profile.id; // 首个配置自动激活
        writeStore(store);
        return res.json({ ok: true, profile, activeId: store.activeId });
      }

      if (req.method === "PUT") {
        const id = payload.id;
        const store = readStore();
        const idx = store.profiles.findIndex((p) => p.id === id);
        if (idx === -1) return res.json({ ok: false, error: "配置不存在（可能已被删除）" });
        const v = validateProfileInput(payload);
        if (v.error) return res.json({ ok: false, error: v.error });
        if (store.profiles.some((p) => p.id !== id && p.name.toLowerCase() === v.value.name.toLowerCase())) {
          return res.json({ ok: false, error: "已存在同名配置，请换一个名称" });
        }
        const profile = { ...store.profiles[idx], ...v.value, id, updatedAt: Date.now() };
        store.profiles[idx] = profile;
        writeStore(store);
        return res.json({ ok: true, profile });
      }

      if (req.method === "DELETE") {
        const id = payload.id;
        const store = readStore();
        const next = store.profiles.filter((p) => p.id !== id);
        if (next.length === store.profiles.length) {
          return res.json({ ok: false, error: "配置不存在" });
        }
        store.profiles = next;
        if (store.activeId === id) store.activeId = next.length ? next[0].id : null;
        writeStore(store);
        return res.json({ ok: true, activeId: store.activeId });
      }

      return res.json({ ok: false, error: `不支持的方法 ${req.method}` });
    }),

    // 切换激活配置
    "/api/profiles/activate": asyncRoute((req, res, body) => {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch { /* ignore */ }
      const id = payload.id;
      const store = readStore();
      if (!store.profiles.some((p) => p.id === id)) {
        return res.json({ ok: false, error: "配置不存在" });
      }
      store.activeId = id;
      writeStore(store);
      res.json({ ok: true, activeId: id });
    }),

    // 测速设置
    "/api/settings": asyncRoute((req, res, body) => {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch { /* ignore */ }
      if (req.method === "GET") {
        return res.json({ ok: true, settings: readStore().settings });
      }
      if (req.method === "PUT") {
        const store = readStore();
        store.settings = normalizeSettings({ ...store.settings, ...payload });
        writeStore(store);
        return res.json({ ok: true, settings: store.settings });
      }
      return res.json({ ok: false, error: `不支持的方法 ${req.method}` });
    }),

    // Clash API 网关（前端唯一的 Clash 出口）
    "/api/clash": asyncRoute((req, res, body) => {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch { /* ignore */ }
      return handleClashAction(payload).then((data) => res.json({ ok: true, data }));
    }),
  },
});

// 平台会注入 TOOL_PORT；未注入时（本地独立调试）默认监听 3910
const port = Number(process.env.TOOL_PORT) || 3910;
server.start(port).then((actual) => {
  console.log(`[clash-controller] listening on http://127.0.0.1:${actual}`);
});
