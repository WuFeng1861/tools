// 正则测试工具 —— 后端
const { ToolServer } = require(process.env.TOOL_RUNTIME);

const server = new ToolServer({
  dir: __dirname,
  routes: {
    "/api/test": (req, res, body) => {
      let input = {};
      try {
        input = JSON.parse(body || "{}");
      } catch {
        /* 忽略 */
      }
      const { pattern, flags, text } = input;
      if (!pattern) return res.json({ ok: true, matches: [] });
      try {
        const re = new RegExp(pattern, flags || "g");
        const matches = [];
        if (flags.includes("g")) {
          for (const m of text.matchAll(re)) {
            matches.push({ match: m[0], index: m.index });
          }
        } else {
          const m = text.match(re);
          if (m) matches.push({ match: m[0], index: m.index });
        }
        res.json({ ok: true, count: matches.length, matches });
      } catch (e) {
        res.json({ ok: false, error: String(e) });
      }
    },
  },
});

server.start();
