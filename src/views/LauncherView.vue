<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import draggable from "vuedraggable";
import { api } from "../api/tauri";
import type { ToolInfo } from "../types";

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

function statusText(t: ToolInfo): string {
  if (t.type === "url") return "外部链接";
  return { stopped: "已停止", running: "运行中", error: "异常" }[t.status] ?? t.status;
}

// ---- 添加工具（网址 / 本地网页）----
const showAddDialog = ref(false);
const addTab = ref<"url" | "page">("url");
const submitting = ref(false);
const addError = ref("");
const form = ref({ url: "", path: "", name: "", icon: "" });

function openAddDialog() {
  form.value = { url: "", path: "", name: "", icon: "" };
  addError.value = "";
  addTab.value = "url";
  showAddDialog.value = true;
}

function closeAddDialog() {
  showAddDialog.value = false;
}

async function submitAdd() {
  if (submitting.value) return;
  addError.value = "";
  submitting.value = true;
  try {
    let id: string;
    if (addTab.value === "url") {
      const url = form.value.url.trim();
      if (!url) throw new Error("请填写网址");
      id = await api.addUrlTool({
        url,
        name: form.value.name.trim(),
        icon: form.value.icon.trim(),
      });
    } else {
      const p = form.value.path.trim();
      if (!p) throw new Error("请填写文件或目录路径");
      id = await api.addStaticTool({
        path: p,
        name: form.value.name.trim(),
        icon: form.value.icon.trim(),
      });
    }
    showAddDialog.value = false;
    await refresh();
    router.push({ name: "tool-runner", params: { id } });
  } catch (e) {
    addError.value = (e as Error)?.message ?? String(e);
  } finally {
    submitting.value = false;
  }
}

function openTool(t: ToolInfo) {
  // 拖拽结束后浏览器可能误触发一次 click
  if (justDragged) return;
  router.push({ name: "tool-runner", params: { id: t.id } });
}

async function removeTool(t: ToolInfo) {
  const detail =
    t.type === "url"
      ? "只会移除这个工具条目，不影响该网址本身。"
      : "它的代码目录会被永久删除。";
  const ok = window.confirm(`确定删除工具「${t.name}」吗？\n${detail}`);
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

// ---- 顶栏下拉菜单 ----
// 功能变多后平铺按钮太挤，按用途收成两组：新建 / 更多。
const menu = ref<"" | "add" | "more">("");

function toggleMenu(name: "add" | "more") {
  menu.value = menu.value === name ? "" : name;
}
function closeMenu() {
  menu.value = "";
}
/** 点菜单项：先收起菜单再执行，避免菜单挡住即将出现的弹窗 */
function run(fn: () => void) {
  closeMenu();
  fn();
}
function onDocClick() {
  closeMenu();
}

async function refresh() {
  // 已有数据时后台静默刷新，避免重复闪烁
  if (!tools.value.length) loading.value = true;
  error.value = "";
  try {
    tools.value = await api.listTools();
  } catch (e) {
    error.value = "运行时未就绪：" + ((e as Error)?.message ?? String(e));
    // 宿主可能还在启动，稍后自动重试（后台隐藏时也会发，等就绪后自动清错）
    scheduleRetry();
  } finally {
    loading.value = false;
  }
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    refresh();
  }, 1500);
}

onMounted(() => {
  refresh();
  document.addEventListener("click", onDocClick);
});

onUnmounted(() => {
  if (retryTimer) clearTimeout(retryTimer);
  document.removeEventListener("click", onDocClick);
});

/** 在文件管理器中打开工具箱保存目录（%APPDATA%\com.tools.platform\toolbox） */
async function openToolbox() {
  try {
    await api.openToolDir();
  } catch (e) {
    error.value = "打开目录失败：" + ((e as Error)?.message ?? String(e));
  }
}
</script>

