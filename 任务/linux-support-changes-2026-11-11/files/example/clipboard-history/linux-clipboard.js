"use strict";

const { spawn } = require("child_process");
const crypto = require("crypto");

const LIMIT = 64 * 1024 * 1024;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FILE_TYPES = ["x-special/gnome-copied-files", "text/uri-list"];
const TEXT_TYPES = ["text/plain;charset=utf-8", "text/plain;charset=UTF-8", "UTF8_STRING", "text/plain", "TEXT", "STRING"];

function decodeFiles(text) {
  return text.split(/\r?\n/).filter((s) => s && s !== "copy" && s !== "cut" && !s.startsWith("#")).flatMap((s) => {
    try {
      const uri = new URL(s);
      if (uri.protocol !== "file:" || (uri.hostname && uri.hostname !== "localhost")) return [];
      const file = decodeURIComponent(uri.pathname);
      return file.includes("\0") ? [] : [file];
    } catch { return []; }
  });
}

function encodeFiles(files) {
  return files.map((p) => {
    if (!p.startsWith("/") || p.includes("\0")) throw new Error("文件路径不是有效的 Linux 绝对路径，请重新选择文件。");
    return "file://" + p.split("/").map(encodeURIComponent).join("/");
  }).join("\r\n") + "\r\n";
}

