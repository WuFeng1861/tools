// 即意 / consciousness-stream —— 后端（Node.js，零依赖）
//
// 忠实复刻本地 Electron 应用「即意」：把脑海中闪过的每个念头随手记进「清单」，
// 支持多清单、已完成子列表、主题色（含彩虹/流光）。
//
// 数据文件：<工具目录>/data.json（与 Electron 端 electron-store 同构，附加窗口字段）
// 运行时：优先取平台注入的 TOOL_RUNTIME，本地调试回退到仓库 runtime.js，再回退内置实现。
"use strict";

const fs = require("fs");
const path = require("path");

// ------------------------------------------------------------------ 运行时加载
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
  ".woff2": "font/woff2",
};

/** 找不到运行时时的最小 fallback：静态服务 + 路由 + res.json */
class MinimalToolServer {
  constructor(opts = {}) {
    this.dir = path.resolve(opts.dir || ".");
    this.routes = opts.routes || {};
    this.index = opts.index || "index.html";
  }

  route(p, h) {
    this.routes[p] = h;
    return this;
  }

  _serveStatic(urlPath, res) {
    let rel;
    try {
      rel = decodeURIComponent(urlPath || "/");
    } catch {
      rel = urlPath;
    }
    if (rel === "/") rel = "/" + this.index;
    const file = path.normalize(path.join(this.dir, rel));
    if (file !== this.dir && !file.startsWith(this.dir + path.sep)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  }

  start(port) {
    const http = require("http");
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
          try {
            handler(req, res, body);
          } catch (e) {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(String(e && e.stack ? e.stack : e));
          }
        });
        return;
      }
      if (req.method === "GET") {
        this._serveStatic(url.pathname, res);
        return;
      }
      res.writeHead(404);
      res.end("Not Found");
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve(server.address().port));
    });
  }

  stop() {}
}

function loadToolServer() {
  if (process.env.TOOL_RUNTIME) {
    try {
      const mod = require(process.env.TOOL_RUNTIME);
      if (mod && mod.ToolServer) return mod.ToolServer;
    } catch {
      /* 忽略 */
    }
  }
  // 本地独立调试：回退到平台仓库里的运行时（工具位于 tools/example/<name>，向上两级到 tools）
  const repoRuntime = path.join(
    __dirname, "..", "..",
    "src-tauri", "resources", "runtime", "runtime.js",
  );
  try {
    if (fs.existsSync(repoRuntime)) return require(repoRuntime).ToolServer;
  } catch {
    /* 忽略 */
  }
  return MinimalToolServer;
}

const ToolServer = loadToolServer();

// ------------------------------------------------------------------ 常量与状态
const DIR = __dirname;
const DATA_FILE = path.join(DIR, "data.json");
const LEGACY_DIR = path.join(DIR, "legacy");

const LEGACY_SOURCES = [
  path.join(process.env.APPDATA || "", "即意", "consciousness-stream.json"),
  path.join(process.env.APPDATA || "", "consciousness-stream", "consciousness-stream.json"),
];

const DEFAULT_DATA = {
  sessions: [],
  activeSessionId: null,
  themeColor: "#6366f1",
  rainbowMode: false,
  flowMode: false,
  windowWidth: 320,
  windowHeight: 500,
  savedColors: [],
  themeMode: "dark",
};

const state = {
  data: { ...DEFAULT_DATA },
  clients: new Set(), // SSE 客户端
};

// ------------------------------------------------------------------ 工具函数
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function parseBody(body) {
  try {
    const j = JSON.parse(body || "{}");
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

function ok(res, data) {
  res.json({ ok: true, data });
}

function fail(res, error, status = 200) {
  res.json({ ok: false, error }, status);
}

// ------------------------------------------------------------------ 持久化
function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") throw new Error("not an object");
    state.data = {
      ...DEFAULT_DATA,
      ...j,
      sessions: Array.isArray(j.sessions) ? j.sessions : [],
      savedColors: Array.isArray(j.savedColors) ? j.savedColors : [],
    };
  } catch {
    state.data = { ...DEFAULT_DATA };
    console.warn("[consciousness-stream] data.json 缺失或损坏，已按默认值启动");
  }
}

