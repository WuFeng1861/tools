/**
 * p2p-chat 的浏览器回归测试（`npm run test:p2p`）
 *
 * 为什么要跑真实浏览器：
 *   Trystero 会把发送方传入的 metadata **再包一层**再交给 onMessage：
 *       发送  act.send(data, { metadata: { name:'a.pdf' } })
 *       接收  onMessage(data, { peerId, metadata: { name:'a.pdf' } })
 *   一旦直接读 meta.name，文件名会静默退化成 "file"、图片也会被当成普通文件，
 *   而 TypeScript / 语法检查**完全发现不了**。这里的桩模块严格复刻这一形态。
 *
 * 覆盖场景：
 *   A 下载回退路径（无「另存为」）· 文件名 · 重复点击提示
 *   B 「另存为」真实写入进度 · 取消提示 · 权限被拒时自动回退
 *   C 接收进度卡片（文件名 / 百分比 / 完成态）
 *   D 拖拽文件发送
 *
 * 注意：场景 D 只能证明「工具自身的 HTML5 拖拽逻辑正确」。真机上拖拽能否抵达网页
 * 取决于 `src-tauri/tauri.conf.json` → `dragDropEnabled`（默认 true 时 Tauri 会在
 * 窗口 HWND 上注册 COM IDropTarget，把文件拖放从系统层截走，网页收不到 drop）。
 *
 * 依赖：playwright-core + 一份 Chromium（托管工作区里已有）。
 *   可用 CHROME_EXE 指定浏览器可执行文件。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.resolve(ROOT, process.argv[2] || "example/p2p-chat");
const PORT = Number(process.env.P2P_TEST_PORT || 4390);

// ---------------------------------------------------------------- playwright
function loadPlaywright() {
  const bases = [
    process.env.PW_CORE_DIR,
    "C:/Users/WuFeng/.workbuddy/binaries/node/workspace/",
    ROOT + "/",
  ].filter(Boolean);
  for (const base of bases) {
    try {
      return createRequire(base.endsWith("/") ? base : base + "/")("playwright-core");
    } catch {
      /* 换下一个 */
    }
  }
  throw new Error("找不到 playwright-core，请设置 PW_CORE_DIR 指向装有它的目录");
}

/** 在 ms-playwright 下挑一个可用的 Chromium（版本号与 playwright-core 未必对得上） */
function findChrome() {
  if (process.env.CHROME_EXE && fs.existsSync(process.env.CHROME_EXE)) return process.env.CHROME_EXE;
  const roots = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "ms-playwright"), process.env.HOME && path.join(process.env.HOME, "AppData/Local/ms-playwright")].filter(Boolean);
  const subs = [
    "chrome-win64/chrome.exe", "chrome-win/chrome.exe",
    "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  ];
  const found = [];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    for (const d of fs.readdirSync(r).filter((x) => /^chromium-\d+$/.test(x))) {
      for (const s of subs) {
        const p = path.join(r, d, s);
        if (fs.existsSync(p)) found.push({ p, v: Number(d.split("-")[1]) });
      }
    }
  }
  found.sort((a, b) => b.v - a.v);
  return found[0]?.p; // 找不到就交给 playwright 自己解析
}

const { chromium } = loadPlaywright();

/** 顶掉 esm.sh 上的 Trystero，但严格复刻它的投递形态 */
const STUB = `
const rooms = [];
export function joinRoom(cfg, roomId){
  const actions = {};
  const room = {
    roomId,
    makeAction(name){
      const a = { name, sent: [], onMessage:null, onProgress:null, onReceiveProgress:null, onReceive:null };
      a.send = (data, opts) => { a.sent.push({ data, opts }); return Promise.resolve(); };
      actions[name] = a;
      return a;
    },
    leave(){ window.__left = true; }
  };
  window.__room = room; window.__actions = actions;
  return room;
}
export const selfId = 'self';
export const defaultRelayUrls = [];
`;

// ---------------------------------------------------------------- 静态服务
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".svg": "image/svg+xml", ".css": "text/css" };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const f = path.join(DIR, p);
  if (!f.startsWith(DIR) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
  res.end(fs.readFileSync(f));
});

