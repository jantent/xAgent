import assert from "node:assert/strict";
import test from "node:test";

import { SharedState } from "../../src/core/shared-state.js";
import { SkillStatus, type PaperPositionSnapshot, type PositionRecord, type SkillMeta } from "../../src/domain/models.js";
import { SkillManager } from "../../src/managers/skill-manager.js";
import { SkillOptimizerService } from "../../src/services/skill-optimizer-service.js";
import { SkillStatsService } from "../../src/services/skill-stats-service.js";
import { createAgentConfig, createPositionRecord, createSkill } from "../helpers/factories.js";

let snapshotSequence = 0;

function createSnapshot(overrides: Partial<PaperPositionSnapshot> = {}): PaperPositionSnapshot {
  return {
    id: `paper-${snapshotSequence++}`,
    positionId: "position-1",
    skillId: "bread_n_butter",
    skillVersion: "1.0.0",
    poolAddress: "pool-1",
    tokenMint: "mint-1",
    tokenSymbol: "BONK",
    timestamp: new Date("2026-01-01T01:00:00.000Z"),
    activeBinId: 8_000,
    valueSol: 1,
    valueUsd: 150,
    pnlPercent: 0,
    feeAccruedSol: 0,
    unclaimedFeesSol: 0,
    inRange: true,
    source: "meteora_http",
    stale: false,
    ...overrides
  };
}

function createClosedPosition(overrides: Partial<PositionRecord> = {}): PositionRecord {
  return createPositionRecord({
    status: "closed",
    closedAt: new Date("2026-01-01T06:00:00.000Z"),
    ...overrides
  });
}

function createService(options: {
  skill?: SkillMeta;
  positions?: PositionRecord[];
  snapshots?: PaperPositionSnapshot[];
  config?: ReturnType<typeof createAgentConfig>;
} = {}): SkillOptimizerService {
  const config = options.config ?? createAgentConfig();
  config.skill_optimizer = {
    ...config.skill_optimizer,
    min_closed_positions: 1,
    min_snapshots: 1
  };
  const skill = options.skill ?? createSkill();
  const state = new SharedState({
    initialSnapshot: {
      allPositions: options.positions ?? [],
      paperPositionSnapshots: options.snapshots ?? []
    }
  });
  const skillManager = new SkillManager([skill]);
  const statsService = new SkillStatsService(state);
  return new SkillOptimizerService(config, state, statsService, skillManager);
}

test("SkillOptimizerService 在 dry_run + paper trading 下生成正向 canary 建议", () => {
  const service = createService({
    positions: [
      createClosedPosition({
        currentValueUsd: 180,
        pnlPercent: 20
      })
    ],
    snapshots: [
      createSnapshot({
        pnlPercent: 4,
        feeAccruedSol: 0.04
      })
    ]
  });

  const [recommendation] = service.evaluate();

  assert.equal(recommendation?.suggestedAction, "increase_canary");
  assert.equal(recommendation?.disabledReason, undefined);
});

test("SkillOptimizerService 在 live mode 下只返回 disabled reason", () => {
  const config = createAgentConfig();
  config.execution = {
    ...config.execution!,
    mode: "live_sdk"
  };
  const service = createService({ config });

  const [recommendation] = service.evaluate();

  assert.equal(recommendation?.suggestedAction, "hold");
  assert.match(recommendation?.disabledReason ?? "", /dry_run/);
});

test("SkillOptimizerService 数据不足时返回 hold", () => {
  const service = createService({
    positions: [],
    snapshots: []
  });

  const [recommendation] = service.evaluate();

  assert.equal(recommendation?.suggestedAction, "hold");
  assert.match(recommendation?.disabledReason ?? "", /已关闭仓位/);
});

test("SkillOptimizerService 高回撤时建议收缩风险", () => {
  const skill = createSkill({
    params: {
      binCount: 10
    },
    riskLimits: {
      stopLossPercent: 20,
      maxAliveHours: 100
    }
  });
  const service = createService({
    skill,
    positions: [
      createClosedPosition({
        currentValueUsd: 80,
        pnlPercent: -20
      })
    ],
    snapshots: [
      createSnapshot({
        pnlPercent: -18
      })
    ]
  });

  const [recommendation] = service.evaluate();

  assert.equal(recommendation?.suggestedAction, "reduce_risk");
  assert.equal(recommendation?.paramsPatch?.binCount, 8);
  assert.equal(recommendation?.riskLimitsPatch?.stopLossPercent, 16);
  assert.equal(recommendation?.riskLimitsPatch?.maxAliveHours, 80);
});

test("SkillOptimizerService stale snapshot 比例过高时不生成参数 patch", () => {
  const service = createService({
    positions: [
      createClosedPosition({
        currentValueUsd: 180,
        pnlPercent: 10
      })
    ],
    snapshots: [
      createSnapshot({
        stale: true,
        staleReason: "missing pool"
      }),
      createSnapshot({
        id: "paper-stale-2",
        stale: false
      })
    ]
  });

  const [recommendation] = service.evaluate();

  assert.equal(recommendation?.suggestedAction, "hold");
  assert.equal(recommendation?.paramsPatch, undefined);
  assert.match(recommendation?.disabledReason ?? "", /stale/);
});

test("SkillOptimizerService 频繁出界且收益为正时建议放宽 range", () => {
  const service = createService({
    positions: [
      createClosedPosition({
        currentValueUsd: 180,
        pnlPercent: 10,
        totalFeesClaimedSol: 0.01
      })
    ],
    snapshots: [
      createSnapshot({
        inRange: false,
        feeAccruedSol: 0.01
      }),
      createSnapshot({
        id: "paper-2",
        inRange: false,
        feeAccruedSol: 0.02
      })
    ]
  });

  const [recommendation] = service.evaluate();

  assert.equal(recommendation?.suggestedAction, "widen");
  assert.ok((recommendation?.paramsPatch?.binCount ?? 0) > 12);
});

test("SkillOptimizerService patch 不超过 max_patch_pct", () => {
  const config = createAgentConfig();
  config.skill_optimizer = {
    ...config.skill_optimizer,
    max_patch_pct: 10
  };
  const skill = createSkill({
    params: {
      binCount: 10
    },
    riskLimits: {
      stopLossPercent: 20
    }
  });
  const service = createService({
    config,
    skill,
    positions: [
      createClosedPosition({
        currentValueUsd: 80,
        pnlPercent: -25
      })
    ],
    snapshots: [
      createSnapshot({
        pnlPercent: -25
      })
    ]
  });

  const [recommendation] = service.evaluate();

  assert.equal(recommendation?.paramsPatch?.binCount, 9);
  assert.equal(recommendation?.riskLimitsPatch?.stopLossPercent, 18);
});

test("SkillOptimizerService 会持久化最新建议到 SharedState", () => {
  const config = createAgentConfig();
  const skill = createSkill({ status: SkillStatus.ACTIVE });
  const state = new SharedState({
    initialSnapshot: {
      allPositions: [
        createClosedPosition({
          currentValueUsd: 180,
          pnlPercent: 20
        })
      ],
      paperPositionSnapshots: [createSnapshot({ pnlPercent: 5 })]
    }
  });
  const service = new SkillOptimizerService(config, state, new SkillStatsService(state), new SkillManager([skill]));

  const recommendations = service.evaluateAndStore();

  assert.equal(recommendations.length, 1);
  assert.equal(state.getSkillOptimizationRecommendations().length, 1);
});
