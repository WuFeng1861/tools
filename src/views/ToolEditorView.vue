<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { api } from "../api/tauri";

const route = useRoute();
const router = useRouter();

const id = computed(() => (route.params.id as string) || "");
const isNew = computed(() => !id.value);

// ---- 新建向导 ----
const newName = ref("");
const newTemplate = ref("blank");
const creating = ref(false);
const createError = ref("");
const templates = [
  { id: "blank", name: "空工具", desc: "基础骨架，从零开始" },
  { id: "json-formatter", name: "JSON 格式化", desc: "格式化 / 校验 / 压缩 JSON" },
  { id: "regex-test", name: "正则测试", desc: "正则表达式在线测试" },
];

// ---- 编辑模式 ----
const files = ref<string[]>([]);
const selectedFile = ref("");
const content = ref("");
const dirty = ref(false);
const saving = ref(false);
const statusMsg = ref("");
const showManifestHint = ref(false);

const editorEl = ref<HTMLElement | null>(null);
let editorView: EditorView | null = null;

/** 按文件扩展名选择 CodeMirror 语言 */
function langFor(path: string): Extension {
  if (/\.(js|mjs|cjs|jsx)$/.test(path)) return javascript();
  if (/\.(html|htm)$/.test(path)) return html();
  if (/\.json$/.test(path)) return json();
  if (/\.css$/.test(path)) return css();
  if (/\.(md|markdown)$/.test(path)) return markdown();
  return [];
}

function createEditor() {
  editorView = new EditorView({
    state: EditorState.create({
      doc: content.value,
      extensions: [
        basicSetup,
        oneDark,
        langFor(selectedFile.value),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            content.value = update.state.doc.toString();
            dirty.value = true;
          }
        }),
      ],
    }),
    parent: editorEl.value!,
  });
}

function destroyEditor() {
  editorView?.destroy();
  editorView = null;
}

async function createTool() {
  const name = newName.value.trim();
  if (!name) {
    createError.value = "请输入工具名称";
    return;
  }
  creating.value = true;
  createError.value = "";
  try {
    const newId = await api.createTool({ name, template: newTemplate.value });
    router.push({ name: "tool-editor", params: { id: newId } });
  } catch (e) {
    createError.value = (e as Error)?.message ?? String(e);
  } finally {
    creating.value = false;
  }
}

async function loadFiles() {
  try {
    files.value = await api.listToolFiles(id.value);
    const preferred = ["manifest.json", "index.html", "app.js", "package.json"];
    selectedFile.value =
      preferred.find((f) => files.value.includes(f)) || files.value[0] || "";
    if (selectedFile.value) await openFile(selectedFile.value);
  } catch (e) {
    statusMsg.value = (e as Error)?.message ?? String(e);
  }
}

async function openFile(path: string) {
  if (path === selectedFile.value && !dirty.value) return;
  selectedFile.value = path;
  try {
    content.value = await api.readToolFile(id.value, path);
    dirty.value = false;
    statusMsg.value = "";
    showManifestHint.value = path === "manifest.json";
    destroyEditor();
    await nextTick();
    if (editorEl.value) createEditor();
  } catch (e) {
    statusMsg.value = (e as Error)?.message ?? String(e);
  }
}

async function save() {
  if (!selectedFile.value || !dirty.value) return;
  saving.value = true;
  statusMsg.value = "";
  try {
    await api.writeToolFile(id.value, selectedFile.value, content.value);
    dirty.value = false;
    statusMsg.value = "已保存（若工具正在运行，需重新打开生效）";
  } catch (e) {
    statusMsg.value = (e as Error)?.message ?? String(e);
  } finally {
    saving.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    save();
  }
}

