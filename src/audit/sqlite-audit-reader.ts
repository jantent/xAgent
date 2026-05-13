import type { AuditEventQuery, AuditEventRecord, IAuditReader } from "./contracts.js";
import type { SqliteHandle } from "../persistence/sqlite-database.js";

export class SqliteAuditReader implements IAuditReader {
  constructor(private readonly handle: SqliteHandle) {}

  async readRecent(limit = 30): Promise<AuditEventRecord[]> {
    return this.queryEvents({ limit });
  }

  async queryEvents(query: AuditEventQuery = {}): Promise<AuditEventRecord[]> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    const source = normalizeText(query.source);
    const cycleId = normalizeText(query.cycleId);
    const search = normalizeText(query.q);
    const limit = Math.max(0, Math.trunc(query.limit ?? 30));
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));

    if (source) {
      where.push("source = ?");
      params.push(source);
    }
    if (cycleId) {
      where.push("cycle_id = ?");
      params.push(cycleId);
    }
    if (query.since) {
      where.push("occurred_at >= ?");
      params.push(query.since);
    }
    if (query.until) {
      where.push("occurred_at <= ?");
      params.push(query.until);
    }
    if (search) {
      const pattern = `%${search}%`;
      where.push("(source LIKE ? OR cycle_id LIKE ? OR payload LIKE ?)");
      params.push(pattern, pattern, pattern);
    }

    const whereClause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const results = this.handle.db.exec(
      `SELECT source, occurred_at, payload FROM audit_events${whereClause} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    if (!results.length || !results[0]!.values.length) {
      return [];
    }

    return results[0]!.values.map((row) => ({
      source: row[0] as string,
      timestamp: row[1] as string,
      payload: JSON.parse(row[2] as string) as Record<string, unknown>
    }));
  }
}

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
