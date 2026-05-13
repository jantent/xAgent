import { promises as fs } from "node:fs";
import path from "node:path";

import type { SqliteHandle } from "../persistence/sqlite-database.js";
import type { Logger } from "../utils/logger.js";

export interface AuditRetentionPolicy {
  enabled?: boolean;
  retentionDays?: number;
  maxEventsPerSource?: number;
  cleanupIntervalMs?: number;
}

export interface AuditRetentionResult {
  backend: "file" | "sqlite";
  deleted: number;
  sources: Record<string, number>;
  filesRewritten?: number;
}

interface AuditRetentionServiceOptions {
  policy: AuditRetentionPolicy;
  auditDir: string;
  cleanFileAudit: boolean;
  sqliteHandle?: SqliteHandle;
  logger: Logger;
}

const AUDIT_FILES = ["actions.jsonl", "errors.jsonl", "phases.jsonl", "cycles.jsonl", "llm.jsonl"];
const DEFAULT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class AuditRetentionService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: AuditRetentionServiceOptions) {}

  start(): void {
    if (!this.isEnabled() || this.timer) {
      return;
    }

    void this.runOnce().catch((error) => {
      this.options.logger.warn("审计日志清理失败", { error });
    });

    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        this.options.logger.warn("审计日志清理失败", { error });
      });
    }, this.cleanupIntervalMs());
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<AuditRetentionResult[]> {
    if (!this.isEnabled() || this.running) {
      return [];
    }

    this.running = true;
    try {
      const results: AuditRetentionResult[] = [];
      if (this.options.sqliteHandle) {
        results.push(this.cleanupSqlite());
      }
      if (this.options.cleanFileAudit) {
        results.push(await this.cleanupFiles());
      }

      const deleted = results.reduce((sum, result) => sum + result.deleted, 0);
      if (deleted > 0) {
        this.options.logger.info("审计日志清理完成", {
          deleted,
          results
        });
      }
      return results;
    } finally {
      this.running = false;
    }
  }

  private cleanupSqlite(): AuditRetentionResult {
    const handle = this.options.sqliteHandle!;
    const before = countRows(handle, "SELECT COUNT(*) FROM audit_events");
    const cutoff = this.cutoffIso();
    const sourcesBefore = this.sqliteSourceCounts();

    if (cutoff) {
      handle.db.run("DELETE FROM audit_events WHERE occurred_at < ?", [cutoff]);
    }

    const maxEventsPerSource = normalizePositiveInteger(this.options.policy.maxEventsPerSource);
    if (maxEventsPerSource !== undefined) {
      const sources = this.sqliteSources();
      for (const source of sources) {
        handle.db.run(
          `DELETE FROM audit_events
           WHERE source = ?
           AND id NOT IN (
             SELECT id FROM audit_events
             WHERE source = ?
             ORDER BY occurred_at DESC, id DESC
             LIMIT ?
           )`,
          [source, source, maxEventsPerSource]
        );
      }
    }

    const after = countRows(handle, "SELECT COUNT(*) FROM audit_events");
    if (before !== after) {
      handle.db.run("VACUUM");
      handle.flush();
    }

    return {
      backend: "sqlite",
      deleted: before - after,
      sources: diffCounts(sourcesBefore, this.sqliteSourceCounts())
    };
  }

  private async cleanupFiles(): Promise<AuditRetentionResult> {
    const cutoffMs = this.cutoffMs();
    const maxEventsPerSource = normalizePositiveInteger(this.options.policy.maxEventsPerSource);
    const sourceDeleted: Record<string, number> = {};
    let deleted = 0;
    let filesRewritten = 0;

    await fs.mkdir(this.options.auditDir, { recursive: true });
    for (const fileName of AUDIT_FILES) {
      const source = fileName.replace(/\.jsonl$/, "");
      const filePath = path.join(this.options.auditDir, fileName);
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }

      const records = raw
        .split("\n")
        .map((line, index) => ({ line, index, timestampMs: parseTimestampMs(line) }))
        .filter((record) => record.line.trim().length > 0);
      const originalLength = records.length;
      let kept = cutoffMs === undefined
        ? records
        : records.filter((record) => record.timestampMs === undefined || record.timestampMs >= cutoffMs);

      if (maxEventsPerSource !== undefined && kept.length > maxEventsPerSource) {
        const keptIndexes = new Set(
          kept
            .slice()
            .sort((left, right) =>
              compareTimestampDesc(left.timestampMs, right.timestampMs) || right.index - left.index
            )
            .slice(0, maxEventsPerSource)
            .map((record) => record.index)
        );
        kept = kept.filter((record) => keptIndexes.has(record.index));
      }

      if (kept.length === originalLength) {
        continue;
      }

      const nextRaw = kept.length > 0 ? `${kept.map((record) => record.line).join("\n")}\n` : "";
      const tempPath = `${filePath}.tmp`;
      await fs.writeFile(tempPath, nextRaw, "utf8");
      await fs.rename(tempPath, filePath);
      const fileDeleted = originalLength - kept.length;
      sourceDeleted[source] = fileDeleted;
      deleted += fileDeleted;
      filesRewritten += 1;
    }

    return {
      backend: "file",
      deleted,
      sources: sourceDeleted,
      filesRewritten
    };
  }

  private isEnabled(): boolean {
    if (this.options.policy.enabled === false) {
      return false;
    }

    return Boolean(
      normalizePositiveNumber(this.options.policy.retentionDays) !== undefined ||
      normalizePositiveInteger(this.options.policy.maxEventsPerSource) !== undefined
    );
  }

  private cleanupIntervalMs(): number {
    return normalizePositiveInteger(this.options.policy.cleanupIntervalMs) ?? DEFAULT_CLEANUP_INTERVAL_MS;
  }

  private cutoffIso(): string | undefined {
    const days = normalizePositiveNumber(this.options.policy.retentionDays);
    return days === undefined ? undefined : new Date(Date.now() - days * DAY_MS).toISOString();
  }

  private cutoffMs(): number | undefined {
    const days = normalizePositiveNumber(this.options.policy.retentionDays);
    return days === undefined ? undefined : Date.now() - days * DAY_MS;
  }

  private sqliteSources(): string[] {
    const result = this.options.sqliteHandle!.db.exec("SELECT DISTINCT source FROM audit_events");
    return (result[0]?.values ?? []).map((row) => String(row[0]));
  }

  private sqliteSourceCounts(): Record<string, number> {
    const result = this.options.sqliteHandle!.db.exec("SELECT source, COUNT(*) FROM audit_events GROUP BY source");
    return Object.fromEntries((result[0]?.values ?? []).map((row) => [String(row[0]), Number(row[1])]));
  }
}

function countRows(handle: SqliteHandle, sql: string): number {
  const value = handle.db.exec(sql)[0]?.values[0]?.[0];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function diffCounts(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const sources = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Object.fromEntries(
    [...sources]
      .map((source) => [source, (before[source] ?? 0) - (after[source] ?? 0)] as const)
      .filter(([, deleted]) => deleted > 0)
  );
}

function parseTimestampMs(line: string): number | undefined {
  try {
    const value = JSON.parse(line) as { timestamp?: unknown; occurred_at?: unknown };
    const timestamp = typeof value.timestamp === "string"
      ? value.timestamp
      : typeof value.occurred_at === "string"
        ? value.occurred_at
        : undefined;
    if (!timestamp) {
      return undefined;
    }
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function compareTimestampDesc(left: number | undefined, right: number | undefined): number {
  const normalizedLeft = left ?? Number.POSITIVE_INFINITY;
  const normalizedRight = right ?? Number.POSITIVE_INFINITY;
  return normalizedRight - normalizedLeft;
}

function normalizePositiveNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  const normalized = normalizePositiveNumber(value);
  return normalized === undefined ? undefined : Math.trunc(normalized);
}
