/**
 * 工具运行时帮助库 —— 由宿主注入（环境变量 TOOL_RUNTIME 指向本目录）。
 *
 * 工具作者在 app.js 中：
 *   const { ToolServer } = require(process.env.TOOL_RUNTIME);
 *
 * 提供：
 *  - 静态文件服务（默认 serve 工具目录下的 index.html 与资源）
 *  - 简易路由（自定义 JSON API，挂在工具自己的端口上）
 *  - res.json() 便捷响应
 *
 * 工具的 Node 进程也可以完全不使用本库：约定只需监听
 * process.env.TOOL_PORT，且 GET / 返回 html 指定的文件即可。
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
};

class ToolServer {
  /**
   * @param {object} opts
   * @param {string}  opts.dir    工具目录（__dirname），静态资源根
   * @param {Record<string, Function>} opts.routes 自定义路由:
   *        { "/api/x": (req, res, body) => void }
   * @param {string}  [opts.index] 入口 HTML，默认 index.html
   */
  constructor(opts = {}) {
    this.dir = path.resolve(opts.dir || ".");
    this.routes = opts.routes || {};
    this.index = opts.index || "index.html";
    this.server = null;
  }

  /** 添加一条路由 */
  route(pathname, handler) {
    this.routes[pathname] = handler;
    return this;
  }

  _readBody(req) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
    });
  }

  _serveStatic(urlPath, res) {
    let rel;
    try {
      rel = decodeURIComponent(urlPath);
    } catch {
      rel = urlPath;
    }
    if (rel === "/") rel = "/" + this.index;

    // 防目录穿越：规范化后必须仍在 dir 内
    const file = path.normalize(path.join(this.dir, rel));
    if (file !== this.dir && !file.startsWith(this.dir + path.sep)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      });
      res.end(buf);
    });
  }

  _handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const routeKey = url.pathname;
    const handler = this.routes[routeKey];

    if (handler) {
      this._readBody(req).then((body) => {
        try {
          handler(req, res, body);
        } catch (e) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(String(e && e.stack ? e.stack : e));
        }
      });
      return;
    }

    if (req.method === "GET") {
      this._serveStatic(url.pathname, res);
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  }

  /**
   * 启动 HTTP 服务。
   * @param {number} [port] 端口，默认取 process.env.TOOL_PORT
   * @returns {Promise<number>} 实际端口
   */
  start(port) {
    const target = port || Number(process.env.TOOL_PORT || 0);
    this.server = http.createServer((req, res) => {
      res.json = (data, status = 200) => {
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(data));
      };
      this._handle(req, res);
    });
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(target, "127.0.0.1", () => {
        const actual = this.server.address().port;
        console.log(`[tool] listening on http://127.0.0.1:${actual}`);
        resolve(actual);
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = { ToolServer };
