import assert from "node:assert/strict";
import test from "node:test";

import initSqlJs from "sql.js";

import { SqliteAuditLogger } from "../../src/audit/sqlite-audit-logger.js";
import { SqliteAuditReader } from "../../src/audit/sqlite-audit-reader.js";
import type { SqliteHandle } from "../../src/persistence/sqlite-database.js";
import { SqliteStateStore } from "../../src/persistence/sqlite-state-store.js";
import { SystemMode } from "../../src/domain/models.js";
import { createOpenAction, createPositionRecord, createStateSnapshot } from "../helpers/factories.js";

async function createInMemoryHandle(): Promise<SqliteHandle> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE IF NOT EXISTS runtime_state_snapshots (
    state_key TEXT PRIMARY KEY,
    snapshot TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    cycle_id TEXT,
    occurred_at TEXT NOT NULL,
    payload TEXT NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_occurred_at ON audit_events(occurred_at DESC)`);

  return {
    db,
    flush: () => undefined,
    close: () => db.close()
  };
}

test("SqliteStateStore 完成 save/load round-trip", async () => {
  const handle = await createInMemoryHandle();
  try {
    const store = new SqliteStateStore(handle);
    const snapshot = createStateSnapshot({
      availableCapitalSol: 8.6,
      activePositions: [createPositionRecord({ walletAddress: "wallet-1" })],
      allPositions: [createPositionRecord({ walletAddress: "wallet-1" })]
    });

    const empty = await store.load();
    assert.equal(empty, null);

    await store.save(snapshot);
    const loaded = await store.load();

    assert.deepEqual(loaded, snapshot);
    assert.equal(await store.ping(), true);
  } finally {
    handle.close();
  }
});

test("SqliteAuditLogger 写入审计事件，SqliteAuditReader 读取", async () => {
  const handle = await createInMemoryHandle();
  try {
    const logger = new SqliteAuditLogger(handle);
    const reader = new SqliteAuditReader(handle);

    await logger.startCycle("cycle-1", { foo: "bar" });

    const action = createOpenAction();
    await logger.recordAction("cycle-1", action, {
      actionId: action.id,
      type: action.type,
      status: "success",
      message: "ok",
      txSignatures: ["tx-1"],
      latencyMs: 5
    });

    await logger.finishCycle("cycle-1", {
      cycleId: "cycle-1",
      mode: SystemMode.NORMAL,
      scanned: 10,
      plans: 2,
      approved: 1,
      executed: 1,
      failed: 0,
      actions: [],
      results: [],
      startedAt: new Date(),
      finishedAt: new Date()
    });

    const events = await reader.readRecent(10);
    assert.equal(events.length, 3);
    assert.equal(events[0]?.source, "cycles");
    assert.ok(events[0]?.timestamp);
    assert.equal(typeof events[0]?.payload.cycleId, "string");
  } finally {
    handle.close();
  }
});

test("SqliteAuditLogger recordError 写入错误事件", async () => {
  const handle = await createInMemoryHandle();
  try {
    const logger = new SqliteAuditLogger(handle);
    const reader = new SqliteAuditReader(handle);

    await logger.recordError("cycle-1", new Error("test error"), { phase: "discovery" });

    const events = await reader.readRecent(5);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.source, "errors");
    assert.equal((events[0]?.payload.error as Record<string, unknown>)?.message, "test error");
  } finally {
    handle.close();
  }
});

test("SqliteAuditReader queryEvents 支持筛选、搜索和分页", async () => {
  const handle = await createInMemoryHandle();
  try {
    const logger = new SqliteAuditLogger(handle);
    const reader = new SqliteAuditReader(handle);

    const action = createOpenAction();
    await logger.recordAction("cycle-2", action, {
      actionId: action.id,
      type: "close",
      status: "success",
      message: "closed RKC",
      txSignatures: [],
      latencyMs: 5
    });
    await logger.recordError("cycle-1", new Error("provider timeout"));
    await logger.recordAction("cycle-1", action, {
      actionId: action.id,
      type: "open",
      status: "success",
      message: "opened BONK",
      txSignatures: [],
      latencyMs: 5
    });

    const events = await reader.queryEvents({
      source: "actions",
      cycleId: "cycle-1",
      q: "bonk",
      limit: 10
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.source, "actions");
    assert.equal(events[0]?.payload.cycleId, "cycle-1");

    const paged = await reader.queryEvents({ limit: 1, offset: 1 });
    assert.equal(paged.length, 1);
  } finally {
    handle.close();
  }
});
