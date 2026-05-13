import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import initSqlJs, { type Database } from "sql.js";

/**
 * sql.js 是内存数据库，需要手动 export() → writeFileSync() 持久化。
 * SqliteHandle 封装了数据库实例和 flush 操作。
 */
export interface SqliteHandle {
  readonly db: Database;
  /** 将内存数据库写回磁盘 */
  flush(): void;
  /** 关闭数据库并写回磁盘 */
  close(): void;
}

export async function openSqliteDatabase(dbPath: string): Promise<SqliteHandle> {
  const SQL = await initSqlJs();
  const dir = dirname(dbPath);
  if (dir) {
    mkdirSync(dir, { recursive: true });
  }

  const existing = existsSync(dbPath) ? readFileSync(dbPath) : undefined;
  const db = existing ? new SQL.Database(existing) : new SQL.Database();

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

  const flush = (): void => {
    writeFileSync(dbPath, db.export());
  };

  const close = (): void => {
    flush();
    db.close();
  };

  return { db, flush, close };
}
