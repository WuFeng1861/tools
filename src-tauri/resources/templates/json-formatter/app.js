// JSON 格式化工具 —— 后端
const { ToolServer } = require(process.env.TOOL_RUNTIME);

function formatJson(text) {
  return JSON.stringify(JSON.parse(text), null, 2);
}
function minifyJson(text) {
  return JSON.stringify(JSON.parse(text));
}

const server = new ToolServer({
  dir: __dirname,
  routes: {
    "/api/process": (req, res, body) => {
      let input = {};
      try {
        input = JSON.parse(body || "{}");
      } catch {
        /* 忽略 */
      }
      const action = input.action || "format";
      try {
        let result;
        if (action === "minify") result = minifyJson(input.json);
        else if (action === "format") result = formatJson(input.json);
        else result = formatJson(input.json);
        res.json({ ok: true, result });
      } catch (e) {
        res.json({ ok: false, error: String(e) });
      }
    },
  },
});

server.start();
