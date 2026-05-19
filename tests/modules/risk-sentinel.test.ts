import assert from "node:assert/strict";
import test from "node:test";

import { SystemMode } from "../../src/domain/models.js";
import { SkillManager } from "../../src/managers/skill-manager.js";
import { RiskSentinel } from "../../src/modules/risk-sentinel.js";
import { createAgentConfig, createPlan, createPositionRecord, createSkill, createStateSnapshot } from "../helpers/factories.js";
import { createTestLogger } from "../helpers/logger.js";

test("RiskSentinel.review 在降级模式下拒绝新开仓", () => {
  const config = createAgentConfig();
  const skillManager = new SkillManager([createSkill()]);
  const sentinel = new RiskSentinel(config, skillManager, createTestLogger());
  const reviewed = sentinel.review([createPlan()], createStateSnapshot(), SystemMode.DEGRADED_NO_SIGNALS);

  assert.equal(reviewed[0]?.approved, false);
  assert.match(reviewed[0]?.rejectionReason ?? "", /禁止新开仓/);
});

test("RiskSentinel.review 会拦截同 token 敞口超限", () => {
  const config = createAgentConfig();
  config.risk.max_position_pct = 100;
  config.risk.max_token_exposure_pct = 50;

  const skill = createSkill();
  skill.riskLimits.maxPositionSizePercent = 100;
  const skillManager = new SkillManager([skill]);
  const sentinel = new RiskSentinel(config, skillManager, createTestLogger());
  const existing = createPositionRecord({
    id: "position-existing",
    skillId: skill.id,
    skillVersion: skill.version,
    tokenMint: "TOKEN-1",
    depositedSol: 4
  });
  const state = createStateSnapshot({
    availableCapitalSol: 6,
    activePositions: [existing],
    allPositions: [existing]
  });
  const plan = createPlan({
    suggestedAmountSol: 2,
    pool: {
      tokenMint: "TOKEN-1"
    },
    skill: {
      id: skill.id,
      version: skill.version,
      riskLimits: {
        maxPositionSizePercent: 100
      }
    }
  });

  const reviewed = sentinel.review([plan], state, SystemMode.NORMAL);

  assert.equal(reviewed[0]?.approved, false);
  assert.match(reviewed[0]?.rejectionReason ?? "", /同 token 敞口/);
});

test("RiskSentinel.review 会消费全局单仓和日累计限额", () => {
  const config = createAgentConfig();
  config.risk.max_position_pct = 10;
  config.wallet.limits.daily_cumulative_max_sol = 1.5;

  const skill = createSkill();
  const sentinel = new RiskSentinel(config, new SkillManager([skill]), createTestLogger());
  const recentPosition = createPositionRecord({
    depositedSol: 1.0,
    openedAt: new Date(Date.now() - 2 * 60 * 60 * 1000)
  });

  const reviewed = sentinel.review(
    [
      createPlan({
        suggestedAmountSol: 2.0,
        skill: { id: skill.id, version: skill.version }
      })
    ],
    createStateSnapshot({
      availableCapitalSol: 8,
      activePositions: [recentPosition],
      allPositions: [recentPosition]
    }),
    SystemMode.NORMAL
  );

  assert.equal(reviewed[0]?.approved, false);
  assert.match(reviewed[0]?.rejectionReason ?? "", /单仓敞口|日限额/);
});

test("RiskSentinel.review 会执行硬过滤拒绝高风险池子", () => {
  const config = createAgentConfig();
  config.risk.max_position_pct = 100;
  config.risk.filters = {
    enabled: true,
    min_tvl: 10_000,
    min_volume_24h: 10_000,
    min_safety_score: 70,
    max_top_holder_pct: 25,
    reject_dev_sell: true,
    reject_stale_data: true
  };
  const skill = createSkill({
    riskLimits: {
      maxPositionSizePercent: 100
    }
  });
  const sentinel = new RiskSentinel(config, new SkillManager([skill]), createTestLogger());
  const plan = createPlan({
    pool: {
      tvl: 50_000,
      vol24h: 80_000,
      safetyScore: 72,
      meta: {
        topHolderPct: 40
      }
    },
    skill: {
      id: skill.id,
      version: skill.version,
      riskLimits: {
        maxPositionSizePercent: 100
      }
    }
  });

  const reviewed = sentinel.review([plan], createStateSnapshot({ availableCapitalSol: 10 }), SystemMode.NORMAL);

  assert.equal(reviewed[0]?.approved, false);
  assert.match(reviewed[0]?.rejectionReason ?? "", /top holder/);
});

