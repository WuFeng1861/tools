/* 剪贴板快速面板 —— 全局快捷键呼出的紧凑窗口 */
(function () {
  "use strict";

  var listEl = document.getElementById("ql");
  var searchEl = document.getElementById("q");
  var q = "";
  var items = [];

  function hide() {
    // 用普通 HTTP 通知工具后端写“关闭”标记，平台侧看到即隐藏面板。
    // 不依赖独立窗口里未必存在的 Tauri 全局 API，最可靠。
    try {
      fetch("/api/panel-close");
    } catch (e) {}
    // 以下作为兜底（若某个环境能拿到 Tauri API 则即时隐藏）
    var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (inv) {
      try { inv("hide_quick_panel"); return; } catch (e) {}
    }
    var t = window.__TAURI__;
    if (t && t.core) { try { t.core.invoke("hide_quick_panel"); return; } catch (e) {} }
    try { if (t && t.window) t.window.getCurrentWindow().hide(); } catch (e) {}
  }

  document.getElementById("closeBtn").addEventListener("click", hide);
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") { ev.preventDefault(); hide(); }
    if (ev.key === "Enter" && searchEl.value) hide(); // 回车关闭，方便粘贴
  });

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function render() {
    var kw = q.trim().toLowerCase();
    var list = items.filter(function (it) {
      if (!kw) return true;
      return (
        (it.text || "").toLowerCase().indexOf(kw) >= 0 ||
        (it.subText || "").toLowerCase().indexOf(kw) >= 0 ||
        (it.files || []).some(function (f) { return f.toLowerCase().indexOf(kw) >= 0; })
      );
    });
    if (!list.length) {
      listEl.innerHTML = '<div class="qempty">' + (items.length ? "无匹配结果" : "暂无剪贴板历史") + "</div>";
      return;
    }
    listEl.innerHTML = list
      .slice(0, 60)
      .map(function (it) {
        var icon = it.type === "text" ? "🔤" : it.type === "image" ? "🖼️" : "📁";
        var content;
        if (it.type === "image") {
          content =
            '<img class="img" src="/images/' + encodeURIComponent(it.imageFile) + '" />' +
            '<div class="content"><div class="text">图片</div></div>';
        } else {
          content =
            '<div class="content"><div class="text">' + esc(it.text || (it.files || []).join("、")) + "</div></div>";
        }
        return (
          '<div class="qi" data-id="' + it.id + '">' +
            '<span class="icon">' + icon + "</span>" + content +
            '<button class="del" data-del data-id="' + it.id + '" title="删除">×</button>' +
          "</div>"
        );
      })
      .join("");
    var cnt = document.getElementById("qcnt");
    if (cnt) cnt.textContent = "共 " + items.length + " 条" + (list.length !== items.length ? "，显示 " + list.length + " 条" : "");
  }

  function load() {
    var url = "/api/history?q=" + encodeURIComponent(q);
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) { items = j.data.items; render(); }
      })
      .catch(function () {});
  }

  searchEl.addEventListener("input", function () { q = this.value; render(); });

  // 点击：写入系统剪贴板，面板不关闭（便于连续粘贴）；点删除则删除该条
  listEl.addEventListener("click", function (ev) {
    var del = ev.target.closest("[data-del]");
    if (del) {
      fetch("/api/delete", {
        method: "POST",
        body: JSON.stringify({ id: del.getAttribute("data-id") }),
      }).catch(function () {});
      searchEl.focus();
      return;
    }
    var card = ev.target.closest(".qi");
    if (!card) return;
    fetch("/api/paste", {
      method: "POST",
      body: JSON.stringify({ id: card.getAttribute("data-id") }),
    }).catch(function () {});
    searchEl.focus();
  });

  // 清空（用面板内自绘确认框，避免原生 confirm 在无边框小窗里被挡住）
  var qc = document.getElementById("qconfirm");
  document.getElementById("qClear").addEventListener("click", function () {
    qc.style.display = "flex";
  });
  document.getElementById("qcCancel").addEventListener("click", function () {
    qc.style.display = "none";
  });
  document.getElementById("qcOk").addEventListener("click", function () {
    qc.style.display = "none";
    fetch("/api/clear", { method: "POST" }).catch(function () {});
  });

  // SSE 实时刷新
  var es = new EventSource("/api/events");
  es.onmessage = function (ev) {
    try {
      var d = JSON.parse(ev.data);
      if (d.type === "history-changed") load();
    } catch (e) {}
  };

  load();
  searchEl.focus();
})();