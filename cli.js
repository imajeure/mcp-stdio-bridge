#!/usr/bin/env node
/**
 * mcp-stdio-bridge/cli.js — command-line entry.
 *
 * Usage:
 *   mcp-stdio-bridge [flags] -- <command> [args...]
 *
 * Everything after `--` is the stdio MCP server to wrap. Flags configure the
 * HTTP side. Environment variables provide defaults; flags override them.
 */

import { startBridge } from "./index.js";

const USAGE = `mcp-stdio-bridge — wrap a stdio MCP server and serve it over Streamable HTTP

Usage:
  mcp-stdio-bridge [flags] -- <command> [args...]

Flags:
  --host <host>          Bind address (default 127.0.0.1, env BRIDGE_HOST)
  --port <port>          Port (default 3000, env PORT)
  --path <path>          MCP mount path (default /mcp, env BRIDGE_PATH)
  --allow-origin <orig>  CORS allowed origin; repeatable (default *, env BRIDGE_ALLOW_ORIGIN)
  --token <token>        Require this bearer token on the MCP endpoint (env BRIDGE_TOKEN)
  -h, --help             Show this help

Examples:
  mcp-stdio-bridge -- npx -y @modelcontextprotocol/server-everything
  mcp-stdio-bridge --port 8080 --path /mcp --token "$TOK" -- my-mcp-server --flag
`;

function parseArgs(argv) {
  const sep = argv.indexOf("--");
  const flags = sep === -1 ? argv : argv.slice(0, sep);
  const cmd = sep === -1 ? [] : argv.slice(sep + 1);

  const opts = { allowedOrigins: [] };
  for (let i = 0; i < flags.length; i++) {
    const a = flags[i];
    switch (a) {
      case "--host": opts.host = flags[++i]; break;
      case "--port": opts.port = parseInt(flags[++i], 10); break;
      case "--path": opts.mountPath = flags[++i]; break;
      case "--allow-origin": opts.allowedOrigins.push(flags[++i]); break;
      case "--token": opts.token = flags[++i]; break;
      case "-h":
      case "--help": opts.help = true; break;
      default:
        console.error("Unknown flag: " + a + "\n");
        opts.help = true;
    }
  }
  opts._command = cmd;
  return opts;
}

function resolveConfig(opts) {
  const [command, ...args] = opts._command;
  const allowedOrigins =
    opts.allowedOrigins.length > 0
      ? opts.allowedOrigins
      : (process.env.BRIDGE_ALLOW_ORIGIN ? process.env.BRIDGE_ALLOW_ORIGIN.split(",").map((s) => s.trim()) : ["*"]);

  return {
    command,
    args,
    host: opts.host ?? process.env.BRIDGE_HOST ?? "127.0.0.1",
    port: opts.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 3000),
    mountPath: opts.mountPath ?? process.env.BRIDGE_PATH ?? "/mcp",
    allowedOrigins,
    token: opts.token ?? process.env.BRIDGE_TOKEN ?? null,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    process.exit(opts._command.length === 0 ? 1 : 0);
  }

  const config = resolveConfig(opts);
  if (!config.command) {
    console.error("error: no wrapped command given (expected `-- <command> [args...]`)\n");
    process.stdout.write(USAGE);
    process.exit(1);
  }

  const bridge = await startBridge(config);

  const shutdown = async (signal) => {
    console.error(`[mcp-stdio-bridge] ${signal} received, shutting down`);
    try { await bridge.stop(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[mcp-stdio-bridge] fatal:", err && err.message ? err.message : err);
  process.exit(1);
});
