"use strict";

const $ = id => document.getElementById(id);
let config, report, busy = false, invalidated = false, receivedMono = 0, referenceAnchor = null;
let wallAnchor = Date.now(), monoAnchor = performance.now();
let currentGuidance;
const timeFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const dateFormat = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" });

function notice(message, type = "") {
  $("notice").hidden = !message;
  $("notice").className = `notice ${type}`;
  $("notice").textContent = message;
}
function signedMs(value) {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} ms`;
}
function updateButtons() {
  $("detect").disabled = busy || !config || config.requiresSelection || config.offline;
  const coarse = report?.consensus.kind === "https";
  $("sync").disabled = busy || !config?.canCalibrate || invalidated || !report?.consensus.canSync || (coarse && !$("allow-coarse").checked) || performance.now() - receivedMono > 120000;
  $("sync").textContent = coarse ? "执行秒级粗略校准" : config?.platform === "linux" ? "校准 Linux 时间" : config?.platform === "win32" ? "校准 Windows 时间" : "校准系统时间";
  $("coarse-option").hidden = !coarse || !config?.canCalibrate || !report?.consensus.canSync;
  for (const element of document.querySelectorAll(".settings input, .settings select")) element.disabled = busy;
  $("allow-coarse").disabled = busy;
  $("redetect-system").disabled = busy || !config;
  $("confirm-system").disabled = busy;
  $("system-select").disabled = busy;
}

function renderGuidance(guide, stage = "detect") {
  if (!guide) return;
  currentGuidance = guide;
  $("help").hidden = false;
  $("help-title").textContent = guide.title;
  $("help-note").textContent = guide.note;
  $("help-commands").replaceChildren();
  for (const [index, item] of guide.blocks.entries()) {
    const block = document.createElement("details"), head = document.createElement("summary"), pre = document.createElement("pre"), copy = document.createElement("button");
    block.className = "command-block"; block.open = index === (stage === "sync" && guide.blocks.length > 1 ? 1 : 0);
    head.className = "command-head"; head.textContent = item.title;
    pre.textContent = item.command; copy.className = "copy-button"; copy.type = "button"; copy.textContent = "复制命令";
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(pre.textContent); copy.textContent = "已复制"; }
      catch { copy.textContent = "请手动选中复制"; }
    });
    block.append(head, pre, copy); $("help-commands").append(block);
  }
}

function localGuidance(system) {
  return {
    title: system === "linux" ? "Linux 处理方法" : "Windows 处理方法",
    note: "无法连接工具后端，因此当前无法自动检测或校准。请先用 Node.js 运行工具目录中的 app.js，再打开终端显示的本机地址；也可先使用以下系统授时命令。",
    blocks: [{ title: "先通过系统时间服务检查并校准", command: system === "linux"
      ? "# 已安装 systemd-timesyncd 时执行：\nsudo timedatectl set-ntp true\ntimedatectl status\ntimedatectl timesync-status\n# 已使用 chrony 的机器改用：\nchronyc sources -v\nchronyc tracking\n# 等待来源出现 * 后执行：\nsudo chronyc makestep"
      : "# 以管理员身份打开 PowerShell 后执行：\nStart-Service W32Time\nw32tm /resync /rediscover\nw32tm /query /status" }],
  };
}

function renderSystem(next) {
  config = next;
  $("platform").textContent = `${config.label}${config.requiresSelection ? " · 待确认" : config.source === "manual" ? " · 手动确认" : " · 自动识别"}`;
  $("system-note").textContent = config.reason;
  $("system-choice").hidden = !config.requiresSelection;
  $("action-note").textContent = config.requiresSelection ? "请先选择并确认电脑系统，再开始检测。" : !config.canCalibrate ? "当前环境无法自动校准，请查看下方对应系统的操作步骤。" : config.platform === "linux" ? "检测无需管理员权限；校准时使用 root、已有 sudo 授权或桌面管理员授权。" : "检测无需管理员权限；校准时按需请求 Windows 管理员授权。";
  currentGuidance = config.guidance;
  if (config.requiresSelection) notice(config.reason, "warning");
  else if (!config.canCalibrate) renderGuidance({ ...config.guidance, note: config.guidance.note.includes(config.reason) ? config.guidance.note : `${config.reason} ${config.guidance.note}` }, "sync");
  updateButtons();
}

function resetReport() {
  report = null; invalidated = true; referenceAnchor = null;
  $("offset").textContent = "—"; $("offset-unit").textContent = "等待检测";
  $("direction").textContent = "系统环境已更新，请重新检测本机时间差。";
  $("agreement").textContent = "—"; $("uncertainty").textContent = "—"; $("checked-at").textContent = "尚未检测";
  $("agreement-note").textContent = "至少两个独立来源"; $("duration").textContent = "手动检测，按需校准";
  $("method").textContent = "NTP 优先"; $("method-note").textContent = "HTTPS 自动兜底";
  $("allow-coarse").checked = false;
}

async function api(route, body) {
  const response = await fetch(route, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Tool-Token": config.token }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    if (data.report) { renderReport(data.report); invalidated = true; }
    if (data.guidance) renderGuidance(data.guidance, route === "/api/sync" ? "sync" : "detect");
    throw new Error(data.error || "请求失败");
  }
  return data;
}

function cell(text, className) {
  const element = document.createElement("td");
  if (className) element.className = className;
  element.textContent = text;
  return element;
}
function renderRows() {
  const rows = $("source-rows");
  rows.replaceChildren();
  for (const source of config.sources) {
    const result = report?.results.find(r => r.id === source.id);
    const selected = document.querySelector(`input[data-source="${source.id}"]`)?.checked ?? true;
    const tr = document.createElement("tr");
    const name = cell("");
    const title = document.createElement("span"), host = document.createElement("span");
    title.className = "source-name"; title.textContent = source.name;
    host.className = "source-host"; host.textContent = source.host;
    name.append(title, host);
    const kind = cell("");
    const protocol = document.createElement("span"); protocol.className = `protocol ${source.kind}`; protocol.textContent = source.kind.toUpperCase(); kind.append(protocol);
    const status = cell("");
    const badge = document.createElement("span"); badge.className = "row-status";
    if (result?.ok) {
      const used = report.consensus.usedIds.includes(source.id);
      const sameProviderUsed = report.results.some(r => r.provider === source.provider && report.consensus.usedIds.includes(r.id));
      badge.textContent = used ? "参与共识" : sameProviderUsed ? "同源备用" : (source.kind !== report.consensus.kind ? "独立参考" : "未参与共识");
      if (used) badge.classList.add("agreed");
      else if (!sameProviderUsed) badge.classList.add("excluded");
      badge.title = `成功采样 ${result.samplesOk}/${result.samplesRequested}；估计不确定度 ±${result.uncertaintyMs.toFixed(1)} ms`;
    } else if (result) {
      badge.textContent = "不可用"; badge.classList.add("failed");
    } else {
      badge.textContent = busy ? "检测中 / 待命" : (!selected ? "未选择" : report ? "未启用 / 无需兜底" : source.kind === "https" ? "兜底待命" : "等待检测");
    }
    status.append(badge);
    if (result?.error) { const detail = document.createElement("span"); detail.className = "error-detail"; detail.textContent = result.error; status.append(detail); }
    tr.append(name, kind, cell(result?.ok ? signedMs(result.offsetMs) : "—"), cell(result?.ok ? `${result.rttMs.toFixed(1)} ms` : "—"), status);
    rows.append(tr);
  }
  const success = report?.results.filter(r => r.ok).length || 0;
  $("sources-footer").textContent = report ? `可达 ${success} / 已检测 ${report.results.length} 个源 · 正偏差：本机慢；负偏差：本机快 · 备用域名不重复计票` : "尚未发送网络请求";
}

function renderReport(next) {
  report = next; invalidated = false; receivedMono = performance.now();
  wallAnchor = Date.now(); monoAnchor = performance.now();
  const c = report.consensus;
  referenceAnchor = Number.isFinite(c.offsetMs) ? Date.now() + c.offsetMs : null;
  if (Number.isFinite(c.offsetMs)) {
    const abs = Math.abs(c.offsetMs);
    const coarse = c.kind === "https";
    const seconds = coarse || abs >= 1000;
    $("offset").textContent = coarse && abs < 1000 ? "< 1" : (seconds ? abs / 1000 : abs).toLocaleString("zh-CN", { maximumFractionDigits: coarse ? 1 : seconds ? 3 : 1 });
    $("offset-unit").textContent = coarse ? "秒（粗略估计）" : seconds ? "秒" : "毫秒";
    const withinUncertainty = abs <= c.uncertaintyMs;
    $("direction").textContent = `${coarse ? "粗略估计：" : "测得"}本机时间${abs < 1 ? "基本一致" : c.offsetMs > 0 ? "偏慢" : "偏快"}。${withinUncertainty ? "偏差处于估计不确定度内。" : c.offsetMs > 0 ? "校准时将向前调整。" : "校准时将向后调整。"}${c.canSync ? "" : "结果仅供参考。"}`;
  } else {
    $("offset").textContent = "—"; $("offset-unit").textContent = "无有效结果";
    $("direction").textContent = "暂时无法确定本机时间差，请查看各来源的失败原因。";
  }
  $("method").textContent = c.kind === "ntp" ? "NTP 多源测量" : c.kind === "https" ? "HTTPS 秒级估计" : "无可用来源";
  $("method-note").textContent = c.kind === "ntp" ? "四时间戳计算网络延迟" : c.kind === "https" ? "精度不足以保证毫秒级校准" : "检查网络与防火墙";
  $("agreement").textContent = `${c.agreedProviders || 0} / ${c.providerCount || 0}`;
  $("agreement-note").textContent = c.canSync ? "独立来源达成多数共识" : "独立来源未形成多数共识";
  $("uncertainty").textContent = Number.isFinite(c.uncertaintyMs) ? c.kind === "https" ? `± ${(c.uncertaintyMs / 1000).toFixed(1)} 秒` : `± ${c.uncertaintyMs.toFixed(1)} ms` : "—";
  $("checked-at").textContent = timeFormat.format(new Date(report.measuredAt));
  $("duration").textContent = `检测耗时 ${(report.elapsedMs / 1000).toFixed(1)} 秒 · 结果有效 2 分钟`;
  notice(!config.canCalibrate && c.canSync ? `时间源已形成共识。${config.reason}` : c.reason, config.canCalibrate && c.canSync && c.kind === "ntp" ? "" : "warning");
  if (!c.canSync || !config.canCalibrate) renderGuidance(config.guidance);
  renderRows(); updateButtons();
}

$("detect").addEventListener("click", async () => {
  if (busy || !config || config.requiresSelection || config.offline) return;
  const sourceIds = [...document.querySelectorAll("input[data-source]:checked")].map(input => input.dataset.source);
  if (!sourceIds.length) return notice("请至少选择一个时间源。", "warning");
  busy = true; invalidated = true; referenceAnchor = null;
  $("detect").textContent = "正在检测…"; updateButtons();
  notice("正在并行检测 NTP 时间源；若无法形成共识，将继续尝试 HTTPS。通常需要 3–20 秒。", "loading");
  try {
    const data = await api("/api/detect", { samples: Number($("samples").value), timeoutMs: Number($("timeout").value), sourceIds, httpsFallback: $("https-fallback").checked });
    renderReport(data.report);
    if (data.guidance) renderGuidance(data.guidance);
  } catch (error) { notice(error.message, "error"); renderGuidance(config.guidance); }
  finally { busy = false; $("detect").textContent = "重新检测 ↗"; updateButtons(); renderRows(); }
});

$("sync").addEventListener("click", async () => {
  if (busy || $("sync").disabled) return;
  busy = true; updateButtons();
  notice(config.platform === "linux" ? "正在重新核对时间，随后尝试 Linux 管理员授权。请在 90 秒内完成桌面授权；无授权窗口时会提供终端操作方法。" : "正在重新核对时间，随后请求 Windows 管理员授权。请在 90 秒内完成授权；校准后将自动复测。", "loading");
  try {
    const data = await api("/api/sync", { reportId: report.id, allowCoarse: $("allow-coarse").checked });
    if (data.report) renderReport(data.report);
    else { invalidated = true; referenceAnchor = null; }
    notice(data.message, data.verified ? "" : "warning");
    if (data.guidance) renderGuidance(data.guidance, "sync");
  } catch (error) { invalidated = true; referenceAnchor = null; notice(`${error.message} 请参考下方处理方法，完成后重新检测。`, "error"); renderGuidance(config.guidance, "sync"); }
  finally { busy = false; wallAnchor = Date.now(); monoAnchor = performance.now(); updateButtons(); }
});
$("allow-coarse").addEventListener("change", updateButtons);
$("show-help").addEventListener("click", () => renderGuidance(currentGuidance || config?.guidance));
$("hide-help").addEventListener("click", () => { $("help").hidden = true; });
$("confirm-system").addEventListener("click", async () => {
  if (busy || !config) return;
  const selected = $("system-select").value;
  if (!selected) return notice("请选择 Windows 或 Linux 后确认。", "warning");
  busy = true; updateButtons();
  try {
    let next;
    if (config.offline) next = { ...config, platform: selected, label: selected === "linux" ? "Linux" : "Windows", source: "manual", requiresSelection: false, guidance: localGuidance(selected), reason: "已手动确认系统，但工具后端不可用，无法自动检测或校准。请按下方步骤操作。" };
    else next = (await api("/api/system", { system: selected })).config;
    resetReport(); $("help").hidden = true; notice(next.reason, next.canCalibrate ? "" : "warning"); renderSystem(next); renderRows();
  } catch (error) { notice(error.message, "error"); }
  finally { busy = false; updateButtons(); renderRows(); }
});
$("redetect-system").addEventListener("click", async () => {
  if (busy || !config) return;
  if (config?.offline) return initialize();
  busy = true; updateButtons();
  try {
    const data = await api("/api/system", { redetect: true });
    resetReport(); $("help").hidden = true; notice("系统环境已重新识别，请重新检测时间。", ""); renderSystem(data.config); renderRows();
  } catch (error) { notice(error.message, "error"); renderGuidance(config?.guidance); }
  finally { busy = false; updateButtons(); renderRows(); }
});
$("settings").addEventListener("change", () => {
  if (report) { invalidated = true; notice("检测设置已修改，请重新检测以应用新设置。", "warning"); }
  renderRows(); updateButtons();
});

function tick() {
  const now = new Date();
  $("local-time").textContent = timeFormat.format(now);
  $("local-date").textContent = dateFormat.format(now);
  const s = now.getSeconds() + now.getMilliseconds() / 1000;
  $("hour-hand").setAttribute("transform", `rotate(${(now.getHours() % 12 + now.getMinutes() / 60) * 30} 90 90)`);
  $("minute-hand").setAttribute("transform", `rotate(${(now.getMinutes() + s / 60) * 6} 90 90)`);
  $("second-hand").setAttribute("transform", `rotate(${s * 6} 90 90)`);
  if (!busy && !invalidated && report && Math.abs(Date.now() - wallAnchor - (performance.now() - monoAnchor)) > 200) {
    invalidated = true; referenceAnchor = null; notice("本机时间已发生变化，请重新检测。", "warning");
  }
  const stale = report && performance.now() - receivedMono > 120000;
  $("reference-time").textContent = referenceAnchor !== null && !invalidated && !stale ? `${report.consensus.kind === "https" ? "≈ " : ""}${timeFormat.format(new Date(referenceAnchor + performance.now() - receivedMono))}` : report ? "请重新检测" : "等待测量";
  updateButtons();
}
setInterval(tick, 200); tick();

async function initialize() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("无法连接工具后端");
    renderSystem(await response.json());
    $("timezone").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
    $("source-count").textContent = `${config.sources.length} 个可选源`;
    $("source-options").replaceChildren();
    for (const source of config.sources) {
      const label = document.createElement("label"), input = document.createElement("input"), region = document.createElement("span");
      input.type = "checkbox"; input.checked = true; input.dataset.source = source.id;
      region.textContent = source.region; label.append(input, document.createTextNode(source.name), region);
      $("source-options").append(label);
    }
    renderRows(); updateButtons();
  } catch (error) {
    resetReport(); $("source-options").replaceChildren();
    renderSystem({ platform: null, label: "系统未识别", requiresSelection: true, canCalibrate: false, offline: true, sources: [], reason: "无法连接工具后端，请先选择电脑系统，查看对应的启动、检测与校准步骤。" });
    $("source-count").textContent = "后端未连接";
    renderRows();
    notice(`${error.message}。请选择电脑系统后查看处理方法。`, "error");
  }
}
initialize();
