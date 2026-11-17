"use strict";

// Manual UI fixtures. No system clock command is executed by these servers.
const { createServer } = require("../app");
const { inspectSystem } = require("../system");
const { SOURCES } = require("../clock");
const crypto = require("node:crypto");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

function sample(canSync = true) {
  return {
    id: crypto.randomUUID(), measuredAt: Date.now(), elapsedMs: 1234, options: { samples: 1, timeoutMs: 500 },
    results: SOURCES.filter(s => ["aliyun", "cloudflare"].includes(s.id)).map(s => ({ ...s, ok: true, offsetMs: 150, rttMs: 20, uncertaintyMs: 12, samplesOk: 1, samplesRequested: 1 })),
    consensus: { kind: "ntp", offsetMs: 150, uncertaintyMs: 12, canSync, usedIds: canSync ? ["aliyun", "cloudflare"] : [], providerCount: 2, agreedProviders: canSync ? 2 : 0, reason: canSync ? "多个独立 NTP 时间源一致，可执行校准。" : "时间源未形成共识，请检查网络。" },
  };
}
const linux = () => inspectSystem("linux", { linuxFacts: { root: false, gnuDate: true, datePath: "/usr/bin/date", pkexecPath: "/usr/bin/pkexec", distribution: "Linux（界面测试）" } });
const servers = [
  [3931, createServer({ platform: "linux", inspectHost: linux, detectClock: async () => sample(), setClock: async () => { throw new Error("桌面管理员授权不可用（界面测试，未修改时间）"); } })],
  [3932, createServer({ platform: "unknown", detectClock: async () => sample() })],
  [3933, createServer({ platform: "linux", inspectHost: linux, detectClock: async () => sample(false) })],
];
const offline = http.createServer(async (req, res) => {
  if (req.url === "/api/config") { res.writeHead(503); return res.end("unavailable"); }
  const files = { "/": ["index.html", "text/html"], "/styles.css": ["styles.css", "text/css"], "/front.js": ["front.js", "text/javascript"], "/theme.js": ["theme.js", "text/javascript"] };
  const file = files[req.url];
  if (!file) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": `${file[1]}; charset=utf-8` });
  res.end(await fs.readFile(path.join(__dirname, "..", file[0])));
});
servers.push([3934, offline]);
for (const [port, server] of servers) server.listen(port, "127.0.0.1", () => console.log(`UI fixture http://127.0.0.1:${port} (no clock changes)`));
