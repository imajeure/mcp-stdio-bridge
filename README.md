# mcp-stdio-bridge

[![CI](https://github.com/imajeure/mcp-stdio-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/imajeure/mcp-stdio-bridge/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@imajeure/mcp-stdio-bridge.svg)](https://www.npmjs.com/package/@imajeure/mcp-stdio-bridge) ![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg) ![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)

**Wrap any stdio MCP server and serve it over Streamable HTTP — with a
self-healing supervisor in front of it.**

Lots of [Model Context Protocol](https://modelcontextprotocol.io) servers only
speak **stdio**. To reach one over the network you put an HTTP bridge in front.
Tools like `supergateway` and `mcp-proxy` do that translation well — but if the
wrapped process crashes or wedges, your endpoint just goes dark.

`mcp-stdio-bridge` does the translation **and keeps the thing alive**:

- 🔁 **Auto-respawn.** If the wrapped child exits, the HTTP listener stays up and
  the child is respawned underneath it — a single crash never drops your endpoint.
- 🚦 **Readiness, not just liveness.** `/ready` runs a real `tools/list` round-trip
  to the child, so "up" means "actually answering," not "the port is open."
- 🩺 **Hang detection.** A readiness-gated `systemd` watchdog catches *hangs*
  (a process that's alive but not responding) — something a plain `Restart=` can
  never do, because a hung process never exits.
- 🪜 **Gentle → hard escalation.** Repeated crashes in a short window stop the
  watchdog heartbeat so your process manager does a clean full restart.

That resilience layer is the whole point — it's the difference between "I wrapped
my MCP server" and "I wrapped my MCP server and it stays up."

```
   external client ──HTTP──▶  mcp-stdio-bridge  ──stdio──▶  your MCP server
                                     │
                                     └─ supervisor: respawn + /ready + watchdog
```

## Quickstart

```sh
npm install

# Wrap the canonical "everything" MCP server and serve it on :3000/mcp
node cli.js -- npx -y @modelcontextprotocol/server-everything
# (after publishing: `npx @imajeure/mcp-stdio-bridge -- npx -y @modelcontextprotocol/server-everything`)
```

In another terminal:

```sh
curl -s localhost:3000/healthz   # {"status":"ok", ...}
curl -s localhost:3000/ready     # {"ready":true}  (real tools/list round-trip to the child)
```

Point any MCP HTTP client at `http://localhost:3000/mcp` and it will see the
wrapped server's tools, resources, and prompts transparently.

### See the self-heal in action

```sh
# Kill the wrapped child out from under the bridge:
pkill -f server-everything

# The supervisor respawns it; within a couple of seconds /ready is green again
# and the HTTP endpoint never went away:
curl -s localhost:3000/ready     # {"ready":true}
```

## Usage

```
mcp-stdio-bridge [flags] -- <command> [args...]
```

Everything after `--` is the stdio MCP server to wrap. Flags configure the HTTP
side; environment variables provide defaults and flags override them.

| Flag | Env | Default | Purpose |
|---|---|---|---|
| `--host <host>` | `BRIDGE_HOST` | `127.0.0.1` | Bind address. Keep it loopback unless something else gates access. |
| `--port <port>` | `PORT` | `3000` | Port to listen on. |
| `--path <path>` | `BRIDGE_PATH` | `/mcp` | MCP mount path. `/healthz` + `/ready` are derived alongside it. |
| `--allow-origin <o>` | `BRIDGE_ALLOW_ORIGIN` | `*` | CORS allowed origin(s); flag is repeatable, env is comma-separated. |
| `--token <token>` | `BRIDGE_TOKEN` | — | If set, require `Authorization: Bearer <token>` on the MCP endpoint. |

### Programmatic API

```js
import { startBridge } from "@imajeure/mcp-stdio-bridge";

const bridge = await startBridge({
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-everything"],
  port: 3000,
  mountPath: "/mcp",
  token: process.env.BRIDGE_TOKEN, // optional
});
// ... later ...
await bridge.stop();
```

## systemd

The bridge sends `READY=1` only after `/ready` first passes and a `WATCHDOG=1`
heartbeat **gated on readiness**, so a hung bridge stops beating and gets
restarted. A matching unit:

```ini
[Service]
Type=notify
NotifyAccess=all
WatchdogSec=30
Restart=on-failure
RestartSec=3
TimeoutStartSec=120
ExecStart=/usr/bin/node /path/to/mcp-stdio-bridge/cli.js -- npx -y @modelcontextprotocol/server-everything
```

When `NOTIFY_SOCKET` is unset (local dev), the notifier is a no-op and the same
code runs unchanged. The supervisor primitives live in `smart-bridge.js`
(zero dependencies, Node built-ins only).

## Testing

```sh
npm test   # node --test
```

Unit tests cover the supervisor logic (respawn ladder, escalation, readiness-gated
heartbeat, `/ready` route). The integration test wraps the real
`@modelcontextprotocol/server-everything`, completes an MCP `initialize` over
HTTP, lists its tools, then **kills the child and asserts the bridge respawns it
and recovers**.

## License

Apache-2.0