<template>
  <div class="launcher">
    <header class="topbar">
      <div class="brand">🧰 小工具平台</div>
      <input v-model="search" class="search" placeholder="搜索工具…" />
      <div class="actions">
        <div class="menu">
          <button
            class="ghost"
            :class="{ on: menu === 'add' }"
            @click.stop="toggleMenu('add')"
          >
            新建 <span class="caret">▾</span>
          </button>
          <div v-if="menu === 'add'" class="menu-panel" @click.stop>
            <button
              class="menu-item"
              @click="run(() => router.push({ name: 'tool-editor-new' }))"
            >
              <span class="mi-label">写代码新建工具</span>
              <span class="mi-hint">HTML 界面 + Node 后端</span>
            </button>
            <button class="menu-item" @click="run(openAddDialog)">
              <span class="mi-label">添加网址 / 本地网页</span>
              <span class="mi-hint">粘贴网址，或导入本地 HTML 文件</span>
            </button>
            <div class="menu-sep" />
            <button class="menu-item" @click="run(openToolbox)">
              <span class="mi-label">打开工具目录</span>
              <span class="mi-hint">手动放入或查看已有工具</span>
            </button>
          </div>
        </div>

        <div class="menu">
          <button
            class="ghost"
            :class="{ on: menu === 'more' }"
            @click.stop="toggleMenu('more')"
          >
            更多 <span class="caret">▾</span>
          </button>
          <div v-if="menu === 'more'" class="menu-panel right" @click.stop>
            <button
              class="menu-item"
              @click="run(() => router.push({ name: 'dependencies' }))"
            >
              <span class="mi-label">依赖管理</span>
              <span class="mi-hint">给工具安装 / 卸载 npm 包</span>
            </button>
            <button
              class="menu-item"
              @click="run(() => router.push({ name: 'shortcuts' }))"
            >
              <span class="mi-label">全局快捷键</span>
              <span class="mi-hint">查看、修改、检测冲突</span>
            </button>
            <button
              class="menu-item"
              @click="run(() => router.push({ name: 'settings' }))"
            >
              <span class="mi-label">设置</span>
              <span class="mi-hint">关闭行为、显示效果、残留数据</span>
            </button>
            <div class="menu-sep" />
            <button
              class="menu-item"
              @click="run(() => router.push({ name: 'tutorial' }))"
            >
              <span class="mi-label">使用教程</span>
              <span class="mi-hint">从零开始写一个工具</span>
            </button>
          </div>
        </div>

        <button class="primary" @click="refresh">刷新</button>
      </div>
    </header>

    <main class="content">
      <div v-if="error" class="notice">{{ error }}</div>

      <div v-if="!loading && tools.length === 0" class="empty">
        <p class="big">还没有工具</p>
        <p class="dim">
          点「新建工具」写本地工具，点「添加网址」把外部网页加进来，<br />
          或把写好的工具目录放进 <code>toolbox/</code> 后点刷新
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
            <div class="card-status" :class="element.type === 'url' ? 'url' : element.status">
              {{ statusText(element) }}
            </div>
          </div>
        </template>
      </draggable>
      <p v-if="tools.length > 1" class="drag-hint">💡 按住卡片拖动可调整顺序</p>
    </main>

    <div v-if="showAddDialog" class="modal-mask" @click.self="closeAddDialog">
      <div class="modal">
        <h3>添加工具</h3>

        <div class="tabs">
          <button :class="{ active: addTab === 'url' }" @click="addTab = 'url'">网址</button>
          <button :class="{ active: addTab === 'page' }" @click="addTab = 'page'">
            本地网页
          </button>
        </div>

        <template v-if="addTab === 'url'">
          <p class="modal-sub">把一个外部网页作为工具加进来，点卡片即可在应用内打开。</p>

          <label>网址</label>
          <input
            v-model="form.url"
            placeholder="https://example.com/tool 或 http://127.0.0.1:8777"
            @keyup.enter="submitAdd"
          />

          <label>名称（留空自动取）</label>
          <input v-model="form.name" placeholder="例如：P2P 聊天室" @keyup.enter="submitAdd" />

          <label>图标（可选，一个 emoji）</label>
          <input v-model="form.icon" placeholder="🔗" @keyup.enter="submitAdd" />

          <p class="modal-note">
            允许 <code>https://</code> 任意地址，或 <code>http://127.0.0.1</code>
            / <code>http://localhost</code> 的本地服务。<br />
            页面由对方站点自己托管，存储也归它自己的域名。
          </p>
        </template>

        <template v-else>
          <p class="modal-sub">
            把本地 HTML 文件（或包含 index.html 的整个目录）复制进来，由平台托管。
          </p>

          <label>文件 / 目录路径</label>
          <input
            v-model="form.path"
            placeholder="C:\path\to\index.html 或 C:\path\to\folder"
            @keyup.enter="submitAdd"
          />

          <label>名称（留空自动取）</label>
          <input v-model="form.name" placeholder="例如：P2P 聊天室" @keyup.enter="submitAdd" />

          <label>图标（可选，一个 emoji）</label>
          <input v-model="form.icon" placeholder="📄" @keyup.enter="submitAdd" />

          <p class="modal-note">
            页面会运行在 <code>http://127.0.0.1:&lt;端口&gt;</code> 下 —— 这是<strong>安全上下文</strong>，
            WebRTC、剪贴板、Service Worker 等只有 https / localhost 才能用的能力都可以用
            （直接双击 .html 用 file:// 打开则不行）。<br />
            端口由平台分配并记住，因此 <strong>localStorage / IndexedDB 能跨重启保存</strong>。
          </p>
        </template>

        <p v-if="addError" class="modal-err">{{ addError }}</p>

        <div class="modal-actions">
          <button class="ghost" @click="closeAddDialog">取消</button>
          <button class="primary" :disabled="submitting" @click="submitAdd">
            {{ submitting ? "添加中…" : "添加" }}
          </button>
        </div>
      </div>
    </div>
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
  align-items: center;
  gap: 8px;
}

