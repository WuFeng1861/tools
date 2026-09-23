// =====================================================================
// 多号签到 quota-pool —— 后端（Node.js，零第三方依赖）
//
// 一句话：WorkBuddy / Trae 多账户自动签到保活，每天定时查状态 + 幂等签到。
// 只做签到，不做聊天中转。
//
// 对外 API（前端同源 fetch）：
//   GET  /api/ping
//   GET  /api/accounts            账户列表（token 脱敏，含分包明细）
//   POST /api/accounts            新增/编辑 {action:create|update, ...}
//   POST /api/accounts/delete     删除 {id}
//   POST /api/accounts/toggle     启用/停用 {id, enabled}
//   POST /api/accounts/check      查状态 {id?}（省略 id = 查全部启用的）
//   POST /api/accounts/claim      签到 {id?}（幂等，已签到直接跳过）
//   POST /api/accounts/refresh    刷新 WorkBuddy token {id}
//   GET  /api/config              自动签到设置
//   POST /api/config              保存自动签到设置
//   GET  /api/logs?tail=200       最近日志
//
// 上游直签接口（实测可用的公开做法）：
//   WorkBuddy: POST {endpoint}/v2/billing/meter/checkin-activity-status
//              POST {endpoint}/v2/billing/meter/daily-checkin
//              endpoint 默认 https://copilot.tencent.com，可在账户里覆盖
//   Trae:      POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status
//              POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim
//              头必须是 Authorization: Cloud-IDE-JWT <jwt>（不是 Bearer）
//   WorkBuddy 刷新: POST https://www.codebuddy.cn/v2/plugin/auth/token/refresh
//
// 运行时兼容：平台注入 TOOL_RUNTIME 时用平台运行时；本地独立调试回退
// 仓库 runtime.js，再回退内置最小实现。未注入 TOOL_PORT 默认监听 3935。
// =====================================================================
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ------------------------------------------------------------------
// 工具运行时加载（三级回退）
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

class MinimalToolServer {
  constructor(opts = {}) {
    this.dir = path.resolve(opts.dir || ".");
    this.routes = opts.routes || {};
    this.index = opts.index || "index.html";
    this.server = null;
  }
  route(p, h) { this.routes[p] = h; return this; }
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
      // handler 直接拿到原始 req/res，可自行决定响应格式
      const url = new URL(req.url, "http://localhost");
      const handler = this.routes[url.pathname];
      if (handler) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try { handler(req, res, body); } catch (e) {
            try { res.json({ ok: false, error: String((e && e.message) || e) }); } catch { /* ignore */ }
          }
        });
        return;
      }
      if (req.method === "GET") { this._serveStatic(url.pathname, res); return; }
      res.writeHead(404); res.end("Not Found");
    });
    this.server = server;
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
  const repoRuntime = path.join(__dirname, "..", "..", "src-tauri", "resources", "runtime", "runtime.js");
  try {
    if (fs.existsSync(repoRuntime)) return require(repoRuntime).ToolServer;
  } catch { /* 忽略 */ }
  return MinimalToolServer;
}

const ToolServer = loadToolServer();

// ------------------------------------------------------------------
// 存储：accounts.json / config.json / pool.log（全在工具目录）
// ------------------------------------------------------------------
const DIR = __dirname;
const ACCOUNTS_FILE = path.join(DIR, "accounts.json");
const CONFIG_FILE = path.join(DIR, "config.json");
const LOG_FILE = path.join(DIR, "pool.log");

// Trae 扫码登录常量（与官方桌面端一致）
const TRAE_CLIENT_ID = "en1oxy7wnw8j9n";
const TRAE_APP_VERSION = "0.1.43";
const TRAE_API_HOST = "https://api.trae.com.cn";
const TRAE_LOGIN_BASE = "https://www.trae.cn/authorization";
const TRAE_CALLBACK_URL = "http://127.0.0.1:18080/authorize";

