// =====================================================================
// Clash 远程控制器 —— 前端逻辑（原生 JS）
//
// 页面与工具后端（app.js）同源，直接 fetch('/api/...')；
// 后端再以 Bearer Secret 调用 Clash External Controller 的 RESTful API。
// 前端不直连 Clash，因此没有 CORS 问题，错误也由后端统一翻译成中文。
//
// 主要模块：
//   · API 封装（api / clashAction）
//   · 全局状态（state）与渲染（renderStatus / renderProfiles / renderGroups）
//   · 连接与数据刷新（connect / refreshData）
//   · 运行模式切换（setMode）
//   · 节点选择（selectNode）
//   · 延迟测速（testNode / testGroup / testAll，均带加载状态与可取消）
//   · 重载配置（reloadConfig）
//   · 控制器配置表单（校验 / 测试连接 / 保存）
// =====================================================================

"use strict";

// ---------- DOM 辅助 ----------
const $ = (id) => document.getElementById(id);

const MODE_LABELS = { global: "全局", rule: "规则", direct: "直连" };

// ---------- 全局状态 ----------
const state = {
  profiles: [],          // 已保存的控制器配置
  activeId: null,        // 当前激活的配置 id
  settings: { testUrl: "http://www.gstatic.com/generate_204", testTimeout: 5000 },
  conn: {
    status: "idle",      // idle | connecting | ok | error
    profile: null,       // 当前连接的配置对象
    version: null,
    meta: false,
    mode: null,          // rule | global | direct
    error: null,
  },
  proxies: {},           // Clash 返回的 name -> proxy 映射
  groupNames: [],        // 有序的代理组名列表（GLOBAL 排最后）
  expanded: new Set(),   // 已展开的组名
  speedTest: { running: false, done: 0, total: 0, cancel: false, ok: 0, fail: 0 },
  busy: { refresh: false, mode: false },
};

// =====================================================================
// API 封装
// =====================================================================

/**
 * 统一请求工具后端。
 * 后端约定：{ok: true, ...} 或 {ok: false, error: "中文错误信息"}。
 */
async function api(path, options = {}) {
  let resp;
  try {
    resp = await fetch(path, options);
  } catch {
    throw new Error("无法连接工具后端（请确认工具正在运行）");
  }
  let data = null;
  try { data = await resp.json(); } catch { data = null; }
  if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);
  if (!data || data.ok !== true) throw new Error((data && data.error) || "后端返回异常");
  return data;
}

/**
 * 调用 Clash 网关。
 * @param {string} action  version|configs|setMode|proxies|select|delay|groupDelay|reload
 * @param {object} params  各 action 的参数
 * @param {string|null} profileId 指定使用哪条配置（默认激活项）
 * @param {object|null} conn 显式连接参数（用于保存前的「测试连接」）
 * @returns {Promise<object>} 后端 data 字段
 */
