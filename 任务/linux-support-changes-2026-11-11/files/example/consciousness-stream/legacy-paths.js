"use strict";
const path = require("path");
const os = require("os");

function legacyPaths({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const roots = platform === "win32" ? [env.APPDATA].filter(Boolean)
    : platform === "linux" ? [env.XDG_CONFIG_HOME || path.join(home, ".config")] : [];
  const override = env.CONSCIOUSNESS_STREAM_LEGACY_FILE;
  return [...new Set([
    override && path.isAbsolute(override) ? override : null,
    ...roots.flatMap((root) => ["即意", "consciousness-stream"].map((app) => path.join(root, app, "consciousness-stream.json"))),
  ].filter(Boolean))];
}

module.exports = { legacyPaths };
