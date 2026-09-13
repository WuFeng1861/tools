<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import draggable from "vuedraggable";
import { api } from "../api/tauri";
import type { ToolInfo, ToolStatus } from "../types";

const router = useRouter();
const tools = ref<ToolInfo[]>([]);
const search = ref("");
const loading = ref(false);
const error = ref("");

/** 过滤后的工具列表（按名称/描述/id 搜索） */
const filteredTools = computed(() => {
  const kw = search.value.trim().toLowerCase();
  if (!kw) return tools.value;
  return tools.value.filter(
    (t) =>
      t.name.toLowerCase().includes(kw) ||
      t.id.toLowerCase().includes(kw) ||
      (t.description || "").toLowerCase().includes(kw),
  );
});

/**
 * 拖拽排序用的可写列表。
 * SortableJS 拖拽时会触发 set；这里把（过滤后的）新顺序写回完整 tools。
 */
const draggableTools = computed<ToolInfo[]>({
  get: () => filteredTools.value,
  set: (val) => {
    const arrIds = new Set(val.map((x) => x.id));
    const rest = tools.value.filter((x) => !arrIds.has(x.id));
    const byId = new Map(tools.value.map((x) => [x.id, x]));
    tools.value = [...val.map((t) => byId.get(t.id)!).filter(Boolean), ...rest];
  },
});

let justDragged = false;

/** 图标：manifest.icon 为短文本（emoji）时直接显示，否则用默认 🧩 */
function toolIcon(t: ToolInfo): string {
  const i = t.icon;
  if (i && i.length <= 4) return i;
  return "🧩";
}

function statusText(s: ToolStatus): string {
  return { stopped: "已停止", running: "运行中", error: "异常" }[s] ?? s;
}

function openTool(t: ToolInfo) {
  // 拖拽结束后浏览器可能误触发一次 click
  if (justDragged) return;
  router.push({ name: "tool-runner", params: { id: t.id } });
}

async function removeTool(t: ToolInfo) {
  const ok = window.confirm(
    `确定删除工具「${t.name}」吗？\n它的代码目录会被永久删除。`,
  );
  if (!ok) return;
  try {
    await api.deleteTool(t.id);
    await refresh();
  } catch (e) {
    error.value = "删除失败：" + ((e as Error)?.message ?? String(e));
  }
}

// ---- 跟随小卡片（rAF 每帧同步鼠标位移）----
let pressX = 0;
let pressY = 0;
let latestX = 0;
let latestY = 0;
let rafId = 0;
let ghostEl: HTMLElement | null = null;
let ghostBaseLeft = 0;
let ghostBaseTop = 0;

/** 按下卡片时记录鼠标按下位置（不干扰 SortableJS 拖拽） */
function onCardMouseDown(e: MouseEvent) {
  if ((e.target as HTMLElement).closest("button")) return;
  if (search.value.trim()) return;
  pressX = e.clientX;
  pressY = e.clientY;
  latestX = e.clientX;
  latestY = e.clientY;
}

/** 拖拽真正开始（SortableJS start）时创建跟随小卡片并启动 rAF */
function onStart(evt: { item?: HTMLElement }) {
  const item = evt.item;
  if (item) {
    const r = item.getBoundingClientRect();
    ghostBaseLeft = r.left;
    ghostBaseTop = r.top;
  }
  const name = item?.querySelector(".card-name")?.textContent ?? "";
  const el = document.createElement("div");
  el.textContent = "🧩 " + name;
  const s = el.style;
  s.position = "fixed";
  s.zIndex = "99999";
  s.pointerEvents = "none";
  s.padding = "10px 16px";
  s.fontWeight = "600";
  s.fontSize = "14px";
  s.borderRadius = "10px";
  s.background = "var(--bg-panel, #fff)";
  s.border = "1px solid var(--accent, #4f6ef7)";
  s.boxShadow = "0 12px 30px rgba(0, 0, 0, 0.25)";
  s.whiteSpace = "nowrap";
  document.body.appendChild(el);
  ghostEl = el;
  document.addEventListener("mousemove", onGhostMouseMove);
  rafId = requestAnimationFrame(tick);
}

function onGhostMouseMove(e: MouseEvent) {
  latestX = e.clientX;
  latestY = e.clientY;
}

/** rAF 每帧：把「按下位置 → 当前位置」的位移同步到小卡片 */
function tick() {
  rafId = 0;
  if (!ghostEl) return;
  ghostEl.style.left = ghostBaseLeft + (latestX - pressX) + "px";
  ghostEl.style.top = ghostBaseTop + (latestY - pressY) + "px";
  rafId = requestAnimationFrame(tick);
}

/** 拖拽结束：移除跟随小卡片、抑制误触发的 click 并保存新顺序 */
async function onDragEnd() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  if (ghostEl) {
    ghostEl.remove();
    ghostEl = null;
  }
  document.removeEventListener("mousemove", onGhostMouseMove);
  justDragged = true;
  try {
    await api.reorderTools(tools.value.map((t) => t.id));
  } catch {
    /* 保存失败下次刷新还原 */
  }
  setTimeout(() => {
    justDragged = false;
  }, 60);
}

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    tools.value = await api.listTools();
  } catch (e) {
    error.value = "运行时未就绪：" + ((e as Error)?.message ?? String(e));
  } finally {
    loading.value = false;
  }
}

