<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api/tauri";
import type { ShortcutInfo } from "../types";

const router = useRouter();

const list = ref<ShortcutInfo[]>([]);
const loading = ref(true);
const loadError = ref("");
const recordingKey = ref(""); // "toolId:shortcutId" 正在录制中
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(msg: string) {
  toast.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 3500);
}

/** 从主键事件解析组合键（修饰键+一个主键），无则返回空串 */
function keysOf(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.metaKey) mods.push("super");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  const k = String(e.key || "").toLowerCase();
  let candidate: string | null = null;
  if (k.length === 1 && /[a-z0-9]/.test(k)) candidate = k;
  else if (/^f([1-9]|1[0-2])$/.test(k)) candidate = k;
  else {
    const sp: Record<string, string> = {
      " ": "space", enter: "enter", tab: "tab", escape: "esc",
      arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right",
      backspace: "backspace", delete: "delete", home: "home", end: "end",
    };
    candidate = sp[k] || null;
  }
  if (!candidate || !mods.length) return "";
  return mods.join("+") + "+" + candidate;
}

async function load() {
  loading.value = true;
  loadError.value = "";
  try {
    list.value = await api.listShortcuts();
    buildGroups();
  } catch (e) {
    loadError.value = "加载失败：" + ((e as Error)?.message ?? String(e));
  } finally {
    loading.value = false;
  }
}

function startRecord(s: ShortcutInfo) {
  recordingKey.value = `${s.toolId}:${s.shortcutId}`;
}

function replaceItem(updated: ShortcutInfo) {
  const i = list.value.findIndex(
    (x) => x.toolId === updated.toolId && x.shortcutId === updated.shortcutId,
  );
  if (i >= 0) list.value[i] = updated;
  else list.value = [updated, ...list.value];
  buildGroups();
}

async function onRecordKeyd(s: ShortcutInfo, e: KeyboardEvent) {
  if (recordingKey.value !== `${s.toolId}:${s.shortcutId}`) return;
  e.preventDefault();
  const combo = keysOf(e);
  if (!combo) {
    showToast("需包含 Ctrl/Alt/Win/Shift 加一个主键");
    return;
  }
  recordingKey.value = "";
  if (combo === s.accel) return;
  try {
    const updated = await api.setShortcutAccel(s.toolId, s.shortcutId, combo);
    replaceItem(updated);
    showToast(`已生效：${updated.accel}`);
  } catch (err) {
    showToast("设置失败：" + ((err as Error)?.message ?? String(err)));
    load();
  }
}

async function onReset(s: ShortcutInfo) {
  try {
    const updated = await api.resetShortcutAccel(s.toolId, s.shortcutId);
    replaceItem(updated);
    showToast("已恢复默认：" + updated.accel);
  } catch (err) {
    showToast("恢复失败：" + ((err as Error)?.message ?? String(err)));
  }
}

async function onOpenPanel(s: ShortcutInfo) {
  try {
    await api.openToolPanel(s.toolId, "quick");
    showToast(`已唤起 ${s.toolName} 的悬浮面板`);
  } catch (err) {
    showToast("唤起失败：" + ((err as Error)?.message ?? String(err)));
  }
}

/** 按工具分组 */
const groups = ref<{ name: string; items: ShortcutInfo[] }[]>([]);
function buildGroups() {
  const map = new Map<string, ShortcutInfo[]>();
  for (const s of list.value) {
    if (!map.has(s.toolName)) map.set(s.toolName, []);
    map.get(s.toolName)!.push(s);
  }
  groups.value = [...map.entries()].map(([name, items]) => ({ name, items }));
}

onMounted(async () => {
  await load();
  buildGroups();
});
</script>

