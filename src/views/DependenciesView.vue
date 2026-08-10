<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api/tauri";
import type { ToolInfo, PackageInfo } from "../types";

const router = useRouter();

const tools = ref<ToolInfo[]>([]);
const selectedId = ref("");
const packages = ref<PackageInfo[]>([]);
const pkgName = ref("");
const pkgVersion = ref("");
const busy = ref(false);
const error = ref("");
const success = ref("");

async function loadTools() {
  try {
    tools.value = await api.listTools();
    if (tools.value.length && !selectedId.value) {
      selectedId.value = tools.value[0].id;
    }
  } catch (e) {
    error.value = (e as Error)?.message ?? String(e);
  }
}

async function loadPackages() {
  error.value = "";
  if (!selectedId.value) {
    packages.value = [];
    return;
  }
  try {
    packages.value = await api.listPackages(selectedId.value);
  } catch (e) {
    error.value = (e as Error)?.message ?? String(e);
  }
}

async function install() {
  const name = pkgName.value.trim();
  if (!name) {
    error.value = "请输入包名";
    return;
  }
  if (!selectedId.value) {
    error.value = "请先选择一个工具";
    return;
  }
  busy.value = true;
  error.value = "";
  success.value = "";
  try {
    packages.value = await api.installPackage(
      selectedId.value,
      name,
      pkgVersion.value.trim() || undefined,
    );
    success.value = `已安装 ${name}`;
    pkgName.value = "";
    pkgVersion.value = "";
  } catch (e) {
    error.value = `安装失败：${(e as Error)?.message ?? String(e)}`;
  } finally {
    busy.value = false;
  }
}

async function uninstall(pkg: PackageInfo) {
  if (!selectedId.value) return;
  busy.value = true;
  error.value = "";
  success.value = "";
  try {
    packages.value = await api.uninstallPackage(selectedId.value, pkg.name);
    success.value = `已卸载 ${pkg.name}`;
  } catch (e) {
    error.value = `卸载失败：${(e as Error)?.message ?? String(e)}`;
  } finally {
    busy.value = false;
  }
}

watch(selectedId, loadPackages);

onMounted(async () => {
  await loadTools();
  await loadPackages();
});
</script>

<template>
  <div class="deps">
    <header class="topbar">
      <button class="ghost" @click="router.push('/')">← 返回</button>
      <span class="title">依赖管理</span>
      <span class="hint">为某个工具安装 / 卸载 npm 库，装好后工具里直接 require 使用</span>
    </header>

    <main class="body">
      <div v-if="error" class="notice error">{{ error }}</div>
      <div v-if="success" class="notice ok">{{ success }}</div>

      <section class="panel">
        <label class="field">
          <span>目标工具</span>
          <select v-model="selectedId" @change="loadPackages">
            <option v-for="t in tools" :key="t.id" :value="t.id">
              {{ t.name }}（{{ t.id }}）
            </option>
          </select>
        </label>

        <form class="install-row" @submit.prevent="install">
          <input v-model="pkgName" placeholder="npm 包名，如 nanoid" />
          <input
            v-model="pkgVersion"
            placeholder="版本（可选），如 ^5.0.0"
            class="ver"
          />
          <button class="primary" type="submit" :disabled="busy">
            {{ busy ? "安装中…" : "安装" }}
          </button>
        </form>
      </section>

      <section class="panel">
        <div class="list-head">
          已安装（{{ packages.length }}）
          <button class="ghost" @click="loadPackages">刷新</button>
        </div>
        <div v-if="packages.length === 0" class="empty">暂无依赖</div>
        <div v-for="pkg in packages" :key="pkg.name" class="pkg-row">
          <span class="pkg-name">{{ pkg.name }}</span>
          <span class="pkg-ver">{{ pkg.version }}{{ pkg.dev ? "（dev）" : "" }}</span>
          <button class="ghost danger" :disabled="busy" @click="uninstall(pkg)">
            卸载
          </button>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.deps {
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
.hint {
  color: var(--text-dim);
  font-size: 12px;
}
.body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  max-width: 760px;
  margin: 0 auto;
  width: 100%;
}
.notice {
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  margin-bottom: 14px;
  font-size: 13px;
}
.notice.error {
  background: rgba(229, 72, 77, 0.1);
  border: 1px solid var(--danger);
  color: var(--danger);
}
.notice.ok {
  background: rgba(48, 164, 108, 0.1);
  border: 1px solid var(--ok);
  color: var(--ok);
}
.panel {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  margin-bottom: 16px;
  box-shadow: var(--shadow);
}
.field {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  color: var(--text-dim);
  font-size: 13px;
}
.field select {
  flex: 1;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
}
.install-row {
  display: flex;
  gap: 8px;
}
.install-row input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
}
.install-row .ver {
  flex: 0 0 180px;
}
.list-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  color: var(--text-dim);
  margin-bottom: 8px;
}
.pkg-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 4px;
  border-top: 1px solid var(--border);
}
.pkg-name {
  font-weight: 600;
}
.pkg-ver {
  flex: 1;
  color: var(--text-dim);
  font-size: 12px;
}
button.danger {
  color: var(--danger);
}
.empty {
  color: var(--text-dim);
  text-align: center;
  padding: 16px;
}
</style>
