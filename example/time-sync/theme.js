"use strict";

// Keep the platform's modes, order, storage key and labels consistent.
(() => {
  const key = "toolbox-theme";
  const order = ["auto", "dark", "light"];
  const labels = { auto: "自动", dark: "夜间", light: "白天" };
  const icons = { auto: "🌗", dark: "🌙", light: "☀️" };
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let mode = "auto";
  try { const saved = localStorage.getItem(key); if (order.includes(saved)) mode = saved; } catch { /* Storage may be disabled. */ }

  function apply(persist = false) {
    document.documentElement.dataset.theme = mode === "auto" ? media.matches ? "dark" : "light" : mode;
    const button = document.getElementById("theme-toggle");
    if (button) {
      button.textContent = icons[mode];
      button.title = button.ariaLabel = `主题：${labels[mode]}（点击切换）`;
    }
    if (persist) { try { localStorage.setItem(key, mode); } catch { /* Continue without persistence. */ } }
  }
  apply(); // Runs before styles and first paint, avoiding a light flash at night.
  media.addEventListener("change", () => { if (mode === "auto") apply(); });
  window.addEventListener("storage", event => {
    if (event.key === key && (event.newValue === null || order.includes(event.newValue))) {
      mode = event.newValue || "auto";
      apply();
    }
  });
  window.addEventListener("message", event => {
    if (window.parent === window || event.source !== window.parent) return;
    if (event.data?.type !== "platform:theme" || !order.includes(event.data.theme)) return;
    mode = event.data.theme;
    apply(true);
  });
  document.addEventListener("DOMContentLoaded", () => {
    apply();
    document.getElementById("theme-toggle").addEventListener("click", () => {
      mode = order[(order.indexOf(mode) + 1) % order.length];
      apply(true);
      if (window.parent !== window) window.parent.postMessage({ type: "platform:set-theme", theme: mode }, "*");
    });
    if (window.parent !== window) window.parent.postMessage({ type: "platform:get-theme" }, "*");
  });
})();
