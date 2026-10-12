<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api/tauri";
import type { ToolInfo } from "../types";

const route = useRoute();
const router = useRouter();
// 工具 id 必须响应式：从启动器切换不同工具时，路由参数变化要能重新启动
const id = computed(() => route.params.id as string);

const tool = ref<ToolInfo | null>(null);
const starting = ref(true);
const error = ref("");
const logs = ref<string[]>([]);
const showLogs = ref(false);
/** 用于强制重建 iframe（URL 工具的「重新加载」） */
const frameKey = ref(0);
/** URL 工具的嵌入限制提示（可关闭） */
const showUrlHint = ref(true);
/**
 * 记忆端口被占用时的弹窗数据。
 * 非 null 表示「正在等用户决定」：重新分配端口 还是 先不启动。
 */
const portConflict = ref<{ port: number; occupiedBy: "other" | "tool" } | null>(null);

/** URL 工具：不跑本地进程，直接 iframe 加载外部地址 */
const isUrl = computed(() => tool.value?.type === "url");

let pollTimer: ReturnType<typeof setInterval> | null = null;
let currentId = "";

/** 判定工具是否已就绪：URL 工具没有端口，只看状态 */
function isReady(t: ToolInfo | null): boolean {
  if (!t || t.status !== "running") return false;
  return t.type === "url" || !!t.port;
}

/**
 * 启动一次。
 * - 返回 "ok"：已就绪
 * - 返回 "conflict"：记忆端口被占用，已弹出决策窗，调用方应停止重试
 * - 其它失败直接抛错，交给外层重试 / 提示
 */
async function startOnce(reassignPort: boolean): Promise<"ok" | "conflict"> {
  const myId = currentId;
  const r = await api.startTool(myId, reassignPort);
  if (myId !== currentId) return "ok"; // 期间切走了，结果作废
  if (r.kind === "portBusy") {
    portConflict.value = { port: r.port, occupiedBy: r.occupiedBy };
    return "conflict";
  }
  tool.value = r.tool;
  if (isReady(r.tool)) return "ok";
  throw new Error(
    r.tool.status === "error" ? r.tool.error || "工具启动失败" : "工具未能进入运行状态",
  );
}

/** 启动工具并加载其页面（失败自动重试：清掉残留状态再起，最多 3 次） */
async function openTool() {
  starting.value = true;
  error.value = "";
  portConflict.value = null;
  const myId = currentId;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (myId !== currentId) return; // 期间切到别的工具了，不再继续
      if (attempt > 0) {
        // 重试前先停掉残留状态（这正是“重新加载”按钮手动做的事）
        try {
          await api.stopTool(myId);
        } catch {
          /* 忽略 */
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      try {
        const r = await startOnce(false);
        if (r === "conflict") return; // 已弹窗，等用户决定，不重试
        if (myId !== currentId) return;
        return; // 成功
      } catch (e) {
        if (attempt >= 2 || myId !== currentId) {
          if (myId === currentId) {
            error.value = (e as Error)?.message ?? String(e);
          }
          return;
        }
        // 否则循环自动重试，不打扰用户
      }
    }
  } finally {
    if (myId === currentId) starting.value = false;
  }
}

/** 用户在弹窗里选择「重新分配端口并启动」 */
async function confirmReassign() {
  portConflict.value = null;
  starting.value = true;
  error.value = "";
  try {
    const r = await startOnce(true);
    if (r === "ok") {
      await refreshLogs();
      startPolling();
    }
  } catch (e) {
    error.value = (e as Error)?.message ?? String(e);
  } finally {
    starting.value = false;
  }
}

/** 用户在弹窗里选择「先不启动」：工具保持停止，下次打开会重新检查端口 */
function cancelConflict() {
  portConflict.value = null;
  router.push("/");
}

/** 「重试启动」：用户已去关掉占用程序，重新走一遍启动流程（端口没变，数据不丢） */
async function retryConflict() {
  portConflict.value = null;
  await openTool();
}

