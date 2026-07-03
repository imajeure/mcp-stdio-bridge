# mcp-stdio-bridge

[![CI](https://github.com/imajeure/mcp-stdio-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/imajeure/mcp-stdio-bridge/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@imajeure/mcp-stdio-bridge.svg)](https://www.npmjs.com/package/@imajeure/mcp-stdio-bridge) [![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/imajeure/mcp-stdio-bridge/badge)](https://scorecard.dev/viewer/?uri=github.com/imajeure/mcp-stdio-bridge) ![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg) ![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)

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

## Client and transport compatibility

`mcp-stdio-bridge` exposes the wrapped stdio server as an MCP Streamable HTTP
endpoint. The table below separates what is covered by this repository's tests
from client integrations that should work through the same transport but still
need client-specific verification.

| Client or transport | Status | Notes |
|---|---|---|
| MCP TypeScript SDK `StreamableHTTPClientTransport` | Verified | Covered by the integration test in `bridge.test.js`: it initializes over HTTP, lists tools, calls the wrapped `echo` tool, and verifies recovery after the child process is killed. |
| Generic Streamable HTTP MCP clients | Expected | Point the client at `http://<host>:<port><path>`; the default local URL is `http://localhost:3000/mcp`. Use `--token` / `BRIDGE_TOKEN` if the endpoint is exposed beyond loopback. |
| Browser-based MCP clients | Expected with origin configuration | Set `--allow-origin` / `BRIDGE_ALLOW_ORIGIN` to the exact browser origin. Requests with an unlisted `Origin` are rejected with `403`; non-browser requests without an `Origin` header are allowed. |
| stdio-only MCP clients | Not directly supported | This bridge converts a stdio server into Streamable HTTP. A client that only launches stdio servers should run the original stdio server directly instead of this bridge. |
| SSE-only MCP clients | Not supported | The bridge serves Streamable HTTP, not the older SSE transport. Use a client that supports Streamable HTTP. |

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
| `--allow-origin <o>` | `BRIDGE_ALLOW_ORIGIN` | `*` | Allowed origin(s) — sets the CORS header **and** enforces a server-side Origin check (DNS-rebinding guard). Repeatable flag, comma-separated env. The default `*` allows any origin; set specific origins to enforce. |
| `--token <token>` | `BRIDGE_TOKEN` | — | If set, require `Authorization: Bearer <token>` on the MCP endpoint. |

### Security

The bridge binds to loopback by default. Two opt-in controls harden a networked
deployment — both off by default to keep the transparent-proxy case frictionless:

- **Bearer token** (`--token` / `BRIDGE_TOKEN`): when set, every MCP request must
  send `Authorization: Bearer <token>` or gets **401** (before any session work).
- **Origin enforcement** (`--allow-origin` / `BRIDGE_ALLOW_ORIGIN`): per the MCP
  spec, the `Origin` header is validated as DNS-rebinding protection. The default
  `*` allows any origin; set specific origins and a request carrying a disallowed
  `Origin` gets **403** (before auth). Requests with no `Origin` header
  (non-browser clients) are always allowed.

For any non-local exposure, run the bridge as a least-privileged user behind an
authenticated reverse proxy / tunnel.

### Programmatic API

```js
import { startBridge } from "@imajeure/mcp-stdio-bridge";

const bridge = await startBridge({
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-everything"],
  port: 3000,
  mountPath: "/mcp",
  token: process.env.BRIDGE_TOKEN, // optional
  allowedOrigins: ["https://app.example.com"], // optional; default ["*"]
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
heartbeat, `/ready` route) and `Origin` validation. The integration test wraps the
real `@modelcontextprotocol/server-everything`, completes an MCP `initialize` over
HTTP, lists its tools, then **kills the child and asserts the bridge respawns it
and recovers**; a further test confirms a request with a disallowed `Origin` is
rejected with **403**.

## License

Apache-2.0
