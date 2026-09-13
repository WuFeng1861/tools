<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api/tauri";
import {
  applyDisplay,
  loadDisplay,
  setDisplay,
  settings,
  type DisplaySettings,
} from "../display";

const router = useRouter();

/** 关闭行为：""=每次询问，background=转入后台，quit=退出程序 */
type CloseMode = "" | "background" | "quit";
const CLOSE_PREF_KEY = "toolbox-close-pref";

const closeMode = ref<CloseMode>("");
const CLOSE_OPTIONS: { value: CloseMode; label: string; hint: string }[] = [
  { value: "", label: "每次关闭都询问", hint: "点右上角 × 时总会弹出“转入后台 / 退出程序”选择" },
  { value: "background", label: "关闭即转入后台", hint: "点 × 直接隐藏到托盘继续运行，可从托盘左键重新打开" },
  { value: "quit", label: "关闭即退出程序", hint: "点 × 直接退出，会停止宿主与所有工具进程" },
];

const autostart = ref(false);
const autostartError = ref("");

// 显示效果滑块配置：key 对应 DisplaySettings 字段
const DISPLAY_SLIDERS: {
  key: keyof DisplaySettings;
  label: string;
  min: number;
  max: number;
  hint?: string;
}[] = [
  { key: "brightness", label: "亮度", min: 0.5, max: 1.6, hint: "越高越亮，过低或刺眼时可调低" },
  { key: "saturate", label: "饱和度", min: 0.5, max: 1.6, hint: "越高颜色越鲜艳，调低更柔和" },
  { key: "contrast", label: "对比度", min: 0.5, max: 1.6, hint: "越高明暗层次越分明" },
  { key: "warmth", label: "暖色调", min: 0, max: 0.35, hint: "越高整体越偏暖黄，白天用可缓解冷感与刺眼" },
];
function onDisplay(key: keyof DisplaySettings, v: number) {
  setDisplay(key, v);
}

function readClosePref(): CloseMode {
  try {
    const v = localStorage.getItem(CLOSE_PREF_KEY);
    return v === "background" || v === "quit" ? v : "";
  } catch {
    return "";
  }
}

function onModeChange(mode: CloseMode) {
  try {
    localStorage.setItem(CLOSE_PREF_KEY, mode);
  } catch {
    /* 忽略 */
  }
}

async function onAutostartChange(v: boolean) {
  autostart.value = v;
  autostartError.value = "";
  try {
    const applied = await api.setAutostart(v);
    autostart.value = applied;
  } catch (e) {
    autostart.value = !v;
    autostartError.value = "设置失败：" + ((e as Error)?.message || String(e));
  }
}

