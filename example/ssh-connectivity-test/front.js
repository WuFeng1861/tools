// =====================================================================
// SSH 连通性测试工具 —— 前端逻辑
//
// 工具运行在自己的 Node 进程端口上，与后端同源，直接 fetch('/api/...')。
// 界面与样式参考 ccp/sshTest 项目，但用 Node.js + 原生 HTML/JS 实现。
// =====================================================================

// ---------- DOM ----------
const form = document.getElementById("test-form");
const btnTest = document.getElementById("btn-test");
const resultCard = document.getElementById("result");
const resultBadge = document.getElementById("result-badge");
const resultTitle = document.getElementById("result-title");
const resultReason = document.getElementById("result-reason");
const resultSteps = document.getElementById("result-steps");

const authMethodRadios = document.querySelectorAll('input[name="auth-method"]');
const passwordField = document.getElementById("password-field");
const keyFields = document.getElementById("key-fields");
const togglePasswordBtn = document.getElementById("toggle-password");
const passwordInput = document.getElementById("password");
const pickKeyBtn = document.getElementById("btn-pick-key");
const keyPathInput = document.getElementById("key-path");
const keyPicker = document.getElementById("key-picker");

// ---------- 认证方式切换 ----------
function syncAuthMethod() {
  const method = document.querySelector('input[name="auth-method"]:checked').value;
  passwordField.classList.toggle("hidden", method !== "password");
  keyFields.classList.toggle("hidden", method !== "key");
}

authMethodRadios.forEach((radio) => radio.addEventListener("change", syncAuthMethod));
syncAuthMethod();

// ---------- 密码显示/隐藏 ----------
let passwordVisible = false;
togglePasswordBtn.addEventListener("click", () => {
  passwordVisible = !passwordVisible;
  passwordInput.type = passwordVisible ? "text" : "password";
  togglePasswordBtn.textContent = passwordVisible ? "隐藏" : "显示";
});

// ---------- 浏览工具目录中的私钥文件 ----------
pickKeyBtn.addEventListener("click", async () => {
  if (!keyPicker.classList.contains("hidden")) {
    keyPicker.classList.add("hidden");
    return;
  }
  keyPicker.innerHTML = '<div class="key-picker-empty">正在扫描…</div>';
  keyPicker.classList.remove("hidden");

  try {
    const resp = await fetch("/api/list-keys");
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "扫描失败");

    if (!data.keys.length) {
      keyPicker.innerHTML =
        '<div class="key-picker-empty">工具目录下没有候选私钥文件，请直接填写绝对路径。</div>';
      return;
    }

    const list = document.createElement("ul");
    for (const name of data.keys) {
      const li = document.createElement("li");
      li.textContent = name;
      li.title = "点击填入（相对工具目录）";
      li.addEventListener("click", () => {
        keyPathInput.value = name;
        keyPicker.classList.add("hidden");
      });
      list.appendChild(li);
    }
    keyPicker.innerHTML = "";
    keyPicker.appendChild(list);
  } catch (err) {
    keyPicker.innerHTML = `<div class="key-picker-empty">${String(err)}</div>`;
  }
});

// ---------- 表单提交 ----------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (btnTest.disabled) return;

  const host = document.getElementById("host").value.trim();
  const port = Number(document.getElementById("port").value) || 22;
  const username = document.getElementById("username").value.trim();
  const timeout = Number(document.getElementById("timeout").value) || 10;
  const method = document.querySelector('input[name="auth-method"]:checked').value;
  const verifyLogin = document.getElementById("verify-login").checked;

  const password = passwordInput.value;
  const keyPath = keyPathInput.value.trim();
  const keyPassphrase = document.getElementById("key-passphrase").value;

  // ---------- 前端校验（后端也会校验） ----------
  if (!host) return showResult(false, "无法开始测试", "请填写主机地址。");
  if (!username) return showResult(false, "无法开始测试", "请填写用户名。");
  if (verifyLogin) {
    if (method === "password" && !password) {
      return showResult(false, "无法开始测试", "认证方式为密码时，请填写登录密码。");
    }
    if (method === "key" && !keyPath) {
      return showResult(false, "无法开始测试", "认证方式为私钥时，请填写私钥文件。");
    }
  }

  hideResult();
  setLoading(true);
  try {
    const resp = await fetch("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host,
        port,
        username,
        authMethod: method,
        password: method === "password" ? password : null,
        keyPath: method === "key" ? keyPath : null,
        keyPassphrase: keyPassphrase || null,
        verifyLogin,
        timeoutSecs: timeout,
      }),
    });
    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error || `HTTP ${resp.status}`);
    renderResult(result);
  } catch (err) {
    console.error(err);
    showResult(false, "测试出错", `调用后端失败：${String(err)}`);
  } finally {
    setLoading(false);
  }
});