/** 原子写：先写 .tmp 再 rename，失败时 copy + unlink 兜底 */
function save() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state.data, null, 2));
  try {
    fs.renameSync(tmp, DATA_FILE);
  } catch {
    fs.copyFileSync(tmp, DATA_FILE);
    fs.unlinkSync(tmp);
  }
}

// ------------------------------------------------------------------ SSE
function broadcast() {
  const payload = `data: ${JSON.stringify({ type: "state-changed" })}\n\n`;
  for (const res of state.clients) {
    try {
      res.write(payload);
    } catch {
      state.clients.delete(res);
    }
  }
}

// ------------------------------------------------------------------ 清单/条目
function normalizeSession(session) {
  if (!Array.isArray(session.items)) session.items = [];
  if (!Array.isArray(session.completedItems)) session.completedItems = [];
  return session;
}

function createSession() {
  const d = state.data;
  const session = {
    id: generateId(),
    title: `清单 ${d.sessions.length + 1}`,
    items: [],
    completedItems: [],
    createdAt: Date.now(),
  };
  d.sessions.push(session);
  d.activeSessionId = session.id;
  return session;
}

/** 取当前清单；无清单则自动创建，activeSessionId 失效则回退到最后一个 */
function ensureActiveSession() {
  const d = state.data;
  const current = d.sessions.find((s) => s.id === d.activeSessionId);
  if (current) return normalizeSession(current);

  if (d.sessions.length > 0) {
    const fallback = normalizeSession(d.sessions[d.sessions.length - 1]);
    d.activeSessionId = fallback.id;
    save();
    return fallback;
  }
  const created = createSession();
  save();
  return created;
}

function sessionDto(session) {
  return {
    sessionId: session.id,
    title: session.title,
    items: session.items,
    completedItems: session.completedItems,
  };
}

function themeDto() {
  const d = state.data;
  return { color: d.themeColor, rainbow: d.rainbowMode, flow: d.flowMode, mode: d.themeMode };
}

// ------------------------------------------------------------------ 迁移辅助
function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    "-" +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

function countSessions(sessions) {
  let items = 0;
  let completed = 0;
  for (const s of sessions) {
    if (Array.isArray(s.items)) items += s.items.length;
    if (Array.isArray(s.completedItems)) completed += s.completedItems.length;
  }
  return { sessions: sessions.length, items, completed };
}

function legacySources() {
  return LEGACY_SOURCES.map((p) => {
    let exists = false;
    let size = 0;
    try {
      const st = fs.statSync(p);
      exists = true;
      size = st.size;
    } catch {
      /* 不存在 */
    }
    return { path: p, exists, size };
  });
}

function legacySnapshots() {
  let files = [];
  try {
    files = fs.readdirSync(LEGACY_DIR).filter((f) => /^legacy-export-.*\.json$/.test(f));
  } catch {
    files = [];
  }
  const list = files.map((file) => {
    const full = path.join(LEGACY_DIR, file);
    let size = 0;
    let mtime = 0;
    let summary = { sessions: 0, items: 0, completed: 0 };
    let error;
    try {
      const st = fs.statSync(full);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      /* 忽略 */
    }
    try {
      const j = JSON.parse(fs.readFileSync(full, "utf8"));
      summary = countSessions(Array.isArray(j.sessions) ? j.sessions : []);
    } catch (e) {
      error = String(e && e.message ? e.message : e);
    }
    const out = { file, path: full, size, mtime, ...summary };
    if (error) out.error = error;
    return out;
  });
  list.sort((a, b) => b.mtime - a.mtime);
  return list;
}

