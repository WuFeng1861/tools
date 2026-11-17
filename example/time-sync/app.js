"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { performance } = require("node:perf_hooks");
const { SOURCES, detect, validateOptions } = require("./clock");
const { inspectSystem, manualSystem, guides } = require("./system");
const { syncLinux } = require("./linux-clock");

const execFileAsync = promisify(execFile);

async function syncWindows(offsetMs) {
  if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > 315360000000) throw new Error("时间偏差超过可校准范围（10 年），请先手动检查日期。");
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let stdout;
  try {
    ({ stdout } = await execFileAsync(executable, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(__dirname, "windows-clock.ps1"), "-OffsetMs", offsetMs.toFixed(4),
    ], { windowsHide: true, timeout: 150000, maxBuffer: 1024 * 1024, encoding: "utf8" }));
  } catch (error) {
    throw new Error(error.killed ? "等待管理员授权超时，请重新检测后重试。" : "无法启动 Windows 时间校准，请检查 PowerShell 和系统策略。");
  }
  let result;
  try { result = JSON.parse(stdout.trim()); }
  catch { throw new Error("Windows 校准没有返回有效结果，请重新检测确认当前时间。"); }
  const messages = {
    5: "没有修改系统时间的权限，请由管理员检查“更改系统时间”权限或组策略。",
    13: "Windows 拒绝校准或执行失败，请检查系统策略，然后重新检测。",
    14: "管理员授权等待超过 90 秒，测量已过期，请重新检测后重试。",
    15: "授权期间系统时间已被其他程序调整，请重新检测。",
    1223: "已取消管理员授权，未执行校准。",
  };
  if (!result.ok) throw new Error(messages[result.code] || `Windows 校准失败（${result.code}）。`);
  return { applied: true };
}