// ---------- 渲染 ----------
function renderResult(result) {
  const { success, message, reason, steps, serverKeyFingerprint, elapsedMs } = result;

  resultBadge.className = `result-badge ${success ? "success" : "fail"}`;
  resultBadge.textContent = success ? "连接成功" : "连接失败";

  resultTitle.textContent = message;

  let fullReason = reason || "";
  if (serverKeyFingerprint) {
    fullReason += `\n服务端主机密钥指纹：${serverKeyFingerprint}`;
  }
  fullReason += `\n总耗时：${elapsedMs} ms`;
  resultReason.textContent = fullReason;

  resultSteps.innerHTML = "";
  for (const step of steps || []) {
    const li = document.createElement("li");
    const timeSpan = document.createElement("span");
    timeSpan.className = "step-time";
    timeSpan.textContent = step.time;
    li.textContent = step.text;
    li.classList.add(step.ok ? "ok" : "fail");
    li.appendChild(timeSpan);
    resultSteps.appendChild(li);
  }

  resultCard.classList.remove("hidden");
}

function showResult(success, title, reason) {
  resultBadge.className = `result-badge ${success ? "success" : "fail"}`;
  resultBadge.textContent = success ? "连接成功" : "连接失败";
  resultTitle.textContent = title;
  resultReason.textContent = reason;
  resultSteps.innerHTML = "";
  resultCard.classList.remove("hidden");
}

function hideResult() {
  resultCard.classList.add("hidden");
}

function setLoading(loading) {
  btnTest.disabled = loading;
  btnTest.classList.toggle("loading", loading);
  btnTest.querySelector(".btn-label").textContent = loading ? "正在测试" : "开始测试";
}

// =====================================================================
// 历史测试记录：后端持久化在工具目录 history.json，前端只做 CRUD
// =====================================================================

let historyRecords = [];

const btnSaveHistory = document.getElementById("btn-save-history");
const btnClearHistory = document.getElementById("btn-clear-history");
const historyList = document.getElementById("history-list");
const historyEmpty = document.getElementById("history-empty");
const toast = document.getElementById("toast");

function formatTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function flashToast(msg, isError = false) {
  toast.textContent = msg;
  toast.className = "toast" + (isError ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.add("hidden"), 1800);
}

/** 收集当前表单为一条记录（主机/用户名为空时返回 null） */
function collectForm() {
  const host = document.getElementById("host").value.trim();
  const username = document.getElementById("username").value.trim();
  if (!host || !username) return null;
  return {
    host,
    port: Number(document.getElementById("port").value) || 22,
    username,
    authMethod: document.querySelector('input[name="auth-method"]:checked').value,
    password: passwordInput.value,
    keyPath: keyPathInput.value.trim(),
    keyPassphrase: document.getElementById("key-passphrase").value,
    verifyLogin: document.getElementById("verify-login").checked,
    timeoutSecs: Number(document.getElementById("timeout").value) || 10,
  };
}

