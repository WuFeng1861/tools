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

let pollTimer: ReturnType<typeof setInterval> | null = null;
let currentId = "";

/** 启动工具并加载其页面（失败自动重试：清掉残留状态再起，最多 3 次） */
async function openTool() {
  starting.value = true;
  error.value = "";
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
        const t = await api.startTool(myId);
        if (myId !== currentId) return;
        tool.value = t;
        if (t.status === "running" && t.port) return; // 成功
        throw new Error(t.status === "error" ? t.error || "工具启动失败" : "工具未能进入运行状态");
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

async function stopAndBack() {
  // 后台常驻工具不随界面关闭而停止
  if (tool.value?.autoStart !== true) {
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
  try {
    await api.stopTool(currentId);
  } catch {
    /* 忽略 */
  }
  await openTool();
  await refreshLogs();
}

/** 轮询工具运行状态：进程意外退出时更新 UI */
function startPolling() {
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
      if (tool.value?.autoStart !== true) {
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
    if (tool.value?.autoStart !== true) {
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
      <span v-if="tool?.status === 'running'" class="badge ok">运行中 :{{ tool.port }}</span>
      <span v-else class="badge">未运行</span>
      <button class="ghost" @click="showLogs = !showLogs">日志</button>
      <button class="ghost" @click="reload">重新加载</button>
    </header>

    <div v-if="error" class="error-bar">
      {{ error }}
      <button class="ghost" @click="openTool">重试</button>
    </div>

    <main v-if="tool?.status === 'running' && tool.port" class="frame">
      <iframe
        :src="`http://127.0.0.1:${tool.port}`"
        class="tool-frame"
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
      />
    </main>
    <main v-else class="frame placeholder">
      <p v-if="starting">正在启动工具…</p>
      <p v-else-if="!tool || tool.status === 'error'">工具无法运行</p>
      <p v-else>准备就绪，等待加载…</p>
    </main>

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
