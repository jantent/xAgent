import type { SharedStateSnapshot } from "../core/shared-state.js";

const DATE_KEYS = new Set([
  "startedAt",
  "finishedAt",
  "openedAt",
  "closedAt",
  "maxAliveUntil",
  "outOfRangeSince",
  "lastClaimedAt",
  "lastFeeCheckAt",
  "lastValuationAt",
  "lastMainCycleAt",
  "lastHighFreqTickAt",
  "lastCheckedAt",
  "lastSuccessAt",
  "lastErrorAt",
  "enabledAt",
  "disabledAt",
  "createdAt",
  "updatedAt",
  "confirmedAt",
  "timestamp",
  "evaluatedAt"
]);

function reviveDates(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => reviveDates(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, current]) => {
      if (typeof current === "string" && DATE_KEYS.has(key)) {
        return [key, new Date(current)];
      }

      return [key, reviveDates(current)];
    })
  );
}

export function deserializeStateSnapshot(value: string | unknown): SharedStateSnapshot {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return reviveDates(parsed) as SharedStateSnapshot;
}

export function serializeStateSnapshot(snapshot: SharedStateSnapshot): string {
  return JSON.stringify(snapshot);
}
