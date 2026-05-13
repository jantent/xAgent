import assert from "node:assert/strict";
import test from "node:test";

import { deserializeStateSnapshot, serializeStateSnapshot } from "../../src/persistence/state-serialization.js";
import { createPositionRecord, createSkill, createStateSnapshot } from "../helpers/factories.js";

test("state serialization round-trip 会保留日期字段", () => {
  const snapshot = createStateSnapshot({
    allPositions: [
      createPositionRecord({
        openedAt: new Date("2026-02-01T00:00:00.000Z"),
        maxAliveUntil: new Date("2026-02-02T00:00:00.000Z"),
        closedAt: new Date("2026-02-03T00:00:00.000Z"),
        outOfRangeSince: new Date("2026-02-01T12:00:00.000Z"),
        lastClaimedAt: new Date("2026-02-01T13:00:00.000Z"),
        lastFeeCheckAt: new Date("2026-02-01T14:00:00.000Z"),
        paper: {
          entryActiveBinId: 8_000,
          entryPrice: 1,
          currentValueSol: 1.2,
          unclaimedFeesSol: 0.01,
          lastValuationAt: new Date("2026-02-01T15:00:00.000Z")
        }
      })
    ],
    activePositions: [],
    lastMainCycleAt: new Date("2026-02-05T00:00:00.000Z"),
    lastHighFreqTickAt: new Date("2026-02-05T01:00:00.000Z"),
    runtimeSkills: [
      createSkill({
        enabledAt: new Date("2026-02-05T02:00:00.000Z"),
        updatedAt: new Date("2026-02-05T03:00:00.000Z")
      })
    ],
    paperPositionSnapshots: [
      {
        id: "paper-1",
        positionId: "position-1",
        skillId: "bread_n_butter",
        skillVersion: "1.0.0",
        poolAddress: "pool-1",
        tokenMint: "mint-1",
        tokenSymbol: "BONK",
        timestamp: new Date("2026-02-01T16:00:00.000Z"),
        activeBinId: 8_000,
        valueSol: 1.2,
        valueUsd: 180,
        pnlPercent: 10,
        feeAccruedSol: 0.01,
        unclaimedFeesSol: 0.01,
        inRange: true,
        source: "meteora_http",
        stale: false
      }
    ],
    skillOptimizationRecommendations: [
      {
        skillId: "bread_n_butter",
        skillVersion: "1.0.0",
        evaluatedAt: new Date("2026-02-01T17:00:00.000Z"),
        suggestedAction: "hold",
        confidence: 0.3,
        reason: "测试建议"
      }
    ]
  });

  const restored = deserializeStateSnapshot(serializeStateSnapshot(snapshot));
  const position = restored.allPositions[0];

  assert.ok(restored.startedAt instanceof Date);
  assert.ok(restored.lastMainCycleAt instanceof Date);
  assert.ok(restored.lastHighFreqTickAt instanceof Date);
  assert.ok(position?.openedAt instanceof Date);
  assert.ok(position?.maxAliveUntil instanceof Date);
  assert.ok(position?.closedAt instanceof Date);
  assert.ok(position?.outOfRangeSince instanceof Date);
  assert.ok(position?.lastClaimedAt instanceof Date);
  assert.ok(position?.lastFeeCheckAt instanceof Date);
  assert.ok(position?.paper?.lastValuationAt instanceof Date);
  assert.ok(restored.paperPositionSnapshots?.[0]?.timestamp instanceof Date);
  assert.ok(restored.runtimeSkills?.[0]?.enabledAt instanceof Date);
  assert.ok(restored.runtimeSkills?.[0]?.updatedAt instanceof Date);
  assert.ok(restored.skillOptimizationRecommendations?.[0]?.evaluatedAt instanceof Date);
});
