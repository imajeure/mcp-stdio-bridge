/**
 * mcp-stdio-bridge/index.js — programmatic API.
 * =============================================
 * Wrap ANY stdio MCP server and serve it over the MCP Streamable HTTP
 * transport, with a self-healing supervisor in front of it:
 *
 *   external client  ──HTTP──▶  this bridge  ──stdio──▶  wrapped MCP server
 *                                   │
 *                                   └─ ChildSupervisor: auto-respawn on crash,
 *                                      readiness-gated /ready + systemd watchdog
 *
 * The headline feature is resilience: if the wrapped child crashes, the HTTP
 * listener stays up and the child is respawned underneath it; if it *hangs*,
 * the readiness-gated watchdog lets a process manager restart the whole bridge.
 * See ./smart-bridge.js for the supervisor internals (zero dependencies).
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ChildSupervisor,
  createNotifier,
  startWatchdog,
  makeReadyRoute,
  withTimeout,
  selfReport,
} from "./smart-bridge.js";

export const VERSION = "1.0.0";
const DEFAULT_READY_TIMEOUT_MS = 2500;

// The /healthz + /ready prefix is derived from the mount path (drop a trailing
// /mcp), so health routes sit alongside the MCP endpoint. routePrefix overrides.
export function deriveRoutePrefix(mountPath, override) {
  if (override !== undefined && override !== null) return override;
  return mountPath.replace(/\/mcp$/, "");
}

/**
 * Build the bridge as an Express app + supervisor, without listening.
 * Returns { app, supervisor, readyCheck, getChildPid, mountPath, routePrefix }.
 */
