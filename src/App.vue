<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "./api/tauri";
import { applyDisplay, loadDisplay } from "./display";

const router = useRouter();

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

// ---- 关闭窗口：转入后台 / 退出程序 / 记住选择 ----
const CLOSE_PREF_KEY = "toolbox-close-pref";
const showCloseModal = ref(false);
const rememberClose = ref(false);
const notice = ref("");
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let unlistenClose: UnlistenFn | null = null;
let unlistenOpen: UnlistenFn | null = null;
let unlistenNotice: UnlistenFn | null = null;

function showNotice(msg: string) {
  notice.value = msg;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = "";
  }, 5000);
}

function readClosePref(): string {
  try {
    return localStorage.getItem(CLOSE_PREF_KEY) || "";
  } catch {
    return "";
  }
}

function saveClosePref(pref: string) {
  try {
    if (rememberClose.value) localStorage.setItem(CLOSE_PREF_KEY, pref);
  } catch {
    /* 忽略 */
  }
}

async function onCloseRequested() {
  const pref = readClosePref();
  if (pref === "background") {
    try {
      await api.hideToTray();
    } catch {
      /* 忽略 */
    }
    return;
  }
  if (pref === "quit") {
    try {
      await api.quitApp();
    } catch {
      /* 忽略 */
    }
    return;
  }
  showCloseModal.value = true;
}

async function goBackground() {
  saveClosePref("background");
  showCloseModal.value = false;
  try {
    await api.hideToTray();
  } catch {
    /* 忽略 */
  }
}

async function doQuit() {
  saveClosePref("quit");
  showCloseModal.value = false;
  try {
    await api.quitApp();
  } catch {
    /* 忽略 */
  }
}

// 从托盘点击后台工具进入运行页
function onOpenTool(ev: { payload: unknown }) {
  const p = ev.payload as { id?: string } | undefined;
  if (p?.id) router.push({ name: "tool-runner", params: { id: p.id } });
}

// 工具 iframe → 平台闪送桥（读取/设置全局快捷键）
async function handleBridge(ev: MessageEvent) {
  const origin = String(ev.origin || "");
  if (!origin.startsWith("http://127.0.0.1:")) return;
  const data = ev.data as { type?: string; accel?: string } | undefined;
  if (!data || !data.type) return;
  const reply = (ok: boolean, extra: Record<string, unknown>) => {
    try {
      (ev.source as Window | null)?.postMessage(
        { type: "platform:hotkey-result", ok, ...extra },
        "*",
      );
    } catch {
      /* 忽略 */
    }
  };
  if (data.type === "platform:get-hotkey") {
    try {
      const accel = await api.getClipboardHotkey();
      reply(true, { accel });
    } catch (e) {
      reply(false, { error: String(e) });
    }
  } else if (data.type === "platform:set-hotkey") {
    try {
      const accel = await api.setClipboardHotkey(data.accel || "");
      reply(true, { accel });
    } catch (e) {
      reply(false, { error: (e as Error)?.message || String(e) });
    }
  }
}

const mql = window.matchMedia("(prefers-color-scheme: dark)");
const onSystemChange = () => {
  if (theme.value === "auto") apply();
};

onMounted(async () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "auto" || saved === "light" || saved === "dark") {
      theme.value = saved;
    }
  } catch {
    /* 忽略读取失败 */
  }
  apply();
  loadDisplay();
  applyDisplay();
  mql.addEventListener("change", onSystemChange);

  try {
    unlistenClose = await listen("app://close-requested", onCloseRequested);
    unlistenOpen = await listen("app://open-tool", onOpenTool);
    unlistenNotice = await listen("app://notice", (ev) => {
      showNotice(String(ev.payload ?? ""));
    });
    window.addEventListener("message", handleBridge);
  } catch {
    /* 非 Tauri 环境忽略 */
  }
});

onUnmounted(() => {
  mql.removeEventListener("change", onSystemChange);
  try {
    unlistenClose?.();
    unlistenOpen?.();
    unlistenNotice?.();
    window.removeEventListener("message", handleBridge);
  } catch {
    /* 忽略 */
  }
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
  <transition name="fade">
    <div v-if="notice" class="toast">{{ notice }}</div>
  </transition>
  <router-view />

  <!-- 关闭窗口选择弹窗 -->
  <div v-if="showCloseModal" class="modal-overlay" @click.self="showCloseModal = false">
    <div class="modal">
      <div class="modal-title">要退出还是转入后台？</div>
      <div class="modal-desc">
        选择「转入后台」后，平台与后台常驻工具会继续在托盘运行，可从系统托盘重新打开主界面。
      </div>
      <div class="modal-actions">
        <button class="btn bg" @click="goBackground">转入后台</button>
        <button class="btn quit" @click="doQuit">退出程序</button>
      </div>
      <label class="modal-remember">
        <input v-model="rememberClose" type="checkbox" />
        记住我的选择，不再询问
      </label>
    </div>
  </div>
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

.toast {
  position: fixed;
  top: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 99999;
  max-width: 80vw;
  padding: 10px 18px;
  border-radius: 8px;
  background: rgba(20, 30, 60, 0.94);
  color: #fff;
  font-size: 13px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 99999;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
}
.modal {
  width: 360px;
  max-width: 90vw;
  padding: 20px;
  border-radius: 12px;
  background: var(--bg-panel, #fff);
  border: 1px solid var(--border);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.25);
}
.modal-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
}
.modal-desc {
  font-size: 13px;
  color: var(--text-dim);
  line-height: 1.6;
  margin-bottom: 16px;
}
.modal-actions {
  display: flex;
  gap: 10px;
}
.btn {
  flex: 1;
  padding: 9px 0;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
}
.btn.bg {
  border-color: var(--accent, #4f6ef7);
  color: var(--accent, #4f6ef7);
}
.btn.quit {
  border-color: var(--danger, #e5484d);
  color: var(--danger, #e5484d);
}
.btn:hover {
  filter: brightness(1.05);
}
.modal-remember {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 14px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
}
</style>