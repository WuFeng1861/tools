import { ref } from "vue";
import { api } from "./api/tauri";

/**
 * 残留数据清理的共享状态。
 *
 * 背景：工具换端口或被删除后，旧端口上的 localStorage / IndexedDB 就成了残留，
 * 同源策略不允许从外部删除。宿主的办法是把该端口（空闲时）重新占下来，
 * 取得那个 origin 的同源身份 —— 但真正执行删除的必须是**同源页面**。
 *
 * 所以 App.vue 会为这里列出的每个端口渲染一个隐藏 iframe 加载清理页；
 * 设置页的「立即清理」也调用 runSweep()，两边共用同一份状态，
 * 避免出现「宿主占下了端口却没人加载清理页」的悬空情况。
 */
export const cleanupPorts = ref<number[]>([]);

const timers: ReturnType<typeof setTimeout>[] = [];

/** 触发一次清理扫描；返回本轮已占下、需要加载清理页的端口列表 */
export async function runSweep(force = false): Promise<number[]> {
  let ports: number[] = [];
  try {
    ports = await api.sweepResiduals(force);
  } catch {
    return []; // 宿主未就绪时静默跳过，下次再来
  }
  for (const p of ports) {
    if (cleanupPorts.value.includes(p)) continue;
    cleanupPorts.value.push(p);
    // 清理页清完会回报宿主（宿主随即关掉那个临时端口），这里只负责稍后摘掉 iframe
    timers.push(
      setTimeout(() => {
        cleanupPorts.value = cleanupPorts.value.filter((x) => x !== p);
      }, 45_000),
    );
  }
  return ports;
}

/** 组件卸载时清理定时器 */
export function disposeSweep() {
  timers.forEach(clearTimeout);
  timers.length = 0;
}