<template>
  <div class="shortcuts">
    <header class="topbar">
      <button class="ghost" @click="router.push('/')">← 返回</button>
      <span class="title">⌨️ 全局快捷键</span>
      <div class="spacer" />
      <button class="ghost" @click="load">刷新</button>
    </header>

    <main class="body">
      <p class="lead">
        集中查看所有工具的全局快捷键。工具在 <code>manifest.json</code> 的
        <code>shortcuts</code> 数组里声明，改动会实时生效；仓库内的同名组合键会标注「冲突」并停止注册。
      </p>

      <div v-if="loadError" class="err">{{ loadError }}</div>
      <div v-else-if="loading" class="dim">加载中…</div>

      <template v-else>
        <div v-if="!list.length" class="empty">
          <p class="big">还没有任何快捷键</p>
          <p class="dim">在工具的 manifest.json 里添加 <code>shortcuts</code> 数组后，回到这里即可统一管理。</p>
        </div>

        <section v-for="g in groups" :key="g.name" class="block">
          <h2>{{ g.name }}</h2>
          <div
            v-for="s in g.items"
            :key="s.shortcutId"
            class="row"
            :class="{ conflict: s.conflict }"
          >
            <div class="info">
              <div class="name">{{ s.name }}</div>
              <div class="sub">
                {{ s.action || "事件" }}
                <span v-if="!s.toolRunning" class="tag warn">工具未运行</span>
                <span v-if="s.conflict" class="tag danger">冲突</span>
                <span v-else-if="s.registered" class="tag ok">已注册</span>
                <span v-else-if="s.accel" class="tag warn">未注册</span>
              </div>
            </div>

            <button
              class="accel"
              :class="{ recording: recordingKey === s.toolId + ':' + s.shortcutId }"
              @click="startRecord(s)"
              :title="s.conflict ? '该组合键已被其它动作占用' : '点击后按新组合键修改'"
              @keydown="onRecordKeyd(s, $event)"
            >
              <span v-if="recordingKey === s.toolId + ':' + s.shortcutId">按下组合键…</span>
              <span v-else-if="s.accel">{{ s.accel }}</span>
              <span v-else class="muted">未设置</span>
            </button>

            <button class="ghost" @click="onOpenPanel(s)" :disabled="s.conflict || !s.accel">
              试开面板
            </button>
            <button
              class="ghost"
              @click="onReset(s)"
              :disabled="s.accel === s.defaultAccel"
            >
              恢复默认
            </button>
          </div>
        </section>
      </template>

      <p class="foot">提示：悬浮面板由工具的用户代码通过写 <code>.quick-open</code>/<code>.quick-close</code> 标记来请求平台创建/收起，平台不在快捷键上绑定任何面板行为。</p>
    </main>

    <transition name="fade">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </transition>
  </div>
</template>

<style scoped>
.shortcuts {
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
  padding: 20px 24px;
  max-width: 860px;
  margin: 0 auto;
  width: 100%;
}
.lead {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-dim);
  margin-bottom: 16px;
}
.block {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 16px 20px;
  margin-bottom: 16px;
}
.block h2 {
  font-size: 15px;
  margin-bottom: 12px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 8px;
  background: var(--bg);
}
.row.conflict {
  border-color: var(--danger);
  background: color-mix(in srgb, var(--danger) 7%, var(--bg));
}
.info {
  flex: 1;
  min-width: 0;
}
.name {
  font-size: 14px;
  font-weight: 500;
}
.sub {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 2px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.accel {
  flex: none;
  min-width: 130px;
  padding: 6px 12px;
  border: 1px dashed var(--border);
  border-radius: 6px;
  background: var(--bg-panel);
  cursor: pointer;
  font-family: Consolas, Menlo, monospace;
  font-size: 13px;
  color: var(--text);
  transition: border-color 0.15s;
}
.accel:hover {
  border-color: var(--accent);
}
.accel.recording {
  border-color: var(--accent);
  color: var(--accent);
  background: rgba(79, 110, 247, 0.08);
}
.muted {
  color: var(--text-dim);
}
.tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
}
.tag.ok {
  background: rgba(48, 164, 108, 0.15);
  color: var(--ok);
}
.tag.danger {
  background: rgba(229, 72, 77, 0.15);
  color: var(--danger);
}
.tag.warn {
  background: rgba(230, 145, 56, 0.16);
  color: #b45309;
}
.err {
  padding: 12px;
  background: rgba(229, 72, 77, 0.08);
  color: var(--danger);
  border-radius: 8px;
  font-size: 13px;
}
.dim {
  color: var(--text-dim);
  font-size: 13px;
}
.empty {
  text-align: center;
  padding: 50px 20px;
}
.empty .big {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 8px;
}
.empty .dim {
  font-size: 13px;
  color: var(--text-dim);
}
.foot {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.6;
  margin-top: 4px;
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
</style>