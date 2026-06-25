/**
 * bridge.test.js — real integration + self-heal tests for the bridge.
 *
 * Wraps the canonical @modelcontextprotocol/server-everything stdio server
 * (a devDependency), then:
 *   1. completes an MCP initialize over HTTP and lists the wrapped tools,
 *   2. kills the child process and confirms the supervisor auto-respawns it and
 *      the bridge recovers — the headline self-heal behaviour, and
 *   3. checks the Origin (DNS-rebinding) guard rejects a disallowed origin.
 *
 * Run: `npm test`
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startBridge, createBridge, isOriginAllowed } from "./index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// The wrapped stdio MCP server: run server-everything's entry directly with node
// (its default transport is stdio). Resolved relative to this file's node_modules.
const EVERYTHING_ENTRY = fileURLToPath(
  new URL("./node_modules/@modelcontextprotocol/server-everything/dist/index.js", import.meta.url)
);

let bridge;
let baseUrl;

async function newClient() {
  const client = new Client({ name: "bridge-test", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}${bridge.mountPath}`));
  await client.connect(transport); // performs the MCP initialize handshake over HTTP
  return client;
}

before(async () => {
  bridge = await startBridge({
    command: process.execPath,
    args: [EVERYTHING_ENTRY, "stdio"],
    host: "127.0.0.1",
    port: 0,
    mountPath: "/mcp",
    gentleDelayMs: 300, // respawn quickly so the self-heal test is fast
    escalateAfter: 10, // a single kill must not escalate to a hard restart
    watchdogIntervalMs: 60_000, // keep the watchdog out of the test's way
  });
  baseUrl = `http://127.0.0.1:${bridge.port}`;
}, { timeout: 30_000 });

after(async () => {
  if (bridge) await bridge.stop();
});

test("MCP initialize over HTTP + lists the wrapped server's tools", { timeout: 30_000 }, async () => {
  const client = await newClient();
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0, "wrapped server advertised tools");
    assert.ok(tools.some((t) => t.name === "echo"), "server-everything 'echo' tool forwarded");

    // Exercise an actual tool call through the bridge.
    const res = await client.callTool({ name: "echo", arguments: { message: "via-bridge" } });
    const text = res.content.map((c) => c.text).join("\n");
    assert.match(text, /via-bridge/);
  } finally {
    await client.close();
  }
});

test("self-heal: killing the child auto-respawns it and the bridge recovers", { timeout: 30_000 }, async () => {
  // Confirm healthy + capture the live child pid.
  assert.ok(bridge.supervisor.isHealthy(), "healthy before kill");
  const pid1 = bridge.getChildPid();
  assert.ok(pid1, "have a child pid");

  // Kill the wrapped child out from under the bridge.
  process.kill(pid1);

  // Wait for the supervisor's gentle respawn: a fresh, healthy child with a new pid.
  let pid2 = pid1;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await delay(150);
    if (bridge.supervisor.isHealthy() && bridge.getChildPid() && bridge.getChildPid() !== pid1) {
      pid2 = bridge.getChildPid();
      break;
    }
  }
  assert.notEqual(pid2, pid1, "child was respawned with a new pid");
  assert.ok(bridge.supervisor.isHealthy(), "healthy again after respawn");

  // Readiness recovers (offline tools/list round-trip to the new child).
  await assert.doesNotReject(() => bridge.readyCheck(), "/ready recovers after respawn");

  // And the bridge still serves MCP over HTTP end-to-end on a fresh session.
  const client = await newClient();
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "echo"), "tools list works again after self-heal");
  } finally {
    await client.close();
  }
});

// ── Origin validation (DNS-rebinding guard) ──────────────────────────────────
test("isOriginAllowed: wildcard allows all, otherwise the list is enforced", () => {
  assert.equal(isOriginAllowed("http://anything.example.com", ["*"]), true, "wildcard allows any origin");
  assert.equal(isOriginAllowed(undefined, ["https://app.example.com"]), true, "no Origin (non-browser) is allowed");
  assert.equal(isOriginAllowed("null", ["https://app.example.com"]), false, "opaque null is rejected");
  assert.equal(isOriginAllowed("https://app.example.com", ["https://app.example.com"]), true, "listed origin allowed");
  assert.equal(isOriginAllowed("http://evil.example.com", ["https://app.example.com"]), false, "unlisted origin rejected");
});

test("Origin guard: a disallowed Origin gets 403, before auth, without spawning the child", async () => {
  // createBridge builds the app without starting the supervisor, so the guard
  // short-circuits before any child access — no wrapped server needed.
  const { app } = createBridge({
    command: process.execPath,
    allowedOrigins: ["http://localhost:9999"],
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example.com" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(res.status, 403);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