async function clashAction(action, params = {}, profileId = null, conn = null) {
  const body = { action, ...params };
  if (profileId) body.profileId = profileId;
  if (conn) body.conn = conn;
  const data = await api("/api/clash", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return data.data;
}

// ---------- 轻提示 ----------
function flashToast(msg, isError = false) {
  const toast = $("toast");
  toast.textContent = msg;
  toast.className = "toast" + (isError ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.add("hidden"), isError ? 3500 : 2200);
}

// =====================================================================
// 渲染：连接状态 + 工具条
// =====================================================================

function renderStatus() {
  const c = state.conn;
  const dot = $("conn-dot");
  dot.className =
    "dot " +
    (c.status === "ok" ? "dot-ok"
      : c.status === "connecting" ? "dot-connecting"
      : c.status === "error" ? "dot-error"
      : "dot-idle");

  if (c.status === "idle" || !c.profile) {
    $("conn-name").textContent = "未连接";
    $("conn-detail").textContent = "添加并启用一个控制器配置后自动连接";
  } else {
    $("conn-name").textContent = c.profile.name;
    const addr = `${c.profile.protocol}://${c.profile.host}:${c.profile.port}`;
    $("conn-detail").textContent =
      c.status === "connecting"
        ? `${addr} · 正在连接…`
        : addr + (c.mode ? ` · ${MODE_LABELS[c.mode] || c.mode}模式` : "");
  }

  // 版本徽章
  const vb = $("conn-version");
  if (c.status === "ok" && c.version) {
    vb.textContent = `v${c.version}${c.meta ? " · Meta" : ""}`;
    vb.classList.remove("hidden");
  } else {
    vb.classList.add("hidden");
  }

  // 错误横幅
  const errBox = $("conn-error");
  if (c.status === "error") {
    $("conn-error-text").textContent = c.error || "连接失败";
    errBox.classList.remove("hidden");
  } else {
    errBox.classList.add("hidden");
  }

  // 模式切换按钮
  document.querySelectorAll("#mode-switch button").forEach((btn) => {
    btn.classList.toggle("active", c.mode === btn.dataset.mode);
    btn.disabled = c.status !== "ok" || state.busy.mode;
  });

  // 操作按钮
  $("btn-refresh").disabled = c.status !== "ok" || state.busy.refresh;
  $("btn-refresh").textContent = state.busy.refresh ? "刷新中…" : "刷新";
  $("btn-test-all").disabled = c.status !== "ok";
  $("btn-test-all").textContent = state.speedTest.running ? "取消测速" : "全部测速";
  $("btn-reload").disabled = c.status !== "ok";
}

/** 全部测速进度条 */
function renderSpeedProgress() {
  const wrap = $("speed-progress");
  const st = state.speedTest;
  if (!st.running) {
    wrap.classList.add("hidden");
    $("btn-cancel-test").classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  $("btn-cancel-test").classList.remove("hidden");
  $("speed-progress-text").textContent =
    `全部节点测速中 ${st.done}/${st.total}（并发 6，可取消）`;
}

// =====================================================================
// 渲染：控制器配置列表
// =====================================================================

function renderProfiles() {
  const list = $("profile-list");
  list.innerHTML = "";
  $("profile-empty").style.display = state.profiles.length ? "none" : "";

  for (const p of state.profiles) {
    const isActive = p.id === state.activeId;
    const li = document.createElement("li");
    li.className = "profile-item" + (isActive ? " active" : "");

    // 主体：点击切换（激活项本身不可点）
    const main = document.createElement("div");
    main.className = "p-main";
    if (!isActive) {
      main.title = "点击使用该配置";
      main.addEventListener("click", () => activateProfile(p.id));
    }

    const nameRow = document.createElement("div");
    nameRow.className = "p-name";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = p.name;
    nameRow.appendChild(nameSpan);
    if (isActive) {
      const badge = document.createElement("span");
      badge.className = "p-badge";
      badge.textContent = "使用中";
      nameRow.appendChild(badge);
    }

    const hostRow = document.createElement("div");
    hostRow.className = "p-host";
    hostRow.textContent =
      `${p.protocol}://${p.host}:${p.port}` + (p.secret ? " · 已设置 Secret" : " · 无 Secret");

    main.append(nameRow, hostRow);

    // 操作按钮
    const ops = document.createElement("div");
    ops.className = "p-ops";
    if (!isActive) {
      const btnUse = document.createElement("button");
      btnUse.type = "button";
      btnUse.className = "btn-mini";
      btnUse.textContent = "使用";
      btnUse.addEventListener("click", () => activateProfile(p.id));
      ops.appendChild(btnUse);
    }
    const btnEdit = document.createElement("button");
    btnEdit.type = "button";
    btnEdit.className = "btn-mini";
    btnEdit.textContent = "编辑";
    btnEdit.addEventListener("click", () => openProfileForm(p));
    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "btn-mini danger";
    btnDel.textContent = "删除";
    btnDel.addEventListener("click", () => deleteProfile(p));
    ops.append(btnEdit, btnDel);

    li.append(main, ops);
    list.appendChild(li);
  }
}

// =====================================================================
// 渲染：代理组与节点
// =====================================================================

/** 从 /proxies 结果中提取组名（all 非空即视为组），GLOBAL 排最后 */
function buildGroups() {
  const names = Object.keys(state.proxies).filter((n) => {
    const p = state.proxies[n];
    return p && Array.isArray(p.all) && p.all.length > 0;
  });
  names.sort((a, b) => (a === "GLOBAL" ? 1 : 0) - (b === "GLOBAL" ? 1 : 0));
  state.groupNames = names;
}

/** 节点延迟：优先用本会话测得的结果（_d），否则取 history 最后一条 */
function getNodeDelay(node) {
  if (!node) return null;
  if (node._d !== undefined) return node._d; // number | "fail"
  const h = Array.isArray(node.history) ? node.history : [];
  for (let i = h.length - 1; i >= 0; i--) {
    if (typeof h[i].delay === "number") {
      return h[i].delay > 0 ? h[i].delay : "fail";
    }
  }
  return null;
}

/** 延迟值 → 徽章文案与颜色 */
function delayInfo(d) {
  if (d === "fail") return { text: "超时", cls: "d-bad" };
  if (d == null) return { text: "未测", cls: "d-none" };
  if (d <= 0) return { text: "超时", cls: "d-bad" };
  if (d < 200) return { text: d + " ms", cls: "d-good" };
  if (d < 600) return { text: d + " ms", cls: "d-mid" };
  return { text: d + " ms", cls: "d-slow" };
}

function buildDelayBadge(node) {
  const span = document.createElement("span");
  if (node && node._testing) {
    span.className = "delay d-testing";
    span.textContent = "…";
    return span;
  }
  const info = delayInfo(getNodeDelay(node));
  span.className = "delay " + info.cls;
  span.textContent = info.text;
  return span;
}

/** 组列表上方的状态提示（未连接 / 连接中 / 连接失败 / 无组） */
function renderGroupsState() {
  const el = $("groups-state");
  const c = state.conn;
  let show = false;

  if (c.status === "idle") {
    el.textContent = "尚未连接控制器。请先在上方「控制器配置」中添加并启用。";
    show = true;
  } else if (c.status === "connecting") {
    el.textContent = "";
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    el.append(spinner, document.createTextNode(`正在连接 ${c.profile ? c.profile.name : ""} …`));
    show = true;
  } else if (c.status === "error") {
    el.textContent = "连接失败，无法加载代理组（错误信息见上方横幅）。";
    show = true;
  } else if (c.status === "ok" && !state.groupNames.length) {
    el.textContent = "该控制器没有返回任何代理组。";
    show = true;
  }

  el.classList.toggle("hidden", !show);
}

function renderGroups() {
  const list = $("groups-list");
  list.innerHTML = "";

  if (state.conn.status !== "ok") {
    $("groups-meta").textContent = "";
    renderGroupsState();
    return;
  }
  renderGroupsState();
  $("groups-meta").textContent = `${state.groupNames.length} 个代理组`;

  for (const gname of state.groupNames) {
    const group = state.proxies[gname];
    if (!group) continue;
    list.appendChild(buildGroupEl(gname, group));
  }
}

/** 构建一个组卡片（组头 + 可展开的节点列表） */
function buildGroupEl(gname, group) {
  const wrap = document.createElement("div");
  wrap.className = "group" + (state.expanded.has(gname) ? " open" : "");

  const selectable = group.type === "Selector"; // 仅手动选择组支持切换节点
  const isOpen = state.expanded.has(gname);

  // --- 组头（点击展开/收起） ---
  const head = document.createElement("div");
  head.className = "group-head";
  head.addEventListener("click", () => {
    if (state.expanded.has(gname)) state.expanded.delete(gname);
    else state.expanded.add(gname);
    renderGroups();
  });

  const nameEl = document.createElement("span");
  nameEl.className = "group-name";
  nameEl.textContent = gname;
  nameEl.title = gname;

  const typeEl = document.createElement("span");
  typeEl.className = "group-type";
  typeEl.textContent = group.type || "Group";

  // 当前选中节点（及其延迟）
  const nowEl = document.createElement("span");
  nowEl.className = "group-now";
  if (group.now) {
    const curDelay = getNodeDelay(state.proxies[group.now]);
    const d = delayInfo(curDelay);
    nowEl.textContent =
      typeof curDelay === "number" ? `当前：${group.now}（${curDelay} ms）` : `当前：${group.now}`;
    nowEl.title = group.now;
    void d;
  } else {
    nowEl.textContent = "当前：—";
  }

  // 组测速按钮（执行期间显示加载状态）
  const btnTest = document.createElement("button");
  btnTest.type = "button";
  btnTest.className = "btn-mini";
  btnTest.textContent = group._testing ? "测速中…" : "测速";
  btnTest.disabled = !!group._testing;
  btnTest.title = "对该组全部节点执行延迟测试";
  btnTest.addEventListener("click", (e) => {
    e.stopPropagation(); // 不要触发展开/收起
    testGroup(gname);
  });

  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.setAttribute("aria-hidden", "true");

  head.append(nameEl, typeEl, nowEl, btnTest, chevron);
  wrap.appendChild(head);

  // --- 节点列表 ---
  if (isOpen) {
    const body = document.createElement("div");
    body.className = "group-body" + (group._testing ? " testing" : "");
    for (const nname of group.all) {
      const node = state.proxies[nname] || { name: nname, type: "未知" };
      body.appendChild(buildNodeEl(gname, nname, node, selectable));
    }
    if (!group.all.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "该组没有节点";
      body.appendChild(empty);
    }
    wrap.appendChild(body);
  }

  return wrap;
}

/** 构建一行节点（名称 / 类型 / 延迟徽章 / 单节点测速按钮） */
function buildNodeEl(gname, nname, node, groupSelectable) {
  const row = document.createElement("div");
  row.className = "node-row" + (groupSelectable ? " selectable" : "");
  const group = state.proxies[gname];
  const isCurrent = group && group.now === nname;
  if (isCurrent) row.classList.add("current");

  const name = document.createElement("span");
  name.className = "node-name";
  name.textContent = nname;
  name.title = nname;

  // 该条目本身是代理组（常见于 GLOBAL 组内嵌套）
  const isNestedGroup = state.groupNames.includes(nname);
  const type = document.createElement("span");
  type.className = "node-type";
  type.textContent = isNestedGroup ? "代理组" : node.type || "";

  const badge = buildDelayBadge(node);

  // 单节点测速按钮
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-test-node";
  btn.textContent = "测";
  btn.title = "测该节点延迟";
  btn.disabled = !!node._testing;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    testNode(nname);
  });

  // 点击行 = 在组内选择该节点（仅 Selector 组支持）
  if (groupSelectable) {
    row.title = "点击选择该节点";
    row.addEventListener("click", () => selectNode(gname, nname));
  } else {
    row.addEventListener("click", () => {
      flashToast(`「${gname}」是 ${state.proxies[gname] && state.proxies[gname].type} 组，自动选择节点，不支持手动切换`);
    });
  }

  row.append(name, type, badge, btn);
  return row;
}

