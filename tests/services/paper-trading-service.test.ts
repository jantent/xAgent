import assert from "node:assert/strict";
import test from "node:test";

import { SharedState } from "../../src/core/shared-state.js";
import { PaperTradingService } from "../../src/services/paper-trading-service.js";
import { createAgentConfig, createPoolCandidate, createPositionRecord } from "../helpers/factories.js";
import { createTestLogger } from "../helpers/logger.js";

function createService(state: SharedState, overrides: Partial<ReturnType<typeof createAgentConfig>["paper_trading"]> = {}) {
  const config = createAgentConfig();
  config.valuation = {
    sol_price_usd: 100
  };
  config.paper_trading = {
    ...config.paper_trading,
    ...overrides
  };
  return new PaperTradingService(config, state, createTestLogger());
}

test("PaperTradingService 会按真实池子 active bin、价格和 fee 更新 in-range 仓位", () => {
  const position = createPositionRecord({
    depositedSol: 2,
    openedAt: new Date("2026-01-01T00:00:00.000Z"),
    paper: {
      entryActiveBinId: 8_000,
      entryPrice: 1,
      currentValueSol: 2,
      unclaimedFeesSol: 0
    }
  });
  const state = new SharedState({
    initialSnapshot: {
      allPositions: [position]
    }
  });
  const service = createService(state);
  const pool = createPoolCandidate({
    address: position.poolAddress,
    dataSource: "meteora_http",
    feeTvlRatio24h: 12,
    meta: {
      activeBinId: 8_000,
      currentPrice: 1.2
    }
  });

  const result = service.valuate([pool], new Date("2026-01-02T00:00:00.000Z"));
  const updated = state.getPosition(position.id);

  assert.equal(result.updated, 1);
  assert.equal(result.stale, 0);
  assert.equal(updated?.isInRange, true);
  assert.equal(updated?.paper?.unclaimedFeesSol.toFixed(6), "0.084000");
  assert.equal(updated?.paper?.currentValueSol?.toFixed(6), "2.284000");
  assert.equal(updated?.pnlPercent.toFixed(2), "14.20");
  assert.equal(updated?.currentValueUsd, 228.4);
  assert.equal(state.getPaperPositionSnapshots().length, 1);
});

test("PaperTradingService 在 live execution 模式下不会估值", () => {
  const config = createAgentConfig();
  config.execution!.mode = "live_sdk";
  const position = createPositionRecord({
    paper: {
      entryActiveBinId: 8_000,
      entryPrice: 1,
      currentValueSol: 1.2,
      unclaimedFeesSol: 0
    }
  });
  const state = new SharedState({
    initialSnapshot: {
      allPositions: [position]
    }
  });
  const service = new PaperTradingService(config, state, createTestLogger());

  const result = service.valuate([
    createPoolCandidate({
      address: position.poolAddress,
      dataSource: "meteora_http",
      meta: {
        activeBinId: 8_000,
        currentPrice: 2
      }
    })
  ]);

  assert.equal(result.enabled, false);
  assert.equal(state.getPaperPositionSnapshots().length, 0);
  assert.equal(state.getPosition(position.id)?.pnlPercent, position.pnlPercent);
});

test("PaperTradingService 会限制异常 fee/TVL 对虚拟手续费的影响", () => {
  const position = createPositionRecord({
    depositedSol: 1,
    openedAt: new Date("2026-01-01T00:00:00.000Z"),
    paper: {
      entryActiveBinId: 8_000,
      entryPrice: 1,
      currentValueSol: 1,
      unclaimedFeesSol: 0
    }
  });
  const state = new SharedState({
    initialSnapshot: {
      allPositions: [position]
    }
  });
  const service = createService(state, {
    max_fee_tvl_ratio_24h: 100
  });
  const pool = createPoolCandidate({
    address: position.poolAddress,
    dataSource: "meteora_http",
    feeTvlRatio24h: 1_000_000,
    meta: {
      activeBinId: 8_000,
      currentPrice: 1
    }
  });

  service.valuate([pool], new Date("2026-01-02T00:00:00.000Z"));
  const updated = state.getPosition(position.id);
  const snapshot = state.getPaperPositionSnapshots()[0];

  assert.equal(updated?.paper?.unclaimedFeesSol.toFixed(6), "0.350000");
  assert.equal(snapshot?.feeAccruedSol.toFixed(6), "0.350000");
  assert.equal(updated?.pnlPercent.toFixed(2), "35.00");
});

test("PaperTradingService 会对 out-of-range 仓位设置出界状态并应用 capped penalty", () => {
  const position = createPositionRecord({
    depositedSol: 1,
    fromBinId: 7_995,
    toBinId: 8_005,
    openedAt: new Date("2026-01-01T00:00:00.000Z"),
    paper: {
      entryActiveBinId: 8_000,
      entryPrice: 1,
      currentValueSol: 1,
      unclaimedFeesSol: 0
    }
  });
  const state = new SharedState({
    initialSnapshot: {
      allPositions: [position]
    }
  });
  const service = createService(state);
  const pool = createPoolCandidate({
    address: position.poolAddress,
    dataSource: "meteora_http",
    feeTvlRatio24h: 0,
    meta: {
      activeBinId: 9_000,
      currentPrice: 1
    }
  });

  service.valuate([pool], new Date("2026-01-02T00:00:00.000Z"));
  const updated = state.getPosition(position.id);

  assert.equal(updated?.isInRange, false);
  assert.ok(updated?.outOfRangeSince instanceof Date);
  assert.equal(updated?.paper?.currentValueSol?.toFixed(6), "0.650000");
  assert.equal(updated?.pnlPercent.toFixed(2), "-35.00");
});

test("PaperTradingService 缺少真实池子或 active bin 时只写 stale snapshot", () => {
  const position = createPositionRecord({
    pnlPercent: 7,
    paper: {
      entryActiveBinId: 8_000,
      entryPrice: 1,
      currentValueSol: 1.284,
      unclaimedFeesSol: 0.01
    }
  });
  const state = new SharedState({
    initialSnapshot: {
      allPositions: [position]
    }
  });
  const service = createService(state);

  const result = service.valuate([], new Date("2026-01-02T00:00:00.000Z"));
  const updated = state.getPosition(position.id);
  const snapshot = state.getPaperPositionSnapshots()[0];

  assert.equal(result.updated, 0);
  assert.equal(result.stale, 1);
  assert.equal(updated?.pnlPercent, 7);
  assert.equal(updated?.paper?.staleReason, "paper valuation 缺少当前池子数据");
  assert.equal(snapshot?.stale, true);
});

test("PaperTradingService 会按配置保留最新快照", () => {
  const positions = [0, 1, 2].map((index) =>
    createPositionRecord({
      id: `position-${index}`,
      poolAddress: `pool-${index}`,
      tokenMint: `mint-${index}`,
      paper: {
        entryActiveBinId: 8_000,
        entryPrice: 1,
        currentValueSol: 1.2,
        unclaimedFeesSol: 0
      }
    })
  );
  const state = new SharedState({
    initialSnapshot: {
      allPositions: positions
    }
  });
  const service = createService(state, {
    snapshot_retention: 2
  });
  const pools = positions.map((position) =>
    createPoolCandidate({
      address: position.poolAddress,
      tokenMint: position.tokenMint,
      dataSource: "meteora_http",
      meta: {
        activeBinId: 8_000,
        currentPrice: 1
      }
    })
  );

  service.valuate(pools, new Date("2026-01-02T00:00:00.000Z"));

  assert.equal(state.getPaperPositionSnapshots().length, 2);
});