function normalizeItems(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    if (typeof it.content !== "string") continue; // 无 content 的条目跳过
    out.push({
      id: typeof it.id === "string" && it.id ? it.id : generateId(),
      content: it.content,
      createdAt: typeof it.createdAt === "number" ? it.createdAt : Date.now(),
    });
  }
  return out;
}

function normalizeLegacySession(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !raw.id) return null; // 无有效 id 的清单跳过
  return {
    id: raw.id,
    title: typeof raw.title === "string" && raw.title ? raw.title : "清单",
    items: normalizeItems(raw.items),
    completedItems: normalizeItems(raw.completedItems),
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
  };
}

// ------------------------------------------------------------------ HTTP 路由
const server = new ToolServer({ dir: DIR, routes: {} });

// 实际监听端口：平台随机分配（PORT_RANGE 30000-40000），
// 由 server.start() 回填，供界面展示，便于排查。
let listenPort = 0;

// 全量状态
server.route("/api/state", (req, res) => {
  const d = state.data;
  ok(res, {
    port: listenPort,
    sessions: d.sessions,
    activeSessionId: d.activeSessionId,
    themeColor: d.themeColor,
    rainbowMode: d.rainbowMode,
    flowMode: d.flowMode,
    savedColors: d.savedColors,
    themeMode: d.themeMode,
  });
});

// 当前清单（必要时自动创建/回退）
server.route("/api/session", (req, res) => {
  ok(res, sessionDto(ensureActiveSession()));
});

// 新建清单
server.route("/api/session/new", (req, res) => {
  const session = createSession();
  save();
  broadcast();
  ok(res, sessionDto(session));
});

// 切换清单
server.route("/api/session/select", (req, res, body) => {
  const { sessionId } = parseBody(body);
  const session = state.data.sessions.find((s) => s.id === sessionId);
  if (!session) return fail(res, "清单不存在", 404);
  state.data.activeSessionId = session.id;
  save();
  broadcast();
  ok(res, sessionDto(normalizeSession(session)));
});

// 重命名清单
server.route("/api/session/rename", (req, res, body) => {
  const { sessionId, title } = parseBody(body);
  const session = state.data.sessions.find((s) => s.id === sessionId);
  if (!session) return fail(res, "清单不存在", 404);
  const t = String(title == null ? "" : title).trim();
  if (t) session.title = t;
  save();
  broadcast();
  ok(res, { sessionId: session.id, title: session.title });
});

// 删除清单（若删的是当前，回退到剩余中 createdAt 最大者）
server.route("/api/session/delete", (req, res, body) => {
  const { sessionId } = parseBody(body);
  const before = state.data.sessions.length;
  state.data.sessions = state.data.sessions.filter((s) => s.id !== sessionId);
  if (state.data.sessions.length === before) {
    return ok(res, { activeSessionId: state.data.activeSessionId });
  }
  if (state.data.activeSessionId === sessionId) {
    let next = null;
    for (const s of state.data.sessions) {
      if (!next || (s.createdAt || 0) > (next.createdAt || 0)) next = s;
    }
    state.data.activeSessionId = next ? next.id : null;
  }
  save();
  broadcast();
  ok(res, { activeSessionId: state.data.activeSessionId });
});

// 新增条目
server.route("/api/items", (req, res, body) => {
  const { content } = parseBody(body);
  const text = String(content == null ? "" : content).trim();
  if (!text) return fail(res, "内容不能为空", 400);
  const session = ensureActiveSession();
  const item = { id: generateId(), content: text, createdAt: Date.now() };
  session.items.push(item);
  save();
  broadcast();
  ok(res, { item, items: session.items, completedItems: session.completedItems });
});

// 删除条目
server.route("/api/items/delete", (req, res, body) => {
  const { id } = parseBody(body);
  const session = ensureActiveSession();
  session.items = session.items.filter((it) => it.id !== id);
  save();
  broadcast();
  ok(res, { items: session.items, completedItems: session.completedItems });
});

