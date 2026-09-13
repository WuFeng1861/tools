import { reactive } from "vue";

/**
 * 显示效果（视觉）设置：通过合成 CSS filter 作用于整棵界面。
 * App.vue 与设置页共用本模块级单例状态。
 */
export interface DisplaySettings {
  brightness: number; // 亮度 0.5~1.6，1=原样
  saturate: number;   // 饱和度 0.5~1.6，1=原样
  contrast: number;   // 对比度 0.5~1.6，1=原样
  warmth: number;     // 暖色调(sepia) 0~0.35，越大越偏暖
}

const KEY = "toolbox-display";
const LEGACY_KEY = "toolbox-brightness"; // 旧版单亮度键，用于迁移

const DEFAULTS: DisplaySettings = {
  brightness: 1,
  saturate: 1,
  contrast: 1,
  warmth: 0,
};

const LIMITS: Record<keyof DisplaySettings, [number, number]> = {
  brightness: [0.5, 1.6],
  saturate: [0.5, 1.6],
  contrast: [0.5, 1.6],
  warmth: [0, 0.35],
};

export const settings = reactive<DisplaySettings>({ ...DEFAULTS });

function clamp(v: number, [min, max]: [number, number]) {
  return Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 启动时从 localStorage 读取（含旧版亮度键迁移） */
export function loadDisplay() {
  let src: Record<string, unknown> | null = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) src = JSON.parse(raw);
  } catch {
    /* 忽略 */
  }
  if (src && typeof src === "object") {
    (Object.keys(LIMITS) as (keyof DisplaySettings)[]).forEach((k) => {
      settings[k] = clamp(num((src as unknown as Record<string, unknown>)[k], settings[k]), LIMITS[k]);
    });
  } else {
    // 兼容旧版单亮度键
    try {
      const old = Number(localStorage.getItem(LEGACY_KEY));
      if (Number.isFinite(old)) {
        settings.brightness = clamp(old, LIMITS.brightness);
      }
    } catch {
      /* 忽略 */
    }
  }
}

/** 持久化到 localStorage */
export function persistDisplay() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...settings }));
  } catch {
    /* 忽略 */
  }
}

/** 把当前值写入 CSS 变量，驱动 #app 的 filter */
export function applyDisplay(root: HTMLElement = document.documentElement) {
  root.style.setProperty("--brightness", String(settings.brightness));
  root.style.setProperty("--saturate", String(settings.saturate));
  root.style.setProperty("--contrast", String(settings.contrast));
  root.style.setProperty("--warmth", String(settings.warmth));
}

/** 便捷：设置单项并立即应用与持久化 */
export function setDisplay<K extends keyof DisplaySettings>(key: K, value: number) {
  settings[key] = clamp(value, LIMITS[key]);
  applyDisplay();
  persistDisplay();
}