/** 节点列表的节流重绘（全部测速时高频更新，避免卡顿） */
let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderGroups();
  }, 150);
}

// =====================================================================
// 连接与数据刷新
// =====================================================================

/** 使用当前激活配置连接：版本 → 配置（模式）→ 代理列表 */
async function connect() {
  const profile = state.profiles.find((p) => p.id === state.activeId);
  if (!profile) {
    state.conn = { status: "idle", profile: null, version: null, meta: false, mode: null, error: null };
    state.proxies = {};
    state.groupNames = [];
    renderStatus();
    renderGroups();
    return;
  }

  state.conn = {
    status: "connecting",
    profile,
    version: null,
    meta: false,
    mode: null,
    error: null,
  };
  state.proxies = {};
  state.groupNames = [];
  renderStatus();
  renderGroups();

  try {
    const ver = await clashAction("version");
    state.conn.version = ver.version;
    state.conn.meta = !!ver.meta;

    const cfg = await clashAction("configs");
    state.conn.mode = cfg.mode || null;

    const px = await clashAction("proxies");
    state.proxies = px.proxies || {};
    buildGroups();

    // 首次连接时展开第一个组，便于直接查看
    if (state.expanded.size === 0 && state.groupNames.length) {
      state.expanded.add(state.groupNames[0]);
    }
    state.conn.status = "ok";
    flashToast(`已连接 ${profile.name}（v${ver.version}${ver.meta ? " Meta" : ""}）`);
  } catch (err) {
    state.conn.status = "error";
    state.conn.error = err.message;
    flashToast(`连接失败：${err.message}`, true);
  }
  renderStatus();
  renderGroups();
}

