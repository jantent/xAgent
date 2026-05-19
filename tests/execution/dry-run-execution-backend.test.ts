import assert from "node:assert/strict";
import test from "node:test";

import { DryRunExecutionBackend } from "../../src/execution/backends/dry-run-execution-backend.js";
import { createAgentConfig, createOpenAction, createPositionRecord } from "../helpers/factories.js";
import { createTestLogger } from "../helpers/logger.js";

function createBackend(config = createAgentConfig()): DryRunExecutionBackend {
  return new DryRunExecutionBackend(
    config,
    {
      getActiveEndpoint() {
        return {
          name: "primary",
          url: "simulated://primary"
        };
      }
    } as never,
    createTestLogger()
  );
}

test("DryRunExecutionBackend open 会返回资金扣减和仓位 upsert 操作", async () => {
  const action = createOpenAction({
    amountSol: 1.5
  });
  const result = await createBackend().execute(action, { availableCapitalSol: 10 });

  assert.equal(result.status, "success");
  assert.equal(result.type, "open");
  assert.equal(result.stateOperations?.length, 2);
  assert.deepEqual(result.stateOperations?.[0], {
    kind: "adjust_capital",
    deltaSol: -1.5
  });
  assert.equal(result.stateOperations?.[1]?.kind, "upsert_position");
  const position = result.stateOperations?.[1]?.kind === "upsert_position" ? result.stateOperations[1].position : undefined;
  assert.equal(position?.poolAddress, action.pool?.address);
  assert.equal(position?.walletAddress, createAgentConfig().wallet.active_address);
  assert.equal(position?.status, "active");
  assert.equal(position?.paper?.entryActiveBinId, action.pool?.meta?.activeBinId);
  assert.equal(position?.paper?.currentValueSol, 1.5);
});

test("DryRunExecutionBackend close 会回收本金、PnL 和已领取手续费", async () => {
  const position = createPositionRecord({
    id: "position-close-1",
    depositedSol: 2,
    pnlPercent: 10,
    totalFeesClaimedSol: 0.05
  });
  const result = await createBackend().execute(
    {
      id: "action-close-1",
      type: "close",
      trigger: "manual",
      reason: "close",
      positionId: position.id
    },
    {
      availableCapitalSol: 5,
      position
    }
  );

  assert.equal(result.status, "success");
  assert.equal(result.stateOperations?.[0]?.kind, "adjust_capital");
  assert.equal(result.stateOperations?.[0]?.kind === "adjust_capital" ? result.stateOperations[0].deltaSol : undefined, 2.25);
  assert.equal(result.stateOperations?.[1]?.kind, "upsert_position");
  const closed = result.stateOperations?.[1]?.kind === "upsert_position" ? result.stateOperations[1].position : undefined;
  assert.equal(closed?.status, "closed");
  assert.ok(closed?.closedAt);
});

test("DryRunExecutionBackend rebalance 会更新 range、次数和出界状态", async () => {
  const position = createPositionRecord({
    id: "position-rebalance-1",
    rebalanceCount: 2,
    isInRange: false,
    outOfRangeSince: new Date("2026-01-01T00:00:00.000Z")
  });
  const result = await createBackend().execute(
    {
      id: "action-rebalance-1",
      type: "rebalance",
      trigger: "out_of_range",
      reason: "rebalance",
      positionId: position.id,
      newRange: {
        minBinId: 7990,
        maxBinId: 8010
      }
    },
    {
      availableCapitalSol: 5,
      position
    }
  );

  assert.equal(result.status, "success");
  assert.equal(result.stateOperations?.[0]?.kind, "upsert_position");
  const updated = result.stateOperations?.[0]?.kind === "upsert_position" ? result.stateOperations[0].position : undefined;
  assert.equal(updated?.fromBinId, 7990);
  assert.equal(updated?.toBinId, 8010);
  assert.equal(updated?.rebalanceCount, 3);
  assert.equal(updated?.isInRange, true);
  assert.equal(updated?.outOfRangeSince, undefined);
});

