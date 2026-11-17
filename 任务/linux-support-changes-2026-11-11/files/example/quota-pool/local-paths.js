"use strict";
const os = require("os");
const path = require("path");

function localPaths({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const unique = (values) => [...new Set(values.filter(Boolean))];
  const override = (name) => env[name] && path.isAbsolute(env[name]) ? env[name] : null;
  const roots = platform === "win32" ? [env.LOCALAPPDATA, env.APPDATA].filter(Boolean)
    : platform === "linux" ? [env.XDG_CONFIG_HOME || path.join(home, ".config"), env.XDG_DATA_HOME || path.join(home, ".local", "share")] : [];
  const auth = unique([override("QUOTA_POOL_WORKBUDDY_AUTH_FILE"), ...roots.map((root) =>
    path.join(root, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"))]);
  // 保留 Windows 原有 APPDATA 优先顺序；Linux 同时查找 XDG config/data。
  const traeRoots = platform === "win32" ? [env.APPDATA, env.LOCALAPPDATA].filter(Boolean) : roots;
  const apps = platform === "linux" ? ["TRAE SOLO CN", "Trae", "Trae CN", "TraeWork"] : ["TRAE SOLO CN"];
  const trae = unique([override("QUOTA_POOL_TRAE_ENV_FILE"), ...traeRoots.flatMap((root) => apps.map((app) =>
    path.join(root, app, "ModularData", "ckg_server", "local_env.json")))]);
  return { auth, trae };
}

module.exports = { localPaths };
