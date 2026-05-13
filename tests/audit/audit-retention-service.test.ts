import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import initSqlJs from "sql.js";

import { AuditRetentionService } from "../../src/audit/audit-retention-service.js";
import type { SqliteHandle } from "../../src/persistence/sqlite-database.js";
import { createTestLogger } from "../helpers/logger.js";

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

test("AuditRetentionService 会清理 SQLite 旧审计并按 source 限制数量", async () => {
  const handle = await createInMemoryHandle();
  try {
    const insert = (source: string, occurredAt: string): void => {
      handle.db.run(
        "INSERT INTO audit_events (source, cycle_id, occurred_at, payload) VALUES (?, ?, ?, ?)",
        [source, "cycle-1", occurredAt, JSON.stringify({ timestamp: occurredAt, source })]
      );
    };
    insert("actions", "2000-01-01T00:00:00.000Z");
    insert("actions", "2999-01-01T00:00:00.000Z");
    insert("actions", "2999-01-02T00:00:00.000Z");
    insert("actions", "2999-01-03T00:00:00.000Z");
    insert("phases", "2000-01-01T00:00:00.000Z");

    const service = new AuditRetentionService({
      policy: {
        enabled: true,
        retentionDays: 30,
        maxEventsPerSource: 2
      },
      auditDir: "/tmp/unused",
      cleanFileAudit: false,
      sqliteHandle: handle,
      logger: createTestLogger()
    });

    const results = await service.runOnce();
    const counts = handle.db.exec("SELECT source, COUNT(*) FROM audit_events GROUP BY source")[0]?.values ?? [];
    const actionDates = handle.db.exec(
      "SELECT occurred_at FROM audit_events WHERE source = 'actions' ORDER BY occurred_at"
    )[0]?.values.map((row) => row[0]) ?? [];

    assert.equal(results[0]?.backend, "sqlite");
    assert.equal(results[0]?.deleted, 3);
    assert.deepEqual(counts, [["actions", 2]]);
    assert.deepEqual(actionDates, ["2999-01-02T00:00:00.000Z", "2999-01-03T00:00:00.000Z"]);
  } finally {
    handle.close();
  }
});

test("AuditRetentionService 会清理 JSONL 审计文件", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "xagent-audit-retention-"));
  try {
    await writeFile(
      path.join(tmpDir, "actions.jsonl"),
      [
        JSON.stringify({ timestamp: "2000-01-01T00:00:00.000Z", message: "old" }),
        JSON.stringify({ timestamp: "2999-01-01T00:00:00.000Z", message: "new-1" }),
        JSON.stringify({ timestamp: "2999-01-02T00:00:00.000Z", message: "new-2" }),
        JSON.stringify({ timestamp: "2999-01-03T00:00:00.000Z", message: "new-3" })
      ].join("\n") + "\n",
      "utf8"
    );
    await writeFile(
      path.join(tmpDir, "errors.jsonl"),
      JSON.stringify({ timestamp: "2000-01-01T00:00:00.000Z", message: "old-error" }) + "\n",
      "utf8"
    );

    const service = new AuditRetentionService({
      policy: {
        enabled: true,
        retentionDays: 30,
        maxEventsPerSource: 2
      },
      auditDir: tmpDir,
      cleanFileAudit: true,
      logger: createTestLogger()
    });

    const results = await service.runOnce();
    const actions = (await readFile(path.join(tmpDir, "actions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message: string });
    const errors = await readFile(path.join(tmpDir, "errors.jsonl"), "utf8");

    assert.equal(results[0]?.backend, "file");
    assert.equal(results[0]?.deleted, 3);
    assert.deepEqual(actions.map((event) => event.message), ["new-2", "new-3"]);
    assert.equal(errors, "");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