/** 重新拉取节点与运行模式（不重测版本） */
async function refreshData() {
  if (state.busy.refresh || state.conn.status !== "ok") return;
  state.busy.refresh = true;
  renderStatus();
  try {
    const cfg = await clashAction("configs");
    state.conn.mode = cfg.mode || null;
    const px = await clashAction("proxies");
    state.proxies = px.proxies || {};
    buildGroups();
    flashToast("已刷新代理数据");
  } catch (err) {
    flashToast(`刷新失败：${err.message}`, true);
  } finally {
    state.busy.refresh = false;
    renderStatus();
    renderGroups();
  }
}

/** 静默同步：不弹提示、不打断当前操作地重新拉取模式与代理数据，
 *  用于自动轮询与节点切换后的确认。保留本会话的测速结果 _d 与「测速中」状态。 */
async function silentRefresh() {
  if (state.conn.status !== "ok") return;
  try {
    const cfg = await clashAction("configs");
    if ((cfg.mode || null) !== state.conn.mode) {
      state.conn.mode = cfg.mode || null;
      renderStatus();
    }
    const px = await clashAction("proxies");
    const fresh = px.proxies || {};
    // 合并：把旧的 _d（本次会话测速结果）与 _testing（正在测速）带到新数据上
    for (const [name, p] of Object.entries(fresh)) {
      const old = state.proxies[name];
      if (old) {
        if (old._d !== undefined) p._d = old._d;
        if (old._testing) p._testing = true;
      }
    }
    state.proxies = fresh;
    buildGroups();
    renderStatus();
    renderGroups();
  } catch {
    // 静默失败：可能是暂时抖动，等下一轮轮询再试
  }
}