/* ---------- 顶栏下拉菜单 ---------- */
.menu {
  position: relative;
}
.menu .ghost.on {
  border-color: var(--accent);
  color: var(--accent);
}
.caret {
  font-size: 10px;
  opacity: 0.7;
}
.menu-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 250px;
  padding: 6px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
  z-index: 200;
}
.menu-panel.right {
  left: auto;
  right: 0;
}
.menu-item {
  display: block;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.menu-item:hover {
  background: var(--bg);
}
.mi-label {
  display: block;
  font-size: 13px;
}
.mi-hint {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-dim);
}
.menu-sep {
  height: 1px;
  margin: 5px 4px;
  background: var(--border);
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
.card-status.url {
  color: var(--accent);
}

/* ---------- 添加网址弹窗 ---------- */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}
.modal {
  width: 100%;
  max-width: 460px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 22px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.28);
}
.modal h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 6px;
}
.modal-sub {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 16px;
  line-height: 1.6;
}
.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.tabs button {
  padding: 8px 14px;
  margin-bottom: -1px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-dim);
  font-size: 13px;
  cursor: pointer;
}
.tabs button.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}
.modal-note strong {
  color: var(--text);
  font-weight: 600;
}
.modal label {
  display: block;
  font-size: 12px;
  color: var(--text-dim);
  margin: 12px 0 6px;
}
.modal input {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text);
  outline: none;
  font-size: 13px;
}
.modal input:focus {
  border-color: var(--accent);
}
.modal-note {
  margin-top: 14px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text-dim);
}
.modal-note code {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 4px;
}
.modal-err {
  margin-top: 12px;
  padding: 8px 11px;
  font-size: 12px;
  border-radius: var(--radius-sm);
  background: rgba(229, 72, 77, 0.1);
  border: 1px solid var(--danger);
  color: var(--danger);
  line-height: 1.6;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
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