/** 界面关闭时是否需要停掉进程：URL 工具没有进程，后台常驻工具不随界面关闭而停止 */
function shouldStop(): boolean {
  return tool.value?.type !== "url" && tool.value?.autoStart !== true;
}

async function stopAndBack() {
  if (shouldStop()) {
    try {
      await api.stopTool(currentId);
    } catch {
      /* 忽略停止错误 */
    }
  }
  router.push("/");
}

async function refreshLogs() {
  try {
    logs.value = await api.toolLogs(currentId, 200);
  } catch {
    /* 忽略 */
  }
}

async function reload() {
  // URL 工具没有进程可重启，重建 iframe 即可
  if (isUrl.value) {
    frameKey.value++;
    return;
  }
  try {
    await api.stopTool(currentId);
  } catch {
    /* 忽略 */
  }
  await openTool();
  await refreshLogs();
}

/** 用系统默认浏览器打开（目标站点禁止 iframe 嵌入时的兜底） */
async function openExternal() {
  if (!tool.value?.url) return;
  try {
    await api.openExternalUrl(tool.value.url);
  } catch (e) {
    error.value = "打开浏览器失败：" + ((e as Error)?.message ?? String(e));
  }
}

/** 轮询工具运行状态：进程意外退出时更新 UI（URL 工具无进程、端口冲突待决策时都跳过） */
function startPolling() {
  if (isUrl.value || portConflict.value) return;
  pollTimer = setInterval(async () => {
    try {
      const st = await api.toolStatus(currentId);
      if (tool.value?.status === "running" && st.status !== "running") {
        error.value = "工具进程已退出";
        tool.value = st;
      }
    } catch {
      /* 宿主暂不可达时忽略 */
    }
  }, 2000);
}

// 路由 id 变化时：停旧工具 → 启动新工具 → 开始轮询
watch(
  id,
  async (newId) => {
    if (pollTimer) clearInterval(pollTimer);
    if (currentId && currentId !== newId) {
      // 后台常驻工具不随界面关闭而停止
      if (shouldStop()) {
        try {
          await api.stopTool(currentId);
        } catch {
          /* 忽略 */
        }
      }
    }
    currentId = newId;
    tool.value = null;
    logs.value = [];
    error.value = "";
    await openTool();
    await refreshLogs();
    startPolling();
  },
  { immediate: true },
);

onUnmounted(async () => {
  if (pollTimer) clearInterval(pollTimer);
  if (currentId) {
    // 后台常驻工具不随界面关闭而停止
    if (shouldStop()) {
      try {
        await api.stopTool(currentId);
      } catch {
        /* 忽略 */
      }
    }
  }
});
</script>