// 自动同步间隔（ms）：Clash 侧（GUI / 其他客户端）的节点切换会自动反映到本页
const POLL_INTERVAL = 8000;
let pollTimer = null;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    // 手动刷新或测速进行中时跳过，避免互相干扰
    if (state.busy.refresh || state.speedTest.running) return;
    silentRefresh();
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// =====================================================================
// 运行模式切换（全局 / 规则 / 直连）
// =====================================================================

async function setMode(mode) {
  if (state.busy.mode || state.conn.status !== "ok" || state.conn.mode === mode) return;
  state.busy.mode = true;
  const prev = state.conn.mode;
  state.conn.mode = mode; // 乐观更新，失败再回滚
  renderStatus();
  try {
    await clashAction("setMode", { mode });
    flashToast(`已切换为${MODE_LABELS[mode]}模式`);
  } catch (err) {
    state.conn.mode = prev;
    flashToast(`模式切换失败：${err.message}`, true);
  } finally {
    state.busy.mode = false;
    renderStatus();
  }
}

// =====================================================================
// 节点选择（组内切换）
// =====================================================================

async function selectNode(groupName, nodeName) {
  try {
    await clashAction("select", { group: groupName, name: nodeName });
    const g = state.proxies[groupName];
    if (g) g.now = nodeName;
    flashToast(`已切换「${groupName}」→ ${nodeName}`);
    renderGroups();
    // 稍等内核应用后重新拉取，确认切换已生效（与 Clash 侧真实状态保持一致）
    setTimeout(silentRefresh, 500);
  } catch (err) {
    flashToast(`切换失败：${err.message}`, true);
  }
}

// =====================================================================
// 延迟测速（单节点 / 单组 / 全部）
// =====================================================================

/** 单节点测速：徽章显示「…」，完成后更新 */
async function testNode(name) {
  const node = state.proxies[name];
  if (!node || node._testing) return;
  node._testing = true;
  renderGroups();
  try {
    const r = await clashAction("delay", { name });
    node._d = r.delay;
  } catch {
    node._d = "fail";
  } finally {
    node._testing = false;
    renderGroups();
  }
}

