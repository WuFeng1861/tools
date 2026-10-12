#!/usr/bin/env node
/**
 * 宿主（host.js）回归测试 —— 用真实进程跑完整流程，不依赖 Tauri。
 *
 *   node scripts/test-host.mjs
 *
 * 重点守护两件事：
 *  1. 「端口 ↔ 存储」不变量：端口决定工具页面的 origin，也就是它
 *     localStorage / IndexedDB 的存放位置，因此端口必须跨重启稳定，
 *     且记忆端口被占用时【不能】擅自重新分配。
 *  2. URL 工具（type: "url"）的识别与状态。
 *
 * 这几条断言都是实际抓出过 bug 的，改动 host.js 后请务必跑一遍。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const NODE = process.execPath;
const HOST_JS = path.join(ROOT, "src-tauri/resources/host/host.js");
const RUNTIME = path.join(ROOT, "src-tauri/resources/runtime");
const PORT_MIN = 30000;
const PORT_MAX = 40000;

const ok = [];
const bad = [];
const check = (cond, label) => (cond ? ok : bad).push(label);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- 脚手架 */

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "host-test-"));
const TB = path.join(DATA, "toolbox");
fs.mkdirSync(TB, { recursive: true });
const stateFile = path.join(DATA, "host-state.json");
const portsFile = path.join(DATA, "ports.json");

const TOOL_SRC =
  'const http=require("http");http.createServer((q,s)=>s.end("ok")).listen(process.env.TOOL_PORT,"127.0.0.1");';

function mkTool(id, manifest, extra = {}) {
  const d = path.join(TB, id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify(manifest, null, 2));
  for (const [name, content] of Object.entries(extra)) {
    fs.writeFileSync(path.join(d, name), content);
  }
}
function mkLocal(id, name) {
  mkTool(
    id,
    { id, name, version: "1.0.0", description: "", main: "app.js", html: "index.html", port: 0 },
    { "app.js": TOOL_SRC, "index.html": `<!doctype html><title>${id}</title>` },
  );
}
/** 本地网页工具：一个 index.html + 一个同目录静态资源 */
function mkStatic(id, name) {
  mkTool(id, {
    id, name, version: "1.0.0", description: "", icon: "📄",
    type: "static", html: "index.html", port: 0,
  });
  const d = path.join(TB, id);
  fs.writeFileSync(
    path.join(d, "index.html"),
    `<!doctype html><title>${id}</title><link rel="stylesheet" href="style.css"><h1>${id}</h1>`,
  );
  fs.writeFileSync(path.join(d, "style.css"), "h1{color:red}");
}

function findFreePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: p, method, headers: { "Content-Type": "application/json" } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    r.on("error", reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

function reqRaw(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method: "GET" }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () =>
        resolve({ status: res.statusCode, type: res.headers["content-type"], body: d }),
      );
    });
    r.on("error", reject);
    r.end();
  });
}

/** 探测端口上是否真的有服务在监听 */
function portListening(p, t = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: p }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(t, () => {
      s.destroy();
      resolve(false);
    });
  });
}

let hostProc = null;

/** 启动宿主，等到 /health 真正可用为止 */
function startHost() {
  return new Promise((resolve, reject) => {
    try {
      fs.unlinkSync(stateFile);
    } catch {}
    hostProc = spawn(
      NODE,
      [HOST_JS, "--data-dir", DATA, "--runtime", RUNTIME, "--templates", ""],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    hostProc.stdout.on("data", (d) => {
      if (process.env.VERBOSE) process.stdout.write("[host] " + d);
    });
    hostProc.stderr.on("data", (d) => process.stderr.write("[host!] " + d));

    const t0 = Date.now();
    let port = 0;
    const poll = setInterval(async () => {
      if (Date.now() - t0 > 15000) {
        clearInterval(poll);
        return reject(new Error("宿主启动超时"));
      }
      if (!port) {
        try {
          const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
          if (st.hostPort) port = st.hostPort;
        } catch {}
        return;
      }
      try {
        await req(port, "GET", "/health");
        clearInterval(poll);
        resolve(port);
      } catch {}
    }, 200);
  });
}

/** 优雅停机；宿主退出会重置连接，属正常，必须吞掉 error */
async function stopHost() {
  const proc = hostProc;
  if (!proc) return;
  const port = proc.__port;
  await new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    if (port) {
      const q = http.request(
        { host: "127.0.0.1", port, path: "/shutdown", method: "POST" },
        fin,
      );
      q.on("error", fin);
      q.end();
    }
    setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      fin();
    }, 1500);
  });
  hostProc = null;
  await wait(800);
}

