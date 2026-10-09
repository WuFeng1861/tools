/* 即意 · consciousness-stream —— 客户端逻辑（无框架 / 无构建） */
(function () {
  "use strict";

  var PRESETS = [
    "#6366f1", "#8b5cf6", "#ec4899", "#ef4444", "#f97316",
    "#eab308", "#22c55e", "#06b6d4", "#3b82f6"
  ];
  var TOTAL = 20;

  /* ---------------- 状态 ---------------- */
  var state = {
    items: [],
    completedItems: [],
    themeColor: "#6366f1",
    rainbow: false,
    flow: false,
    mode: "dark",
    savedColors: [],
    sessions: [],
    activeSessionId: null,
    sessionTitle: ""
  };

  var collapsed = false;
  var copiedId = null;
  var copyTimer = null;
  var pending = false;

  var rainbowTimer = null;
  var rainbowHue = 0;
  var flowTimer = null;
  var flowBaseHue = 230;
  var flowPhase = 0;

  var drag = { active: false, from: -1, to: -1, heights: [] };

  var overlayOpen = false;
  var popupOpen = false;
  var renameActive = null;   // { id, text, original }
  var confirmOpen = false;
  var confirmCb = null;
  var migrateOpen = false;

  /* ---------------- DOM ---------------- */
  var inputEl = document.getElementById("streamInput");
  var streamListEl = document.getElementById("streamList");
  var completedEl = document.getElementById("completedContainer");
  var progressTextEl = document.getElementById("progressText");
  var progressFillEl = document.getElementById("progressFill");
  var listsBtn = document.getElementById("listsBtn");
  var minBtn = document.getElementById("minBtn");
  var closeBtn = document.getElementById("closeBtn");
  var themeTrigger = document.getElementById("themeTrigger");
  var themeDot = document.getElementById("themeDot");
  var themePopup = document.getElementById("themePopup");
  var overlayEl = document.getElementById("overlayContainer");
  var dialogEl = document.getElementById("dialogContainer");
  var newSessionBtn = document.getElementById("newSessionBtn");
  var legacyBtn = document.getElementById("legacyBtn");
  var portInfoEl = document.getElementById("portInfo");

  /* ---------------- 工具 ---------------- */
  function api(path, body) {
    return fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function hexToHsl(hex) {
    var r = parseInt(hex.slice(1, 3), 16) / 255;
    var g = parseInt(hex.slice(3, 5), 16) / 255;
    var b = parseInt(hex.slice(5, 7), 16) / 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var h = 0;
    var s = 0;
    var l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  function formatTime(ts) {
    var d = new Date(ts);
    var now = new Date();
    function pad(n) { return String(n).padStart(2, "0"); }
    var hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    function startOfDay(x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); }
    var dayDiff = Math.floor((startOfDay(now) - startOfDay(d)) / 86400000);
    if (dayDiff === 0) return "今天 " + hm;
    if (dayDiff === 1) return "昨天 " + hm;
    if (dayDiff < 7) return dayDiff + "天前 " + hm;
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function fmtSize(n) {
    if (n == null) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  /* ---------------- 主题 ---------------- */
  function applyThemeColor(hex) {
    var hsl = hexToHsl(hex);
    var root = document.documentElement;
    root.style.setProperty("--theme-h", String(hsl.h));
    root.style.setProperty("--theme-s", hsl.s + "%");
    root.style.setProperty("--theme-l", hsl.l + "%");
  }

  function applyThemeMode(mode) {
    document.documentElement.setAttribute("data-theme", mode);
  }

  function startRainbow() {
    stopRainbow();
    rainbowTimer = setInterval(function () {
      rainbowHue = (rainbowHue + 1) % 360;
      var root = document.documentElement;
      root.style.setProperty("--theme-h", String(rainbowHue));
      root.style.setProperty("--theme-s", "84%");
      root.style.setProperty("--theme-l", "64%");
    }, 50);
  }

  function stopRainbow() {
    if (rainbowTimer) { clearInterval(rainbowTimer); rainbowTimer = null; }
  }

  function startFlow() {
    stopFlow();
    flowBaseHue = hexToHsl(state.themeColor).h;
    flowPhase = 0;
    flowTimer = setInterval(function () {
      flowPhase = (flowPhase + 0.03) % (Math.PI * 2);
      var hue = flowBaseHue + Math.sin(flowPhase) * 25;
      var root = document.documentElement;
      root.style.setProperty("--theme-h", String(Math.round(hue)));
      root.style.setProperty("--theme-s", "75%");
      root.style.setProperty("--theme-l", "60%");
    }, 40);
  }

  function stopFlow() {
    if (flowTimer) { clearInterval(flowTimer); flowTimer = null; }
  }

  function applyThemeFrom(data) {
    if (!data) return;
    if (typeof data.color === "string") state.themeColor = data.color;
    state.rainbow = !!data.rainbow;
    state.flow = !!data.flow;
    state.mode = data.mode === "light" ? "light" : "dark";
    applyThemeMode(state.mode);
    stopRainbow();
    stopFlow();
    if (state.rainbow) {
      startRainbow();
    } else if (state.flow) {
      startFlow();
    } else {
      applyThemeColor(state.themeColor);
    }
  }

  function setThemeColor(color) {
    state.rainbow = false;
    stopRainbow();
    state.flow = false;
    stopFlow();
    state.themeColor = color;
    applyThemeColor(color);
    renderThemeDot();
    renderPopup();
    api("/api/theme", { color: color, rainbow: false, flow: false }).catch(function () {});
  }

  function toggleRainbow() {
    state.rainbow = !state.rainbow;
    if (state.rainbow) {
      state.flow = false;
      stopFlow();
      startRainbow();
      api("/api/theme", { rainbow: true, flow: false }).catch(function () {});
    } else {
      stopRainbow();
      applyThemeColor(state.themeColor);
      api("/api/theme", { rainbow: false, flow: false }).catch(function () {});
    }
    renderThemeDot();
    renderPopup();
  }

  function toggleFlow() {
    state.flow = !state.flow;
    if (state.flow) {
      state.rainbow = false;
      stopRainbow();
      startFlow();
      api("/api/theme", { flow: true, rainbow: false }).catch(function () {});
    } else {
      stopFlow();
      applyThemeColor(state.themeColor);
      api("/api/theme", { flow: false, rainbow: false }).catch(function () {});
    }
    renderThemeDot();
    renderPopup();
  }

  function toggleMode() {
    state.mode = state.mode === "dark" ? "light" : "dark";
    applyThemeMode(state.mode);
    api("/api/theme", { mode: state.mode }).catch(function () {});
    renderPopup();
  }

  function randomColor() {
    var h = Math.floor(Math.random() * 360);
    var s = 70 + Math.floor(Math.random() * 20);
    var l = 55 + Math.floor(Math.random() * 15);
    var ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "hsl(" + h + ", " + s + "%, " + l + "%)";
    setThemeColor(ctx.fillStyle);
  }

  function renderThemeDot() {
    if (!themeDot) return;
    themeDot.classList.toggle("rainbow", state.rainbow);
    themeDot.classList.toggle("flow", state.flow);
    if (state.rainbow || state.flow) {
      themeDot.style.background = "";
    } else {
      themeDot.style.background = state.themeColor;
    }
  }

  /* ---------------- 渲染：主体 ---------------- */
  function setSession(data) {
    if (!data) return;
    state.activeSessionId = data.sessionId;
    state.sessionTitle = data.title || "";
    state.items = data.items || [];
    state.completedItems = data.completedItems || [];
  }

  function render() {
    renderStream();
    renderCompleted();
    renderProgress();
    renderThemeDot();
  }

  function renderProgress() {
    var cur = state.items.length;
    var pct = Math.min((cur / TOTAL) * 100, 100);
    if (cur >= TOTAL) {
      progressTextEl.textContent = "你并不空洞 ✨";
      progressTextEl.className = "progress-done";
    } else {
      progressTextEl.textContent = cur + " / " + TOTAL;
      progressTextEl.className = "progress-count";
    }
    progressFillEl.style.width = pct + "%";
  }

  function buildDisplayItems() {
    var out = [];
    if (!drag.active || drag.from < 0) {
      for (var i = 0; i < state.items.length; i++) {
        out.push({ item: state.items[i], ghost: false, index: i + 1, original: i });
      }
      return out;
    }
    var from = drag.from;
    var to = drag.to < 0 ? from : drag.to;
    var src = state.items.slice();
    var dragged = src.splice(from, 1)[0];
    if (!dragged) return out;
    if (to <= 0) {
      out.push({ item: dragged, ghost: true, index: 1, original: from });
      for (var j = 0; j < src.length; j++) {
        out.push({ item: src[j], ghost: false, index: j + 2, original: j >= from ? j + 1 : j });
      }
    } else {
      var insertAt = Math.min(to, src.length);
      for (var k = 0; k < src.length; k++) {
        if (k === insertAt) {
          out.push({ item: dragged, ghost: true, index: out.length + 1, original: from });
        }
        out.push({ item: src[k], ghost: false, index: out.length + 1, original: k >= from ? k + 1 : k });
      }
      if (insertAt >= src.length) {
        out.push({ item: dragged, ghost: true, index: out.length + 1, original: from });
      }
    }
    return out;
  }

  function renderStream() {
    if (!state.items.length && !drag.active) {
      streamListEl.innerHTML = '<div class="empty-hint">还没有内容<br />把此刻冒出来的想法写下来，回车即可加入</div>';
      return;
    }
    var rows = buildDisplayItems();
    var html = '<div class="list-inner">';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var cls = "stream-item" + (r.ghost ? " is-ghost" : "");
      var copyLabel = copiedId === r.item.id ? "✓" : "⧉";
      html +=
        '<div class="' + cls + '" data-index="' + r.original + '" data-id="' + esc(r.item.id) + '">' +
          '<span class="item-drag">⠿</span>' +
          '<span class="item-index">' + r.index + "</span>" +
          '<span class="item-content">' + esc(r.item.content) + "</span>" +
          '<div class="item-actions">' +
            '<button class="item-copy" data-id="' + esc(r.item.id) + '" title="复制">' + copyLabel + "</button>" +
            '<button class="item-complete" data-id="' + esc(r.item.id) + '" title="完成">✓</button>' +
            '<button class="item-delete" data-id="' + esc(r.item.id) + '" title="删除">×</button>' +
          "</div>" +
        "</div>";
    }
    html += "</div>";
    streamListEl.innerHTML = html;
  }

  function renderCompleted() {
    if (!state.completedItems.length) {
      completedEl.innerHTML = "";
      return;
    }
    var html =
      '<div class="completed-list">' +
        '<div class="completed-header" id="completedHeader">' +
          '<span class="completed-icon">✓</span>' +
          '<span class="completed-title">已完成</span>' +
          '<span class="completed-count">' + state.completedItems.length + "</span>" +
          '<span class="collapse-arrow' + (collapsed ? " is-collapsed" : "") + '">▾</span>' +
        "</div>" +
        '<div class="completed-items' + (collapsed ? " is-collapsed" : "") + '">' +
          '<div class="completed-inner">';
    for (var i = 0; i < state.completedItems.length; i++) {
      var it = state.completedItems[i];
      html +=
        '<div class="completed-item" data-id="' + esc(it.id) + '">' +
          '<span class="completed-check">✓</span>' +
          '<span class="completed-content">' + esc(it.content) + "</span>" +
          '<button class="completed-restore" data-id="' + esc(it.id) + '" title="返回未完成">↩</button>' +
          '<button class="completed-delete" data-id="' + esc(it.id) + '" title="删除">×</button>' +
        "</div>";
    }
    html += "</div></div></div>";
    completedEl.innerHTML = html;
  }

  function scrollToBottom() {
    streamListEl.scrollTop = streamListEl.scrollHeight;
  }

  /* ---------------- 输入 ---------------- */
  function focusInput() {
    if (!inputEl) return;
    if (document.activeElement === inputEl) return;
    try { inputEl.focus(); } catch (e) {}
  }

  function submitInput() {
    var text = (inputEl.value || "").trim();
    if (!text || pending) return;
    pending = true;
    api("/api/items", { content: text }).then(function (res) {
      pending = false;
      if (res.ok) {
        state.items = res.data.items || state.items;
        state.completedItems = res.data.completedItems || state.completedItems;
        inputEl.value = "";
        render();
        scrollToBottom();
        focusInput();
      }
    }).catch(function () { pending = false; });
  }

  /* ---------------- 条目操作 ---------------- */
  function copyItem(id) {
    var item = null;
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === id) { item = state.items[i]; break; }
    }
    if (!item) return;
    function done() {
      copiedId = id;
      var btn = streamListEl.querySelector('.item-copy[data-id="' + cssEscape(id) + '"]');
      if (btn) btn.textContent = "✓";
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(function () {
        copiedId = null;
        var b = streamListEl.querySelector('.item-copy[data-id="' + cssEscape(id) + '"]');
        if (b) b.textContent = "⧉";
      }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(item.content).then(done).catch(function () { fallbackCopy(item.content); done(); });
    } else {
      fallbackCopy(item.content);
      done();
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
  }

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  function deleteItem(id) {
    api("/api/items/delete", { id: id }).then(function (res) {
      if (res.ok) {
        state.items = res.data.items || state.items;
        state.completedItems = res.data.completedItems || state.completedItems;
        render();
      }
    }).catch(function () {});
  }

  function completeItem(id) {
    api("/api/items/complete", { id: id }).then(function (res) {
      if (res.ok) {
        state.items = res.data.items || state.items;
        state.completedItems = res.data.completedItems || state.completedItems;
        render();
      }
    }).catch(function () {});
  }

  function deleteCompleted(id) {
    api("/api/completed/delete", { id: id }).then(function (res) {
      if (res.ok) {
        state.items = res.data.items || state.items;
        state.completedItems = res.data.completedItems || state.completedItems;
        render();
      }
    }).catch(function () {});
  }

  // 已完成 → 返回未完成（移回当前清单末尾）
  function restoreCompleted(id) {
    api("/api/completed/restore", { id: id }).then(function (res) {
      if (res.ok) {
        state.items = res.data.items || state.items;
        state.completedItems = res.data.completedItems || state.completedItems;
        render();
        scrollToBottom();
      }
    }).catch(function () {});
  }

  /* ---------------- 拖拽排序 ---------------- */
  function measureHeights() {
    var rows = streamListEl.querySelectorAll(".stream-item");
    drag.heights = [];
    for (var i = 0; i < rows.length; i++) {
      drag.heights.push(rows[i].offsetHeight + 4);
    }
  }

  function getIndexFromY(y) {
    var rect = streamListEl.getBoundingClientRect();
    var relY = y - rect.top + streamListEl.scrollTop;
    var acc = 0;
    var heights = drag.heights;
    for (var i = 0; i < heights.length; i++) {
      acc += heights[i];
      if (relY < acc - heights[i] / 2) return i;
      if (relY < acc) return i;
    }
    return heights.length - 1;
  }

  function onDragMove(ev) {
    drag.to = getIndexFromY(ev.clientY);
    renderStream();
  }

  function onDragUp() {
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragUp);
    document.body.style.cursor = "";
    var from = drag.from;
    var to = drag.to;
    drag.active = false;
    drag.from = -1;
    drag.to = -1;
    if (from >= 0 && to >= 0 && from !== to) {
      var re = state.items.slice();
      var moved = re.splice(from, 1)[0];
      if (moved) {
        re.splice(to, 0, moved);
        state.items = re;
        renderStream();
        api("/api/items/reorder", { ids: re.map(function (it) { return it.id; }) }).then(function (res) {
          if (res && res.ok && res.data && res.data.items) {
            state.items = res.data.items;
            renderStream();
          }
        }).catch(function () {});
      }
      return;
    }
    renderStream();
  }

  function startDrag(fromIndex, clientY) {
    if (fromIndex < 0) return;
    drag.active = true;
    drag.from = fromIndex;
    drag.to = fromIndex;
    measureHeights();
    renderStream();
    document.body.style.cursor = "grabbing";
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragUp);
  }

  /* ---------------- 主题弹层 ---------------- */
  function renderPopup() {
    var activeColor = function (c) {
      return state.themeColor === c && !state.rainbow && !state.flow ? " active" : "";
    };
    var h = '<div class="popup-header">' +
      '<button class="mode-toggle" data-act="mode" title="' + (state.mode === "dark" ? "切换亮色" : "切换暗色") + '">' +
      (state.mode === "dark" ? "☀️" : "🌙") + "</button></div>";
    h += '<div class="section-label">预设</div><div class="preset-colors">';
    for (var i = 0; i < PRESETS.length; i++) {
      var c = PRESETS[i];
      h += '<button class="color-dot' + activeColor(c) + '" style="background:' + c + '" data-color="' + c + '"></button>';
    }
    h += "</div>";
    if (state.savedColors.length) {
      h += '<div class="saved-section"><div class="section-label">已保存</div><div class="saved-colors">';
      for (var j = 0; j < state.savedColors.length; j++) {
        var sc = state.savedColors[j];
        h += '<div class="saved-color-item">' +
          '<button class="color-dot' + activeColor(sc) + '" style="background:' + sc + '" data-color="' + esc(sc) + '"></button>' +
          '<button class="remove-saved" data-remove="' + esc(sc) + '" title="移除">×</button>' +
          "</div>";
      }
      h += "</div></div>";
    }
    h += '<div class="theme-actions">' +
      '<label class="custom-color-wrap"><input type="color" class="custom-color" value="' + esc(state.themeColor) + '" />' +
      '<span class="custom-color-label">自选</span></label>' +
      '<button class="action-btn save-btn" data-act="save">保存</button>' +
      '<button class="action-btn random-btn" data-act="random">随机</button>' +
      '<button class="action-btn rainbow-btn' + (state.rainbow ? " active" : "") + '" data-act="rainbow">炫彩</button>' +
      '<button class="action-btn flow-btn' + (state.flow ? " active" : "") + '" data-act="flow">流光</button>' +
      "</div>";
    themePopup.innerHTML = h;
  }

  function openPopup() {
    popupOpen = true;
    renderPopup();
    themePopup.classList.add("show");
  }

  function closePopup() {
    popupOpen = false;
    themePopup.classList.remove("show");
  }

  function saveColor() {
    if (state.rainbow || state.flow) return;
    api("/api/saved-colors", { color: state.themeColor }).then(function (res) {
      if (res.ok) {
        state.savedColors = res.data.colors || [];
        renderPopup();
      }
    }).catch(function () {});
  }

  function removeSaved(color) {
    api("/api/saved-colors/delete", { color: color }).then(function (res) {
      if (res.ok) {
        state.savedColors = res.data.colors || [];
        renderPopup();
      }
    }).catch(function () {});
  }

  /* ---------------- 全部清单遮罩 ---------------- */
  function loadState() {
    return api("/api/state").then(function (res) {
      if (res.ok && res.data) {
        state.sessions = res.data.sessions || [];
        state.activeSessionId = res.data.activeSessionId;
        if (res.data.themeColor) state.themeColor = res.data.themeColor;
        if (portInfoEl && res.data.port) {
          portInfoEl.textContent = "127.0.0.1:" + res.data.port;
        }
      }
      return res;
    });
  }

  function openOverlay() {
    overlayOpen = true;
    overlayEl.classList.add("show");
    renderOverlay();
    loadState().then(renderOverlay).catch(function () {});
  }

  function closeOverlay() {
    overlayOpen = false;
    renameActive = null;
    overlayEl.classList.remove("show");
  }

  function renderOverlay() {
    var sessions = state.sessions.slice().sort(function (a, b) { return b.createdAt - a.createdAt; });
    var h = '<div class="all-lists">' +
      '<div class="lists-header">' +
        '<button class="back-btn" data-act="back" title="返回">‹</button>' +
        '<span class="lists-title">全部清单</span>' +
        '<span class="lists-count">' + sessions.length + "</span>" +
        '<button class="new-btn" data-act="new" title="新建">＋</button>' +
      "</div>" +
      '<div class="lists-body">';
    if (!sessions.length) {
      h += '<div class="empty"><p>还没有清单</p></div>';
    }
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var isActive = s.id === state.activeSessionId;
      var items = s.items || [];
      var completed = s.completedItems || [];
      var total = items.length + completed.length;
      h += '<div class="list-card' + (isActive ? " active" : "") + '" data-id="' + esc(s.id) + '">' +
        '<div class="card-main">';
      if (renameActive && renameActive.id === s.id) {
        h += '<input class="card-title-input" value="' + esc(renameActive.text) + '" placeholder="' + esc(s.title) + '" />';
      } else {
        h += '<span class="card-title">' + esc(s.title) + "</span>";
      }
      if (isActive) h += '<span class="badge">当前</span>';
      h += '<button class="card-edit" data-act="edit" title="重命名">✎</button>' +
        '<button class="card-delete" data-act="del" title="删除">×</button>' +
      "</div>" +
      '<div class="card-meta">' +
        '<span class="meta-count">' + total + " 条</span>" +
        '<span class="meta-time">' + formatTime(s.createdAt) + "</span>" +
      "</div>";
      if (items.length) {
        h += '<div class="card-preview"><span class="preview-text">' + esc(items[0].content) + "</span></div>";
      }
      h += "</div>";
    }
    h += "</div></div>";
    overlayEl.innerHTML = h;
    if (renameActive) {
      var inp = overlayEl.querySelector(".card-title-input");
      if (inp) { inp.focus(); inp.select(); }
    }
  }

  function startRename(id) {
    var s = null;
    for (var i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === id) { s = state.sessions[i]; break; }
    }
    if (!s) return;
    renameActive = { id: id, text: s.title, original: s.title };
    renderOverlay();
  }

  function cancelRename() {
    renameActive = null;
    renderOverlay();
  }

  function saveRename() {
    if (!renameActive) return;
    var r = renameActive;
    renameActive = null;
    var title = (r.text || "").trim() || r.original;
    api("/api/session/rename", { sessionId: r.id, title: title }).then(function () {
      loadState().then(renderOverlay).catch(function () { renderOverlay(); });
    }).catch(function () { renderOverlay(); });
  }

  function selectSession(id) {
    api("/api/session/select", { sessionId: id }).then(function (res) {
      if (res.ok) {
        setSession(res.data);
        render();
        closeOverlay();
        focusInput();
      }
    }).catch(function () {});
  }

  function reloadSession() {
    return api("/api/session").then(function (res) {
      if (res.ok) { setSession(res.data); render(); }
    }).catch(function () {});
  }

  function newSession() {
    return api("/api/session/new", {}).then(function (res) {
      if (res.ok) {
        setSession(res.data);
        render();
        closeOverlay();
        focusInput();
      }
    }).catch(function () {});
  }

  function deleteSession(id) {
    var s = null;
    for (var i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === id) { s = state.sessions[i]; break; }
    }
    var title = s ? s.title : "";
    showConfirm('删除清单「' + title + '」？', function () {
      api("/api/session/delete", { sessionId: id }).then(function (res) {
        if (!res.ok) return;
        var wasActive = id === state.activeSessionId;
        renameActive = null;
        loadState().then(function () {
          renderOverlay();
          if (wasActive) reloadSession();
        }).catch(function () {});
      }).catch(function () {});
    });
  }

  /* ---------------- 弹窗：确认 ---------------- */
  function showConfirm(message, onOk) {
    confirmOpen = true;
    confirmCb = onOk;
    dialogEl.innerHTML =
      '<div class="modal-body">' +
        '<div class="modal-title">' + esc(message) + "</div>" +
        '<div class="modal-actions">' +
          '<button data-act="cancel">取消</button>' +
          '<button class="danger" data-act="ok">确定</button>' +
        "</div>" +
      "</div>";
    dialogEl.classList.add("show");
  }

  function closeConfirm() {
    confirmOpen = false;
    confirmCb = null;
    dialogEl.classList.remove("show");
  }

  /* ---------------- 弹窗：旧数据迁移 ---------------- */
  function openMigrate() {
    migrateOpen = true;
    dialogEl.innerHTML =
      '<div class="modal-body">' +
        '<div class="modal-title">旧数据迁移</div>' +
        '<div class="migrate-hint">从原「即意」Electron 版导出快照或导入历史数据。</div>' +
        '<div class="modal-actions">' +
          '<button data-act="check">检查</button>' +
          '<button data-act="export">导出</button>' +
          '<button data-act="import">导入</button>' +
        "</div>" +
        '<div class="migrate-result" id="migrateResult"></div>' +
        '<div class="modal-actions" style="margin-top:10px">' +
          '<button data-act="close">关闭</button>' +
        "</div>" +
      "</div>";
    dialogEl.classList.add("show");
  }

  function migrateResult(text) {
    var el = document.getElementById("migrateResult");
    if (el) el.textContent = text;
  }

  function closeMigrate() {
    migrateOpen = false;
    dialogEl.classList.remove("show");
    dialogEl.innerHTML = "";
  }

  function migrateCheck() {
    migrateResult("检查中…");
    api("/api/legacy/status").then(function (res) {
      if (!res.ok) { migrateResult("错误：" + res.error); return; }
      var d = res.data || {};
      var lines = [];
      lines.push("数据源：");
      var sources = d.sources || [];
      if (!sources.length) lines.push("（无）");
      for (var i = 0; i < sources.length; i++) {
        var s = sources[i];
        lines.push((s.exists ? "✔ " : "✘ ") + s.path + (s.exists ? "  (" + fmtSize(s.size) + ")" : "  [不存在]"));
      }
      var snaps = d.snapshots || [];
      lines.push("");
      lines.push("快照（" + snaps.length + "）：");
      if (!snaps.length) lines.push("（无）");
      for (var j = 0; j < snaps.length; j++) {
        var sn = snaps[j];
        if (sn.error) {
          lines.push("· " + sn.file + " — 解析失败：" + sn.error);
        } else {
          lines.push("· " + sn.file + " — " + sn.sessions + " 清单 / " + sn.items + " 条 / " + sn.completed + " 完成");
        }
      }
      migrateResult(lines.join("\n"));
    }).catch(function (e) { migrateResult("请求失败：" + e); });
  }

  function migrateExport() {
    migrateResult("导出中…");
    api("/api/legacy/export", {}).then(function (res) {
      if (!res.ok) { migrateResult("导出失败：" + res.error); return; }
      var d = res.data || {};
      migrateResult("已导出快照：\n" + d.path + "\n" +
        d.sessions + " 清单 / " + d.items + " 条 / " + d.completed + " 完成");
    }).catch(function (e) { migrateResult("请求失败：" + e); });
  }

  function migrateImport() {
    migrateResult("导入中…");
    api("/api/legacy/import", {}).then(function (res) {
      if (!res.ok) { migrateResult("导入失败：" + res.error); return; }
      var d = res.data || {};
      migrateResult("已导入：\n" + (d.path || "") + "\n" +
        d.sessions + " 清单 / " + d.items + " 条 / " + d.completed + " 完成\n" +
        "当前清单：" + (d.activeSessionId || ""));
      Promise.all([loadAll(), loadState()]).catch(function () {});
    }).catch(function (e) { migrateResult("请求失败：" + e); });
  }

  /* ---------------- 面板关闭 ---------------- */
  // 面板是独立的外部 HTTP 窗口（拿不到完整的 Tauri 窗口 API），
  // 主路径 = 写 .quick-close 标记，由平台轮询到后收起面板；
  // 兜底 = 若该窗口能拿到 Tauri 内部 API，直接调用平台已注册的 hide_tool_panel。
  function closePanel() {
    try { fetch("/api/panel-close"); } catch (e) {}
    try {
      var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (inv) inv("hide_tool_panel", { toolId: "consciousness-stream" }).catch(function () {});
    } catch (e) {}
  }

  /* ---------------- 加载 ---------------- */
  function loadAll() {
    return Promise.all([
      api("/api/theme"),
      api("/api/session"),
      api("/api/saved-colors")
    ]).then(function (res) {
      if (res[0] && res[0].ok) applyThemeFrom(res[0].data);
      if (res[1] && res[1].ok) setSession(res[1].data);
      if (res[2] && res[2].ok) state.savedColors = (res[2].data.colors || []);
      render();
      return loadState();
    }).then(function () {
      render();
    }).catch(function () {});
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); submitInput(); }
    });

    listsBtn.addEventListener("click", openOverlay);
    minBtn.addEventListener("click", closePanel);
    closeBtn.addEventListener("click", closePanel);

    streamListEl.addEventListener("click", function (e) {
      var copyBtn = e.target.closest(".item-copy");
      if (copyBtn) { copyItem(copyBtn.getAttribute("data-id")); return; }
      var cBtn = e.target.closest(".item-complete");
      if (cBtn) { completeItem(cBtn.getAttribute("data-id")); return; }
      var dBtn = e.target.closest(".item-delete");
      if (dBtn) {
        var delId = dBtn.getAttribute("data-id");
        showConfirm("删除这条内容？", function () { deleteItem(delId); });
        return;
      }
    });

    streamListEl.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      if (e.target.closest(".item-actions")) return;
      var row = e.target.closest(".stream-item");
      if (!row) return;
      e.preventDefault();
      startDrag(parseInt(row.getAttribute("data-index"), 10), e.clientY);
    });

    completedEl.addEventListener("click", function (e) {
      if (e.target.closest("#completedHeader")) {
        collapsed = !collapsed;
        renderCompleted();
        return;
      }
      var rBtn = e.target.closest(".completed-restore");
      if (rBtn) { restoreCompleted(rBtn.getAttribute("data-id")); return; }
      var d = e.target.closest(".completed-delete");
      if (d) {
        var cid = d.getAttribute("data-id");
        showConfirm("删除这条已完成内容？", function () { deleteCompleted(cid); });
      }
    });

    // 主题
    themeTrigger.addEventListener("click", function (e) {
      e.stopPropagation();
      if (popupOpen) closePopup(); else openPopup();
    });

    themePopup.addEventListener("click", function (e) {
      e.stopPropagation();
      var rm = e.target.closest(".remove-saved");
      if (rm) { removeSaved(rm.getAttribute("data-remove")); return; }
      var dot = e.target.closest(".color-dot");
      if (dot) { setThemeColor(dot.getAttribute("data-color")); return; }
      var act = e.target.closest("[data-act]");
      if (!act) return;
      switch (act.getAttribute("data-act")) {
        case "mode": toggleMode(); break;
        case "save": saveColor(); break;
        case "random": randomColor(); break;
        case "rainbow": toggleRainbow(); break;
        case "flow": toggleFlow(); break;
      }
    });

    themePopup.addEventListener("input", function (e) {
      if (e.target.classList.contains("custom-color")) setThemeColor(e.target.value);
    });

    document.addEventListener("click", function (e) {
      if (!popupOpen) return;
      if (themePopup.contains(e.target) || themeTrigger.contains(e.target)) return;
      closePopup();
    });

    newSessionBtn.addEventListener("click", function () { newSession(); });
    legacyBtn.addEventListener("click", openMigrate);

    // 遮罩层
    overlayEl.addEventListener("click", function (e) {
      var act = e.target.closest("[data-act]");
      if (act) {
        var a = act.getAttribute("data-act");
        if (a === "back") { closeOverlay(); return; }
        if (a === "new") { newSession(); return; }
        if (a === "edit") {
          var card = e.target.closest(".list-card");
          if (card) startRename(card.getAttribute("data-id"));
          return;
        }
        if (a === "del") {
          var c2 = e.target.closest(".list-card");
          if (c2) deleteSession(c2.getAttribute("data-id"));
          return;
        }
      }
      var card2 = e.target.closest(".list-card");
      if (card2) selectSession(card2.getAttribute("data-id"));
    });

    overlayEl.addEventListener("input", function (e) {
      if (e.target.classList.contains("card-title-input") && renameActive) {
        renameActive.text = e.target.value;
      }
    });

    overlayEl.addEventListener("keydown", function (e) {
      if (!e.target.classList.contains("card-title-input")) return;
      if (e.key === "Enter") { e.preventDefault(); saveRename(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelRename(); }
    });

    overlayEl.addEventListener("focusout", function (e) {
      if (e.target.classList.contains("card-title-input")) saveRename();
    });

    // 弹窗
    dialogEl.addEventListener("click", function (e) {
      var act = e.target.closest("[data-act]");
      if (!act) return;
      var a = act.getAttribute("data-act");
      if (confirmOpen) {
        if (a === "ok") { var cb = confirmCb; closeConfirm(); if (cb) cb(); }
        else if (a === "cancel") { closeConfirm(); }
        return;
      }
      if (migrateOpen) {
        if (a === "check") migrateCheck();
        else if (a === "export") migrateExport();
        else if (a === "import") migrateImport();
        else if (a === "close") closeMigrate();
      }
    });

    // 键盘
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (migrateOpen) { e.preventDefault(); closeMigrate(); return; }
      if (confirmOpen) { e.preventDefault(); closeConfirm(); return; }
      if (renameActive) { e.preventDefault(); cancelRename(); return; }
      if (popupOpen) { e.preventDefault(); closePopup(); return; }
      e.preventDefault();
      closePanel();
    });

    // 实时同步
    try {
      var es = new EventSource("/api/events");
      es.onmessage = function (ev) {
        try {
          var d = JSON.parse(ev.data);
          if (d.type === "state-changed") onExternalChange();
        } catch (err) {}
      };
    } catch (e) {}

    // 聚焦
    window.addEventListener("focus", function () {
      if (!renameActive && !confirmOpen && !migrateOpen) focusInput();
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && !renameActive && !confirmOpen && !migrateOpen) {
        focusInput();
      }
    });

    window.addEventListener("beforeunload", function () {
      stopRainbow();
      stopFlow();
      if (copyTimer) clearTimeout(copyTimer);
    });
  }

  function onExternalChange() {
    if (renameActive || confirmOpen || migrateOpen || overlayOpen) return;
    reloadSession();
  }

  /* ---------------- 启动 ---------------- */
  document.addEventListener("DOMContentLoaded", function () {
    bind();
    loadAll().then(function () { focusInput(); });
  });
})();