/** 把一条历史记录填充到表单 */
function fillForm(rec) {
  document.getElementById("host").value = rec.host || "";
  document.getElementById("port").value = rec.port || 22;
  document.getElementById("username").value = rec.username || "";
  const radio = document.querySelector(
    `input[name="auth-method"][value="${rec.authMethod === "key" ? "key" : "password"}"]`,
  );
  if (radio) radio.checked = true;
  syncAuthMethod();
  passwordInput.value = rec.password || "";
  keyPathInput.value = rec.keyPath || "";
  document.getElementById("key-passphrase").value = rec.keyPassphrase || "";
  document.getElementById("verify-login").checked = !!rec.verifyLogin;
  document.getElementById("timeout").value = rec.timeoutSecs || 10;
  document.getElementById("host").focus();
  document.getElementById("host").select();
  flashToast(`已填充：${rec.username}@${rec.host}:${rec.port}`);
}

async function loadHistory() {
  try {
    const resp = await fetch("/api/history");
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "加载失败");
    historyRecords = data.records || [];
  } catch (err) {
    console.error("加载历史记录失败:", err);
    historyRecords = [];
  }
  renderHistory();
}

function renderHistory() {
  historyList.innerHTML = "";
  historyEmpty.style.display = historyRecords.length ? "none" : "";

  for (const rec of historyRecords) {
    const li = document.createElement("li");
    li.className = "history-item";
    li.dataset.id = rec.id;

    // 主体：点击填充
    const main = document.createElement("div");
    main.className = "history-main";
    main.title = "点击填充到表单";
    main.addEventListener("click", () => fillForm(rec));

    const user = document.createElement("span");
    user.className = "history-user";
    user.textContent = `${rec.username}@${rec.host}`;
    const port = document.createElement("span");
    port.className = "history-port";
    port.textContent = `:${rec.port}`;
    const method = document.createElement("span");
    method.className = `history-method${rec.authMethod === "key" ? " key" : ""}`;
    method.textContent = rec.authMethod === "key" ? "私钥" : "密码";
    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = formatTime(rec.savedAt);
    main.append(user, port, method, time);

    // 操作：更新 / 删除
    const ops = document.createElement("div");
    ops.className = "history-ops";
    const btnUpd = document.createElement("button");
    btnUpd.type = "button";
    btnUpd.className = "btn-mini";
    btnUpd.textContent = "更新";
    btnUpd.title = "用当前表单内容覆盖这条记录";
    btnUpd.addEventListener("click", () => updateHistory(rec.id));
    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "btn-mini danger";
    btnDel.textContent = "删除";
    btnDel.title = "删除这条记录";
    btnDel.addEventListener("click", () => deleteHistory(rec.id));
    ops.append(btnUpd, btnDel);

    li.append(main, ops);
    historyList.appendChild(li);
  }
}

async function saveHistory() {
  const rec = collectForm();
  if (!rec) return flashToast("请先填写主机地址和用户名", true);
  try {
    const resp = await fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rec),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "保存失败");
    flashToast("已保存到历史记录");
    await loadHistory();
  } catch (err) {
    flashToast(`保存失败：${err}`, true);
  }
}

async function updateHistory(id) {
  const rec = collectForm();
  if (!rec) return flashToast("请先填写主机地址和用户名", true);
  try {
    const resp = await fetch("/api/history", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...rec }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "更新失败");
    flashToast("已更新该条记录");
    await loadHistory();
  } catch (err) {
    flashToast(`更新失败：${err}`, true);
  }
}

async function deleteHistory(id) {
  if (!confirm("确定删除这条历史记录？")) return;
  try {
    await fetch("/api/history", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    flashToast("已删除");
    await loadHistory();
  } catch (err) {
    flashToast(`删除失败：${err}`, true);
  }
}

async function clearHistory() {
  if (!historyRecords.length) return;
  if (!confirm(`确定清空全部 ${historyRecords.length} 条历史记录？`)) return;
  try {
    await fetch("/api/history", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    flashToast("已清空历史记录");
    await loadHistory();
  } catch (err) {
    flashToast(`清空失败：${err}`, true);
  }
}

btnSaveHistory.addEventListener("click", saveHistory);
btnClearHistory.addEventListener("click", clearHistory);

// 页面加载时读取历史
loadHistory();