const DEFAULT_CONFIG = {
  autoSignHour: 9,       // 每天几点自动查+签（0-23，-1=关闭）；若该时间没开机，下次启动后补签
  lastAutoSignDay: "",   // 上次自动签到的本地日期（防重复）
};

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return fallback; }
}
function writeJSON(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  try { fs.renameSync(tmp, file); }
  catch { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
}
function localTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function appendLog(line) {
  try { fs.appendFileSync(LOG_FILE, `[${localTimestamp()}] ${line}\n`); } catch { /* 忽略 */ }
}

function loadAccounts() {
  const obj = readJSON(ACCOUNTS_FILE, null);
  if (obj && Array.isArray(obj.accounts)) return obj.accounts;
  return [];
}
function saveAccounts(accounts) {
  writeJSON(ACCOUNTS_FILE, { version: 1, accounts });
}
function loadConfig() {
  const obj = readJSON(CONFIG_FILE, null);
  return { ...DEFAULT_CONFIG, ...(obj || {}) };
}
function saveConfig(cfg) {
  writeJSON(CONFIG_FILE, cfg);
}

// ------------------------------------------------------------------
// 账户规范化与脱敏
// ------------------------------------------------------------------
function newId() { return crypto.randomBytes(4).toString("hex"); }

function normalizeAccount(input, prev) {
  const a = { ...(prev || {}) };
  if (input.remark !== undefined) a.remark = String(input.remark || "").trim().slice(0, 60);
  if (input.type !== undefined) a.type = input.type;
  if (!["workbuddy", "trae"].includes(a.type)) throw new Error("账户类型必须是 workbuddy / trae");
  if (input.enabled !== undefined) a.enabled = !!input.enabled;
  if (a.enabled === undefined) a.enabled = true;
  // 各类型凭据（空字符串视为清空）
  for (const k of ["accessToken", "refreshToken", "uid", "domain", "endpoint",
    "token", "deviceId", "machineId"]) {
    if (input[k] !== undefined) a[k] = String(input[k] || "").trim();
  }
  if (input.expiresAt !== undefined) {
    const t = Number(input.expiresAt);
    if (Number.isFinite(t)) a.expiresAt = t; // 到期时间，毫秒时间戳
  }
  if (!a.remark) throw new Error("请填写备注名（如：主力号/小号1），方便区分");
  if (a.type === "workbuddy" && !a.accessToken) throw new Error("WorkBuddy 账户缺少 accessToken");
  if (a.type === "trae" && !a.token) throw new Error("Trae 账户缺少 token（JWT）");
  if (a.type === "trae" && !a.deviceId) throw new Error("Trae 账户缺少 deviceId（签到强绑设备，没有它会 9074）");
  if (a.endpoint) a.endpoint = a.endpoint.replace(/\/+$/, "");
  // 兼容旧版本残留的中转字段：直接丢弃（本工具只做签到）
  delete a.upstreamBaseUrl; delete a.apiKey; delete a.model; delete a.weight;
  return a;
}

function maskToken(s) {
  s = String(s || "");
  if (!s) return "";
  if (s.length <= 12) return s.slice(0, 3) + "****";
  return s.slice(0, 6) + "****" + s.slice(-4) + `（${s.length}位）`;
}

function publicAccount(a) {
  return {
    id: a.id,
    remark: a.remark,
    type: a.type,
    enabled: a.enabled !== false,
    uid: a.uid ? maskToken(a.uid) : "",
    deviceId: a.deviceId ? maskToken(a.deviceId) : "",
    accessToken: a.accessToken ? maskToken(a.accessToken) : "",
    refreshToken: a.refreshToken ? "已保存" : "",
    token: a.token ? maskToken(a.token) : "",
    expiresAt: a.expiresAt || null,
    endpoint: a.endpoint || "",
    credits: a.credits ?? null,
    signinCredits: a.signinCredits ?? null,
    resources: Array.isArray(a.resources) ? a.resources : [],
    checkedIn: a.checkedIn ?? null,
    lastCheck: a.lastCheck || null,
    lastSign: a.lastSign || null,
    lastError: a.lastError || "",
    cooldownUntil: a.cooldownUntil || 0,
    failCount: a.failCount || 0,
    createdAt: a.createdAt || 0,
    updatedAt: a.updatedAt || 0,
  };
}

// 从 JWT 里尽力解出 uid（WorkBuddy 需要 X-User-Id；用户没填时自动推导）
function jwtPayload(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch { return null; }
}
function deriveUid(account) {
  if (account.uid) return account.uid;
  const p = jwtPayload(account.accessToken || "");
  if (p && typeof p === "object") {
    for (const k of ["uid", "uin", "oneidAccountId", "sub", "userId", "user_id"]) {
      if (p[k] !== undefined && String(p[k]).trim()) return String(p[k]).trim();
    }
  }
  return "";
}

// ------------------------------------------------------------------
// 上游 HTTP（内置 https，无依赖，支持超时）
// ------------------------------------------------------------------
function upstreamRequest({ url, method = "POST", headers = {}, body = null, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const payload = body != null ? (typeof body === "string" ? body : JSON.stringify(body)) : null;
    const req = mod.request(u, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(payload != null ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (resp) => {
      let buf = "";
      resp.setEncoding("utf8");
      resp.on("data", (c) => {
        buf += c;
        if (buf.length > 4 * 1024 * 1024) req.destroy(new Error("上游响应过大"));
      });
      resp.on("end", () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch { json = null; }
        resolve({ status: resp.statusCode || 0, json, text: buf });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`上游超时（${timeoutMs}ms）`)));
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

// ---- Trae 直签 ----
async function traeStatus(account, timeoutMs) {
  const r = await upstreamRequest({
    url: "https://api.trae.cn/trae/api/v2/ug/checkin_credits/status",
    method: "POST",
    headers: {
      Authorization: "Cloud-IDE-JWT " + account.token,
      "x-device-id": account.deviceId,
      "User-Agent": "quota-pool/0.1.0",
    },
    body: {},
    timeoutMs,
  });
  if (r.status === 401 || r.status === 403) throw new Error("Trae token 无效或已过期（HTTP 401/403），请重新获取");
  const d = r.json || {};
  if (typeof d.code !== "undefined" && d.code !== 0) {
    if (d.code === 1001) throw new Error("Trae 认证失败 code=1001：鉴权头必须用 Cloud-IDE-JWT 前缀，或 token 已失效");
    if (d.code === 9074) throw new Error("Trae 返回 9074：deviceId 与该账号未绑定（必须用该账号自己电脑绑定过的 deviceId）");
    throw new Error(`Trae 状态查询失败 code=${d.code}：${d.message || r.text.slice(0, 120)}`);
  }
  const out = {
    enable: d.enable !== false,
    checkedIn: !!d.checked_in,
    // 注意：status 的 credits 是签到活动口径，不是剩余额度；剩余额度看下面的用量接口
    credits: typeof d.credits === "number" ? d.credits : null,
    signinCredits: null,
    raw: d,
  };
  // 权威剩余额度：用量接口 usage_summary.total - consumed；签到奖励累计单独算
  try {
    const u = await upstreamRequest({
      url: "https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage",
      method: "POST",
      headers: {
        Authorization: "Cloud-IDE-JWT " + account.token,
        "x-device-id": account.deviceId,
        "User-Agent": "quota-pool/0.1.0",
      },
      body: {},
      timeoutMs,
    });
    const ud = u.json || {};
    const packs = Array.isArray(ud.user_entitlement_pack_list) ? ud.user_entitlement_pack_list : [];
    let signin = 0;
    for (const p of packs) {
      if (!p || typeof p !== "object") continue;
      const bi = p.entitlement_base_info || {};
      const pe = bi.product_extra || {};
      const pkg = pe.package_extra || {};
      if (pkg.package_name === "签到奖励") {
        const lim = Number((bi.quota || {}).credits_limit);
        if (Number.isFinite(lim)) signin += lim;
      }
    }
    if (signin) out.signinCredits = signin;
    const sum = ud.usage_summary || {};
    const total = Number(sum.total_amount);
    const used = Number(sum.consumed_amount);
    if (Number.isFinite(total) && Number.isFinite(used)) out.credits = total - used;
  } catch { /* 用量接口失败就沿用 status 的 credits，不报错 */ }
  return out;
}

async function traeClaim(account, timeoutMs) {
  const r = await upstreamRequest({
    url: "https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim",
    method: "POST",
    headers: {
      Authorization: "Cloud-IDE-JWT " + account.token,
      "x-device-id": account.deviceId,
      "User-Agent": "quota-pool/0.1.0",
    },
    body: {},
    timeoutMs,
  });
  const d = r.json || {};
  if (typeof d.code !== "undefined" && d.code !== 0) {
    if (d.code === 1001) throw new Error("Trae 认证失败 code=1001：token 失效或鉴权头错误");
    if (d.code === 9074) throw new Error("Trae 返回 9074：deviceId 未绑定，积分未到账（需换该账号绑定过的 deviceId）");
    throw new Error(`Trae 签到失败 code=${d.code}：${d.message || r.text.slice(0, 120)}`);
  }
  return d;
}

// ---- WorkBuddy 直签 ----
function wbEndpoint(account) {
  return (account.endpoint || "https://copilot.tencent.com").replace(/\/+$/, "");
}
function wbHeaders(account) {
  const uid = deriveUid(account);
  const h = {
    Authorization: "Bearer " + account.accessToken,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "WorkBuddy/5.3.5",
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Version": "5.3.5",
    "X-Product": "WorkBuddy",
  };
  if (uid) h["X-User-Id"] = uid;
  if (account.domain) h["X-Domain"] = account.domain;
  return h;
}

async function wbStatus(account, timeoutMs) {
  const r = await upstreamRequest({
    url: wbEndpoint(account) + "/v2/billing/meter/checkin-activity-status",
    method: "POST",
    headers: wbHeaders(account),
    body: {},
    timeoutMs,
  });
  if (r.status === 401 || r.status === 403) throw new Error("WorkBuddy token 已过期（HTTP 401/403），请点“刷新”或重新粘贴");
  const d = (r.json && r.json.data) || {};
  if (r.json && r.json.code !== undefined && r.json.code !== 0 && r.json.code !== "0") {
    throw new Error(`WorkBuddy 状态查询失败 code=${r.json.code}`);
  }
  const out = {
    active: d.active !== false,
    checkedIn: !!d.today_checked_in,
    // 注意：这里的 total_credits 是签到活动口径，不是账户剩余额度；剩余额度看下面的资源接口
    credits: typeof d.total_credits === "number" ? d.total_credits : null,
    signinCredits: typeof d.total_credits === "number" ? d.total_credits : null,
    streak: d.streak_days || 0,
    raw: d,
  };
  // 权威剩余额度：资源接口各套餐剩余之和
  try {
    const rr = await upstreamRequest({
      url: wbEndpoint(account) + "/v2/billing/meter/get-user-resource",
      method: "POST",
      headers: wbHeaders(account),
      body: {},
      timeoutMs,
    });
    const payload = (rr.json && rr.json.data) || {};
    const resp = payload.Response || {};
    const data = resp.Data || {};
    const resources = Array.isArray(data.Accounts) ? data.Accounts : [];
    let remain = 0, found = false;
    let cycleRemain = 0, cycleFound = false;
    const resList = [];
    for (const item of resources) {
      if (!item || typeof item !== "object") continue;
      let v = item.CapacityRemainPrecise;
      if (v === undefined || v === null) v = item.CapacityRemain;
      const n = Number(v);
      if (Number.isFinite(n)) { remain += n; found = true; }
      // 分包明细（只留展示字段，方便和客户端对账）
      let cv = item.CycleCapacityRemainPrecise;
      if (cv === undefined || cv === null) cv = item.CycleCapacityRemain;
      const cn = Number(cv);
      const cFin = Number.isFinite(cn);
      if (cFin) { cycleRemain += cn; cycleFound = true; }
      resList.push({
        name: String(item.PackageName || item.ProductName || item.DealName || "").slice(0, 60),
        unit: String(item.CapacityUnit || item.OriginUnit || "").slice(0, 16),
        remaining: Number.isFinite(n) ? n : null,
        cycleRemaining: cFin ? cn : null,
        status: item.Status,
      });
      if (resList.length >= 100) break;
    }
    // 客户端按“周期剩”展示（如体验版剩 500 但周期剩 0 就不计入）；有周期数据时优先用它
    const round2 = (x) => Math.round(x * 100) / 100;
    if (cycleFound) out.credits = round2(cycleRemain);
    else if (found) out.credits = round2(remain);
    out.resources = resList;
  } catch { /* 资源接口失败就沿用活动口径，不报错 */ }
  return out;
}

async function wbClaim(account, timeoutMs) {
  const r = await upstreamRequest({
    url: wbEndpoint(account) + "/v2/billing/meter/daily-checkin",
    method: "POST",
    headers: wbHeaders(account),
    body: {},
    timeoutMs,
  });
  if (r.status === 401 || r.status === 403) throw new Error("WorkBuddy token 已过期（HTTP 401/403），请点“刷新”或重新粘贴");
  if (r.json && r.json.code !== undefined && r.json.code !== 0 && r.json.code !== "0") {
    throw new Error(`WorkBuddy 签到失败 code=${r.json.code}：${(r.json.msg || r.json.message || "").toString().slice(0, 120)}`);
  }
  return r.json || { ok: true };
}

async function wbRefresh(account, timeoutMs) {
  if (!account.refreshToken) throw new Error("该账户没有保存 refreshToken，无法自动刷新，请重新粘贴完整登录态");
  const r = await upstreamRequest({
    url: "https://www.codebuddy.cn/v2/plugin/auth/token/refresh",
    method: "POST",
    headers: {
      Authorization: "Bearer " + account.accessToken,
      "X-Refresh-Token": account.refreshToken,
      "X-Auth-Refresh-Source": "plugin",
      "X-Product": "SaaS",
      "Content-Type": "application/json",
    },
    body: {},
    timeoutMs,
  });
  const d = (r.json && r.json.data) || null;
  if (r.status !== 200 || !d || !d.accessToken) {
    throw new Error("刷新失败：refreshToken 可能已过期（约90天），请在 WorkBuddy 客户端重新登录后粘贴");
  }
  return {
    accessToken: d.accessToken,
    refreshToken: d.refreshToken || account.refreshToken,
    expiresAt: d.expiresIn ? Date.now() + Number(d.expiresIn) * 1000 : account.expiresAt,
  };
}

// ------------------------------------------------------------------
// Trae 扫码登录 + refreshToken 续期（免外部脚本，逻辑与官方 login.ps1 一致）
// ------------------------------------------------------------------
function safeJSON(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* 回调参数已由 URL 解码，直接解析即可 */ }
  return null;
}

/** 读本机 TraeWork 已绑定的 deviceId（签到按它校验；没有则返回 ""） */
function readTraeDeviceId() {
  const cands = [
    process.env.APPDATA && path.join(process.env.APPDATA, "TRAE SOLO CN", "ModularData", "ckg_server", "local_env.json"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "TRAE SOLO CN", "ModularData", "ckg_server", "local_env.json"),
  ].filter(Boolean);
  for (const f of cands) {
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
      if (j && j.device_id) return String(j.device_id);
    } catch { /* 下一个 */ }
  }
  return "";
}

/** 用 refreshToken 换 access token（毫秒时间戳的 expiresAt 一起返回） */
async function traeExchange(refreshToken, timeoutMs) {
  const r = await upstreamRequest({
    url: TRAE_API_HOST + "/cloudide/api/v3/trae/oauth/ExchangeToken",
    method: "POST",
    headers: { "User-Agent": "Trae/" + TRAE_APP_VERSION },
    body: { ClientID: TRAE_CLIENT_ID, RefreshToken: refreshToken, ClientSecret: "-", UserID: "" },
    timeoutMs,
  });
  const result = (r.json && (r.json.Result || r.json.result)) || {};
  const token = result.Token || result.token || "";
  if (!token) throw new Error("ExchangeToken 失败：refreshToken 无效或已过期，请重走扫码登录");
  let exp = Number(result.TokenExpireAt || result.tokenExpireAt) || 0;
  if (exp > 1e12) exp = Math.floor(exp / 1000); // 毫秒转秒
  if (!exp || exp <= Date.now() / 1000) {
    exp = Math.floor(Date.now() / 1000) + (Number(result.TokenExpireDuration) || 1209600);
  }
  return {
    token,
    refreshToken: result.RefreshToken || result.refreshToken || refreshToken,
    expiresAt: exp * 1000,
  };
}

async function traeUserInfo(token, timeoutMs) {
  const r = await upstreamRequest({
    url: TRAE_API_HOST + "/cloudide/api/v3/trae/GetUserInfo",
    method: "POST",
    headers: { "x-cloudide-token": token, "User-Agent": "Trae/" + TRAE_APP_VERSION },
    body: { ReqSource: "IDE", IDEVersion: TRAE_APP_VERSION },
    timeoutMs,
  });
  return (r.json && (r.json.Result || r.json.result)) || {};
}

// ------------------------------------------------------------------
// 查状态 / 签到（单号）
// ------------------------------------------------------------------
async function checkOne(account, timeoutMs) {
  if (account.type === "trae") return traeStatus(account, timeoutMs);
  if (account.type === "workbuddy") return wbStatus(account, timeoutMs);
  throw new Error("未知账户类型，请删除后重建");
}

async function claimOne(account, timeoutMs) {
  if (account.type === "trae") {
    const st = await traeStatus(account, timeoutMs);
    if (!st.enable) return { skipped: true, reason: "活动未开启（enable=false，非故障）" };
    if (st.checkedIn) return { skipped: true, reason: "今日已签到，跳过（幂等）", credits: st.credits };
    await traeClaim(account, timeoutMs);
    const after = await traeStatus(account, timeoutMs);
    return { skipped: false, credits: after.credits };
  }
  // workbuddy
  if (account.type !== "workbuddy") throw new Error("未知账户类型，请删除后重建");
  const st = await wbStatus(account, timeoutMs);
  if (st.checkedIn) return { skipped: true, reason: "今日已签到，跳过（幂等）" };
  await wbClaim(account, timeoutMs);
  return { skipped: false };
}

function persistCheckResult(id, patch) {
  const accounts = loadAccounts();
  const a = accounts.find((x) => x.id === id);
  if (!a) return;
  Object.assign(a, patch, { updatedAt: Date.now() });
  saveAccounts(accounts);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 致命错误不重试：token 失效、设备未绑定、缺凭据——重试多少次都没用 */
function isFatalSignError(msg) {
  return /9074|1001|401|403|过期|无效|缺少|未知账户|重新登录|重新粘贴|refreshToken|deviceId/i.test(String(msg || ""));
}

/**
 * 带重试的签到：最多 tries 次，间隔 10s、30s；致命错误直接返回不再试。
 * @returns {{ok, result?, error?, attempts}}
 */
async function claimWithRetry(account, timeoutMs, tries, tag) {
  let lastMsg = "";
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await claimOne(account, timeoutMs);
      if (i > 1) appendLog(`${tag} ${account.remark}：第 ${i} 次重试成功`);
      return { ok: true, result: r, attempts: i };
    } catch (e) {
      lastMsg = String((e && e.message) || e).slice(0, 200);
      if (isFatalSignError(lastMsg)) {
        appendLog(`${tag} ${account.remark} 失败（不再重试）：${lastMsg}`);
        return { ok: false, error: lastMsg, attempts: i };
      }
      if (i === tries) break;
      appendLog(`${tag} ${account.remark} 第 ${i} 次失败，${i === 1 ? 10 : 30} 秒后重试：${lastMsg}`);
      await sleep(i === 1 ? 10 * 1000 : 30 * 1000);
    }
  }
  appendLog(`${tag} ${account.remark} 失败（共试 ${tries} 次）：${lastMsg}`);
  return { ok: false, error: `${lastMsg}（共试 ${tries} 次）`.slice(0, 220), attempts: tries };
}

// ------------------------------------------------------------------
// 每日自动签到（best-effort，失败只记日志）
// ------------------------------------------------------------------
let lastAutoSignDay = "";
let schedulerWarned = false;
function localDay(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/** 单实例定时锁：同一时间只允许一个进程跑自动签到（多开会导致重复签到甚至 10001） */
const LOCK_FILE = path.join(DIR, "scheduler.lock");
function acquireSchedulerRole() {
  let cur = null;
  try { cur = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8").replace(/^\uFEFF/, "")); } catch { /* 无锁 */ }
  if (cur && cur.pid && cur.pid !== process.pid) {
    let alive = false;
    try { process.kill(cur.pid, 0); alive = true; } catch { /* 进程已死，接管 */ }
    if (alive) {
      if (!schedulerWarned) {
        schedulerWarned = true;
        appendLog(`检测到另一实例（pid=${cur.pid}）已在跑定时，本实例只提供界面不重复签到`);
      }
      return false;
    }
  }
  try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch { /* 忽略 */ }
  return true;
}

/** 签到成功后顺手刷新额度/状态并落盘，界面不用再点检查 */
async function refreshStatusInto(id, timeoutMs, tag) {
  const accounts = loadAccounts();
  const a = accounts.find((x) => x.id === id);
  if (!a) return;
  const st = await checkOne(a, timeoutMs);
  const patch = { lastCheck: Date.now() };
  if (typeof st.credits === "number") patch.credits = st.credits;
  if (typeof st.signinCredits === "number") patch.signinCredits = st.signinCredits;
  if (typeof st.checkedIn === "boolean") patch.checkedIn = st.checkedIn;
  if (Array.isArray(st.resources)) patch.resources = st.resources;
  persistCheckResult(id, patch);
}

async function autoSignTick() {
  if (!acquireSchedulerRole()) return;
  const cfg = loadConfig();
  if (cfg.autoSignHour === -1) return;
  const now = new Date();
  const day = localDay(now);
  if (cfg.lastAutoSignDay === day || lastAutoSignDay === day) return;
  // 到点即跑；若整点时没开机（比如 9 点关机、12 点才开），开机后补跑
  const sched = new Date(now);
  sched.setHours(Number(cfg.autoSignHour), 0, 0, 0);
  if (now < sched) return;
  lastAutoSignDay = day;
  cfg.lastAutoSignDay = day;
  saveConfig(cfg);
  appendLog(`自动签到触发（每天 ${cfg.autoSignHour}:00）`);
  const accounts = loadAccounts().filter((a) => a.enabled !== false && isSupported(a));
  for (const a of accounts) {
    const r = await claimWithRetry(a, 15000, 3, "自动签到");
    if (r.ok) {
      persistCheckResult(a.id, { lastSign: Date.now(), lastError: "" });
      try {
        await refreshStatusInto(a.id, 15000);
      } catch (e) {
        appendLog(`自动签到 ${a.remark}：签后额度刷新失败，下次检查时更新：${String((e && e.message) || e).slice(0, 120)}`);
      }
      appendLog(`自动签到 ${a.remark}：${r.result.skipped ? r.result.reason : "成功"}`);
    } else {
      persistCheckResult(a.id, { lastError: r.error });
    }
  }
}
setInterval(autoSignTick, 60 * 1000);
setTimeout(autoSignTick, 30 * 1000); // 启动 30 秒后补跑一次，覆盖“整点没开机”的情况

// ------------------------------------------------------------------
// HTTP 服务
// ------------------------------------------------------------------
function parseBody(body) {
  try { return JSON.parse(body || "{}"); } catch { return {}; }
}
function asyncRoute(fn) {
  return (req, res, body) => {
    Promise.resolve()
      .then(() => fn(req, res, body))
      .catch((err) => {
        console.error("[quota-pool] 请求失败:", (err && err.stack) || err);
        try { res.json({ ok: false, error: String((err && err.message) || err).slice(0, 500) }); } catch { /* ignore */ }
      });
  };
}

function isSupported(a) { return a.type === "workbuddy" || a.type === "trae"; }

const server = new ToolServer({
  dir: __dirname,
  routes: {
    "/api/ping": (req, res) => res.json({ ok: true, msg: "pong", time: Date.now() }),

    "/api/accounts": asyncRoute((req, res, body) => {
      if (req.method === "GET") {
        return res.json({ ok: true, data: loadAccounts().map(publicAccount) });
      }
      const p = parseBody(body);
      const action = p.action || "create";
      const accounts = loadAccounts();
      if (action === "create") {
        const na = normalizeAccount(p.account || p, null);
        na.id = newId();
        na.createdAt = Date.now(); na.updatedAt = Date.now();
        accounts.push(na);
        saveAccounts(accounts);
        appendLog(`新增账户 ${na.remark}（${na.type}）`);
        return res.json({ ok: true, data: publicAccount(na) });
      }
      if (action === "update") {
        const a = accounts.find((x) => x.id === p.id);
        if (!a) return res.json({ ok: false, error: "账户不存在（可能已被删除）" });
        const merged = normalizeAccount({ ...a, ...(p.account || p.patch || {}), type: a.type }, a);
        Object.assign(a, merged, { id: a.id, updatedAt: Date.now() });
        saveAccounts(accounts);
        appendLog(`编辑账户 ${a.remark}`);
        return res.json({ ok: true, data: publicAccount(a) });
      }
      return res.json({ ok: false, error: `未知 action：${action}` });
    }),

    "/api/accounts/delete": asyncRoute((req, res, body) => {
      const { id } = parseBody(body);
      const accounts = loadAccounts();
      const next = accounts.filter((x) => x.id !== id);
      if (next.length === accounts.length) return res.json({ ok: false, error: "账户不存在" });
      saveAccounts(next);
      appendLog(`删除账户 ${id}`);
      return res.json({ ok: true });
    }),

    "/api/accounts/toggle": asyncRoute((req, res, body) => {
      const { id, enabled } = parseBody(body);
      const accounts = loadAccounts();
      const a = accounts.find((x) => x.id === id);
      if (!a) return res.json({ ok: false, error: "账户不存在" });
      a.enabled = !!enabled; a.updatedAt = Date.now();
      saveAccounts(accounts);
      return res.json({ ok: true, data: publicAccount(a) });
    }),

    "/api/accounts/check": asyncRoute(async (req, res, body) => {
      const { id } = parseBody(body);
      const list = id
        ? loadAccounts().filter((x) => x.id === id && isSupported(x))
        : loadAccounts().filter((x) => x.enabled !== false && isSupported(x));
      if (!list.length) return res.json({ ok: false, error: "没有可检查的账户（旧通用号请删除）" });
      const out = [];
      for (const a of list) {
        try {
          const st = await checkOne(a, 15000);
          const patch = { lastCheck: Date.now(), lastError: "", failCount: 0, cooldownUntil: 0 };
          if (typeof st.credits === "number") patch.credits = st.credits;
          if (typeof st.signinCredits === "number") patch.signinCredits = st.signinCredits;
          if (Array.isArray(st.resources)) patch.resources = st.resources;
          if (typeof st.checkedIn === "boolean") patch.checkedIn = st.checkedIn;
          persistCheckResult(a.id, patch);
          out.push({ id: a.id, remark: a.remark, ok: true, ...st });
        } catch (e) {
          const msg = String((e && e.message) || e).slice(0, 200);
          persistCheckResult(a.id, { lastCheck: Date.now(), lastError: msg });
          out.push({ id: a.id, remark: a.remark, ok: false, error: msg });
        }
      }
      appendLog(`手动检查 ${out.filter((x) => x.ok).length}/${out.length} 成功`);
      return res.json({ ok: true, data: out });
    }),

    "/api/accounts/claim": asyncRoute(async (req, res, body) => {
      const { id } = parseBody(body);
      const list = id
        ? loadAccounts().filter((x) => x.id === id && isSupported(x))
        : loadAccounts().filter((x) => x.enabled !== false && isSupported(x));
      if (!list.length) return res.json({ ok: false, error: "没有可签到的账户" });
      const out = [];
      for (const a of list) {
        const r = await claimWithRetry(a, 15000, 3, "手动签到");
        if (r.ok) {
          persistCheckResult(a.id, { lastSign: Date.now(), lastError: "" });
          try { await refreshStatusInto(a.id, 15000); } catch { /* 额度下次检查再更新 */ }
          appendLog(`手动签到 ${a.remark}：${r.result.skipped ? r.result.reason : "成功"}`);
          out.push({ id: a.id, remark: a.remark, ok: true, ...r.result });
        } else {
          persistCheckResult(a.id, { lastError: r.error });
          out.push({ id: a.id, remark: a.remark, ok: false, error: r.error });
        }
      }
      return res.json({ ok: true, data: out });
    }),

    "/api/accounts/refresh": asyncRoute(async (req, res, body) => {
      const { id } = parseBody(body);
      const accounts = loadAccounts();
      const a = accounts.find((x) => x.id === id);
      if (!a) return res.json({ ok: false, error: "账户不存在" });
      if (a.type === "workbuddy") {
        const r = await wbRefresh(a, 15000);
        a.accessToken = r.accessToken;
        if (r.refreshToken) a.refreshToken = r.refreshToken;
        if (r.expiresAt) a.expiresAt = r.expiresAt;
        a.lastError = ""; a.updatedAt = Date.now();
        saveAccounts(accounts);
        appendLog(`刷新 token ${a.remark} 成功`);
        return res.json({ ok: true, data: publicAccount(a) });
      }
      if (a.type === "trae") {
        if (!a.refreshToken) {
          return res.json({ ok: false, error: "该 Trae 号没有 refreshToken（内存抓的 JWT 自带不了），请走“扫码登录”重建" });
        }
        const r = await traeExchange(a.refreshToken, 15000);
        a.token = r.token;
        a.refreshToken = r.refreshToken;
        a.expiresAt = r.expiresAt;
        a.lastError = ""; a.updatedAt = Date.now();
        saveAccounts(accounts);
        appendLog(`刷新 token ${a.remark} 成功`);
        return res.json({ ok: true, data: publicAccount(a) });
      }
      return res.json({ ok: false, error: "未知账户类型" });
    }),

    // 一键导入本机 WorkBuddy 登录态（只能导当前登录的这一个号）
    "/api/accounts/import-local": asyncRoute(async (req, res) => {
      const cands = [
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"),
        process.env.APPDATA && path.join(process.env.APPDATA, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"),
      ].filter(Boolean);
      let doc = null;
      for (const f of cands) {
        try {
          doc = JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
          break;
        } catch { /* 下一个 */ }
      }
      if (!doc) return res.json({ ok: false, error: "没找到本机登录态文件，请先在 WorkBuddy 客户端登录一次" });
      const auth = doc.auth || {};
      const account = doc.account || {};
      if (!auth.accessToken) return res.json({ ok: false, error: "登录态文件里没有 accessToken，请在客户端重登" });
      const uid = String(account.uid || account.uin || account.oneidAccountId || "");
      const accounts = loadAccounts();
      let a = uid ? accounts.find((x) => x.type === "workbuddy" && x.uid === uid) : null;
      if (a) {
        a.accessToken = auth.accessToken;
        if (auth.refreshToken) a.refreshToken = auth.refreshToken;
        if (!a.uid && uid) a.uid = uid;
        a.updatedAt = Date.now();
        appendLog(`一键导入更新 ${a.remark}`);
      } else {
        a = {
          id: newId(), remark: "WorkBuddy-本机", type: "workbuddy", enabled: true,
          accessToken: auth.accessToken, refreshToken: auth.refreshToken || "",
          uid, domain: auth.domain || "",
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        accounts.push(a);
        appendLog("一键导入新增 WorkBuddy-本机");
      }
      saveAccounts(accounts);
      return res.json({ ok: true, data: publicAccount(a) });
    }),

    // Trae 扫码登录第 1 步：生成登录链接（优先复用本机已绑定 deviceId）
    "/api/trae/login-url": asyncRoute(async (req, res) => {
      const bound = readTraeDeviceId();
      const deviceId = bound || crypto.randomBytes(8).toString("hex");
      const machineId = crypto.randomBytes(8).toString("hex");
      const traceId = crypto.randomBytes(4).toString("hex");
      const params = {
        login_version: "1", auth_from: "solo", login_channel: "native_ide",
        plugin_version: "2.3.62834", auth_type: "local", client_id: TRAE_CLIENT_ID,
        redirect: "0", login_trace_id: traceId, auth_callback_url: TRAE_CALLBACK_URL,
        machine_id: machineId, device_id: deviceId,
        x_device_id: deviceId, x_machine_id: machineId,
        x_device_brand: "PC", x_device_type: "PC", x_os_version: "1.0",
        x_app_version: TRAE_APP_VERSION, x_app_type: "stable",
      };
      const loginUrl = TRAE_LOGIN_BASE + "?" + new URLSearchParams(params).toString();
      return res.json({ ok: true, data: { loginUrl, deviceId, machineId, reusedDevice: !!bound } });
    }),

    // Trae 扫码登录第 2 步：粘贴浏览器回调链接，换 token 并入库
    "/api/trae/login-callback": asyncRoute(async (req, res, body) => {
      const { callbackUrl, deviceId, machineId } = parseBody(body);
      if (!callbackUrl || !deviceId) {
        return res.json({ ok: false, error: "缺少回调链接或设备信息，请先点“生成登录链接”" });
      }
      let u;
      try { u = new URL(String(callbackUrl).trim()); }
      catch { return res.json({ ok: false, error: "回调链接格式不对，请复制浏览器地址栏的完整地址" }); }
      const q = u.searchParams;
      let refreshToken = q.get("refreshToken") || "";
      const userInfo = safeJSON(q.get("userInfo")) || {};
      const userJwt = safeJSON(q.get("userJwt")) || {};
      if (!refreshToken && userJwt.RefreshToken) refreshToken = userJwt.RefreshToken;
      const jwtToken = userJwt.Token || "";
      if (!refreshToken && !jwtToken) {
        return res.json({ ok: false, error: "回调里没有 refreshToken，请确认浏览器里已登录成功再复制地址" });
      }
      // 换 access token（优先 refreshToken，没有才用 userJwt 兜底）
      let token = "", newRefresh = refreshToken, expiresAt = 0;
      if (refreshToken) {
        const ex = await traeExchange(refreshToken, 20000);
        token = ex.token; newRefresh = ex.refreshToken; expiresAt = ex.expiresAt;
      } else {
        token = jwtToken;
        let exp = Number(userJwt.TokenExpireAt) || 0;
        if (exp > 1e12) exp = Math.floor(exp / 1000);
        expiresAt = exp ? exp * 1000 : 0;
      }
      // 拿 uid/昵称
      let uid = String(userInfo.UserID || "");
      let nickname = String(userInfo.ScreenName || "");
      try {
        const ui = await traeUserInfo(token, 15000);
        if (ui.UserID) {
          uid = String(ui.UserID);
          if (ui.ScreenName) nickname = String(ui.ScreenName);
        }
      } catch { /* 用回调里的信息 */ }
      if (!uid) return res.json({ ok: false, error: "未能获取 uid，token 可能无效，请重走登录" });
      const accounts = loadAccounts();
      let a = accounts.find((x) => x.type === "trae" && x.uid === uid);
      if (a) {
        a.token = token; a.refreshToken = newRefresh; a.expiresAt = expiresAt;
        a.deviceId = deviceId; if (machineId) a.machineId = machineId;
        a.lastError = ""; a.updatedAt = Date.now();
        appendLog(`扫码登录更新 ${a.remark}`);
      } else {
        a = {
          id: newId(), remark: `Trae-${nickname || uid.slice(0, 6)}`, type: "trae", enabled: true,
          token, refreshToken: newRefresh, expiresAt, uid,
          deviceId, machineId: machineId || "",
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        accounts.push(a);
        appendLog(`扫码登录新增 ${a.remark}`);
      }
      saveAccounts(accounts);
      return res.json({ ok: true, data: publicAccount(a) });
    }),

    "/api/config": asyncRoute((req, res, body) => {
      if (req.method === "GET") {
        return res.json({ ok: true, data: loadConfig() });
      }
      const p = parseBody(body);
      const cfg = loadConfig();
      if (p.autoSignHour !== undefined) {
        const h = Number(p.autoSignHour);
        cfg.autoSignHour = h === -1 ? -1 : Math.min(Math.max(Math.round(h) || 0, 0), 23);
      }
      saveConfig(cfg);
      return res.json({ ok: true, data: cfg });
    }),

    "/api/logs": (req, res) => {
      const url = new URL(req.url, "http://localhost");
      const tail = Math.min(Math.max(Number(url.searchParams.get("tail")) || 200, 1), 2000);
      let lines = [];
      try {
        const raw = fs.readFileSync(LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean);
        lines = raw.slice(-tail);
      } catch { lines = []; }
      res.json({ ok: true, data: lines });
    },

  },
});

const port = Number(process.env.TOOL_PORT) || 3935;
server.start(port).then((actual) => {
  console.log(`[quota-pool] listening on http://127.0.0.1:${actual}`);
  // 首次运行生成默认文件，方便用户直接编辑
  if (!fs.existsSync(ACCOUNTS_FILE)) saveAccounts([]);
  if (!fs.existsSync(CONFIG_FILE)) saveConfig(loadConfig());
  appendLog(`启动，端口 ${actual}`);
});
