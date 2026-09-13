// 剪贴板历史工具后端 —— 后台常驻捕获文字/图片/文件历史，持久化到工具目录。
// 依赖：仅 Node 内置模块 + 系统 PowerShell（零原生 npm 模块）。
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const readline = require("readline");
const { spawn } = require("child_process");

const { ToolServer } = require(process.env.TOOL_RUNTIME);

const DIR = __dirname;
const IMG_DIR = path.join(DIR, "images");
const HISTORY_FILE = path.join(DIR, "history.json");
const SETTINGS_FILE = path.join(DIR, "settings.json");

const DEFAULT_SETTINGS = {
  monitoringEnabled: true,
  maxEntries: 200,
  maxImages: 50,
  pollIntervalMs: 300,
  dedupe: true,
  showSourceApp: true,
  keepPinnedOnClear: true,
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  items: [], // ts 倒序
  watcher: null,
  clients: new Set(), // SSE 客户端
};

// ------------------------------------------------------------------ 持久化
function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    const j = JSON.parse(raw);
    Object.assign(state.settings, DEFAULT_SETTINGS, j);
  } catch {
    /* 缺失/损坏用默认 */
  }
}

function saveSettings() {
  fs.writeFileSync(
    SETTINGS_FILE,
    JSON.stringify(state.settings, null, 2),
  );
}

function loadHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      state.items = arr
        .filter((x) => x && typeof x.id === "string")
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    }
  } catch {
    // 损坏则告警并空启（不崩溃）
    state.items = [];
    console.error("[clipboard] history.json 损坏，已按空历史启动");
  }
  const bad = state.items.filter((x) => !x.imageFile && !x.text && x.type === "image");
  if (bad.length) console.warn(`[clipboard] ${bad.length} 条图片记录的文件缺失`);
}

function historySnapshot() {
  return state.items.map((x) => ({ ...x }));
}

function saveHistory() {
  const tmp = HISTORY_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state.items, null, 2));
  try {
    fs.renameSync(tmp, HISTORY_FILE);
  } catch {
    fs.copyFileSync(tmp, HISTORY_FILE);
    fs.unlinkSync(tmp);
  }
}

// ------------------------------------------------------------------ SSE
function broadcast() {
  const payload = `data: ${JSON.stringify({ type: "history-changed" })}\n\n`;
  for (const res of state.clients) {
    try {
      res.write(payload);
    } catch {
      state.clients.delete(res);
    }
  }
}

// ------------------------------------------------------------------ 条目管理
function newId() {
  return crypto.randomBytes(6).toString("hex");
}

function removeItem(id) {
  const idx = state.items.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const item = state.items[idx];
  if (item.imageFile) {
    fs.rm(path.join(IMG_DIR, item.imageFile), { force: true }, () => {});
  }
  state.items.splice(idx, 1);
}

/** 判断两条记录内容是否相同（文字比内容、文件比清单、图片比文件哈希） */
function sameItem(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === "text") return a.text === b.text;
  if (a.type === "files")
    return JSON.stringify(a.files) === JSON.stringify(b.files);
  if (a.type === "image") return !!(a.sig && b.sig && a.sig === b.sig);
  return false;
}

/** 容量控制：图片张数上限 + 总条数上限（置顶项永不淘汰） */
function enforceLimits() {
  // 图片张数上限（置顶图片不占名额）
  let overImages =
    state.items.filter((x) => x.type === "image" && !x.pinned).length -
    state.settings.maxImages;
  while (overImages > 0) {
    const oldest = state.items
      .filter((x) => x.type === "image" && !x.pinned)
      .sort((a, b) => a.ts - b.ts)[0];
    if (!oldest) break;
    removeItem(oldest.id);
    overImages--;
  }

  // 总条数上限（置顶项不占名额）
  if (state.items.length > state.settings.maxEntries) {
    const pinnedCount = state.items.filter((x) => x.pinned).length;
    let removable = state.items.length - Math.max(pinnedCount, state.settings.maxEntries);
    while (removable > 0) {
      const oldest = state.items
        .filter((x) => !x.pinned)
        .sort((a, b) => a.ts - b.ts)[0];
      if (!oldest) break;
      removeItem(oldest.id);
      removable--;
    }
  }
}

