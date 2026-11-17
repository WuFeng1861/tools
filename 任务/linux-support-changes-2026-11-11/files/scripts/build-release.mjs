#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
if (!["win32", "linux"].includes(process.platform)) {
  console.error("此发布脚本支持 Windows 和 Linux；其他系统请使用 npm run tauri build。");
  process.exit(1);
}
// 直接用 Node 执行本地 CLI，避免 Windows .cmd 和 shell 转义差异。
const cli = require.resolve("@tauri-apps/cli/tauri.js");
const bundles = process.platform === "win32" ? "nsis" : "deb,appimage";
const result = spawnSync(process.execPath,
  [cli, "build", "--bundles", bundles, ...process.argv.slice(2)],
  { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