const readPorts = () => JSON.parse(fs.readFileSync(portsFile, "utf8"));

/* ---------------------------------------------------------------- 场景准备 */

mkTool("web-a", {
  id: "web-a", name: "外部工具", version: "1.0.0", description: "x",
  icon: "🔗", type: "url", url: "http://127.0.0.1:8777/",
});
mkTool("web-bad", {
  id: "web-bad", name: "非法地址", version: "1.0.0", description: "",
  type: "url", url: "http://example.com/x",
});
mkLocal("local-a", "工具A");
mkLocal("local-b", "工具B");
mkLocal("local-c", "工具C");
mkLocal("local-new", "新工具"); // ports.json 里没有它 → 走随机分配
mkStatic("page-a", "本地网页");

// 用户手动丢进 toolbox/ 的网页目录：只有 index.html，没有 manifest.json
const droppedDir = path.join(TB, "dropped-page");
fs.mkdirSync(droppedDir, { recursive: true });
fs.writeFileSync(
  path.join(droppedDir, "index.html"),
  "<!doctype html><title>dropped</title><h1>dropped</h1>",
);
// 既没有 manifest.json 也没有 index.html 的目录：应给出可操作的错误提示
const emptyDir = path.join(TB, "no-entry");
fs.mkdirSync(emptyDir, { recursive: true });
fs.writeFileSync(path.join(emptyDir, "readme.txt"), "not a tool");

// local-a / local-b 记忆同一端口（模拟历史遗留或手改 ports.json）
// local-c 的记忆端口将由一个「平台外程序」占住
const P_SHARED = await findFreePort();
const P_EXT = await findFreePort();
const extServer = net.createServer();
await new Promise((res, rej) => {
  extServer.once("error", rej);
  extServer.listen(P_EXT, "127.0.0.1", res);
});

// 预置大量「已被其它工具记住」的端口，用来验证随机分配会避开它们
const GHOST_COUNT = 8000;
const candidates = [];
for (let p = PORT_MIN; p < PORT_MAX; p++) {
  if (p !== P_SHARED && p !== P_EXT) candidates.push(p);
}
for (let i = candidates.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
}
const ghostPorts = candidates.slice(0, GHOST_COUNT);
const ghostSet = new Set(ghostPorts);
const seed = { "local-a": P_SHARED, "local-b": P_SHARED, "local-c": P_EXT };
ghostPorts.forEach((p, i) => (seed["ghost-" + i] = p));
fs.writeFileSync(portsFile, JSON.stringify(seed, null, 2));

// 预置一条「冷却中」的残留（模拟上次清理未完成），用于验证 force 重试
const P_COOLDOWN = await findFreePort();
fs.writeFileSync(
  path.join(DATA, "residuals.json"),
  JSON.stringify(
    [
      {
        toolId: "cooling-tool",
        port: P_COOLDOWN,
        at: Date.now() - 60_000,
        retryAfter: Date.now() + 10 * 60 * 1000,
      },
    ],
    null,
    2,
  ),
);

/* ---------------------------------------------------------------- 跑 */

