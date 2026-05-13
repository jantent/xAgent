import { promises as fs } from "node:fs";
import path from "node:path";

import { openSqliteDatabase } from "../persistence/sqlite-database.js";

interface MigrationArgs {
  statePath: string;
  auditDir: string;
  dbPath: string;
  replace: boolean;
}

const AUDIT_FILES = ["actions.jsonl", "errors.jsonl", "phases.jsonl", "cycles.jsonl", "llm.jsonl"];

function parseArgs(argv: string[]): MigrationArgs {
  const args = new Map<string, string>();
  let replace = false;
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]!;
    if (item === "--replace") {
      replace = true;
      continue;
    }
    if (!item.startsWith("--")) {
      throw new Error(`未知参数 ${item}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${item} 缺少参数值`);
    }
    args.set(item, value);
    i += 1;
  }

  return {
    statePath: args.get("--state") ?? "runtime/state.json",
    auditDir: args.get("--audit-dir") ?? "runtime/audit",
    dbPath: args.get("--db") ?? "runtime/xagent.db",
    replace
  };
}

async function importAuditEvents(auditDir: string, db: Awaited<ReturnType<typeof openSqliteDatabase>>["db"]): Promise<{
  imported: number;
  skipped: number;
  sources: Record<string, number>;
}> {
  let imported = 0;
  let skipped = 0;
  const sources: Record<string, number> = {};

  for (const fileName of AUDIT_FILES) {
    const source = fileName.replace(/\.jsonl$/, "");
    const filePath = path.resolve(auditDir, fileName);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const payload = JSON.parse(trimmed) as Record<string, unknown>;
        const timestamp = typeof payload.timestamp === "string" ? payload.timestamp : new Date().toISOString();
        const cycleId = typeof payload.cycleId === "string" ? payload.cycleId : null;
        db.run(
          "INSERT INTO audit_events (source, cycle_id, occurred_at, payload) VALUES (?, ?, ?, ?)",
          [source, cycleId, timestamp, JSON.stringify(payload)]
        );
        sources[source] = (sources[source] ?? 0) + 1;
        imported += 1;
      } catch {
        skipped += 1;
      }
    }
  }

  return { imported, skipped, sources };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const statePath = path.resolve(args.statePath);
  const dbPath = path.resolve(args.dbPath);
  const auditDir = path.resolve(args.auditDir);
  const stateRaw = await fs.readFile(statePath, "utf8");
  JSON.parse(stateRaw);

  const handle = await openSqliteDatabase(dbPath);
  try {
    if (args.replace) {
      handle.db.run("DELETE FROM runtime_state_snapshots");
      handle.db.run("DELETE FROM audit_events");
    }

    handle.db.run(
      "INSERT OR REPLACE INTO runtime_state_snapshots (state_key, snapshot, updated_at) VALUES (?, ?, ?)",
      ["default", stateRaw, new Date().toISOString()]
    );
    const audit = await importAuditEvents(auditDir, handle.db);
    handle.flush();

    console.log(JSON.stringify({
      dbPath,
      stateImported: true,
      auditImported: audit.imported,
      auditSkipped: audit.skipped,
      sources: audit.sources
    }));
  } finally {
    handle.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