// ---------------------------------------------------------------- 断言
let pass = 0, fail = 0;
const check = (ok, name, extra) => {
  if (ok) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra ? "  → " + extra : "")); }
};

await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
const browser = await chromium.launch({ executablePath: findChrome() });
const routeStub = (page) => page.route("https://esm.sh/**", (route) => route.fulfill({
  status: 200, contentType: "text/javascript",
  headers: { "access-control-allow-origin": "*" }, body: STUB,
}));

const join = async (page, room) => {
  await page.fill("#nameInput", "测试员");
  await page.fill("#roomInput", room);
  await page.click("#enterBtn");
  await page.waitForFunction(() => !!window.__actions?.file, null, { timeout: 15000 });
};
/** 复刻 Trystero 的真实投递形态：metadata 被包在 meta.metadata 里 */
const deliver = (page, bytes, meta) => page.evaluate(([b, m]) => {
  window.__actions.file.onMessage(new Uint8Array(b), { peerId: "peer-1", metadata: m });
}, [bytes, meta]);

// ============================================================
// 场景 A：下载回退路径（环境不支持「另存为」）+ 文件名 + 重复点击
// ============================================================
try {
  const ctxA = await browser.newContext();
  await ctxA.addInitScript(() => {
    // 不能用 delete：该 API 挂在 Window.prototype 上，delete 删不掉
    window.showSaveFilePicker = undefined;
    window.__dl = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { window.__dl.push(this.download); };
    void orig;
  });
  const page = await ctxA.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await routeStub(page);
  await page.goto(`http://127.0.0.1:${PORT}/`);
  check((await page.evaluate(() => typeof window.showSaveFilePicker)) === "undefined",
    "环境准备：已模拟为不支持「另存为」");
  await join(page, "testroom");

  await deliver(page, [1, 2, 3, 4, 5, 6, 7, 8],
    { name: "季度报告 v2.pdf", mime: "application/pdf", size: 123456, kind: "file", from: "同事" });
  await page.waitForSelector(".row .bubble.file");
  const fname = await page.textContent(".row .bubble.file .fname");
  check(fname === "季度报告 v2.pdf", "★ 收到的文件显示真实文件名（不再叫 file）", "实际=" + JSON.stringify(fname));
  check((await page.textContent(".row .bubble.file .fsize")) === "120.6 KB", "文件大小正确显示");

  await deliver(page, [137, 80, 78, 71, 13, 10, 26, 10],
    { name: "截图.png", mime: "image/png", size: 8, kind: "image", from: "同事" });
  await page.waitForSelector(".row .bubble.imgb img");
  check((await page.locator(".row .bubble.imgb img").count()) === 1, "★ 图片按图片渲染（kind 判定修复）");

  const dlBtn = page.locator(".row .bubble.file .fdl").first();
  check((await dlBtn.count()) === 1, "文件气泡内有「下载」按钮");
  check((await dlBtn.getAttribute("download")) === null, "下载按钮不是裸 <a download>（改为可反馈的按钮）");

  await dlBtn.click();
  await page.waitForFunction(() => window.__dl.length === 1, null, { timeout: 5000 });
  check((await page.evaluate(() => window.__dl[0])) === "季度报告 v2.pdf",
    "★ 实际下载文件名正确（原 bug 是 file）");
  await page.waitForFunction(() => document.querySelector(".row .bubble.file .dltxt")?.textContent.includes("已保存"),
    null, { timeout: 5000 });
  check((await page.textContent(".row .bubble.file .dltxt")).includes("已保存到下载目录"),
    "★ 保存完成后有明确状态提示");
  check((await page.textContent(".row .bubble.file .fdl")).includes("已保存"), "下载按钮进入「✓ 已保存」状态");
  const t1 = await page.textContent("#toast");
  check(t1.includes("季度报告 v2.pdf") && t1.includes("下载目录"), "保存完成弹出提示（含文件名与位置）", t1);

  await dlBtn.click();
  await page.waitForFunction(() => window.__dl.length === 2, null, { timeout: 5000 });
  check(true, "★ 重复点击可再次保存");
  check((await page.textContent("#toast")).includes("季度报告 v2.pdf"), "★ 重复点击仍有提示（不再静默）");

  await page.evaluate(() => {
    const b = document.querySelector(".row .bubble.file .fdl");
    b.click(); b.click();
  });
  await page.waitForTimeout(80);
  check(/正在保存|已保存/.test(await page.textContent("#toast")), "连点两次给出明确反馈");
  check(errors.length === 0, "场景 A 无页面报错", errors.join(" | "));
} catch (e) {
  fail++; console.log("FAIL 场景 A 异常：" + e.message);
}