test("DryRunExecutionBackend claim 即使模拟固定收益也会更新时间戳", async () => {
  const position = createPositionRecord({
    id: "position-claim-1",
    totalFeesClaimedSol: 0.03
  });
  const result = await createBackend().execute(
    {
      id: "action-claim-1",
      type: "claim",
      trigger: "interval",
      reason: "claim",
      positionId: position.id
    },
    {
      availableCapitalSol: 5,
      position
    }
  );

  assert.equal(result.status, "success");
  assert.equal(result.stateOperations?.[0]?.kind, "upsert_position");
  const updated = result.stateOperations?.[0]?.kind === "upsert_position" ? result.stateOperations[0].position : undefined;
  assert.equal(updated?.totalFeesClaimedSol, 0.05);
  assert.ok(updated?.lastClaimedAt);
  assert.ok(updated?.lastFeeCheckAt);
});

test("DryRunExecutionBackend paper claim 会领取未领取虚拟手续费并清零", async () => {
  const position = createPositionRecord({
    id: "position-paper-claim-1",
    depositedSol: 2,
    totalFeesClaimedSol: 0.03,
    paper: {
      entryActiveBinId: 8_000,
      entryPrice: 1,
      currentValueSol: 2.25,
      unclaimedFeesSol: 0.11
    }
  });
  const result = await createBackend().execute(
    {
      id: "action-paper-claim-1",
      type: "claim",
      trigger: "interval",
      reason: "claim",
      positionId: position.id
    },
    {
      availableCapitalSol: 5,
      position
    }
  );

  const updated = result.stateOperations?.[0]?.kind === "upsert_position" ? result.stateOperations[0].position : undefined;
  assert.equal(updated?.totalFeesClaimedSol, 0.14);
  assert.equal(updated?.paper?.unclaimedFeesSol, 0);
  assert.equal(updated?.paper?.currentValueSol, 2.14);
});

test("DryRunExecutionBackend paper close 会按当前 mark value 和已领取手续费回收", async () => {
  const position = createPositionRecord({
    id: "position-paper-close-1",
    depositedSol: 2,
    pnlPercent: 20,
    totalFeesClaimedSol: 0.2,
    paper: {
      entryActiveBinId: 8_000,
      entryPrice: 1,
      currentValueSol: 2.5,
      unclaimedFeesSol: 0.1
    }
  });
  const result = await createBackend().execute(
    {
      id: "action-paper-close-1",
      type: "close",
      trigger: "manual",
      reason: "close",
      positionId: position.id
    },
    {
      availableCapitalSol: 5,
      position
    }
  );

  assert.equal(result.stateOperations?.[0]?.kind, "adjust_capital");
  assert.equal(result.stateOperations?.[0]?.kind === "adjust_capital" ? result.stateOperations[0].deltaSol : undefined, 2.7);
});

test("DryRunExecutionBackend 启用成本模型后会落账成本并扣减资金", async () => {
  const config = createAgentConfig();
  config.cost_model = {
    enabled: true,
    network_fee_lamports: 5_000,
    priority_fee_lamports: 0,
    jito_tip_lamports: 0,
    rent_per_position_sol: 0.002,
    slippage_bps: 100,
    rebalance_slippage_bps: 100,
    failed_tx_fee_lamports: 0
  };
  const action = createOpenAction({
    amountSol: 1
  });
  const result = await createBackend(config).execute(action, { availableCapitalSol: 10 });
  const delta = result.stateOperations?.[0]?.kind === "adjust_capital" ? result.stateOperations[0].deltaSol : undefined;
  const position = result.stateOperations?.[1]?.kind === "upsert_position" ? result.stateOperations[1].position : undefined;

  assert.equal(delta?.toFixed(6), "-1.012005");
  assert.equal(position?.costsPaidSol?.toFixed(6), "0.012005");
  assert.equal((result.metadata?.costEstimate as { totalSol?: number } | undefined)?.totalSol?.toFixed(6), "0.012005");
});
