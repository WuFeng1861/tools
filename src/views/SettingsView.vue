<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api/tauri";
import type { ResidualInfo } from "../types";
import { runSweep } from "../residual";
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
  refreshResiduals();
});

// ---- 残留数据 ----
// 工具换端口（用户确认「重新分配」）或被删除后，它旧端口上的
// localStorage / IndexedDB 就访问不到了，成为留在磁盘上的残留。
// 宿主会在该端口空闲时占回来清理 —— 这里让这件事可见、可手动触发。
const residuals = ref<ResidualInfo[]>([]);
const residualLoading = ref(false);
const residualError = ref("");
const toolNames = ref<Record<string, string>>({});

function fmtMoment(ts: number): string {
  if (!ts) return "未知";
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function refreshResiduals() {
  residualLoading.value = true;
  residualError.value = "";
  try {
    const [list, tools] = await Promise.all([api.listResiduals(), api.listTools()]);
    residuals.value = list;
    toolNames.value = Object.fromEntries(tools.map((t) => [t.id, t.name]));
  } catch (e) {
    residualError.value = "读取残留数据失败：" + ((e as Error)?.message ?? String(e));
  } finally {
    residualLoading.value = false;
  }
}

/** 这条残留来自哪个工具（工具可能已被删除） */
function residualTool(r: ResidualInfo): string {
  if (!r.toolId) return "未知来源";
  return toolNames.value[r.toolId] || `${r.toolId}（已删除）`;
}

/** 用一句话说清「什么时候会被清理」 */
function residualState(r: ResidualInfo): string {
  switch (r.state) {
    case "ready":
      return "端口已空闲 · 下次扫描就会清理";
    case "cleaning":
      return "正在清理…";
    case "busy-tool":
      return "端口被运行中的工具占用 · 等该工具停止后自动清理";
    case "busy-external":
      return "端口被其它程序占用 · 等它释放后自动清理";
    case "cooldown": {
      const mins = Math.max(1, Math.ceil(((r.retryAfter || 0) - Date.now()) / 60000));
      return `上次未完成 · 约 ${mins} 分钟后重试`;
    }
    default:
      return r.state;
  }
}

/** 手动触发一次清理：宿主占下空闲端口，App.vue 的隐藏 iframe 随即加载清理页。
 *  传 force 是为了让「冷却中」的条目也能被立刻重试。 */
async function cleanNow() {
  residualError.value = "";
  try {
    await runSweep(true);
    setTimeout(refreshResiduals, 2500); // 等清理页执行完回报宿主后再刷新
  } catch (e) {
    residualError.value = "清理失败：" + ((e as Error)?.message ?? String(e));
  }
}

/** 端口被别的东西占用时，立即清理也没用 —— 按钮置灰，状态文字已说明原因 */
function canCleanNow(r: ResidualInfo): boolean {
  return r.state === "ready" || r.state === "cooldown";
}

/** 放弃清理：数据继续留在磁盘上，平台不再尝试 */
async function ignoreOne(r: ResidualInfo) {
  const ok = window.confirm(
    `放弃清理端口 ${r.port} 上的残留数据？\n\n` +
      `这些数据会继续留在磁盘上占用空间，平台不再尝试清理它。`,
  );
  if (!ok) return;
  try {
    await api.ignoreResidual(r.port);
    await refreshResiduals();
  } catch (e) {
    residualError.value = "操作失败：" + ((e as Error)?.message ?? String(e));
  }
}
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
        <h2>残留数据</h2>
        <p class="desc">
          工具「重新分配端口」或被删除后，它旧端口上的 localStorage / IndexedDB 就访问不到了，
          成为留在磁盘上的残留。平台会在该端口空闲时把它占回来清理掉。
        </p>

        <p v-if="residualLoading" class="res-empty">读取中…</p>
        <p v-else-if="!residuals.length" class="res-empty">当前没有残留数据。</p>
        <template v-else>
          <div v-for="r in residuals" :key="r.port" class="res-item">
            <div class="res-main">
              <div class="res-head">
                <span class="res-port">:{{ r.port }}</span>
                <span class="res-tool">{{ residualTool(r) }}</span>
              </div>
              <div class="res-state" :class="r.state">{{ residualState(r) }}</div>
              <div class="res-time">登记于 {{ fmtMoment(r.at) }}</div>
            </div>
            <div class="res-acts">
              <button
                class="ghost"
                :disabled="!canCleanNow(r)"
                :title="canCleanNow(r) ? '' : '端口正被占用，等它释放后会自动清理'"
                @click="cleanNow"
              >
                立即清理
              </button>
              <button class="ghost" @click="ignoreOne(r)">放弃</button>
            </div>
          </div>
          <div class="res-foot">
            <span>共 {{ residuals.length }} 个残留端口</span>
            <button class="ghost" @click="refreshResiduals">刷新</button>
          </div>
        </template>
        <p v-if="residualError" class="err">{{ residualError }}</p>
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

/* ---------- 残留数据 ---------- */
.res-empty {
  font-size: 13px;
  color: var(--text-dim);
  padding: 4px 0 2px;
}
.res-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 13px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  margin-bottom: 8px;
}
.res-main {
  flex: 1;
  min-width: 0;
}
.res-head {
  display: flex;
  align-items: baseline;
  gap: 9px;
  flex-wrap: wrap;
}
.res-port {
  font-family: Consolas, Menlo, monospace;
  font-size: 14px;
  color: var(--accent);
}
.res-tool {
  font-size: 13px;
  font-weight: 500;
}
.res-state {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 3px;
}
.res-state.ready {
  color: var(--ok);
}
.res-state.cleaning {
  color: var(--accent);
}
.res-state.busy-external,
.res-state.cooldown {
  color: var(--danger);
}
.res-time {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 2px;
  opacity: 0.8;
}
.res-acts {
  display: flex;
  gap: 6px;
  flex: none;
}
.res-acts .ghost {
  padding: 5px 10px;
  font-size: 12px;
}
.res-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-dim);
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