async function pushSnapshot(snap) {
  const nl = {};
  if (snap.kind === "text") {
    const text = String(snap.text || "");
    if (!text) return;
    nl.type = "text";
    nl.text = text;
    nl.subText = text.slice(0, 80);
  } else if (snap.kind === "files") {
    const files = Array.isArray(snap.files) ? snap.files.map(String) : [];
    if (!files.length) return;
    nl.type = "files";
    nl.files = files;
    nl.subText = files.join(" · ");
  } else if (snap.kind === "image") {
    if (!snap.imageTemp || !fs.existsSync(snap.imageTemp)) return;
    const id = newId();
    const fileName = id + ".png";
    try {
      await fsp.mkdir(IMG_DIR, { recursive: true });
      await fsp.rename(snap.imageTemp, path.join(IMG_DIR, fileName));
    } catch {
      return;
    }
    const buf = await fsp.readFile(path.join(IMG_DIR, fileName));
    nl.type = "image";
    nl.imageFile = fileName;
    nl.imageSize = buf.length;
    nl.width = snap.width || 0;
    nl.height = snap.height || 0;
    nl.subText = `${nl.width}×${nl.height}`;
    nl.sig = crypto.createHash("sha256").update(buf).digest("hex");
  } else {
    return;
  }

  nl.id = newId();
  nl.ts = Date.now();
  nl.pinned = false;
  nl.sourceApp = state.settings.showSourceApp ? snap.sourceApp || "" : "";

  // 全局去重：删除历史中所有相同内容（文字/文件/图片），只保留最新这一条
  if (state.settings.dedupe) {
    for (let i = state.items.length - 1; i >= 0; i--) {
      if (sameItem(state.items[i], nl)) {
        const dup = state.items[i];
        if (dup.imageFile) {
          fs.rm(path.join(IMG_DIR, dup.imageFile), { force: true }, () => {});
        }
        state.items.splice(i, 1);
      }
    }
  }

  state.items.unshift(nl);
  enforceLimits();
  saveHistory();
  broadcast();
}