test("RiskSentinel.inspectActivePositions 会生成止损、超时和平衡动作", () => {
  const config = createAgentConfig();
  config.risk.stop_loss_pct = 25;
  config.risk.max_alive_hours = 48;

  const skill = createSkill({
    riskLimits: {
      stopLossPercent: 10,
      maxAliveHours: 24
    }
  });
  const skillManager = new SkillManager([skill]);
  const sentinel = new RiskSentinel(config, skillManager, createTestLogger());
  const now = Date.now();

  const stopLoss = createPositionRecord({
    id: "stop-loss",
    skillId: skill.id,
    skillVersion: skill.version,
    pnlPercent: -30
  });
  const maxAlive = createPositionRecord({
    id: "max-alive",
    skillId: skill.id,
    skillVersion: skill.version,
    openedAt: new Date(now - 30 * 60 * 60 * 1000),
    maxAliveUntil: new Date(now - 1_000)
  });
  const rebalance = createPositionRecord({
    id: "rebalance",
    skillId: skill.id,
    skillVersion: skill.version,
    openedAt: new Date(now - 2 * 60 * 60 * 1000),
    maxAliveUntil: new Date(now + 24 * 60 * 60 * 1000),
    isInRange: false,
    outOfRangeSince: new Date(now - 6 * 60 * 1000),
    fromBinId: 100,
    toBinId: 120
  });

  const actions = sentinel.inspectActivePositions([stopLoss, maxAlive, rebalance], new Map([[rebalance.poolAddress, 90]]));

  assert.equal(actions.length, 3);
  assert.deepEqual(
    actions.map((action) => ({ type: action.type, trigger: action.trigger, positionId: action.positionId })),
    [
      { type: "close", trigger: "stop_loss", positionId: "stop-loss" },
      { type: "close", trigger: "max_alive", positionId: "max-alive" },
      { type: "rebalance", trigger: "out_of_range", positionId: "rebalance" }
    ]
  );
  assert.deepEqual(actions[2]?.newRange, {
    minBinId: 80,
    maxBinId: 100
  });
});

test("RiskSentinel.inspectActivePositions 在重平衡次数超限时转为平仓", () => {
  const skill = createSkill({
    riskLimits: {
      maxDailyRebalances: 1
    }
  });
  const sentinel = new RiskSentinel(createAgentConfig(), new SkillManager([skill]), createTestLogger());
  const now = Date.now();
  const position = createPositionRecord({
    skillId: skill.id,
    skillVersion: skill.version,
    isInRange: false,
    outOfRangeSince: new Date(Date.now() - 10 * 60 * 1000),
    rebalanceCount: 1,
    openedAt: new Date(now - 60 * 60 * 1000),
    maxAliveUntil: new Date(now + 24 * 60 * 60 * 1000)
  });

  const actions = sentinel.inspectActivePositions([position], new Map([[position.poolAddress, 100]]));

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "close");
  assert.equal(actions[0]?.trigger, "rebalance_limit");
});

test("RiskSentinel.inspectActivePositions 会按手续费周期 claim，并在 Lincoln 失效时退出", () => {
  const config = createAgentConfig();
  config.risk.fee_claim_interval_hours = 4;
  config.risk.lincoln_exit_threshold = 1.2;

  const skill = createSkill();
  const sentinel = new RiskSentinel(config, new SkillManager([skill]), createTestLogger());
  const now = Date.now();
  const claimPosition = createPositionRecord({
    id: "claim-position",
    skillId: skill.id,
    skillVersion: skill.version,
    openedAt: new Date(now - 10 * 60 * 60 * 1000),
    maxAliveUntil: new Date(now + 10 * 60 * 60 * 1000),
    lastFeeCheckAt: new Date(now - 5 * 60 * 60 * 1000)
  });
  const lincolnExit = createPositionRecord({
    id: "lincoln-exit",
    poolAddress: "pool-lincoln",
    skillId: skill.id,
    skillVersion: skill.version
  });

  const actions = sentinel.inspectActivePositions(
    [claimPosition, lincolnExit],
    new Map(),
    new Map([
      [
        "pool-lincoln",
        {
          ...createPlan().pool,
          address: "pool-lincoln",
          lincolnScore: 0.8
        }
      ]
    ])
  );

  assert.deepEqual(
    actions.map((action) => ({ type: action.type, trigger: action.trigger, positionId: action.positionId })),
    [
      { type: "claim", trigger: "fee_interval", positionId: "claim-position" },
      { type: "close", trigger: "lincoln_exit", positionId: "lincoln-exit" }
    ]
  );
});
