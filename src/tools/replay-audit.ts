import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

interface ReplaySummary {
  source: string;
  totalEvents: number;
  actions: Record<string, number>;
  statuses: Record<string, number>;
  realizedPnlSol: number;
  capitalDeltaSol: number;
  feesClaimedSol: number;
  missingCloseActions: string[];
}

function readArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1]!;
  }

  return fallback;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

async function main(): Promise<void> {
  const actionsPath = readArg("--actions", "runtime/audit/actions.jsonl");
  const openByPosition = new Map<string, number>();
  const closedPositions = new Set<string>();
  const summary: ReplaySummary = {
    source: actionsPath,
    totalEvents: 0,
    actions: {},
    statuses: {},
    realizedPnlSol: 0,
    capitalDeltaSol: 0,
    feesClaimedSol: 0,
    missingCloseActions: []
  };

  const lines = createInterface({
    input: createReadStream(actionsPath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY
  });

  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const rawEvent = readRecord(JSON.parse(line));
    const payload = readRecord(rawEvent?.payload);
    const event = payload ?? rawEvent;
    const action = readRecord(event?.action);
    const result = readRecord(event?.result);
    const metadata = readRecord(result?.metadata) ?? {};
    const actionType = String(action?.type ?? "unknown");
    const status = String(result?.status ?? "unknown");
    const stateOperations = Array.isArray(result?.stateOperations)
      ? result.stateOperations.map(readRecord).filter((item): item is Record<string, unknown> => Boolean(item))
      : [];
    const position = stateOperations
      .map((operation) => (operation.kind === "upsert_position" ? readRecord(operation.position) : undefined))
      .find((item): item is Record<string, unknown> => Boolean(item));
    const positionId = String(position?.id ?? metadata.positionId ?? action?.positionId ?? "");

    summary.totalEvents += 1;
    increment(summary.actions, actionType);
    increment(summary.statuses, status);

    for (const operation of stateOperations) {
      if (operation.kind === "adjust_capital") {
        summary.capitalDeltaSol += readNumber(operation.deltaSol) ?? 0;
      }
    }

    if (status !== "success") {
      continue;
    }

    if (actionType === "open" && positionId) {
      openByPosition.set(positionId, readNumber(position?.depositedSol) ?? readNumber(action?.amountSol) ?? 0);
    }

    if ((actionType === "close" || actionType === "emergency_exit") && positionId) {
      const depositedSol = openByPosition.get(positionId) ?? readNumber(position?.depositedSol) ?? 0;
      const recoveredSol = readNumber(metadata.recoveredSol) ?? 0;
      summary.realizedPnlSol += recoveredSol - depositedSol;
      closedPositions.add(positionId);
    }

    if (actionType === "claim") {
      summary.feesClaimedSol += readNumber(metadata.claimedFee) ?? 0;
    }
  }

  for (const positionId of openByPosition.keys()) {
    if (!closedPositions.has(positionId)) {
      summary.missingCloseActions.push(positionId);
    }
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