// ============================================================
// 场景 B：支持「另存为」→ 真实写入进度 + 取消提示 + 自动回退
// ============================================================
try {
  const ctxB = await browser.newContext();
  await ctxB.addInitScript(() => {
    window.__wrote = 0; window.__closed = false; window.__picked = [];
    let mode = "ok";
    window.__setPickerMode = (m) => { mode = m; };
    window.showSaveFilePicker = async (opts) => {
      window.__picked.push(opts && opts.suggestedName);
      if (mode === "abort") { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
      if (mode === "denied") { const e = new Error("denied"); e.name = "SecurityError"; throw e; }
      return {
        name: "另存为-报告.pdf",
        createWritable: async () => ({
          // 故意放慢，让分片写入进度可被观测到
          write: async (blob) => { window.__wrote += blob.size; await new Promise((r) => setTimeout(r, 130)); },
          close: async () => { window.__closed = true; },
          abort: async () => { window.__aborted = true; },
        }),
      };
    };
  });
  const page = await ctxB.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await routeStub(page);
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await join(page, "roomB");

  const SZ = 5_000_000;
  await page.evaluate((n) => {
    window.__actions.file.onMessage(new Uint8Array(n), {
      peerId: "p2", metadata: { name: "大包.zip", mime: "application/zip", size: n, kind: "file" },
    });
  }, SZ);
  await page.waitForSelector(".row .bubble.file .fdl");
  await page.click(".row .bubble.file .fdl");

  let sawMid = null;
  for (let i = 0; i < 200; i++) {
    const t = ((await page.textContent(".row .bubble.file .dltxt").catch(() => "")) || "").trim();
    if (/^\d+%$/.test(t) && t !== "100%") { sawMid = t; break; }
    await page.waitForTimeout(30);
  }
  check(!!sawMid, "★ 另存为路径显示真实写入进度", "观测到=" + sawMid);
  await page.waitForFunction(() => document.querySelector(".row .bubble.file .dltxt")?.textContent.includes("已保存"),
    null, { timeout: 10000 });
  check((await page.evaluate(() => window.__wrote)) === SZ, "★ 全部字节写入完成",
    "wrote=" + (await page.evaluate(() => window.__wrote)));
  check((await page.evaluate(() => window.__closed)) === true, "文件流已正常关闭");
  check((await page.evaluate(() => window.__picked[0])) === "大包.zip", "另存为对话框带上了正确文件名");
  check((await page.textContent("#toast")).includes("另存为-报告.pdf"), "另存为完成后提示使用实际保存名");

  await page.evaluate(() => window.__setPickerMode("abort"));
  await page.click(".row .bubble.file .fdl");
  await page.waitForTimeout(200);
  check((await page.textContent("#toast")).includes("已取消保存"), "★ 取消保存有明确提示");

  await page.evaluate(() => {
    window.__dl2 = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { window.__dl2.push(this.download); };
    void orig;
    window.__setPickerMode("denied");
  });
  await page.click(".row .bubble.file .fdl");
  await page.waitForFunction(() => window.__dl2.length === 1, null, { timeout: 5000 });
  check((await page.evaluate(() => window.__dl2[0])) === "大包.zip", "★ 另存为不可用时自动回退且文件名正确");
  check(errors.length === 0, "场景 B 无页面报错", errors.join(" | "));

  // ---- 场景 C：接收进度卡片 ----
  await page.evaluate(() => {
    window.__actions.file.onReceiveProgress(0.32, {
      peerId: "p3", metadata: { name: "超大电影.mp4", mime: "video/mp4", size: 10_000_000, kind: "file" },
    });
  });
  await page.waitForSelector(".xcard");
  check((await page.textContent(".xcard .xname")) === "超大电影.mp4", "★ 接收进度卡片显示文件名");
  check((await page.textContent(".xcard .xstat")) === "32%", "★ 接收进度百分比正确");
  const w = await page.evaluate(() => {
    const t = document.querySelector(".xcard .xbar").getBoundingClientRect().width;
    const f = document.querySelector(".xcard .xbar i").getBoundingClientRect().width;
    return t ? f / t : 0;
  });
  check(Math.abs(w - 0.32) < 0.03, "★ 进度条填充比例正确（实测计算样式）", "比例=" + w.toFixed(3));

  await page.evaluate(() => {
    const M = { name: "超大电影.mp4", mime: "video/mp4", size: 10_000_000, kind: "file" };
    window.__actions.file.onMessage(new Uint8Array(4), { peerId: "p3", metadata: M });
  });
  await page.waitForFunction(() => document.querySelector(".xcard .xstat")?.textContent.includes("已接收"),
    null, { timeout: 5000 });
  check(true, "接收完成后卡片显示「已接收」");

  await page.evaluate(() => {
    document.querySelectorAll(".xcard").forEach((e) => e.remove());
    const M = { name: "小.txt", mime: "text/plain", size: 3, kind: "file" };
    window.__actions.file.onReceiveProgress(1, { peerId: "p4", metadata: M });
    window.__actions.file.onMessage(new Uint8Array(3), { peerId: "p4", metadata: M });
  });
  await page.waitForTimeout(250);
  check((await page.locator(".xcard").count()) === 0, "小文件不弹多余进度卡片");

  // ============================================================
  // 场景 D：拖拽发送
  // 注意：这一条只能证明「工具自己的 HTML5 拖拽逻辑是对的」。
  // 真机里拖拽能否抵达网页，取决于 Tauri 的 dragDropEnabled —— 默认开启时
  // Tauri 会在窗口 HWND 上注册 COM IDropTarget，把文件拖放从系统层截走，
  // 网页永远收不到 drop。所以 src-tauri/tauri.conf.json 必须设为 false。
  // ============================================================
  // 先造一个在线成员：peers 是在收到 hello 时才建立的（onPeerJoin 只负责回 hello），
  // 否则 send 会走「未送出（无人在线）」分支，测不到真正的发送
  await page.evaluate(() => {
    window.__actions.hello.onMessage({ name: "小王" }, { peerId: "peer-9", metadata: {} });
  });
  await page.waitForTimeout(100);

  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File([new Uint8Array([1, 2, 3, 4])], "拖进来的文件.txt", { type: "text/plain" }));
    return d;
  });
  await page.dispatchEvent("body", "dragenter", { dataTransfer: dt });
  check(await page.evaluate(() => document.getElementById("drop").classList.contains("on")),
    "拖入时显示「松开即可发送文件」遮罩");

  await page.dispatchEvent("body", "dragover", { dataTransfer: dt });
  await page.dispatchEvent("body", "drop", { dataTransfer: dt });

  await page.waitForFunction(() => window.__actions.file.sent.length >= 1, null, { timeout: 5000 });
  const sent = await page.evaluate(() => {
    const s = window.__actions.file.sent[0];
    return { name: s.opts.metadata.name, kind: s.opts.metadata.kind, size: s.opts.metadata.size };
  });
  check(sent.name === "拖进来的文件.txt", "★ 拖拽的文件按真实文件名发出", JSON.stringify(sent));
  check(sent.kind === "file" && sent.size === 4, "拖拽文件的类型与大小正确", JSON.stringify(sent));
  check(!(await page.evaluate(() => document.getElementById("drop").classList.contains("on"))),
    "松手后遮罩收起");
  check(errors.length === 0, "场景 D 无页面报错", errors.join(" | "));
} catch (e) {
  fail++; console.log("FAIL 场景 B/C/D 异常：" + e.message);
}

console.log("\n===== " + pass + "/" + (pass + fail) + " 通过 =====");
await browser.close();
srv.close();
process.exit(fail ? 1 : 0);