/** 单组测速：优先用内核组测速接口，失败自动回退（后端处理） */
async function testGroup(groupName) {
  const group = state.proxies[groupName];
  if (!group || group._testing) return;
  group._testing = true;
  state.expanded.add(groupName); // 测速时展开，结果直观
  renderGroups();
  const t0 = Date.now();
  try {
    const r = await clashAction("groupDelay", { group: groupName });
    const delays = r.delays || {};
    let ok = 0;
    let fail = 0;
    for (const nname of group.all) {
      const node = state.proxies[nname];
      const d = delays[nname];
      if (typeof d === "number" && d > 0) {
        if (node) node._d = d;
        ok++;
      } else {
        if (node) node._d = "fail"; // 不在结果里 = 超时/失败
        fail++;
      }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    flashToast(`「${groupName}」测速完成：${ok} 可用 / ${fail} 超时（${secs}s）`);
  } catch (err) {
    flashToast(`「${groupName}」测速失败：${err.message}`, true);
  } finally {
    group._testing = false;
    renderGroups();
  }
}

/** 并发受限执行（可被取消） */
async function runWithLimit(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length && !state.speedTest.cancel) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

/** 收集全部可测速节点：各组成员（去重、排除组本身与 DIRECT/REJECT）+ 独立节点 */
function collectTestableNodeNames() {
  const names = [];
  const seen = new Set();
  for (const gname of state.groupNames) {
    for (const nname of state.proxies[gname].all || []) {
      if (seen.has(nname)) continue;
      seen.add(nname);
      if (nname === "DIRECT" || nname === "REJECT") continue;
      if (state.groupNames.includes(nname)) continue; // 嵌套组不重复测
      names.push(nname);
    }
  }
  for (const [nname, p] of Object.entries(state.proxies)) {
    if (seen.has(nname)) continue;
    if (Array.isArray(p.all) && p.all.length) continue; // 组
    if (nname === "DIRECT" || nname === "REJECT") continue;
    seen.add(nname);
    names.push(nname);
  }
  return names;
}

/** 全部测速：并发 6，实时更新徽章，可取消；再次点击按钮即取消 */
async function testAll() {
  if (state.speedTest.running) {
    state.speedTest.cancel = true;
    return;
  }
  const names = collectTestableNodeNames();
  if (!names.length) {
    flashToast("没有可测速的节点", true);
    return;
  }

  state.speedTest = { running: true, done: 0, total: names.length, cancel: false, ok: 0, fail: 0 };
  renderStatus();
  renderSpeedProgress();

  await runWithLimit(names, 6, async (name) => {
    if (state.speedTest.cancel) return;
    const node = state.proxies[name];
    try {
      const r = await clashAction("delay", { name });
      if (node) node._d = r.delay;
      state.speedTest.ok++;
    } catch {
      if (node) node._d = "fail";
      state.speedTest.fail++;
    }
    state.speedTest.done++;
    renderSpeedProgress();
    scheduleRender(); // 节流重绘
  });

  const st = state.speedTest;
  state.speedTest = { running: false, done: 0, total: 0, cancel: false, ok: 0, fail: 0 };
  renderStatus();
  renderSpeedProgress();
  renderGroups();
  flashToast(
    st.cancel
      ? `已取消全部测速（完成 ${st.done}/${st.total}）`
      : `全部测速完成：${st.ok} 可用 / ${st.fail} 超时`,
  );
}

// =====================================================================
// 重载订阅配置
// =====================================================================

async function reloadConfig() {
  if (state.conn.status !== "ok") return;
  if (!confirm("确定重载 Clash 配置？重载会短暂中断现有连接。")) return;
  const btn = $("btn-reload");
  btn.disabled = true;
  btn.textContent = "重载中…";
  try {
    await clashAction("reload");
    flashToast("配置已重载，正在刷新代理数据…");
    // 给内核一点时间应用新配置，再重新拉取
    await new Promise((r) => setTimeout(r, 600));
    await refreshData();
  } catch (err) {
    flashToast(`重载失败：${err.message}`, true);
  } finally {
    btn.textContent = "重载配置";
    renderStatus();
  }
}

// =====================================================================
// 控制器配置管理（列表加载 / 激活 / 删除）
// =====================================================================

async function loadProfiles() {
  try {
    const data = await api("/api/profiles");
    state.profiles = data.profiles || [];
    state.activeId = data.activeId || null;
    if (data.settings) state.settings = data.settings;
    $("test-url").value = state.settings.testUrl;
    $("test-timeout").value = state.settings.testTimeout;
  } catch (err) {
    flashToast(`加载配置失败：${err.message}`, true);
    state.profiles = [];
    state.activeId = null;
  }
  renderProfiles();
}

async function activateProfile(id) {
  try {
    await api("/api/profiles/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    state.activeId = id;
    renderProfiles();
    await connect();
  } catch (err) {
    flashToast(`切换失败：${err.message}`, true);
  }
}

async function deleteProfile(p) {
  if (!confirm(`确定删除配置「${p.name}」？`)) return;
  try {
    const data = await api("/api/profiles", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: p.id }),
    });
    const wasActive = state.activeId === p.id;
    await loadProfiles();
    if (wasActive) {
      // 删除的是当前配置：切换到下一条（或回到未连接状态）
      await connect();
    }
    flashToast("已删除配置");
    void data;
  } catch (err) {
    flashToast(`删除失败：${err.message}`, true);
  }
}