onMounted(async () => {
  closeMode.value = readClosePref();
  loadDisplay();
  applyDisplay();
  try {
    autostart.value = await api.getAutostart();
  } catch {
    autostart.value = false;
  }
});
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="ghost" @click="router.push('/')">← 返回</button>
      <span class="title">⚙️ 设置</span>
      <div class="spacer" />
    </header>

    <main class="body">
      <section class="block">
        <h2>关闭行为</h2>
        <p class="desc">
          决定点主界面右上角「关闭 (×)」时的动作。该选择与关闭弹窗里的「记住我的选择」一致，可随时在此修改。
        </p>
        <label
          v-for="opt in CLOSE_OPTIONS"
          :key="opt.value"
          class="opt"
          :class="{ on: closeMode === opt.value }"
        >
          <input
            type="radio"
            name="closeMode"
            :value="opt.value"
            :checked="closeMode === opt.value"
            @change="onModeChange(opt.value)"
          />
          <span class="opt-label">{{ opt.label }}</span>
          <span class="opt-hint">{{ opt.hint }}</span>
        </label>
      </section>

      <section class="block">
        <h2>启动</h2>
        <div class="row">
          <div>
            <div class="row-label">开机启动</div>
            <div class="row-hint">登录 Windows 后自动运行本平台（进入托盘后台）</div>
          </div>
          <label class="switch">
            <input type="checkbox" :checked="autostart" @change="onAutostartChange(($event.target as HTMLInputElement).checked)" />
            <span class="track"></span>
          </label>
        </div>
        <p v-if="autostartError" class="err">{{ autostartError }}</p>
      </section>

      <section class="block">
        <h2>显示</h2>
        <div
          v-for="s in DISPLAY_SLIDERS"
          :key="s.key"
          class="brightness"
        >
          <label :for="`disp-${s.key}`" class="brightness-label">{{ s.label }}</label>
          <input
            :id="`disp-${s.key}`"
            class="range"
            type="range"
            :min="s.min"
            :max="s.max"
            step="0.01"
            :value="settings[s.key]"
            @input="onDisplay(s.key, Number(($event.target as HTMLInputElement).value))"
          />
          <span class="brightness-val">{{ Math.round((settings[s.key] as number) * 100) }}%</span>
          <p class="brightness-hint">{{ s.hint }}</p>
        </div>
        <p class="desc">
          调整界面整体的视觉感受，实时生效并自动保存。亮度、暖色调调低可缓解白天冷白刺眼，夜间可整体调暗更柔和。仅影响当前平台界面。
        </p>
      </section>

      <section class="block">
        <h2>全局快捷键</h2>
        <div class="row">
          <div>
            <div class="row-label">集中管理所有工具声明的全局快捷键</div>
            <div class="row-hint">可修改组合键、自动检测冲突、恢复默认</div>
          </div>
          <button class="ghost" @click="router.push({ name: 'shortcuts' })">管理快捷键</button>
        </div>
      </section>

      <section class="block">
        <h2>关于</h2>
        <p class="desc">
          更多设置项将陆续加入。已提供的平台能力：系统托盘、后台挂起、后台常驻工具、全局快捷键、剪贴板历史、开机自启等。
        </p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.settings {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}
.title {
  font-weight: 600;
}
.spacer {
  flex: 1;
}
.body {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  max-width: 720px;
  margin: 0 auto;
  width: 100%;
}
.block {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 18px 22px;
  margin-bottom: 16px;
}
.block h2 {
  font-size: 16px;
  margin-bottom: 8px;
}
.desc {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-dim);
  margin-bottom: 14px;
}
.opt {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 8px;
  cursor: pointer;
  background: var(--bg);
}
.opt.on {
  border-color: var(--accent);
}
.opt input {
  flex: none;
  accent-color: var(--accent);
}
.opt-label {
  flex: none;
  font-size: 14px;
  font-weight: 500;
}
.opt-hint {
  font-size: 12px;
  color: var(--text-dim);
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.row-label {
  font-size: 14px;
  font-weight: 500;
}
.row-hint {
  font-size: 12px;
  color: var(--text-dim);
}
.err {
  margin-top: 10px;
  font-size: 12px;
  color: var(--danger);
}
.brightness {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.brightness-label {
  flex: none;
  width: 64px;
  font-size: 14px;
  font-weight: 500;
}
.brightness .range {
  flex: 1;
  min-width: 160px;
  accent-color: var(--accent);
}
.brightness-val {
  flex: none;
  width: 44px;
  text-align: right;
  font-size: 13px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.brightness-hint {
  flex-basis: 100%;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 6px;
}
.switch {
  position: relative;
  width: 42px;
  height: 22px;
  flex: none;
}
.switch input {
  display: none;
}
.switch .track {
  position: absolute;
  inset: 0;
  background: var(--border);
  border-radius: 99px;
  transition: background 0.15s;
}
.switch .track::after {
  content: "";
  position: absolute;
  left: 2px;
  top: 2px;
  width: 18px;
  height: 18px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.15s;
}
.switch input:checked + .track {
  background: var(--accent);
}
.switch input:checked + .track::after {
  transform: translateX(20px);
}
</style>