function createServer({ platform = process.platform, detectClock = detect, setClock, inspectHost = inspectSystem } = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  let latest = null, latestMono = 0, busy = false;
  let system;
  async function identify() {
    try { return await inspectHost(platform); }
    catch {
      return { platform: null, detectedPlatform: platform, source: "runtime", requiresSelection: true, supportedRuntime: false, label: "系统未识别", canCalibrate: false, capabilities: {}, reason: "自动识别系统失败，请手动选择后查看对应操作方法。", guidance: guides(null) };
    }
  }
  const initialSystem = identify();
  function configuration() { return { ...system, sources: SOURCES, token }; }
  const publicFiles = { "/": ["index.html", "text/html"], "/index.html": ["index.html", "text/html"], "/styles.css": ["styles.css", "text/css"], "/front.js": ["front.js", "text/javascript"], "/theme.js": ["theme.js", "text/javascript"] };
  const server = http.createServer(async (req, res) => {
    function json(data, status = 200) {
      if (status >= 400 && system) data = { ...data, guidance: data.guidance || system.guidance };
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify(data));
    }
    try {
      const port = server.address().port;
      const validHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!validHosts.includes(req.headers.host)) return json({ error: "不允许的本机地址" }, 403);
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json({ error: "仅允许本工具页面调用" }, 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (!system) system = await initialSystem;
      if (req.method === "GET" && url.pathname === "/api/config") {
        return json(configuration());
      }
      if (req.method === "GET" && publicFiles[url.pathname]) {
        const [file, type] = publicFiles[url.pathname];
        const data = await fs.readFile(path.join(__dirname, file));
        res.writeHead(200, {
          "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'",
        });
        return res.end(data);
      }
      if (!["/api/detect", "/api/sync", "/api/system"].includes(url.pathname)) return json({ error: "未找到接口" }, 404);
      if (req.method !== "POST") return json({ error: "请使用 POST" }, 405);
      if (req.headers["x-tool-token"] !== token || !req.headers["content-type"]?.startsWith("application/json")) return json({ error: "请求校验失败，请刷新页面" }, 403);
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 8192) return json({ error: "请求过大" }, 413);
      }
      let input;
      try { input = JSON.parse(body); }
      catch { return json({ error: "无效的 JSON 请求" }, 400); }
      if (!input || typeof input !== "object" || Array.isArray(input)) return json({ error: "无效的请求" }, 400);
      if (busy) return json({ error: "检测或校准正在进行，请稍候" }, 409);
      if (url.pathname === "/api/system") {
        busy = true;
        try {
          if (input.redetect === true) system = await identify();
          else {
            try { system = manualSystem(system, input.system); }
            catch (error) { return json({ error: error.message }, 400); }
          }
          latest = null;
          return json({ ok: true, config: configuration() });
        } finally { busy = false; }
      }
      if (system.requiresSelection) return json({ error: "请先选择并确认运行后端的电脑系统。" }, 400);
      if (url.pathname === "/api/detect") {
        let options;
        try { options = validateOptions(input); }
        catch (error) { return json({ error: error.message }, 400); }
        busy = true;
        try {
          latest = await detectClock(options);
          latestMono = performance.now();
          return json({ ok: true, report: latest, guidance: latest.consensus.canSync ? undefined : guides(system.platform, { reason: latest.consensus.reason, actualPlatform: platform }) });
        } finally { busy = false; }
      }
      if (!system.canCalibrate || !system.supportedRuntime) return json({ error: system.reason || "当前系统无法自动校准，请按下方指引操作。" }, 400);
      if (!latest || input.reportId !== latest.id || performance.now() - latestMono > 120000) return json({ error: "检测结果已过期，请重新检测" }, 409);
      if (!latest.consensus.canSync) return json({ error: "时间源未形成共识，无法校准" }, 409);
      if (latest.consensus.kind === "https" && input.allowCoarse !== true) return json({ error: "HTTPS 只能进行秒级校准，请先勾选允许粗略校准。" }, 409);
      const previous = latest;
      latest = null; // One-shot report; concurrent and replayed syncs cannot run twice.
      busy = true;
      try {
        const fresh = await detectClock(previous.options);
        if (!fresh.consensus.canSync) return json({ error: "校准前复测未形成共识，请重新检测。", report: fresh }, 409);
        if (fresh.consensus.kind === "https" && input.allowCoarse !== true) return json({ error: "校准前 NTP 已不可用，已停止。请重新检测。", report: fresh }, 409);
        const tolerance = Math.max(250, previous.consensus.uncertaintyMs + fresh.consensus.uncertaintyMs);
        if (Math.abs(fresh.consensus.offsetMs - previous.consensus.offsetMs) > tolerance) return json({ error: "时间偏差已明显变化，请检查复测结果后重新校准。", report: fresh }, 409);
        const appliedOffsetMs = fresh.consensus.offsetMs;
        if (setClock) await setClock(appliedOffsetMs, system);
        else if (system.platform === "win32" && platform === "win32") await syncWindows(appliedOffsetMs);
        else if (system.platform === "linux" && platform === "linux") await syncLinux(appliedOffsetMs, system);
        else return json({ error: "运行环境与已确认系统不一致，请在目标电脑上执行下方操作步骤。" }, 400);
        const systemName = system.platform === "linux" ? "Linux" : "Windows";
        let verification;
        try { verification = await detectClock(previous.options); }
        catch { return json({ ok: true, applied: true, verified: false, guidance: system.guidance, message: `${systemName} 已执行校准，但复测失败，请重新检测确认，并参考下方处理方法。` }); }
        latest = verification;
        latestMono = performance.now();
        const verified = verification.consensus.canSync && verification.consensus.kind === fresh.consensus.kind && Math.abs(verification.consensus.offsetMs) <= Math.max(fresh.consensus.kind === "ntp" ? 100 : 1500, verification.consensus.uncertaintyMs);
        return json({ ok: true, applied: true, verified, appliedOffsetMs, report: verification, guidance: verified ? undefined : system.guidance, message: verified ? "校准已执行，校后复测通过。" : `${systemName} 已执行校准，但复测未通过，请查看当前偏差并参考下方处理方法。` });
      } finally { busy = false; }
    } catch (error) { json({ error: error.message || "操作失败，请重试" }, 500); }
  });
  server.requestTimeout = 180000;
  server.headersTimeout = 10000;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.TOOL_PORT || 3930);
  const server = createServer();
  server.on("error", error => { console.error(`[time-sync] ${error.message}`); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => console.log(`[time-sync] http://127.0.0.1:${server.address().port}`));
}

module.exports = { createServer, syncWindows };
