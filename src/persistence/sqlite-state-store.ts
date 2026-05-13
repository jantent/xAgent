import type { SharedStateSnapshot } from "../core/shared-state.js";
import type { IStateStore } from "./contracts.js";
import type { SqliteHandle } from "./sqlite-database.js";
import { deserializeStateSnapshot, serializeStateSnapshot } from "./state-serialization.js";

export class SqliteStateStore implements IStateStore {
  readonly kind = "sqlite";

  constructor(private readonly handle: SqliteHandle) {}

  async load(): Promise<SharedStateSnapshot | null> {
    const results = this.handle.db.exec(
      "SELECT snapshot FROM runtime_state_snapshots WHERE state_key = 'default' LIMIT 1"
    );
    if (!results.length || !results[0]!.values.length) {
      return null;
    }

    const raw = results[0]!.values[0]![0] as string;
    return deserializeStateSnapshot(raw);
  }

  async save(snapshot: SharedStateSnapshot): Promise<void> {
    const json = serializeStateSnapshot(snapshot);
    const now = new Date().toISOString();
    this.handle.db.run(
      "INSERT OR REPLACE INTO runtime_state_snapshots (state_key, snapshot, updated_at) VALUES (?, ?, ?)",
      ["default", json, now]
    );
    this.handle.flush();
  }

  async ping(): Promise<boolean> {
    try {
      this.handle.db.exec("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
}
