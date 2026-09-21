// quota-pool 前端：账户 CRUD + 检查/签到 + 自动签到设置 + 日志
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const state = { editingId: null, ftype: "workbuddy", busy: false };

  const els = {
    acctEmpty: $("acct-empty"), acctTable: $("acct-table"), acctBody: $("acct-body"),
    acctFeedback: $("acct-feedback"),
    btnAdd: $("btn-add"), btnCheckAll: $("btn-check-all"), btnClaimAll: $("btn-claim-all"),
    form: $("acct-form"), formTitle: $("form-title"), typeSeg: $("f-type-seg"),
    typeHint: $("type-hint"), remark: $("f-remark"),
    access: $("f-access"), refresh: $("f-refresh"), uid: $("f-uid"), endpoint: $("f-endpoint"),
    jwt: $("f-jwt"), device: $("f-device"),
    formFeedback: $("form-feedback"),
    btnCancelForm: $("btn-cancel-form"),
    cHour: $("c-hour"),
    btnSaveConfig: $("btn-save-config"), configFeedback: $("config-feedback"),
    btnLogs: $("btn-logs"), logs: $("logs"),
    toast: $("toast"),
  };

  const TYPE_HINTS = {
    workbuddy: "WorkBuddy：必填备注 + accessToken（refreshToken 强烈建议一起填，否则 60 天后需重贴）。",
    trae: "Trae：必填备注 + token(JWT) + deviceId（该账号绑定过的设备，错了 9074）。",
  };

  function toast(msg, isErr) {
    els.toast.textContent = msg;
    els.toast.className = "toast" + (isErr ? " error" : "");
    clearTimeout(els.toast._t);
    els.toast._t = setTimeout(() => els.toast.classList.add("hidden"), 2400);
  }
  function banner(el, ok, msg) {
    if (!msg) { el.classList.add("hidden"); return; }
    el.className = "banner " + (ok ? "ok" : "err");
    el.textContent = msg;
    el.classList.remove("hidden");
  }
  async function api(path, opts) {
    const resp = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...(opts || {}),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) throw new Error("HTTP " + resp.status);
    if (data.ok !== true && !data.error) throw new Error("接口返回异常");
    return data;
  }
  function fmtTime(ts) {
    if (!ts) return "-";
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ---------- 类型切换 ----------
  function setType(t) {
    state.ftype = t;
    els.typeSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.type === t));
    els.typeHint.textContent = TYPE_HINTS[t];
    document.querySelectorAll("[data-for]").forEach((el) => {
      const kinds = el.getAttribute("data-for").split(/\s+/);
      el.style.display = kinds.includes(t) ? "" : "none";
    });
  }
  els.typeSeg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setType(b.dataset.type)));

  // ---------- 列表 ----------
  function statusBadge(a) {
    if (a.enabled === false) return '<span class="badge mute">停用</span>';
    if (a.cooldownUntil && a.cooldownUntil > Date.now()) return '<span class="badge warn">冷却中</span>';
    if (a.lastError) return '<span class="badge err">异常</span>';
    if (a.lastCheck) return '<span class="badge ok">正常</span>';
    return '<span class="badge mute">未检查</span>';
  }
  function quotaText(a) {
    if (a.type !== "workbuddy" && a.type !== "trae") return "旧通用号（已移除中转，请删除）";
    const c = a.credits != null ? `剩 ${a.credits}` : "剩 ?";
    const bonus = a.signinCredits != null ? `（签到累计 ${a.signinCredits}）` : "";
    const s = a.checkedIn == null ? "" : (a.checkedIn ? " · 已签" : " · 未签");
    let detail = "";
    if (Array.isArray(a.resources) && a.resources.length) {
      const rows = a.resources.map((r) =>
        `<div>${esc(r.name || "未知包")}｜${esc(r.unit || "?")}｜剩 ${esc(r.remaining)}` +
        (r.cycleRemaining != null ? `｜周期剩 ${esc(r.cycleRemaining)}` : "") +
        `｜status=${esc(r.status)}</div>`).join("");
      detail = `<details class="res-detail"><summary>分包明细（${a.resources.length}）</summary>${rows}</details>`;
    }
    return esc(c + bonus + s) + detail;
  }
  async function loadAccounts() {
    try {
      const r = await api("/api/accounts");
      const list = r.data || [];
      els.acctEmpty.classList.toggle("hidden", list.length > 0);
      els.acctTable.classList.toggle("hidden", !list.length);
      els.acctBody.innerHTML = list.map((a) => `
        <tr>
          <td><div class="row-remark">${esc(a.remark)}</div>
            <div class="row-sub">${esc(a.id)}${a.cooldownUntil > Date.now() ? " · 冷却至 " + fmtTime(a.cooldownUntil) : ""}</div></td>
          <td>${esc(a.type)}${a.enabled === false ? "（停用）" : ""}</td>
          <td>${statusBadge(a)}${a.lastError ? `<div class="row-sub">${esc(a.lastError)}</div>` : ""}</td>
          <td>${quotaText(a)}</td>
          <td>${fmtTime(a.lastCheck)}</td>
          <td><div class="row-actions">
            <button class="mini" data-act="check" data-id="${esc(a.id)}">检查</button>
            ${(a.type === "workbuddy" || a.type === "trae") ? `<button class="mini" data-act="claim" data-id="${esc(a.id)}">签到</button>` : ""}
            ${a.type === "workbuddy" ? `<button class="mini" data-act="refresh" data-id="${esc(a.id)}">刷新</button>` : ""}
            <button class="mini" data-act="toggle" data-id="${esc(a.id)}">${a.enabled === false ? "启用" : "停用"}</button>
            <button class="mini" data-act="edit" data-id="${esc(a.id)}">编辑</button>
            <button class="mini danger" data-act="del" data-id="${esc(a.id)}">删除</button>
          </div></td>
        </tr>`).join("");
    } catch (e) {
      banner(els.acctFeedback, false, "加载账户失败：" + e.message);
    }
  }
  els.acctBody.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button[data-act]");
    if (!btn) return;
    const { act, id } = btn.dataset;
    try {
      if (act === "del") {
        if (!confirm("确定删除该账户吗？token 将一并清除。")) return;
        await api("/api/accounts/delete", { method: "POST", body: JSON.stringify({ id }) });
        toast("已删除");
      } else if (act === "toggle") {
        const cur = await api("/api/accounts");
        const a = (cur.data || []).find((x) => x.id === id);
        await api("/api/accounts/toggle", { method: "POST", body: JSON.stringify({ id, enabled: !(a && a.enabled !== false) }) });
        toast("已切换");
      } else if (act === "edit") {
        openEdit(id);
        return;
      } else if (act === "check") {
        btn.disabled = true;
        const r = await api("/api/accounts/check", { method: "POST", body: JSON.stringify({ id }) });
        const item = (r.data || [])[0];
        banner(els.acctFeedback, item && item.ok, item ? (item.ok ? `${item.remark} 检查正常` : `${item.remark} 失败：${item.error}`) : "无结果");
      } else if (act === "claim") {
        btn.disabled = true;
        const r = await api("/api/accounts/claim", { method: "POST", body: JSON.stringify({ id }) });
        const item = (r.data || [])[0];
        banner(els.acctFeedback, item && item.ok, item ? (item.ok ? `${item.remark}：${item.skipped ? item.reason : "签到成功"}` : `${item.remark} 失败：${item.error}`) : "无结果");
      } else if (act === "refresh") {
        btn.disabled = true;
        await api("/api/accounts/refresh", { method: "POST", body: JSON.stringify({ id }) });
        banner(els.acctFeedback, true, "刷新成功（accessToken 已更新）");
      }
    } catch (e) {
      banner(els.acctFeedback, false, "操作失败：" + e.message);
    } finally {
      loadAccounts();
    }
  });

  // ---------- 新增/编辑 ----------
  function openAdd() {
    state.editingId = null;
    els.formTitle.textContent = "加入账户";
    els.form.classList.remove("hidden");
    els.form.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  async function openEdit(id) {
    try {
      const r = await api("/api/accounts");
      const a = (r.data || []).find((x) => x.id === id);
      if (!a) { toast("账户不存在", true); return; }
      state.editingId = id;
      els.formTitle.textContent = "编辑账户（token 留空=不改）";
      els.remark.value = "";
      banner(els.formFeedback, true, `正在编辑 ${a.remark}（${a.type}）：token 类字段留空则保留原值，备注会直接覆盖。点保存前先在上方“备注”填回备注名。`);
      els.form.classList.remove("hidden");
      els.form.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (e) { toast(e.message, true); }
  }
  els.btnAdd.addEventListener("click", openAdd);
  els.btnCancelForm.addEventListener("click", () => {
    els.form.classList.add("hidden");
    state.editingId = null;
    banner(els.formFeedback, true, "");
  });
  els.form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (state.busy) return;
    const remark = els.remark.value.trim();
    if (!remark) { banner(els.formFeedback, false, "请先填备注名"); return; }
    const patch = { remark, type: state.ftype };
    // 编辑时空=不改，新增时按必填校验（后端会再拦一次）
    const take = (el) => el.value.trim();
    if (state.ftype === "workbuddy") {
      if (take(els.access)) patch.accessToken = take(els.access);
      else if (!state.editingId) patch.accessToken = "";
      if (take(els.refresh)) patch.refreshToken = take(els.refresh);
      if (take(els.uid)) patch.uid = take(els.uid);
      if (take(els.endpoint)) patch.endpoint = take(els.endpoint);
    } else if (state.ftype === "trae") {
      if (take(els.jwt)) patch.token = take(els.jwt);
      else if (!state.editingId) patch.token = "";
      if (take(els.device)) patch.deviceId = take(els.device);
    }
    state.busy = true;
    try {
      if (!state.editingId) {
        await api("/api/accounts", { method: "POST", body: JSON.stringify({ action: "create", account: patch }) });
        banner(els.formFeedback, true, "已加入。建议点一次“检查”，正常再配下游。");
      } else {
        await api("/api/accounts", { method: "POST", body: JSON.stringify({ action: "update", id: state.editingId, patch }) });
        banner(els.formFeedback, true, "已保存。");
      }
      els.form.reset();
      setType(state.ftype);
      loadAccounts();
    } catch (e) {
      banner(els.formFeedback, false, "保存失败：" + e.message);
    } finally { state.busy = false; }
  });

  // ---------- 批量 ----------
  els.btnCheckAll.addEventListener("click", async () => {
    banner(els.acctFeedback, true, "");
    try {
      const r = await api("/api/accounts/check", { method: "POST", body: "{}" });
      const ok = (r.data || []).filter((x) => x.ok).length;
      banner(els.acctFeedback, ok > 0, `检查完成：${ok}/${(r.data || []).length} 正常`);
    } catch (e) { banner(els.acctFeedback, false, e.message); }
    loadAccounts();
  });
  els.btnClaimAll.addEventListener("click", async () => {
    try {
      const r = await api("/api/accounts/claim", { method: "POST", body: "{}" });
      const ok = (r.data || []).filter((x) => x.ok).length;
      banner(els.acctFeedback, ok > 0, `签到完成：${ok}/${(r.data || []).length} 成功（含已签跳过）`);
    } catch (e) { banner(els.acctFeedback, false, e.message); }
    loadAccounts();
  });

  // ---------- 自动签到设置 ----------
  async function loadConfig() {
    try {
      const r = await api("/api/config");
      const c = r.data || {};
      els.cHour.value = c.autoSignHour ?? 9;
    } catch { /* 忽略 */ }
  }
  els.btnSaveConfig.addEventListener("click", async () => {
    try {
      await api("/api/config", { method: "POST", body: JSON.stringify({ autoSignHour: Number(els.cHour.value) }) });
      els.configFeedback.textContent = "已保存";
      setTimeout(() => (els.configFeedback.textContent = ""), 2000);
      loadConfig();
    } catch (e) { toast(e.message, true); }
  });

  // ---------- 日志 ----------
  async function loadLogs() {
    try {
      const r = await fetch("/api/logs?tail=200").then((x) => x.json());
      els.logs.textContent = (r.data || []).join("\n") || "(暂无日志)";
    } catch { els.logs.textContent = "(日志读取失败)"; }
  }
  els.btnLogs.addEventListener("click", loadLogs);

  setType("workbuddy");
  loadAccounts();
  loadConfig();
  loadLogs();
})();