<template>
  <div class="runner">
    <header class="topbar">
      <button class="ghost" @click="stopAndBack">← 返回</button>
      <span class="title">{{ tool?.name || id }}</span>
      <div class="spacer" />
      <span v-if="isUrl" class="badge">外部链接</span>
      <span v-else-if="tool?.status === 'running'" class="badge ok">运行中 :{{ tool.port }}</span>
      <span v-else class="badge">未运行</span>
      <button v-if="isUrl" class="ghost" @click="openExternal">用浏览器打开</button>
      <button v-if="!isUrl" class="ghost" @click="showLogs = !showLogs">日志</button>
      <button class="ghost" @click="reload">重新加载</button>
    </header>

    <div v-if="error" class="error-bar">
      {{ error }}
      <button class="ghost" @click="openTool">重试</button>
    </div>

    <div v-if="isUrl && showUrlHint" class="url-hint">
      <span>若下方空白，说明该站点禁止被嵌入（X-Frame-Options / CSP），请点右上角「用浏览器打开」。</span>
      <button class="ghost" @click="showUrlHint = false">知道了</button>
    </div>

    <!-- URL 工具：直接 iframe 加载外部地址。它用自己的 origin，
         localStorage / IndexedDB 天然与平台及其它工具隔离，且由该站点自己持久化。 -->
    <main v-if="isUrl && tool?.url" class="frame">
      <iframe
        :key="frameKey"
        :src="tool?.url || undefined"
        class="tool-frame"
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"
      />
    </main>
    <main v-else-if="tool?.status === 'running' && tool.port" class="frame">
      <iframe
        :src="`http://127.0.0.1:${tool.port}`"
        class="tool-frame"
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
      />
    </main>
    <main v-else class="frame placeholder">
      <p v-if="starting">正在启动工具…</p>
      <p v-else-if="portConflict">端口 {{ portConflict.port }} 被占用，请在弹窗中选择处理方式</p>
      <p v-else-if="!tool || tool.status === 'error'">工具无法运行</p>
      <p v-else>准备就绪，等待加载…</p>
    </main>

    <!-- 记忆端口被占用：不擅自换端口（换端口 = 换存储位置），交由用户决定 -->
    <div v-if="portConflict" class="modal-mask">
      <div class="modal">
        <h3>端口被占用，无法启动</h3>
        <p class="modal-text">
          工具「{{ tool?.name || id }}」上次使用的端口
          <b class="mono">{{ portConflict.port }}</b>
          已被{{ portConflict.occupiedBy === "tool" ? "另一个正在运行的工具" : "系统上的其它程序" }}占用。
        </p>
        <p class="modal-warn">
          这个端口决定了工具页面的<strong>来源地址（origin）</strong>，也就是它
          <strong>localStorage / IndexedDB 的存放位置</strong>。<br />
          重新分配端口会让工具换到新的存储位置，<strong>之前保存的数据将无法读取</strong>。
          数据不会被删除、也<strong>不会被自动清理</strong>（浏览器同源策略不允许跨来源删除数据），
          它会一直留在磁盘上占空间。<br />
          所以如果这些数据对你重要，建议<strong>先去关掉占用该端口的程序，再点「重试启动」</strong>。
        </p>
        <div class="modal-actions">
          <button class="ghost" @click="cancelConflict">先不启动</button>
          <button class="ghost" @click="retryConflict">重试启动</button>
          <button class="primary" @click="confirmReassign">重新分配端口并启动</button>
        </div>
      </div>
    </div>

    <div v-if="showLogs" class="logs">
      <div class="logs-head">运行日志</div>
      <pre class="logs-body">{{ logs.join("\n") || "(暂无日志)" }}</pre>
    </div>
  </div>
</template>

<style scoped>
.runner {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}
.title {
  font-weight: 600;
}
.spacer {
  flex: 1;
}
.badge {
  font-size: 12px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 10px;
}
.badge.ok {
  color: var(--ok);
  border-color: var(--ok);
}
.error-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  background: rgba(229, 72, 77, 0.1);
  border-bottom: 1px solid var(--danger);
  color: var(--danger);
  font-size: 13px;
}
.frame {
  flex: 1;
  position: relative;
  background: #fff;
}
.url-hint {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  font-size: 12px;
  color: var(--text-dim);
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}
.url-hint span {
  flex: 1;
}

/* ---------- 端口冲突弹窗 ---------- */
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
  max-width: 480px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 22px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.28);
}
.modal h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
}
.modal-text {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text);
  margin-bottom: 12px;
}
.modal-text .mono {
  font-family: Consolas, Menlo, monospace;
  color: var(--accent);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
}
.modal-warn {
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-dim);
  background: rgba(240, 180, 41, 0.08);
  border: 1px solid rgba(240, 180, 41, 0.35);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.modal-warn strong {
  color: var(--text);
  font-weight: 600;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
.tool-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}
.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  background: var(--bg);
}
.logs {
  height: 200px;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
}
.logs-head {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}
.logs-body {
  flex: 1;
  overflow: auto;
  padding: 8px 12px;
  font-family: Consolas, Menlo, monospace;
  font-size: 12px;
  white-space: pre-wrap;
}
</style>
