import { createRouter, createWebHashHistory } from "vue-router";
import LauncherView from "./views/LauncherView.vue";

// 使用 hash 模式：Tauri 生产环境加载 tauri://localhost，hash 路由最稳妥（避免深链刷新 404）
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "launcher", component: LauncherView },
    {
      path: "/tool/:id",
      name: "tool-runner",
      component: () => import("./views/ToolRunnerView.vue"),
    },
    {
      path: "/editor",
      name: "tool-editor-new",
      component: () => import("./views/ToolEditorView.vue"),
    },
    {
      path: "/editor/:id",
      name: "tool-editor",
      component: () => import("./views/ToolEditorView.vue"),
    },
    {
      path: "/deps",
      name: "dependencies",
      component: () => import("./views/DependenciesView.vue"),
    },
    {
      path: "/tutorial",
      name: "tutorial",
      component: () => import("./views/TutorialView.vue"),
    },
    {
      path: "/settings",
      name: "settings",
      component: () => import("./views/SettingsView.vue"),
    },
    {
      path: "/shortcuts",
      name: "shortcuts",
      component: () => import("./views/ShortcutsView.vue"),
    },
  ],
});

export default router;