// 条目排序
server.route("/api/items/reorder", (req, res, body) => {
  const { ids } = parseBody(body);
  const session = ensureActiveSession();
  if (Array.isArray(ids)) {
    const map = new Map(session.items.map((it) => [it.id, it]));
    session.items = ids.map((id) => map.get(id)).filter(Boolean);
  }
  save();
  broadcast();
  ok(res, { items: session.items });
});

// 完成条目（items → completedItems，追加到末尾）
server.route("/api/items/complete", (req, res, body) => {
  const { id } = parseBody(body);
  const session = ensureActiveSession();
  const idx = session.items.findIndex((it) => it.id === id);
  if (idx < 0) return fail(res, "条目不存在", 404);
  const [item] = session.items.splice(idx, 1);
  session.completedItems.push(item);
  save();
  broadcast();
  ok(res, { items: session.items, completedItems: session.completedItems });
});

// 删除已完成条目
server.route("/api/completed/delete", (req, res, body) => {
  const { id } = parseBody(body);
  const session = ensureActiveSession();
  session.completedItems = session.completedItems.filter((it) => it.id !== id);
  save();
  broadcast();
  ok(res, { items: session.items, completedItems: session.completedItems });
});

// 主题：读取
server.route("/api/theme", (req, res, body) => {
  if (req.method === "POST") {
    const j = parseBody(body);
    const d = state.data;
    if (j.color !== undefined) d.themeColor = j.color;
    if (j.rainbow !== undefined) d.rainbowMode = !!j.rainbow;
    if (j.flow !== undefined) d.flowMode = !!j.flow;
    if (j.mode !== undefined) d.themeMode = j.mode;
    save();
    broadcast();
  }
  ok(res, themeDto());
});

// 收藏色
server.route("/api/saved-colors", (req, res, body) => {
  if (req.method === "POST") {
    const { color } = parseBody(body);
    if (typeof color === "string" && color && !state.data.savedColors.includes(color)) {
      state.data.savedColors.push(color);
      save();
      broadcast();
    }
  }
  ok(res, { colors: state.data.savedColors });
});

server.route("/api/saved-colors/delete", (req, res, body) => {
  const { color } = parseBody(body);
  state.data.savedColors = state.data.savedColors.filter((c) => c !== color);
  save();
  broadcast();
  ok(res, { colors: state.data.savedColors });
});

// 迁移：状态
server.route("/api/legacy/status", (req, res) => {
  ok(res, { sources: legacySources(), snapshots: legacySnapshots() });
});

// 迁移：导出（把 Electron 端 data.json 原样快照到工具目录 legacy/）
server.route("/api/legacy/export", (req, res) => {
  try {
    const source = LEGACY_SOURCES.find((p) => fs.existsSync(p));
    if (!source) {
      return fail(res, "未找到即意的本地存储文件：" + LEGACY_SOURCES.join(" 或 "), 404);
    }
    const raw = fs.readFileSync(source, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return fail(res, "本地存储不是有效的 JSON：" + e.message);
    }
    const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    const summary = countSessions(sessions);

    fs.mkdirSync(LEGACY_DIR, { recursive: true });
    const target = path.join(LEGACY_DIR, `legacy-export-${timestamp()}.json`);
    fs.writeFileSync(target, raw); // 原样写入，不重新序列化
    console.log("[consciousness-stream] 导出快照 -> " + target);
    ok(res, { source, path: target, ...summary });
  } catch (e) {
    fail(res, "导出失败：" + (e && e.message ? e.message : e));
  }
});

