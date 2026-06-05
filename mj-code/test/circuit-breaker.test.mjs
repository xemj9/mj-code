import test from "node:test";
import assert from "node:assert/strict";

import { CircuitBreaker, createCircuitSnapshot } from "../src/lib/circuit-breaker.mjs";

test("circuit breaker opens, half-opens, and closes after a successful trial", () => {
  const breaker = new CircuitBreaker("provider:openai:models", {
    failureThreshold: 2,
    cooldownMs: 20,
    halfOpenMaxRequests: 1,
  });

  assert.equal(breaker.beforeRequest(1).allowed, true);
  breaker.onFailure(2, {});
  assert.equal(breaker.beforeRequest(3).allowed, true);
  const opened = breaker.onFailure(4, {});
  assert.equal(opened.snapshot.state, "open");

  const blocked = breaker.beforeRequest(5);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.state, "open");
  assert.ok(blocked.retryAt >= 22);

  const halfOpenGate = breaker.beforeRequest(30);
  assert.equal(halfOpenGate.allowed, true);
  assert.equal(halfOpenGate.state, "half_open");

  const closed = breaker.onSuccess(31, { latencyMs: 12 });
  assert.equal(closed.snapshot.state, "closed");
  assert.equal(closed.snapshot.failureStreak, 0);
});

test("circuit breaker re-opens when half-open trial fails", () => {
  const breaker = new CircuitBreaker("provider:openai:stream", {
    failureThreshold: 1,
    cooldownMs: 10,
    halfOpenMaxRequests: 1,
  });

  breaker.beforeRequest(1);
  breaker.onFailure(2, {});
  assert.equal(breaker.getSnapshot().state, "open");

  breaker.beforeRequest(20);
  const reopened = breaker.onFailure(21, {});
  assert.equal(reopened.snapshot.state, "open");
  assert.ok(reopened.snapshot.cooldownUntilMs > 21);
});

test("circuit breaker escalates cooldown and tracks blocked requests in snapshots", () => {
  const breaker = new CircuitBreaker("web:fallback:search", {
    failureThreshold: 1,
    cooldownMs: 10,
    maxCooldownMs: 50,
    halfOpenMaxRequests: 1,
  });

  breaker.beforeRequest(1);
  const opened = breaker.onFailure(2, { error: "network_error" });
  assert.equal(opened.snapshot.state, "open");
  assert.equal(opened.snapshot.cooldownMs, 10);
  assert.equal(opened.snapshot.lastOpenReason, "failure_threshold");

  const blocked = breaker.beforeRequest(3);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.snapshot.blockedRequests, 1);

  breaker.beforeRequest(20);
  const reopened = breaker.onFailure(21, { error: "retry_failed" });
  assert.equal(reopened.snapshot.state, "open");
  assert.equal(reopened.snapshot.openCount, 2);
  assert.equal(reopened.snapshot.cooldownMs, 20);
});

test("createCircuitSnapshot normalizes partial snapshot input", () => {
  const snapshot = createCircuitSnapshot("mcp:server:invoke", {
    cooldownMs: 25,
  }, {
    state: "open",
    openCount: 2,
    blockedRequests: 3,
    lastOpenReason: "failure_threshold",
  });

  assert.equal(snapshot.key, "mcp:server:invoke");
  assert.equal(snapshot.state, "open");
  assert.equal(snapshot.openCount, 2);
  assert.equal(snapshot.blockedRequests, 3);
  assert.equal(snapshot.cooldownMs, 25);
  assert.equal(snapshot.lastOpenReason, "failure_threshold");
});