export function createBridge(options = {}) {
  const {
    command,
    args = [],
    childEnv = process.env,
    mountPath = "/mcp",
    routePrefix,
    allowedOrigins = ["*"],
    token = null,
    clientName = "mcp-stdio-bridge",
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    escalateAfter,
    gentleWindowMs,
    gentleDelayMs,
    selfReport: report = selfReport,
  } = options;

  if (!command) {
    throw new Error("mcp-stdio-bridge: a wrapped command is required");
  }

  const MOUNT = mountPath;
  const PREFIX = deriveRoutePrefix(MOUNT, routePrefix);

  // The supervisor owns the stdio child. Its spawn thunk builds an MCP Client
  // over a stdio transport to the wrapped command and records the live
  // transport so we can expose the child pid (used by the self-heal test).
  let currentTransport = null;
  const supervisor = new ChildSupervisor({
    name: command,
    selfReport: report,
    ...(escalateAfter !== undefined ? { escalateAfter } : {}),
    ...(gentleWindowMs !== undefined ? { gentleWindowMs } : {}),
    ...(gentleDelayMs !== undefined ? { gentleDelayMs } : {}),
    spawn: async (onClose) => {
      const client = new Client({ name: clientName, version: VERSION }, { capabilities: {} });
      const transport = new StdioClientTransport({
        command,
        args,
        env: childEnv,
        stderr: "inherit",
      });
      transport.onclose = onClose;
      await client.connect(transport);
      currentTransport = transport;
      const { tools } = await client.listTools();
      console.error(`[mcp-stdio-bridge] connected to "${command}"; tools: ${tools.map((t) => t.name).join(", ") || "(none)"}`);
      return client;
    },
  });

  // Readiness: an offline tools/list round-trip to the child, raced with a
  // timeout so a hung child can't wedge /ready or the watchdog.
  const readyCheck = () =>
    withTimeout(supervisor.getClient().listTools(), readyTimeoutMs, "bridge /ready");

  // A fresh proxy Server per HTTP session; every request is forwarded to the
  // current child via the supervisor (transparent to the wrapped server's
  // surface: tools, resources, prompts).
  function createProxyServer() {
    const server = new Server(
      { name: "mcp-stdio-bridge", version: VERSION },
      { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );
    const child = () => supervisor.getClient();

    server.setRequestHandler(ListToolsRequestSchema, async () => child().listTools());
    server.setRequestHandler(CallToolRequestSchema, async (req) => child().callTool(req.params));

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      try { return await child().listResources(); } catch { return { resources: [] }; }
    });
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      try { return await child().listResourceTemplates(); } catch { return { resourceTemplates: [] }; }
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => child().readResource(req.params));

    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      try { return await child().listPrompts(); } catch { return { prompts: [] }; }
    });
    server.setRequestHandler(GetPromptRequestSchema, async (req) => child().getPrompt(req.params));

    return server;
  }

  const sessions = new Map();
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  const originHeader = allowedOrigins.includes("*") ? "*" : allowedOrigins.join(", ");
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", originHeader);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, Authorization");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    next();
  });

  app.options(MOUNT, (_req, res) => res.sendStatus(204));

  // Liveness + readiness (unauthenticated operational probes).
  app.get(`${PREFIX}/healthz`, (_req, res) => {
    res.json({
      status: supervisor.isHealthy() ? "ok" : "child_disconnected",
      version: VERSION,
      childConnected: supervisor.isHealthy(),
      sessions: sessions.size,
      uptime: Math.floor(process.uptime()),
    });
  });
  app.get(`${PREFIX}/ready`, makeReadyRoute(readyCheck));

  // Optional bearer auth, enforced on the MCP endpoint before any session work.
  function requireAuth(req, res, next) {
    if (!token) return next();
    const header = req.headers["authorization"] || "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!provided || provided !== token) {
      return res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
    }
    next();
  }

  app.post(MOUNT, requireAuth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    try {
      if (sessionId && sessions.has(sessionId)) {
        const { transport } = sessions.get(sessionId);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      if (!sessionId && req.body?.method === "initialize") {
        const proxyServer = createProxyServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server: proxyServer });
            console.error("[mcp-stdio-bridge] session created: " + sid);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.has(sid)) {
            sessions.delete(sid);
            console.error("[mcp-stdio-bridge] session closed: " + sid);
          }
        };
        await proxyServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32600, message: "Bad request: missing or invalid session" }, id: req.body?.id ?? null });
    } catch (err) {
      console.error("[mcp-stdio-bridge] POST error:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: req.body?.id ?? null });
      }
    }
  });

  app.get(MOUNT, requireAuth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && sessions.has(sessionId)) {
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res);
      return;
    }
    res.status(400).json({ error: "Invalid or missing session" });
  });

  app.delete(MOUNT, requireAuth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && sessions.has(sessionId)) {
      const { transport, server } = sessions.get(sessionId);
      await transport.close();
      await server.close();
      sessions.delete(sessionId);
      console.error("[mcp-stdio-bridge] session deleted: " + sessionId);
      res.sendStatus(204);
      return;
    }
    res.status(404).json({ error: "Session not found" });
  });

  app.locals.mountPath = MOUNT;
  app.locals.routePrefix = PREFIX;

  return {
    app,
    supervisor,
    readyCheck,
    getChildPid: () => (currentTransport ? currentTransport.pid : null),
    sessions,
    mountPath: MOUNT,
    routePrefix: PREFIX,
  };
}

/**
 * Start the bridge: spawn the child, listen, and run the watchdog. Returns the
 * createBridge object plus { httpServer, watchdog, port, stop() }.
 */
export async function startBridge(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const report = options.selfReport ?? selfReport;

  const bridge = createBridge(options);

  await bridge.supervisor.start();

  const notifier = createNotifier({ selfReport: report });
  let watchdog;
  bridge.supervisor.onEscalate(() => { if (watchdog) watchdog.halt(); });

  const httpServer = await new Promise((resolve, reject) => {
    const s = bridge.app.listen(port, host, () => resolve(s));
    s.on("error", reject); // surface EADDRINUSE etc. instead of hanging
  });
  const boundPort = httpServer.address().port;

  watchdog = startWatchdog({
    notifier,
    readyCheck: bridge.readyCheck,
    intervalMs: options.watchdogIntervalMs ?? 15_000,
    selfReport: report,
  });

  console.error(`[mcp-stdio-bridge] v${VERSION} listening on ${host}:${boundPort}${bridge.mountPath} → wrapping "${options.command}"`);

  return {
    ...bridge,
    httpServer,
    watchdog,
    port: boundPort,
    async stop() {
      watchdog.stop();
      // Prevent the supervisor from respawning while we tear down.
      bridge.supervisor.escalated = true;
      const pid = bridge.getChildPid();
      if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
      httpServer.closeAllConnections?.();
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}
