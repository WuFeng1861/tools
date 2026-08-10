// 工具后端入口（Node.js）
// 约定：监听 process.env.TOOL_PORT，GET / 返回 index.html。
// 使用运行时帮助库（src-tauri/resources/runtime/runtime.js），开箱即用。
const { ToolServer } = require(process.env.TOOL_RUNTIME);

const server = new ToolServer({
  dir: __dirname,
  routes: {
    "/api/ping": (req, res, body) =>
      res.json({ ok: true, msg: "pong", time: Date.now() }),
  },
});

server.start();