// 新建页(/editor)与编辑页(/editor/:id)共用同一组件，路由切换时组件会被复用
// 而 onMounted 不会重新触发，所以用 watch 监听工具 id 来加载文件
watch(
  id,
  async () => {
    destroyEditor();
    dirty.value = false;
    statusMsg.value = "";
    selectedFile.value = "";
    content.value = "";
    if (id.value) {
      await loadFiles();
    } else {
      files.value = [];
    }
  },
  { immediate: true },
);

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  destroyEditor();
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div class="editor">
    <!-- 新建向导 -->
    <div v-if="isNew" class="wizard">
      <header class="topbar">
        <button class="ghost" @click="router.push('/')">← 返回</button>
        <span class="title">新建工具</span>
        <div class="spacer" />
        <button class="ghost" @click="router.push({ name: 'tutorial' })">
          📖 新建工具教程
        </button>
      </header>
      <main class="wizard-body">
        <div class="wizard-card">
          <h2>创建你的第一个工具</h2>
          <p class="dim">
            平台会生成基础骨架（manifest.json + index.html + app.js），之后你可以在编辑器中修改它们。
          </p>
          <div v-if="createError" class="notice error">{{ createError }}</div>
          <form @submit.prevent="createTool">
            <label>工具名称</label>
            <input
              v-model="newName"
              placeholder="如：JSON 格式化"
              autofocus
            />
            <label style="margin-top: 12px">选择模板</label>
            <select v-model="newTemplate">
              <option v-for="t in templates" :key="t.id" :value="t.id">
                {{ t.name }} — {{ t.desc }}
              </option>
            </select>
            <p class="hint">
              名称将自动生成英文 id（中文名会自动追加随机后缀，之后可在 manifest.json 修改）。
            </p>
            <button class="primary" type="submit" :disabled="creating">
              {{ creating ? "创建中…" : "创建工具" }}
            </button>
          </form>
        </div>
      </main>
    </div>

    <!-- 编辑模式 -->
    <template v-else>
      <header class="topbar">
        <button class="ghost" @click="router.push('/')">← 返回</button>
        <span class="title">工具编辑器 · {{ id }}</span>
        <div class="spacer" />
        <button
          class="ghost"
          :disabled="!dirty || saving"
          @click="save"
        >
          {{ saving ? "保存中…" : "保存（Ctrl+S）" }}
        </button>
        <button class="ghost" @click="router.push({ name: 'tool-runner', params: { id } })">
          运行 ▶
        </button>
      </header>

      <main class="split">
        <aside class="tree">
          <div class="tree-head">文件</div>
          <div
            v-for="f in files"
            :key="f"
            class="file-row"
            :class="{ active: f === selectedFile }"
            :style="{ paddingLeft: (f.split('/').length - 1) * 16 + 10 + 'px' }"
            @click="openFile(f)"
          >
            <span class="file-name">{{ f }}</span>
            <span v-if="dirty && f === selectedFile" class="dot">●</span>
          </div>
        </aside>

        <section class="edit-area">
          <div v-if="statusMsg" class="status-bar">{{ statusMsg }}</div>
          <div v-if="showManifestHint" class="manifest-hint">
            💡 manifest.json 中的 <code>id</code> 只能用小写字母/数字/-/_；<code>port</code> 填 0 表示随机端口。
          </div>
          <div
            v-if="selectedFile"
            ref="editorEl"
            class="editor-host"
          />
          <div v-else class="empty">{{ statusMsg || "没有可编辑的文件" }}</div>
        </section>
      </main>
    </template>
  </div>
</template>

<style scoped>
.editor {
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
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 新建向导 */
.wizard-body {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.wizard-card {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 28px;
  width: 460px;
}
.wizard-card h2 {
  margin-bottom: 8px;
}
.wizard-card .dim {
  color: var(--text-dim);
  font-size: 13px;
  margin-bottom: 18px;
}
.wizard-card form label {
  display: block;
  font-size: 13px;
  color: var(--text-dim);
  margin-bottom: 6px;
}
.wizard-card input,
.wizard-card select {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  margin-bottom: 6px;
  font-size: 14px;
  color: var(--text);
}
.wizard-card .hint {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 16px;
}
.wizard-card button {
  width: 100%;
}
.notice.error {
  margin-bottom: 12px;
  padding: 8px 12px;
  background: rgba(229, 72, 77, 0.1);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  color: var(--danger);
  font-size: 13px;
}

/* 编辑区 */
.split {
  flex: 1;
  display: flex;
  min-height: 0;
}
.tree {
  width: 240px;
  border-right: 1px solid var(--border);
  background: var(--bg-panel);
  overflow-y: auto;
  flex-shrink: 0;
}
.tree-head {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}
.file-row {
  padding: 7px 10px;
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
}
.file-row:hover {
  background: rgba(79, 110, 247, 0.08);
}
.file-row.active {
  background: rgba(79, 110, 247, 0.15);
  color: var(--accent);
}
.file-name {
  font-family: Consolas, Menlo, monospace;
}
.dot {
  color: var(--accent);
  margin-left: 4px;
}
.edit-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.status-bar {
  padding: 6px 14px;
  font-size: 12px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.manifest-hint {
  padding: 6px 14px;
  font-size: 12px;
  color: var(--text-dim);
  background: rgba(79, 110, 247, 0.08);
  border-bottom: 1px solid var(--border);
}
.editor-host {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: #282c34;
}
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
}
</style>