// 迁移：导入（合并去重，不覆盖现有数据）
server.route("/api/legacy/import", (req, res, reqBody) => {
  try {
    const body = parseBody(reqBody);
    let snapshot = null;
    if (typeof body.path === "string" && body.path && fs.existsSync(body.path)) {
      snapshot = body.path;
    } else {
      const snaps = legacySnapshots(); // 新→旧
      if (snaps.length) snapshot = snaps[0].path;
    }
    if (!snapshot) return fail(res, "没有可导入的导出快照，请先执行导出");

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(snapshot, "utf8"));
    } catch (e) {
      return fail(res, "无法解析快照：" + e.message);
    }

    const d = state.data;
    const existing = new Set(d.sessions.map((s) => s.id));
    let imported = 0;
    let importedItems = 0;
    let importedCompleted = 0;

    const legacySessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    for (const raw of legacySessions) {
      const s = normalizeLegacySession(raw);
      if (!s) continue;
      if (existing.has(s.id)) continue; // 同 id 去重
      d.sessions.push(s);
      existing.add(s.id);
      imported++;
      importedItems += s.items.length;
      importedCompleted += s.completedItems.length;
    }

    // activeSessionId：仅在合法且已存在时采用
    if (typeof parsed.activeSessionId === "string" && existing.has(parsed.activeSessionId)) {
      d.activeSessionId = parsed.activeSessionId;
    } else if (!d.activeSessionId && d.sessions.length) {
      d.activeSessionId = d.sessions[d.sessions.length - 1].id;
    }

    // 主题：仅应用合法字段，非法值不覆盖
    if (typeof parsed.themeColor === "string" && parsed.themeColor.startsWith("#")) {
      d.themeColor = parsed.themeColor;
    }
    if (typeof parsed.rainbowMode === "boolean") d.rainbowMode = parsed.rainbowMode;
    if (typeof parsed.flowMode === "boolean") d.flowMode = parsed.flowMode;
    if (parsed.themeMode === "dark" || parsed.themeMode === "light") {
      d.themeMode = parsed.themeMode;
    }
    if (Array.isArray(parsed.savedColors)) {
      const colors = parsed.savedColors.filter((c) => typeof c === "string" && c.startsWith("#"));
      if (colors.length) d.savedColors = colors;
    }

    save();
    broadcast();
    console.log(
      "[consciousness-stream] 导入快照 <- " + snapshot +
        `（清单 ${imported} / 条目 ${importedItems} / 已完成 ${importedCompleted}）`,
    );
    ok(res, {
      path: snapshot,
      sessions: imported,
      items: importedItems,
      completed: importedCompleted,
      activeSessionId: d.activeSessionId,
    });
  } catch (e) {
    fail(res, "导入失败：" + (e && e.message ? e.message : e));
  }
});

// 面板 ×/Esc：写标记文件，平台轮询后隐藏面板
server.route("/api/panel-close", (req, res) => {
  try {
    fs.writeFileSync(path.join(DIR, ".quick-close"), JSON.stringify({ panelId: "main" }));
  } catch {
    /* 忽略 */
  }
  ok(res, { closed: true });
});

// 平台全局快捷键：写 .quick-toggle 标记，平台按面板可见性反转显示
server.route("/__platform/shortcut", (req, res, body) => {
  try {
    const j = parseBody(body);
    if (j.action === "toggle-panel" || j.shortcutId === "toggle-panel") {
      fs.writeFileSync(path.join(DIR, ".quick-toggle"), JSON.stringify({ panelId: "main" }));
    }
  } catch {
    /* 忽略 */
  }
  ok(res, { received: true });
});

// SSE：实时推送状态变化
server.route("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ type: "ready" })}\n\n`);
  state.clients.add(res);
  req.on("close", () => state.clients.delete(res));
  const hb = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(hb);
      state.clients.delete(res);
    }
  }, 20000);
  res.on("error", () => {
    clearInterval(hb);
    state.clients.delete(res);
  });
});

// ------------------------------------------------------------------ 启动
loadData();
// 平台会注入 TOOL_PORT；未注入时（本地独立调试）默认监听 3900
const port = Number(process.env.TOOL_PORT) || 3900;
server.start(port).then((actual) => {
  listenPort = actual;
  console.log("[consciousness-stream] 即意就绪 http://127.0.0.1:" + actual);
});

process.on("SIGINT", () => server.stop());
process.on("SIGTERM", () => server.stop());