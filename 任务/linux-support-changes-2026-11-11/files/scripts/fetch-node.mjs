#!/usr/bin/env node
/**
 * 准备 sidecar 运行时的本地资源：
 *   1) Windows：复制 node.exe → src-tauri/resources/bin/node.exe
 *   2) 复制 npm 模块 → src-tauri/resources/npm（供宿主执行 npm install）
 *
 * 用法：
 *   node scripts/fetch-node.mjs
 *   node scripts/fetch-node.mjs --node <node.exe路径> --npm <npm目录>
 *
 * Windows 默认使用当前 Node 及其同目录 node_modules/npm。
 * Linux 只检查系统 Node/npm，不修改 Windows 资源。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--node") out.node = argv[++i];
    else if (argv[i] === "--npm") out.npm = argv[++i];
  }
  return out;
}

function resolveNodeExe() {
  // 优先用户显式指定，否则取 PATH 上的 node.exe
  return (
    args.node ||
    process.env.NODE_PATH_SAFE ||
    process.execPath // 本脚本用 node 运行，execPath 即本机 node
  );
}

const args = parseArgs(process.argv.slice(2));
if (process.platform === "linux") {
  // Linux 发行包使用系统 Node/npm，不覆盖 Windows 的内置运行时资源。
  try {
    const npmVersion = execFileSync("npm", ["--version"], {
      encoding: "utf8", timeout: 30000,
    }).trim();
    console.log(`✓ Linux 使用系统 Node ${process.version} / npm ${npmVersion}，无需复制 node.exe 或 npm。`);
    process.exit(0);
  } catch (e) {
    console.error(`无法运行系统 npm，请先安装 npm：${e.message}`);
    process.exit(1);
  }
}
const nodeExe = resolveNodeExe();
if (!existsSync(nodeExe)) {
  console.error(`找不到 node.exe: ${nodeExe}`);
  process.exit(1);
}

// 1) node 运行时：作为普通 resource 打包，由 Rust 用 std::process::Command 启动
const resBinDir = join(root, "src-tauri", "resources", "bin");
mkdirSync(resBinDir, { recursive: true });
const targetExe = join(resBinDir, "node.exe");
copyFileSync(nodeExe, targetExe);
console.log(`✓ node.exe → ${targetExe} (${Math.round(statSync(targetExe).size / 1048576)} MB)`);

// 2) npm 模块
const nodeDir = dirname(nodeExe);
const npmSource = args.npm || join(nodeDir, "node_modules", "npm");
if (!existsSync(join(npmSource, "bin", "npm-cli.js"))) {
  console.error(`找不到 npm 模块: ${npmSource}`);
  process.exit(1);
}
const npmTarget = join(root, "src-tauri", "resources", "npm");
rmSync(npmTarget, { recursive: true, force: true });
mkdirSync(npmTarget, { recursive: true });
cpSync(npmSource, npmTarget, { recursive: true });
console.log(`✓ npm → ${npmTarget}`);

// 3) 验证复制后的 npm-cli 可运行
try {
  const v = execFileSync(targetExe, [join(npmTarget, "bin", "npm-cli.js"), "--version"], {
    encoding: "utf8",
    timeout: 30000,
  }).trim();
  console.log(`✓ npm-cli.js 可运行，npm 版本: ${v}`);
} catch (e) {
  console.error(`✗ npm-cli.js 验证失败: ${e.message}`);
  process.exit(1);
}

console.log("资源准备完成。");