// ------------------------------------------------------------------ 回贴
function pasteCommand(mode) {
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$mode = $env:CLIP_MODE
try {
  if ($mode -eq 'text') {
    $t = [System.IO.File]::ReadAllText($env:CLIP_TEXT_FILE, [System.Text.Encoding]::UTF8)
    [System.Windows.Forms.Clipboard]::SetText($t)
  } elseif ($mode -eq 'image') {
    $img = [System.Drawing.Image]::FromFile($env:CLIP_IMG)
    $d = New-Object System.Windows.Forms.DataObject
    $d.SetImage($img)
    # 第2个参数 $true：退出后仍保留，否则复制完那边粘贴时已是空
    [System.Windows.Forms.Clipboard]::SetDataObject($d, $true)
  } elseif ($mode -eq 'files') {
    $paths = @(Get-Content -Path $env:CLIP_FILES_FILE | ForEach-Object { $_ })
    $arr = New-Object System.Collections.Specialized.StringCollection
    foreach ($p in $paths) { if ($p) { [void]$arr.Add($p) } }
    [System.Windows.Forms.Clipboard]::SetFileDropList($arr)
  }
  Write-Output "ok"
} catch {
  Write-Output ("err:" + $_.Exception.Message)
}`;
}

function runPs(script, env) {
  return new Promise((resolve) => {
    const p = spawn(
      "powershell",
      ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    p.stdout.on("data", (d) => (out += String(d)));
    let err = "";
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("error", () => resolve({ out, err }));
    p.on("exit", () => resolve({ out, err }));
  });
}

async function pasteItem(item) {
  const env = { CLIP_MODE: item.type };
  if (item.type === "text") {
    const tmp = path.join(os.tmpdir(), "clip_txt_" + newId() + ".txt");
    fs.writeFileSync(tmp, item.text, "utf8");
    env.CLIP_TEXT_FILE = tmp;
    const r = await runPs(pasteCommand("text"), env);
    fs.rm(tmp, { force: true }, () => {});
    return r;
  }
  if (item.type === "image") {
    env.CLIP_IMG = path.join(IMG_DIR, item.imageFile);
    return runPs(pasteCommand("image"), env);
  }
  if (item.type === "files") {
    const tmp = path.join(os.tmpdir(), "clip_files_" + newId() + ".txt");
    fs.writeFileSync(tmp, item.files.join("\n"), "utf8");
    env.CLIP_FILES_FILE = tmp;
    const r = await runPs(pasteCommand("files"), env);
    fs.rm(tmp, { force: true }, () => {});
    return r;
  }
  return null;
}

// ------------------------------------------------------------------ 监控
const MONITOR_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$src = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W32Clip {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder t, int n);
  public static string ActiveTitle() {
    IntPtr h = GetForegroundWindow();
    StringBuilder t = new StringBuilder(512);
    GetWindowText(h, t, 512);
    return t.ToString();
  }
}
"@
Add-Type -TypeDefinition $src
$last = [uint32]0
$pollMs = [int]($env:CLIP_POLL_MS)
while ($true) {
  Start-Sleep -Milliseconds $pollMs
  try {
    $seq = [W32Clip]::GetClipboardSequenceNumber()
    if ($seq -eq $last) { continue }
    $last = $seq
    $d = [System.Windows.Forms.Clipboard]::GetDataObject()
    if ($d -eq $null) { continue }
    if ($d.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
      $files = @([string[]]$d.GetData([System.Windows.Forms.DataFormats]::FileDrop))
      $o = @{ kind='files'; files=$files; sourceApp=[W32Clip]::ActiveTitle() }
      Write-Output ($o | ConvertTo-Json -Compress)
    } elseif ($d.GetDataPresent([System.Windows.Forms.DataFormats]::Bitmap)) {
      $img = $d.GetData([System.Windows.Forms.DataFormats]::Bitmap)
      $tmp = Join-Path $env:TEMP ("clip_" + [guid]::NewGuid().ToString('N') + ".png")
      $img.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
      $o = @{ kind='image'; imageTemp=$tmp; width=$img.Width; height=$img.Height; sourceApp=[W32Clip]::ActiveTitle() }
      Write-Output ($o | ConvertTo-Json -Compress)
    } else {
      $txt = [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText)
      if ($txt -ne $null) {
        $o = @{ kind='text'; text=$txt; sourceApp=[W32Clip]::ActiveTitle() }
        Write-Output ($o | ConvertTo-Json -Compress)
      }
    }
  } catch { }
}
`;

function startMonitor() {
  if (state.watcher) return;
  const p = spawn(
    "powershell",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", MONITOR_SCRIPT],
    {
      env: { ...process.env, CLIP_POLL_MS: String(state.settings.pollIntervalMs || 300) },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const rl = readline.createInterface({ input: p.stdout });
  rl.on("line", (line) => {
    try {
      const snap = JSON.parse(line);
      pushSnapshot(snap).catch(() => {});
    } catch {
      /* 忽略无效行 */
    }
  });
  p.on("error", (e) => console.error("[clipboard] 监控进程错误:", e.message));
  p.on("exit", (code) => {
    console.log("[clipboard] 监控进程退出 code=" + code);
    state.watcher = null;
    // 自动重拉，保证后台常驻
    if (state.settings.monitoringEnabled) startMonitor();
  });
  state.watcher = p;
  console.log("[clipboard] 剪贴板监控已启动");
}

function stopMonitor() {
  if (state.watcher) {
    try {
      state.watcher.kill();
    } catch {
      /* 忽略 */
    }
    state.watcher = null;
  }
}

function applyMonitoring() {
  if (state.settings.monitoringEnabled) startMonitor();
  else stopMonitor();
}

// ------------------------------------------------------------------ HTTP
const server = new ToolServer({ dir: DIR, routes: {} });

server.route("/api/history", (req, res, body) => {
  const url = new URL(req.url, "http://localhost");
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const type = (url.searchParams.get("type") || "").trim();
  let list = historySnapshot();
  if (type === "text" || type === "image" || type === "files") {
    list = list.filter((x) => x.type === type);
  }
  if (q) {
    list = list.filter(
      (x) =>
        (x.text || "").toLowerCase().includes(q) ||
        (x.subText || "").toLowerCase().includes(q) ||
        (x.files || []).some((f) => f.toLowerCase().includes(q)),
    );
  }
  res.json({ ok: true, data: { items: list, settings: state.settings } });
});

server.route("/api/delete", async (req, res, body) => {
  let id = "";
  try {
    id = JSON.parse(body || "{}").id;
  } catch {
    /* 忽略 */
  }
  removeItem(id);
  saveHistory();
  broadcast();
  res.json({ ok: true, data: {} });
});

server.route("/api/clear", (req, res, body) => {
  if (state.settings.keepPinnedOnClear) {
    state.items = state.items.filter((x) => x.pinned);
  } else {
    state.items = [];
  }
  // 删除不再引用的图片文件
  const keep = new Set(state.items.map((x) => x.imageFile).filter(Boolean));
  let stale = [];
  try {
    stale = fs.readdirSync(IMG_DIR).filter((f) => !keep.has(f));
  } catch {
    /* 目录不存在 */
  }
  for (const f of stale) fs.rm(path.join(IMG_DIR, f), { force: true }, () => {});
  saveHistory();
  broadcast();
  res.json({ ok: true, data: {} });
});

server.route("/api/pin", (req, res, body) => {
  let id = "";
  try {
    id = JSON.parse(body || "{}").id;
  } catch {
    /* 忽略 */
  }
  const it = state.items.find((x) => x.id === id);
  if (it) it.pinned = !it.pinned;
  saveHistory();
  broadcast();
  res.json({ ok: true, data: {} });
});

server.route("/api/paste", async (req, res, body) => {
  let id = "";
  try {
    id = JSON.parse(body || "{}").id;
  } catch {
    /* 忽略 */
  }
  const it = state.items.find((x) => x.id === id);
  if (!it) return res.json({ ok: false, error: "记录不存在" });
  const r = await pasteItem(it);
  const ok = !(r && r.out.startsWith("err:"));
  res.json({ ok, data: { done: true, out: r ? r.out.trim() : "" } });
});

server.route("/api/settings", (req, res, body) => {
  if (req.method === "POST") {
    try {
      const j = JSON.parse(body || "{}");
      const prevMonitoring = state.settings.monitoringEnabled;
      const prevPoll = state.settings.pollIntervalMs;
      Object.assign(state.settings, j);
      saveSettings();
      if (prevMonitoring !== state.settings.monitoringEnabled) {
        applyMonitoring();
      } else if (prevPoll !== state.settings.pollIntervalMs) {
        stopMonitor();
        applyMonitoring();
      }
      broadcast();
    } catch (e) {
      return res.json({ ok: false, error: e.message });
    }
  }
  res.json({ ok: true, data: state.settings });
});

// 面板 ×/Esc：写一个标记文件，由平台 Rust 侧周期检查并隐藏面板窗口
server.route("/api/panel-close", (req, res) => {
  try {
    fs.writeFileSync(path.join(DIR, ".quick-close"), String(Date.now()));
  } catch {
    /* 忽略 */
  }
  res.json({ ok: true, data: {} });
});

// 平台全局快捷键事件（manifest.shortcuts 声明；按下时平台转发到这里）。
// 用 .quick-toggle 标记请求“开/关”悬浮面板：平台按面板当前可见性反转，
// 因此按一次开、再按一次必关（即使曾被 ×/Esc 关闭过，下次也能正确重新打开）。
server.route("/__platform/shortcut", (req, res, body) => {
  let j = {};
  try {
    j = JSON.parse(body || "{}");
  } catch {
    /* 忽略 */
  }
  const isToggle =
    j.action === "toggle-quick" || j.shortcutId === "toggle-quick";
  if (isToggle) {
    fs.writeFileSync(path.join(DIR, ".quick-toggle"), JSON.stringify({ panelId: "quick" }));
  }
  res.json({ ok: true, data: { received: true } });
});

// SSE：实时推送历史变化
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

server.start()
  .then(() => {
    loadSettings();
    loadHistory();
    applyMonitoring();
    console.log(`[clipboard] 剪贴板历史就绪 ${new Date().toISOString()}`);
  });

process.on("SIGINT", () => stopMonitor());
process.on("SIGTERM", () => stopMonitor());