// =====================================================================
// 配置表单（新增 / 编辑 / 校验 / 测试连接 / 保存）
// =====================================================================

let editingId = null; // null = 新增模式

function openProfileForm(profile) {
  editingId = profile ? profile.id : null;
  $("form-title").textContent = profile ? "编辑配置" : "新增配置";
  $("f-name").value = profile ? profile.name : "";
  $("f-proto").value = profile ? profile.protocol : "http";
  $("f-host").value = profile ? profile.host : "";
  $("f-port").value = profile ? profile.port : "";
  $("f-secret").value = profile ? profile.secret : "";
  clearFieldErrors();
  hideFormFeedback();
  $("profile-form").classList.remove("hidden");
  $("btn-add-profile").classList.add("hidden");
  $("f-name").focus();
}

function closeProfileForm() {
  $("profile-form").classList.add("hidden");
  $("btn-add-profile").classList.remove("hidden");
  editingId = null;
}

/** 与后端一致的主机校验：IPv4 / 域名 / IPv6 */
function isValidHost(h) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    return h.split(".").every((n) => Number(n) <= 255);
  }
  if (/^[0-9a-fA-F:.]+$/.test(h) && (h.match(/:/g) || []).length >= 2) return true;
  return /^[a-zA-Z0-9]([a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/.test(h);
}

/** 表单校验（提交前），返回错误映射 */
function validateForm() {
  const errors = {};
  const name = $("f-name").value.trim();
  if (!name) errors.name = "请填写配置名称";
  else if (state.profiles.some((p) => p.id !== editingId && p.name.toLowerCase() === name.toLowerCase())) {
    errors.name = "已存在同名配置";
  }
  const host = $("f-host").value.trim();
  if (!host) errors.host = "请填写控制器地址";
  else if (!isValidHost(host)) errors.host = "地址格式不正确（应为 IP、域名或 IPv6）";
  const port = Number($("f-port").value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.port = "端口应为 1-65535 的整数";
  }
  return errors;
}

function showFieldErrors(errors) {
  for (const key of ["name", "host", "port"]) {
    const el = $("err-" + key);
    if (errors[key]) {
      el.textContent = errors[key];
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }
}

function clearFieldErrors() {
  showFieldErrors({});
}

/** 表单内反馈横幅：ok=true 绿 / false 红 / null 蓝 */
function showFormFeedback(ok, msg) {
  const el = $("form-feedback");
  el.className = "banner " + (ok === true ? "success" : ok === false ? "error" : "info");
  el.textContent = msg;
}

function hideFormFeedback() {
  const el = $("form-feedback");
  el.className = "banner hidden";
  el.textContent = "";
}

/** 从表单读取连接参数（不保存，用于「测试连接」与保存后的连通性反馈） */
function formConn() {
  return {
    protocol: $("f-proto").value,
    host: $("f-host").value.trim(),
    port: Number($("f-port").value),
    secret: $("f-secret").value,
  };
}

/** 「测试连接」：用当前表单参数请求 /version，给出成功/失败反馈 */
async function testConnectionFromForm() {
  const errors = validateForm();
  showFieldErrors(errors);
  if (Object.keys(errors).length) {
    showFormFeedback(false, "请先修正表单错误");
    return;
  }
  const btn = $("btn-test-conn");
  btn.disabled = true;
  btn.textContent = "测试中…";
  showFormFeedback(null, "正在连接…");
  try {
    const ver = await clashAction("version", {}, null, formConn());
    showFormFeedback(true, `连接成功：${ver.meta ? "Clash Meta" : "Clash"} v${ver.version}`);
  } catch (err) {
    showFormFeedback(false, `连接失败：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "测试连接";
  }
}

/** 保存（提交）：先校验，再保存；激活项或新配置会自动连接并反馈连接结果 */
async function saveProfile(e) {
  e.preventDefault();
  const errors = validateForm();
  showFieldErrors(errors);
  if (Object.keys(errors).length) {
    flashToast("表单有误，请修正后重试", true);
    return;
  }

  const conn = formConn();
  const payload = { ...conn, name: $("f-name").value.trim() };
  const btn = $("btn-save-profile");
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    let data;
    if (editingId) {
      data = await api("/api/profiles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingId, ...payload }),
      });
    } else {
      data = await api("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    closeProfileForm();
    await loadProfiles();

    const savedId = data.profile.id;
    if (state.activeId === savedId) {
      // 新配置被自动激活，或编辑的是当前配置 → 连接并给出成功/失败反馈
      await connect();
      if (state.conn.status === "ok") {
        flashToast(`已保存并连接成功：${data.profile.name}`);
      } else if (state.conn.status === "error") {
        flashToast(`已保存，但连接失败：${state.conn.error}`, true);
      }
    } else {
      // 未切换激活项：仍然对保存的参数做一次连接测试给出反馈
      try {
        const ver = await clashAction("version", {}, null, conn);
        flashToast(`已保存配置，连接测试通过（v${ver.version}${ver.meta ? " Meta" : ""}）`);
      } catch (err) {
        flashToast(`已保存配置，但连接测试失败：${err.message}`, true);
      }
    }
  } catch (err) {
    showFormFeedback(false, err.message);
    flashToast(`保存失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "保存";
  }
}

// =====================================================================
// 测速设置
// =====================================================================

async function saveSettings() {
  const url = $("test-url").value.trim();
  const timeout = Number($("test-timeout").value);
  if (!/^https?:\/\/.+/.test(url)) {
    flashToast("测速 URL 需以 http:// 或 https:// 开头", true);
    return;
  }
  if (!Number.isFinite(timeout) || timeout < 500 || timeout > 30000) {
    flashToast("超时需在 500-30000 ms 之间", true);
    return;
  }
  try {
    const data = await api("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testUrl: url, testTimeout: timeout }),
    });
    state.settings = data.settings;
    flashToast("测速设置已保存");
  } catch (err) {
    flashToast(`保存失败：${err.message}`, true);
  }
}

// =====================================================================
// 事件绑定与启动
// =====================================================================

function bindEvents() {
  // 状态卡
  document.querySelectorAll("#mode-switch button").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });
  $("btn-refresh").addEventListener("click", refreshData);
  $("btn-test-all").addEventListener("click", testAll);
  $("btn-cancel-test").addEventListener("click", () => {
    state.speedTest.cancel = true;
  });
  $("btn-reload").addEventListener("click", reloadConfig);
  $("btn-retry").addEventListener("click", connect);
  $("btn-save-settings").addEventListener("click", saveSettings);

  // 配置管理
  $("btn-add-profile").addEventListener("click", () => openProfileForm(null));
  $("btn-cancel-form").addEventListener("click", closeProfileForm);
  $("profile-form").addEventListener("submit", saveProfile);
  $("btn-test-conn").addEventListener("click", testConnectionFromForm);
  $("btn-toggle-secret").addEventListener("click", () => {
    const input = $("f-secret");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("btn-toggle-secret").textContent = show ? "隐藏" : "显示";
  });
}

async function init() {
  bindEvents();
  await loadProfiles();
  await connect();
  startPolling(); // 启动自动同步：Clash 侧的节点/模式切换会自动反映到本页
}

init();
