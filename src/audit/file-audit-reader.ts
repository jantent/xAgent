import { promises as fs } from "node:fs";
import path from "node:path";

import type { AuditEventQuery, AuditEventRecord, IAuditReader } from "./contracts.js";

export class FileAuditReader implements IAuditReader {
  private readonly sourceFiles = ["actions.jsonl", "errors.jsonl", "phases.jsonl", "cycles.jsonl", "llm.jsonl"];

  constructor(private readonly rootDir: string) {}

  async readRecent(limit = 30): Promise<AuditEventRecord[]> {
    return this.queryEvents({ limit });
  }

  async queryEvents(query: AuditEventQuery = {}): Promise<AuditEventRecord[]> {
    const normalizedSource = normalizeText(query.source);
    const fileNames = normalizedSource ? [`${normalizedSource}.jsonl`] : this.sourceFiles;
    const records = await Promise.all(fileNames.map((fileName) => this.readFile(fileName)));
    const cycleId = normalizeText(query.cycleId);
    const search = normalizeText(query.q)?.toLowerCase();
    const since = query.since ? new Date(query.since).getTime() : undefined;
    const until = query.until ? new Date(query.until).getTime() : undefined;
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));
    const limit = Math.max(0, Math.trunc(query.limit ?? 30));

    return records
      .flat()
      .filter((record) => {
        const timestamp = record.timestamp ? new Date(record.timestamp).getTime() : 0;
        if (cycleId && getCycleId(record) !== cycleId) {
          return false;
        }
        if (since !== undefined && timestamp < since) {
          return false;
        }
        if (until !== undefined && timestamp > until) {
          return false;
        }
        if (search) {
          const haystack = `${record.source} ${getCycleId(record) ?? ""} ${JSON.stringify(record.payload)}`.toLowerCase();
          return haystack.includes(search);
        }
        return true;
      })
      .sort((left, right) => {
        const leftTs = left.timestamp ? new Date(left.timestamp).getTime() : 0;
        const rightTs = right.timestamp ? new Date(right.timestamp).getTime() : 0;
        return rightTs - leftTs;
      })
      .slice(offset, offset + limit);
  }

  private async readFile(fileName: string): Promise<AuditEventRecord[]> {
    const filePath = path.join(this.rootDir, fileName);

    try {
      const raw = await fs.readFile(filePath, "utf8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .map((payload) => ({
          source: fileName.replace(/\.jsonl$/, ""),
          timestamp: typeof payload.timestamp === "string" ? payload.timestamp : undefined,
          payload
        }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }
}

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getCycleId(record: AuditEventRecord): string | undefined {
  return typeof record.payload.cycleId === "string" ? record.payload.cycleId : undefined;
}
