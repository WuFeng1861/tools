<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";

// 主题状态：auto=跟随系统，light/dark=手动指定
type Theme = "auto" | "light" | "dark";
const STORAGE_KEY = "toolbox-theme";
const ORDER: Theme[] = ["auto", "dark", "light"];
const LABELS: Record<Theme, string> = { auto: "自动", dark: "夜间", light: "白天" };
const ICONS: Record<Theme, string> = { auto: "🌗", dark: "🌙", light: "☀️" };

const theme = ref<Theme>("auto");

/** 当前生效主题：手动指定优先，否则跟随系统 */
function effective(): "light" | "dark" {
  if (theme.value !== "auto") return theme.value;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** 把生效主题写到 <html data-theme>，驱动 CSS 变量切换 */
function apply() {
  document.documentElement.dataset.theme = effective();
}

/** 点击切换：自动 → 夜间 → 白天 → 自动，并持久化 */
function cycle() {
  theme.value = ORDER[(ORDER.indexOf(theme.value) + 1) % ORDER.length];
  try {
    localStorage.setItem(STORAGE_KEY, theme.value);
  } catch {
    /* 忽略存储失败 */
  }
  apply();
}

const mql = window.matchMedia("(prefers-color-scheme: dark)");
const onSystemChange = () => {
  if (theme.value === "auto") apply();
};

onMounted(() => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "auto" || saved === "light" || saved === "dark") {
      theme.value = saved;
    }
  } catch {
    /* 忽略读取失败 */
  }
  apply();
  mql.addEventListener("change", onSystemChange);
});

onUnmounted(() => {
  mql.removeEventListener("change", onSystemChange);
});
</script>

<template>
  <button
    class="theme-toggle"
    :title="`主题：${LABELS[theme]}（点击切换）`"
    :aria-label="`主题：${LABELS[theme]}（点击切换）`"
    @click="cycle"
  >
    {{ ICONS[theme] }}
  </button>
  <router-view />
</template>

<style scoped>
.theme-toggle {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 9999;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: 17px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow);
  transition: border-color 0.15s, transform 0.1s;
}
.theme-toggle:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}
</style>