try {
  // ============ 第一轮 ============
  let HP = await startHost();
  hostProc.__port = HP;

  // --- URL 工具 ---
  const list = await req(HP, "GET", "/tools");
  const pick = (id) => list.data.find((x) => x.id === id);
  check(!!pick("web-a"), "URL 工具出现在工具列表中");
  check(pick("web-a")?.type === "url", "URL 工具的 type 标记为 url");
  check(pick("web-a")?.url === "http://127.0.0.1:8777/", "URL 工具的 url 字段正确回传");
  check(pick("web-a")?.status === "running", "URL 工具恒为 running（不跑进程）");
  check(pick("web-a")?.port === null, "URL 工具不占用端口");
  check(pick("web-bad")?.status === "error", "http:// 非回环地址被拒绝");
  check(/回环|127/.test(pick("web-bad")?.error || ""), "拒绝原因指明回环限制");

  // --- 本地工具：启动 / 复用 ---
  const a1 = await req(HP, "POST", "/tools/local-a/start", { reassignPort: false });
  check(a1.data?.status === "running" && a1.data?.port === P_SHARED, "本地工具启动并占用记忆端口");
  check(readPorts()["local-a"] === P_SHARED, "ports.json 记录了该端口");

  const a2 = await req(HP, "POST", "/tools/local-a/start", { reassignPort: false });
  check(a2.data?.port === P_SHARED, "已运行的工具重复 start 幂等返回真实端口（展开顺序）");

  await req(HP, "POST", "/tools/local-a/stop");
  await wait(700);
  const a3 = await req(HP, "POST", "/tools/local-a/start", { reassignPort: false });
  check(a3.data?.port === P_SHARED, "同一宿主内停止后重启仍复用同一端口");
  await req(HP, "POST", "/tools/local-a/stop");
  await wait(700);

  // --- 端口被「另一个运行中的工具」占用 ---
  const x1 = await req(HP, "POST", "/tools/local-a/start", { reassignPort: false });
  const b1 = await req(HP, "POST", "/tools/local-b/start", { reassignPort: false });
  check(x1.data?.status === "running", "为冲突场景启动工具A");
  check(b1.data?.pending === "portBusy", "★ 端口冲突时不静默换端口，返回待决策状态");
  check(b1.data?.port === P_SHARED, "待决策状态里带上了被占用的端口号");
  check(b1.data?.occupiedBy === "tool", "占用方识别为「另一个运行中的工具」");
  check(readPorts()["local-b"] === P_SHARED, "★ 未经确认不改动 ports.json");
  await req(HP, "POST", "/tools/local-a/stop");
  await wait(700);

  // --- 端口被「平台外程序」占用 + 用户确认重新分配 ---
  const c1 = await req(HP, "POST", "/tools/local-c/start", { reassignPort: false });
  check(c1.data?.pending === "portBusy", "★ 外部程序占用时同样返回待决策状态");
  check(c1.data?.occupiedBy === "other", "占用方识别为「平台外程序」");
  check(c1.data?.port === P_EXT, "待决策状态里带上被占用的端口号");
  check(readPorts()["local-c"] === P_EXT, "★ 未经确认不改动 ports.json");

  const c2 = await req(HP, "POST", "/tools/local-c/start", { reassignPort: true });
  const NEW_PORT = c2.data?.port;
  check(c2.data?.status === "running", "用户确认重新分配后成功启动");
  check(NEW_PORT && NEW_PORT !== P_EXT, "分配到了不同于被占用端口的新端口");
  check(readPorts()["local-c"] === NEW_PORT, "ports.json 更新为新端口");
  check(
    readPorts()["local-a"] === P_SHARED && readPorts()["local-b"] === P_SHARED,
    "其它工具的端口记录未被波及",
  );
  await req(HP, "POST", "/tools/local-c/stop");
  await wait(700);

  // --- 随机分配要避开别的工具「记住」的端口 ---
  const n1 = await req(HP, "POST", "/tools/local-new/start", { reassignPort: false });
  check(n1.data?.status === "running", "无记忆端口的新工具正常启动");
  check(
    !ghostSet.has(n1.data?.port),
    "★ 随机分配的端口避开了其它工具保留的 " + GHOST_COUNT + " 个端口",
  );
  check(!new Set([P_SHARED, P_EXT]).has(n1.data?.port), "也避开了手动指定的端口");
  await req(HP, "POST", "/tools/local-new/stop");
  await wait(700);

  // --- 本地网页工具（type: "static"）---
  const plist = await req(HP, "GET", "/tools");
  const p0 = plist.data.find((x) => x.id === "page-a");
  check(p0?.type === "static", "本地网页工具 type 标记为 static");
  check(p0?.status === "stopped", "未启动时状态为 stopped");
  check(p0?.html === "index.html", "manifest 里的入口页面正确回传");

  const ps = await req(HP, "POST", "/tools/page-a/start", { reassignPort: false });
  const PP = ps.data?.port;
  check(ps.data?.status === "running" && typeof PP === "number", "静态工具启动并拿到端口 " + PP);
  check(ps.data?.pid === null, "静态工具没有子进程（pid 为 null）");
  check(!ghostSet.has(PP), "★ 静态工具的端口也避开了保留端口");

  const idx = await reqRaw(PP, "/");
  check(idx.status === 200 && /text\/html/.test(idx.type || ""), "GET / 返回 index.html");
  check(idx.body.includes("page-a"), "返回内容确实是该工具的页面");
  const css = await reqRaw(PP, "/style.css");
  check(css.status === 200 && /text\/css/.test(css.type || ""), "同目录静态资源可访问且 MIME 正确");
  const nf = await reqRaw(PP, "/not-exist.html");
  check(nf.status === 404, "不存在的路径返回 404");

  // 目录穿越防护说明：
  //  WHATWG URL 解析器自己会把 %2e%2e / .. 规范化掉，所以 /../x 与 /%2e%2e/x
  //  实际都会落到工具目录内的同名文件（不是穿越）。
  //  真正需要拦的是「编码斜杠」这类能骗过解析器的形式 —— 由服务端显式校验兜底。
  const inDir = await reqRaw(PP, "/%2e%2e/manifest.json");
  check(inDir.status === 200, "被解析器规范化回工具目录内的路径正常返回（非穿越）");
  const esc = await reqRaw(PP, "/%2e%2e%2fmanifest.json");
  check(esc.status === 403, "★ 编码斜杠的目录穿越被拒绝（403）");
  const esc2 = await reqRaw(PP, "/%2e%2e%2f%2e%2e%2fhost-state.json");
  check(esc2.status === 403, "★ 多级穿越同样被拒绝（403）");

  await req(HP, "POST", "/tools/page-a/stop");
  await wait(700);
  const pl2 = await req(HP, "GET", "/tools/page-a");
  check(pl2.data?.status === "stopped", "静态工具可正常停止");
  const ps2 = await req(HP, "POST", "/tools/page-a/start", { reassignPort: false });
  check(ps2.data?.port === PP, "★ 静态工具重启仍复用同一端口（存储可持久）");
  await req(HP, "POST", "/tools/page-a/stop");
  await wait(700);

  // --- 手动丢进 toolbox/ 的目录要能自动接管 ---
  const dl = await req(HP, "GET", "/tools");
  const dp = dl.data.find((x) => x.id === "dropped-page");
  check(!!dp && !dp.error, "★ 手动丢进 toolbox/ 的网页目录不再报「缺少 manifest.json」");
  check(
    dp?.type === "static" && dp?.html === "index.html",
    "被自动识别为本地网页工具",
  );
  check(
    fs.existsSync(path.join(droppedDir, "manifest.json")),
    "并自动生成了 manifest.json（之后可在编辑器里改）",
  );

  const dps = await req(HP, "POST", "/tools/dropped-page/start", { reassignPort: false });
  check(
    dps.data?.status === "running" && typeof dps.data?.port === "number",
    "自动接管的工具能正常启动（" + dps.data?.port + "）",
  );
  const dpHtml = await reqRaw(dps.data.port, "/");
  check(
    dpHtml.status === 200 && dpHtml.body.includes("dropped"),
    "页面能被正常托管",
  );
  await req(HP, "POST", "/tools/dropped-page/stop");
  await wait(600);

  // 真正的空目录：错误信息要能指路
  const ne = dl.data.find((x) => x.id === "no-entry");
  check(ne?.status === "error", "既无 manifest 也无 index.html 的目录仍报错");
  check(
    /index\.html/.test(ne?.error || ""),
    "错误信息指明原因并给出解决办法",
  );

  // --- 残留数据清理（被放弃端口上的 localStorage / IndexedDB）---
  // 前置：上面 local-c 被「重新分配」过端口，P_EXT 应已自动登记为残留
  const res0 = await req(HP, "GET", "/residuals");
  check(
    (res0.data || []).some((r) => Number(r.port) === P_EXT),
    "★ 用户确认重新分配后，旧端口自动登记为残留",
  );
  const extRec = (res0.data || []).find((r) => Number(r.port) === P_EXT);
  check(
    extRec?.state === "busy-external",
    "残留清单带状态：被外部程序占用 → busy-external（界面据此说明何时清理）",
  );
  check(
    extRec?.toolId === "local-c" && typeof extRec?.at === "number",
    "残留清单带上来源工具与登记时间",
  );

  // 放弃清理：从清单移除，不再尝试
  const P_IGNORE = await findFreePort();
  await req(HP, "POST", "/residuals", { toolId: "ignore-me", port: P_IGNORE });
  const listBefore = await req(HP, "GET", "/residuals");
  const rec = (listBefore.data || []).find((r) => Number(r.port) === P_IGNORE);
  check(rec?.state === "ready", "空闲的残留端口状态为 ready（下次扫描即清理）");
  await req(HP, "POST", "/residuals/ignore", { port: P_IGNORE });
  const listAfter = await req(HP, "GET", "/residuals");
  check(
    !(listAfter.data || []).some((r) => Number(r.port) === P_IGNORE),
    "★ 放弃清理后该条从清单移除",
  );

  // P_EXT 此刻仍被「平台外程序」占着 → sweep 必须跳过，不能去抢
  const sweepBusy = await req(HP, "POST", "/residuals/sweep");
  check(
    !(sweepBusy.data || []).includes(P_EXT),
    "★ 仍被占用的残留端口会被跳过（不抢别人的端口）",
  );

  // 登记一个空闲的残留端口，验证完整清理流程
  const P_LEFTOVER = await findFreePort();
  await req(HP, "POST", "/residuals", { toolId: "old-tool", port: P_LEFTOVER });
  const sweep1 = await req(HP, "POST", "/residuals/sweep");
  check((sweep1.data || []).includes(P_LEFTOVER), "★ 空闲的残留端口被占下，等界面加载清理页");

  const cleanPage = await reqRaw(P_LEFTOVER, "/");
  check(
    cleanPage.status === 200 && /text\/html/.test(cleanPage.type || ""),
    "该端口上提供的是清理页（HTML）",
  );
  check(
    cleanPage.body.includes("indexedDB") && cleanPage.body.includes("localStorage"),
    "清理页会清 localStorage 与 IndexedDB",
  );

  const doneRes = await req(P_LEFTOVER, "POST", "/__residual-done", { ok: true });
  check(doneRes.ok === true, "清理页可回报完成");
  await wait(600);

  const resAfter = await req(HP, "GET", "/residuals");
  check(
    !(resAfter.data || []).some((r) => Number(r.port) === P_LEFTOVER),
    "★ 清理完成后残留记录被移除",
  );
  check(!(await portListening(P_LEFTOVER)), "★ 清理完成后临时服务关闭、端口释放");

  // 冷却中的残留：普通扫描跳过，只有用户手动「立即清理」才强制重试
  const resCool = await req(HP, "GET", "/residuals");
  const coolRec = (resCool.data || []).find((r) => Number(r.port) === P_COOLDOWN);
  check(coolRec?.state === "cooldown", "冷却中的残留状态为 cooldown（界面会显示倒计时）");
  const sweepNormal = await req(HP, "POST", "/residuals/sweep", { force: false });
  check(!(sweepNormal.data || []).includes(P_COOLDOWN), "普通扫描会跳过冷却中的条目");
  const sweepForce = await req(HP, "POST", "/residuals/sweep", { force: true });
  check(
    (sweepForce.data || []).includes(P_COOLDOWN),
    "★ 手动「立即清理」可强制重试冷却中的条目",
  );
  await req(P_COOLDOWN, "POST", "/__residual-done", { ok: true });
  await wait(500);
  const resCooled = await req(HP, "GET", "/residuals");
  check(
    !(resCooled.data || []).some((r) => Number(r.port) === P_COOLDOWN),
    "强制重试成功后该条也被移除",
  );

  // ============ 第二轮：宿主重启后端口仍复用 ============
  await stopHost();
  HP = await startHost();
  hostProc.__port = HP;
  const a4 = await req(HP, "POST", "/tools/local-a/start", { reassignPort: false });
  check(a4.data?.port === P_SHARED, "★ 宿主重启后端口仍复用同一值（存储 origin 稳定）");
  await req(HP, "POST", "/tools/local-a/stop");
  await wait(500);
} finally {
  await stopHost();
  try {
    extServer.close();
  } catch {}
  await fsp.rm(DATA, { recursive: true, force: true }).catch(() => {});
}

/* ---------------------------------------------------------------- 结果 */

console.log(`\n通过 ${ok.length} 项`);
ok.forEach((t) => console.log("  ✓ " + t));
if (bad.length) {
  console.log(`\n失败 ${bad.length} 项`);
  bad.forEach((t) => console.log("  ✗ " + t));
  process.exit(1);
}
console.log("\n全部通过");
