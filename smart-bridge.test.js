/**
 * index.test.js — unit tests for the self-heal primitives.
 *
 * Run: `node --test`
 *
 * Scope: the in-process logic (respawn ladder, escalation, readiness-gated
 * heartbeat, /ready route, notifier idempotency). The sd_notify *wire* and the
 * real systemd watchdog semantics are NOT exercised here — there is no way to
 * receive an AF_UNIX datagram in pure Node either — they are validated against
 * a live systemd unit. These tests run with no NOTIFY_SOCKET, so the notifier's
 * send() is a no-op and nothing shells out.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createNotifier,
  startWatchdog,
  makeReadyRoute,
  withTimeout,
  TimeoutError,
  ChildSupervisor,
} from "./smart-bridge.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}

// ── withTimeout ──────────────────────────────────────────────────────────────
test("withTimeout resolves a fast promise", async () => {
  assert.equal(await withTimeout(Promise.resolve(42), 1000, "fast"), 42);
});

test("withTimeout rejects a hanging promise with TimeoutError", async () => {
  // Keep the event loop alive while withTimeout's unref'd timer fires. In production
  // withTimeout always runs alongside the live server/watchdog; in isolation the
  // unref'd timeout would otherwise let an empty loop drain before it fires (Node <=22),
  // which the node:test runner reports as "Promise resolution is still pending".
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      () => withTimeout(new Promise(() => {}), 20, "slow"),
      (e) => e instanceof TimeoutError
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

// ── ChildSupervisor: gentle respawn ──────────────────────────────────────────
test("ChildSupervisor: a single child exit gently respawns, no escalation", async () => {
  let spawns = 0;
  let onClose = null;
  let escalated = false;
  const sup = new ChildSupervisor({
    name: "t",
    gentleDelayMs: 5,
    escalateAfter: 2,
    gentleWindowMs: 10_000,
    selfReport: () => {},
    spawn: async (cb) => {
      spawns++;
      onClose = cb;
      return { id: spawns };
    },
  });
  sup.onEscalate(() => {
    escalated = true;
  });

  await sup.start();
  assert.equal(spawns, 1);
  assert.ok(sup.isHealthy());

  onClose(); // simulate child exit
  assert.equal(sup.isHealthy(), false); // immediately not healthy
  await delay(20); // allow gentle respawn
  assert.equal(spawns, 2);
  assert.ok(sup.isHealthy());
  assert.equal(escalated, false);
});

// ── ChildSupervisor: escalation ──────────────────────────────────────────────
test("ChildSupervisor: 2 exits within the window escalate; no respawn after", async () => {
  let spawns = 0;
  let onClose = null;
  let escalations = 0;
  const sup = new ChildSupervisor({
    name: "t",
    gentleDelayMs: 5,
    escalateAfter: 2,
    gentleWindowMs: 10_000,
    selfReport: () => {},
    spawn: async (cb) => {
      spawns++;
      onClose = cb;
      return {};
    },
  });
  sup.onEscalate(() => {
    escalations++;
  });

  await sup.start(); // spawn 1
  onClose(); // failure 1 → gentle respawn
  await delay(15); // spawn 2
  onClose(); // failure 2 → escalate
  await delay(15);

  assert.equal(escalations, 1);
  assert.equal(sup.escalated, true);
  const spawnsAtEscalation = spawns;
  await delay(15);
  assert.equal(spawns, spawnsAtEscalation); // no respawn once escalated
});

// ── startWatchdog: readiness-gated heartbeat ─────────────────────────────────
test("startWatchdog: beats only when /ready passes; READY once; halt stops beats", async () => {
  let ready = 0;
  let beats = 0;
  // Mock mirrors createNotifier's contract: notifyReady is idempotent.
  const notifier = (() => {
    let sent = false;
    return {
      notifyReady: () => {
        if (!sent) {
          sent = true;
          ready++;
        }
      },
      beat: () => {
        beats++;
      },
    };
  })();

  let pass = true;
  const wd = startWatchdog({
    notifier,
    readyCheck: async () => {
      if (!pass) throw new Error("not ready");
    },
    intervalMs: 10,
    selfReport: () => {},
  });

  await delay(35);
  assert.equal(ready, 1, "READY=1 sent exactly once across many passes");
  assert.ok(beats >= 2, "beating while ready");

  const beatsBeforeHang = beats;
  pass = false; // simulate a hang
  await delay(35);
  assert.equal(beats, beatsBeforeHang, "no WATCHDOG=1 while /ready fails (gating)");

  pass = true; // recover
  await delay(25);
  assert.ok(beats > beatsBeforeHang, "beating resumes after recovery");

  const beatsBeforeHalt = beats;
  wd.halt(); // escalation lever
  await delay(25);
  assert.equal(beats, beatsBeforeHalt, "halt stops beats permanently");
  assert.equal(wd.isHalted(), true);
  wd.stop();
});

// ── createNotifier ───────────────────────────────────────────────────────────
test("createNotifier: disabled without NOTIFY_SOCKET; READY idempotent; reports once", () => {
  const saved = process.env.NOTIFY_SOCKET;
  delete process.env.NOTIFY_SOCKET;
  try {
    const events = [];
    const n = createNotifier({ selfReport: (e) => events.push(e) });
    assert.equal(n.enabled, false);
    n.notifyReady();
    n.notifyReady(); // idempotent
    n.beat(); // no-op, must not throw
    assert.equal(events.filter((e) => e.event === "ready").length, 1);
  } finally {
    if (saved === undefined) delete process.env.NOTIFY_SOCKET;
    else process.env.NOTIFY_SOCKET = saved;
  }
});

// ── makeReadyRoute ───────────────────────────────────────────────────────────
test("makeReadyRoute: 200 on pass, 503 on fail", async () => {
  const ok = mockRes();
  await makeReadyRoute(async () => {})({}, ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body, { ready: true });

  const bad = mockRes();
  await makeReadyRoute(async () => {
    throw new Error("nope");
  })({}, bad);
  assert.equal(bad.statusCode, 503);
  assert.equal(bad.body.ready, false);
});
