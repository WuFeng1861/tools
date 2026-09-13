/* 剪贴板历史 —— 完整页前端逻辑 */
(function () {
  "use strict";

  var state = { items: [], settings: null, q: "", type: "" };

  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------ 工具函数
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function fmtTime(ts) {
    var d = new Date(ts || 0);
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return (
      d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds())
    );
  }
  function typeName(t) {
    return t === "text" ? "文字" : t === "image" ? "图片" : t === "files" ? "文件" : t;
  }
  function toast(msg) {
    var el = document.createElement("div");
    el.textContent = msg;
    el.style.cssText =
      "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);" +
      "background:rgba(20,30,60,.92);color:#fff;padding:9px 16px;border-radius:8px;" +
      "font-size:13px;z-index:9999;box-shadow:0 6px 20px rgba(0,0,0,.2)";
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 1800);
  }

  // ------------------------------------------------------------ 平台桥（读取/设置全局快捷键）
  var inPlatform = (function () {
    try { return window.top && window.top !== window.self; } catch (e) { return false; }
  })();
  function bridgeCall(payload) {
    return new Promise(function (resolve) {
      if (!inPlatform) { resolve({ ok: false, error: "need-platform" }); return; }
      var timer = window.setTimeout(function () {
        window.removeEventListener("message", h);
        resolve({ ok: false, error: "timeout" });
      }, 1500);
      function h(ev) {
        var d = ev.data;
        if (d && d.type === "platform:hotkey-result") {
          window.removeEventListener("message", h);
          window.clearTimeout(timer);
          resolve(d);
        }
      }
      window.addEventListener("message", h);
      try { (window.parent || window).postMessage(payload, "*"); }
      catch (e) { resolve({ ok: false, error: String(e) }); }
    });
  }
  function getHotkey() { return bridgeCall({ type: "platform:get-hotkey" }); }
  function setHotkey(accel) { return bridgeCall({ type: "platform:set-hotkey", accel: accel }); }

  // ------------------------------------------------------------ 数据加载
  function fetchJSON(url, opts) {
    return fetch(url, opts).then(function (r) { return r.json(); });
  }

  function load() {
    var url = "/api/history?q=" + encodeURIComponent(state.q) + "&type=" + encodeURIComponent(state.type);
    fetchJSON(url)
      .then(function (j) {
        if (j.ok) {
          state.items = j.data.items;
          state.settings = j.data.settings;
          renderRow();
          renderSettings();
        }
      })
      .catch(function () { toast("加载失败"); });
  }

  // ------------------------------------------------------------ 渲染
  function cardHTML(it) {
    var pinBtn =
      '<button class="pin-btn ' + (it.pinned ? "on" : "") + '" data-act="pin" data-id="' + it.id + '" title="置顶/取消置顶">📌</button>';
    var body = "";
    if (it.type === "text") {
      body = '<div class="body-text">' + esc(it.text) + "</div>";
    } else if (it.type === "image") {
      body = '<img class="body-img" src="/images/' + encodeURIComponent(it.imageFile) + '" />';
    } else {
      body =
        '<div class="body-files">' +
        (it.files || []).map(function (f) { return "<div>📄 " + esc(f) + "</div>"; }).join("") +
        "</div>";
    }
    var srcText =
      it.sourceApp && it.settingsShow ? '<span>来源：' + esc(it.sourceApp) + "</span>" : "";
    return (
      '<div class="card" data-id="' + it.id + '">' +
      pinBtn +
      '<div class="meta">' +
      '<span class="tag">' + typeName(it.type) + "</span>" +
      (it.pinned ? '<span style="color:#d97706">★ 置顶</span>' : "") +
      "<span>" + esc(it.subText || "") + "</span>" +
      srcText +
      '<span class="time">' + fmtTime(it.ts) + "</span>" +
      '<span class="actions">' +
      '<button data-act="paste" data-id="' + it.id + '">复制</button>' +
      '<button class="del" data-act="del" data-id="' + it.id + '">删除</button>' +
      "</span>" +
      "</div>" +
      body +
      "</div>"
    );
  }

  function renderRow() {
    var list = $("list");
    var empty = $("empty");
    if (!state.items.length) {
      list.innerHTML = "";
      empty.style.display = "";
      return;
    }
    empty.style.display = "none";
    if (!state.settings) state.settings = {};
    var showSource = !!state.settings.showSourceApp;
    list.innerHTML = state.items
      .map(function (it) {
        it.settingsShow = showSource;
        return cardHTML(it);
      })
      .join("");
  }

  // ------------------------------------------------------------ 交互
  $("search").addEventListener("input", function () {
    state.q = this.value.trim();
    load();
  });

  $("typeSeg").addEventListener("click", function (ev) {
    var btn = ev.target.closest("button");
    if (!btn) return;
    this.querySelectorAll("button").forEach(function (b) { b.classList.remove("on"); });
    btn.classList.add("on");
    state.type = btn.getAttribute("data-type");
    load();
  });

  $("list").addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-act]");
    if (!btn) return;
    var id = btn.getAttribute("data-id");
    var act = btn.getAttribute("data-act");
    if (act === "paste") {
      fetchJSON("/api/paste", { method: "POST", body: JSON.stringify({ id: id }) })
        .then(function (j) { toast(j.ok ? "已复制到剪贴板" : (j.error || "复制失败")); });
    } else if (act === "pin") {
      fetchJSON("/api/pin", { method: "POST", body: JSON.stringify({ id: id }) }).then(load);
    } else if (act === "del") {
      if (!confirm("删除这条记录？")) return;
      fetchJSON("/api/delete", { method: "POST", body: JSON.stringify({ id: id }) }).then(load);
    }
  });

  // 点击卡片任意处也可复制（快速粘贴）
  $("list").addEventListener("click", function (ev) {
    if (ev.target.closest("[data-act]")) return;
    var card = ev.target.closest(".card");
    if (card) {
      fetchJSON("/api/paste", { method: "POST", body: JSON.stringify({ id: card.getAttribute("data-id") }) })
        .then(function (j) { toast(j.ok ? "已复制到剪贴板" : (j.error || "复制失败")); });
    }
  });

  $("btnClear").addEventListener("click", function () {
    if (!confirm("确定清空全部历史？\n置顶项会根据设置决定是否保留。")) return;
    fetchJSON("/api/clear", { method: "POST" }).then(load);
  });

  $("btnSettings").addEventListener("click", function () {
    var s = $("settings");
    s.style.display = s.style.display === "none" ? "" : "none";
  });

  function saveSettings(patch, cb) {
    fetchJSON("/api/settings", { method: "POST", body: JSON.stringify(patch) })
      .then(function (j) { if (j.ok && state.settings) Object.assign(state.settings, patch); cb && cb(j); });
  }

  function renderSettings() {
    if (!state.settings) return;
    $("sMonitor").checked = !!state.settings.monitoringEnabled;
    $("sMaxEntries").value = state.settings.maxEntries;
    $("sMaxImages").value = state.settings.maxImages;
    $("sPoll").value = state.settings.pollIntervalMs;
    $("sDedupe").checked = !!state.settings.dedupe;
    $("sSource").checked = !!state.settings.showSourceApp;
    $("sKeepPin").checked = !!state.settings.keepPinnedOnClear;
  }

  $("sMonitor").addEventListener("change", function () { saveSettings({ monitoringEnabled: this.checked }); });
  $("sMaxEntries").addEventListener("change", function () { saveSettings({ maxEntries: Math.max(10, Number(this.value) || 200) }); });
  $("sMaxImages").addEventListener("change", function () { saveSettings({ maxImages: Math.max(5, Number(this.value) || 50) }); });
  $("sPoll").addEventListener("change", function () { saveSettings({ pollIntervalMs: Math.max(100, Number(this.value) || 300) }); });
  $("sDedupe").addEventListener("change", function () { saveSettings({ dedupe: this.checked }); });
  $("sSource").addEventListener("change", function () { saveSettings({ showSourceApp: this.checked }, load); });
  $("sKeepPin").addEventListener("change", function () { saveSettings({ keepPinnedOnClear: this.checked }); });

  // ------------------------------------------------------------ 全局快捷键设置
  var hotkeyInput = $("hotkey");
  var applyBtn = $("btnHotkeyApply");
  var hotkeyStatus = $("hotkeyStatus");
  var captured = "";

  if (!inPlatform) {
    hotkeyInput.placeholder = "需在平台内使用";
    hotkeyInput.disabled = true;
    hotkeyStatus.textContent = "平台专属";
  } else {
    getHotkey().then(function (r) {
      if (r.ok) { hotkeyInput.value = r.accel; captured = r.accel; }
      else hotkeyStatus.textContent = r.error === "need-platform" ? "平台专属" : "读取失败";
    });
  }

  hotkeyInput.addEventListener("focus", function () {
    captured = "";
    hotkeyStatus.textContent = "按下组合键…";
  });

  hotkeyInput.addEventListener("keydown", function (ev) {
    ev.preventDefault();
    var combo = keysOf(ev);
    if (!combo) {
      hotkeyStatus.textContent = "需包含 Ctrl/Alt/Win/Shift 加一个键";
      return;
    }
    captured = combo;
    this.value = combo;
    applyBtn.style.display = "";
    hotkeyStatus.textContent = "点「应用」生效";
  });

  function keysOf(e) {
    var mods = [];
    if (e.ctrlKey) mods.push("ctrl");
    if (e.metaKey) mods.push("super");
    if (e.altKey) mods.push("alt");
    if (e.shiftKey) mods.push("shift");
    var k = String(e.key || "").toLowerCase();
    var candidate = null;
    if (k.length === 1 && /[a-z0-9]/.test(k)) candidate = k;
    else if (/^f([1-9]|1[0-2])$/.test(k)) candidate = k;
    else {
      var sp = {
        " ": "space", enter: "enter", tab: "tab", escape: "esc",
        arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right",
        backspace: "backspace", delete: "delete", home: "home", end: "end",
      };
      candidate = sp[k] || null;
    }
    if (!candidate || !mods.length) return null;
    return mods.join("+") + "+" + candidate;
  }

  applyBtn.addEventListener("click", function () {
    if (!captured) return;
    setHotkey(captured).then(function (r) {
      if (r.ok) {
        applyBtn.style.display = "none";
        hotkeyStatus.textContent = "已生效：" + r.accel;
        toast("全局快捷键已更新");
      } else {
        hotkeyStatus.textContent = r.error === "timeout" ? "平台无响应" : (r.error || "设置失败");
      }
    });
  });

  // ------------------------------------------------------------ SSE 实时刷新
  function connectEvents() {
    var es = new EventSource("/api/events");
    es.onmessage = function (ev) {
      try {
        var d = JSON.parse(ev.data);
        if (d.type === "history-changed") load();
      } catch (e) {}
    };
    es.onerror = function () {
      // 断线自动重连（EventSource 内置）
    };
  }

  // ------------------------------------------------------------ 启动
  load();
  connectEvents();
})();