/** 在文件管理器中打开工具箱保存目录（%APPDATA%\com.tools.platform\toolbox） */
async function openToolbox() {
  try {
    await api.openToolDir();
  } catch (e) {
    error.value = "打开目录失败：" + ((e as Error)?.message ?? String(e));
  }
}

onMounted(refresh);
</script>

<template>
  <div class="launcher">
    <header class="topbar">
      <div class="brand">🧰 小工具平台</div>
      <input v-model="search" class="search" placeholder="搜索工具…" />
      <div class="actions">
        <button
          class="ghost"
          title="打开工具箱保存目录（%APPDATA%\\com.tools.platform\\toolbox）"
          @click="openToolbox"
        >
          打开目录
        </button>
        <button class="ghost" @click="router.push({ name: 'tutorial' })">
          📖 教程
        </button>
        <button class="ghost" @click="router.push({ name: 'settings' })">
          ⚙️ 设置
        </button>
        <button class="ghost" @click="router.push({ name: 'shortcuts' })">
          ⌨️ 快捷键
        </button>
        <button class="ghost" @click="router.push({ name: 'dependencies' })">
          依赖管理
        </button>
        <button class="ghost" @click="router.push({ name: 'tool-editor-new' })">
          新建工具
        </button>
        <button class="primary" @click="refresh">刷新</button>
      </div>
    </header>

    <main class="content">
      <div v-if="error" class="notice">{{ error }}</div>

      <div v-if="!loading && tools.length === 0" class="empty">
        <p class="big">还没有工具</p>
        <p class="dim">
          点击「新建工具」开始，或把写好的工具目录放进
          <code>toolbox/</code> 后点刷新
        </p>
      </div>

      <div v-if="tools.length > 0 && filteredTools.length === 0" class="empty">
        <p class="big">没有匹配「{{ search }}」的工具</p>
      </div>

      <draggable
        v-model="draggableTools"
        item-key="id"
        class="grid"
        :animation="180"
        :ghost-class="'drag-ghost'"
        :chosen-class="'drag-chosen'"
        :force-fallback="true"
        :fallback-on-body="true"
        :fallback-tolerance="4"
        :disabled="search.trim().length > 0"
        @start="onStart"
        @end="onDragEnd"
      >
        <template #item="{ element }">
          <div
            class="card"
            :class="{ disabled: element.status === 'error' }"
            @mousedown="onCardMouseDown"
            @click="openTool(element)"
          >
            <button
              class="card-edit"
              title="编辑代码（更新功能）"
              @click.stop="router.push({ name: 'tool-editor', params: { id: element.id } })"
            >
              ✏️
            </button>
            <button
              class="card-del"
              title="删除工具"
              @click.stop="removeTool(element)"
            >
              ×
            </button>
            <div class="card-icon">{{ toolIcon(element) }}</div>
            <div class="card-name">{{ element.name }}</div>
            <div class="card-desc">{{ element.description }}</div>
            <div class="card-status" :class="element.status">
              {{ statusText(element.status) }}
            </div>
          </div>
        </template>
      </draggable>
      <p v-if="tools.length > 1" class="drag-hint">💡 按住卡片拖动可调整顺序</p>
    </main>
  </div>
</template>

<style scoped>
.launcher {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}
.brand {
  font-size: 17px;
  font-weight: 600;
  white-space: nowrap;
}
.search {
  flex: 1;
  max-width: 300px;
  margin: 0 16px;
  padding: 7px 14px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  outline: none;
  color: var(--text);
}
.search:focus {
  border-color: var(--accent);
}
.actions {
  display: flex;
  gap: 8px;
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.notice {
  margin-bottom: 16px;
  padding: 10px 14px;
  background: rgba(229, 72, 77, 0.1);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  color: var(--danger);
}

.empty {
  text-align: center;
  padding: 80px 20px;
  color: var(--text-dim);
}
.empty .big {
  font-size: 18px;
  color: var(--text);
  margin-bottom: 6px;
}
.empty code {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
}

.card {
  position: relative;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px;
  cursor: pointer;
  transition: box-shadow 0.15s, transform 0.1s;
  box-shadow: var(--shadow);
  user-select: none;
}
.card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  transform: translateY(-1px);
}
.card.disabled {
  cursor: not-allowed;
  opacity: 0.7;
}
.card-del {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-dim);
  font-size: 16px;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.15s;
}
.card:hover .card-del {
  opacity: 1;
}
.card-del:hover {
  background: rgba(229, 72, 77, 0.15);
  color: var(--danger);
}
.card-edit {
  position: absolute;
  top: 6px;
  right: 34px;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.15s;
}
.card:hover .card-edit {
  opacity: 1;
}
.card-edit:hover {
  background: rgba(79, 110, 247, 0.15);
  color: var(--accent);
}
.card-icon {
  font-size: 30px;
  margin-bottom: 10px;
}
.card-name {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 4px;
}
.card-desc {
  font-size: 12px;
  color: var(--text-dim);
  min-height: 34px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-status {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-dim);
}
.card-status.running {
  color: var(--ok);
}
.card-status.error {
  color: var(--danger);
}

/* SortableJS 拖拽样式：占位 ghost 隐藏（跟随虚影已弃用，靠实时让位反馈），
   被拖卡片半透明 */
.drag-ghost {
  visibility: hidden;
}
.drag-chosen {
  opacity: 0.4;
}

.drag-hint {
  margin-top: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--text-dim);
}
</style>