function createLinuxClipboard({ env = process.env, spawnProcess = spawn } = {}) {
  const wayland = env.TOOL_CLIPBOARD_BACKEND === "wayland" ||
    (env.TOOL_CLIPBOARD_BACKEND !== "x11" && (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland"));
  const backend = wayland ? "wayland" : "x11";
  const command = wayland ? "wl-paste" : "xclip";
  const readers = new Set();
  const owners = new Set();
  let stopPolling = null;
  let disposed = false;
  let error = "";
  const hint = wayland
    ? "Wayland 需要 wl-clipboard 及桌面的 data-control 后台剪贴板支持。Linux 不提供来源窗口名称。"
    : "X11 需要 xclip，并从当前图形会话启动。Linux 不提供来源窗口名称。";

  function session() {
    if (disposed) throw new Error("剪贴板服务已关闭");
    if (!(wayland ? env.WAYLAND_DISPLAY : env.DISPLAY)) {
      throw new Error(`未找到 ${wayland ? "Wayland" : "X11"} 图形会话，请从当前桌面会话启动平台。`);
    }
  }
  function explain(e) {
    if (e.code === "ENOENT") return `缺少 ${wayland ? "wl-clipboard（wl-copy / wl-paste）" : "xclip"}，请安装后重启监控。`;
    if (e.code === "ETIMEDOUT") return "读取系统剪贴板超时，请检查桌面会话是否允许后台访问剪贴板。";
    return e.message;
  }
  function readArgs(type) {
    return wayland ? (type ? ["--no-newline", "--type", type] : ["--list-types"])
      : ["-selection", "clipboard", "-out", "-target", type || "TARGETS"];
  }
  // 必须按字节读取图片，不经过 UTF-8 转码；有大小和超时上限。
  function runRead(type, timeout = 3000) {
    session();
    return new Promise((resolve, reject) => {
      const child = spawnProcess(command, readArgs(type), { env, stdio: ["ignore", "pipe", "pipe"] });
      readers.add(child);
      const chunks = [];
      let length = 0, stderr = "", settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        readers.delete(child);
        if (err) reject(err); else resolve(Buffer.concat(chunks));
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(Object.assign(new Error("剪贴板读取超时"), { code: "ETIMEDOUT" }));
      }, timeout);
      child.stdout.on("data", (chunk) => {
        length += chunk.length;
        if (length > LIMIT) { child.kill("SIGKILL"); finish(new Error("剪贴板内容超过 64 MiB，已跳过。")); }
        else chunks.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000); });
      child.on("error", finish);
      child.on("close", (code) => finish(code === 0 ? null : new Error(stderr.trim() || `${command} 退出码 ${code}`)));
    });
  }
  async function readSnapshot() {
    try {
      const types = (await runRead()).toString("utf8").trim().split(/\r?\n/);
      // 常见密码管理器会用此 MIME 标记敏感内容，不收录。
      if (types.includes("x-kde-passwordManagerHint")) return null;
      let type = FILE_TYPES.find((t) => types.includes(t));
      if (type) {
        const files = decodeFiles((await runRead(type)).toString("utf8"));
        return files.length ? { kind: "files", files } : null;
      }
      if (types.includes("image/png")) {
        const data = await runRead("image/png");
        if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          throw new Error("剪贴板没有返回有效的 PNG 图片。");
        }
        return { kind: "image", imageData: data, width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
      }
      type = TEXT_TYPES.find((t) => types.includes(t));
      if (!type) return null;
      return { kind: "text", text: (await runRead(type)).toString("utf8") };
    } catch (e) {
      // 空剪贴板，以及查询类型后选择被其他程序替换，属于正常情况。
      if (/nothing is copied|no selection|selection.*does not exist|target .* not available|mime type.*not available/i.test(e.message)) return null;
      throw new Error(explain(e));
    }
  }

  async function write(item, imageData) {
    session();
    let type, data;
    if (item.type === "text") { type = "text/plain;charset=utf-8"; data = Buffer.from(item.text || "", "utf8"); }
    else if (item.type === "image") { type = "image/png"; data = imageData; }
    else if (item.type === "files") { type = "text/uri-list"; data = Buffer.from(encodeFiles(item.files)); }
    else throw new Error("不支持的剪贴板内容类型");
    if (!Buffer.isBuffer(data) || data.length > LIMIT) throw new Error("剪贴板内容缺失或超过 64 MiB。");
    const writer = wayland ? "wl-copy" : "xclip";
    const args = wayland ? ["--foreground", "--type", type]
      : ["-selection", "clipboard", "-in", "-target", type, "-quiet"];
    const previous = [...owners];
    const owner = spawnProcess(writer, args, { env, stdio: ["pipe", "ignore", "pipe"] });
    owners.add(owner);
    let failure = null, stderr = "";
    owner.stderr.on("data", (d) => { stderr = (stderr + d.toString()).slice(-2000); });
    owner.on("error", (e) => { failure = e; });
    owner.stdin.on("error", (e) => { failure = e; });
    owner.on("close", (code) => {
      owners.delete(owner);
      if (code !== 0) failure = failure || new Error(stderr.trim() || `${writer} 退出码 ${code}`);
    });
    owner.stdin.end(data);
    try {
      // 前台持有选择，避免产生无人管理的后台副本；实际回读后才报告复制成功。
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await pause(50);
        if (failure) throw failure;
        if (disposed) throw new Error("剪贴板服务已关闭");
        const copied = await runRead(type, 1000).catch(() => null);
        if (copied?.equals(data)) {
          for (const old of previous) { try { old.kill(); } catch {} }
          error = "";
          return { out: "ok", err: "" };
        }
      }
      throw new Error("无法确认剪贴板写入，请检查桌面权限或剪贴板是否已被其他程序替换。");
    } catch (e) {
      owner.kill();
      throw new Error(explain(e));
    }
  }
  function start(getInterval, onSnapshot, onStatus) {
    if (stopPolling) stopPolling();
    let stopped = false, timer, signature = null, watcher = null;
    const poll = async () => {
      try {
        const snap = await readSnapshot();
        if (stopped || disposed) return;
        const next = snap ? crypto.createHash("sha256")
          .update(snap.kind).update(snap.imageData || (snap.kind === "files" ? JSON.stringify(snap.files) : snap.text)).digest("hex") : null;
        if (snap && next !== signature) await onSnapshot(snap);
        signature = next;
        if (error) { error = ""; onStatus(); }
      } catch (e) {
        if (!stopped && !disposed && error !== e.message) { error = e.message; onStatus(); }
      }
      if (!stopped && !disposed && !wayland) timer = setTimeout(poll, error ? 5000 : Math.min(10000, Math.max(100, Number(getInterval()) || 300)));
    };
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      if (watcher) watcher.kill();
      for (const child of readers) child.kill("SIGKILL");
    };
    stopPolling = stop;
    if (wayland) {
      // 事件驱动监控需要 data-control；不以不断弹出透明窗口的方式轮询受限桌面。
      try {
        session();
        watcher = spawnProcess("wl-paste", ["--watch", process.execPath, "-e",
          "setTimeout(()=>process.exit(0),3000).unref();process.stdin.resume();process.stdin.on('end',()=>console.log('changed'))"],
        { env, stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "", buffer = "", queued = false, reading = false;
        const drain = async () => {
          if (reading) return;
          reading = true;
          while (queued && !stopped && !disposed) { queued = false; await poll(); }
          reading = false;
        };
        watcher.stdout.on("data", (d) => {
          buffer += d.toString();
          if (buffer.includes("\n")) {
            buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
            queued = true; drain();
          }
        });
        watcher.stderr.on("data", (d) => { stderr = (stderr + d.toString()).slice(-2000); });
        watcher.on("error", (e) => { if (!stopped) { error = explain(e); onStatus(); } });
        watcher.on("close", () => {
          if (!stopped && !disposed) {
            error = error || `Wayland 后台监控已退出：${stderr.trim() || "请检查 data-control 支持"}。安装依赖或调整桌面后，请重新开启监控。`;
            onStatus();
          }
        });
      } catch (e) { error = explain(e); onStatus(); }
    } else poll();
    return { kill: stop };
  }
  function dispose() {
    disposed = true;
    if (stopPolling) stopPolling();
    for (const child of owners) child.kill();
  }
  return { readSnapshot, write, start, dispose, status: () => ({ backend, error, hint, sourceApp: false }) };
}

module.exports = { createLinuxClipboard, decodeFiles, encodeFiles };
