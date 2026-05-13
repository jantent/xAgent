import assert from "node:assert/strict";
import test from "node:test";

import { SharedState } from "../../src/core/shared-state.js";
import { SystemMode } from "../../src/domain/models.js";
import { ExecutionLayer } from "../../src/execution/execution-layer.js";
import { createOpenAction, createPositionRecord } from "../helpers/factories.js";
import { createMetricsServiceSpy } from "../helpers/fakes.js";
import { createTestLogger } from "../helpers/logger.js";

test("ExecutionLayer 在成功时应用状态回写并记录指标", async () => {
  const state = new SharedState({
    initialSnapshot: {
      availableCapitalSol: 5,
      allPositions: []
    }
  });
  const metrics = createMetricsServiceSpy();
  const position = createPositionRecord({
    id: "position-opened",
    depositedSol: 1.4
  });
  const backend = {
    getStatus() {
      return {
        mode: "dry_run" as const,
        backend: "fake",
        dryRun: true,
        healthy: true,
        supportedActions: ["open" as const],
        submissionStrategy: "gateway_managed" as const
      };
    },
    async execute() {
      return {
        actionId: "action-open-1",
        type: "open" as const,
        status: "success" as const,
        message: "ok",
        txSignatures: ["tx-1"],
        latencyMs: 12,
        stateOperations: [
          {
            kind: "adjust_capital" as const,
            deltaSol: -1.4
          },
          {
            kind: "upsert_position" as const,
            position
          }
        ]
      };
    }
  };

  const layer = new ExecutionLayer(
    state,
    metrics as never,
    backend,
    createTestLogger()
  );

  const result = await layer.execute(createOpenAction());

  assert.equal(result.status, "success");
  assert.equal(state.getAvailableCapitalSol(), 3.6);
  assert.equal(state.getPosition("position-opened")?.poolAddress, position.poolAddress);
  assert.equal(metrics.actionResults.length, 1);
});

test("ExecutionLayer 会把 backend 异常包装成 failed 结果", async () => {
  const state = new SharedState({
    initialSnapshot: {
      availableCapitalSol: 5,
      allPositions: []
    }
  });
  const metrics = createMetricsServiceSpy();
  const backend = {
    getStatus() {
      return {
        mode: "dry_run" as const,
        backend: "fake",
        dryRun: true,
        healthy: true,
        supportedActions: ["open" as const],
        submissionStrategy: "gateway_managed" as const
      };
    },
    async execute() {
      throw new Error("backend exploded");
    }
  };

  const layer = new ExecutionLayer(
    state,
    metrics as never,
    backend,
    createTestLogger()
  );

  const result = await layer.execute(createOpenAction());

  assert.equal(result.status, "failed");
  assert.match(result.message, /backend exploded/);
  assert.equal(state.getAvailableCapitalSol(), 5);
  assert.equal(metrics.actionResults.length, 1);
});

test("ExecutionLayer 会拒绝缺少状态回写的成功 mutating action", async () => {
  const state = new SharedState({
    initialSnapshot: {
      availableCapitalSol: 5,
      allPositions: []
    }
  });
  const metrics = createMetricsServiceSpy();
  const backend = {
    getStatus() {
      return {
        mode: "live_gateway" as const,
        backend: "gateway",
        dryRun: false,
        healthy: true,
        supportedActions: ["open" as const],
        submissionStrategy: "gateway_managed" as const
      };
    },
    async execute() {
      return {
        actionId: "action-open-1",
        type: "open" as const,
        status: "success" as const,
        message: "ok",
        txSignatures: ["tx-1"],
        latencyMs: 12
      };
    }
  };

  const layer = new ExecutionLayer(
    state,
    metrics as never,
    backend,
    createTestLogger()
  );

  const result = await layer.execute(createOpenAction());

  assert.equal(result.status, "failed");
  assert.match(result.message, /缺少状态回写操作/);
  assert.equal(state.getAllPositions().length, 0);
});

test("ExecutionLayer 会跳过已处理过的重复 action", async () => {
  let executed = false;
  const state = new SharedState({
    initialSnapshot: {
      availableCapitalSol: 5,
      allPositions: [],
      appliedActionIds: ["action-open-1"]
    }
  });
  const metrics = createMetricsServiceSpy();
  const backend = {
    getStatus() {
      return {
        mode: "dry_run" as const,
        backend: "fake",
        dryRun: true,
        healthy: true,
        supportedActions: ["open" as const],
        submissionStrategy: "gateway_managed" as const
      };
    },
    async execute() {
      executed = true;
      throw new Error("should not run");
    }
  };

  const layer = new ExecutionLayer(
    state,
    metrics as never,
    backend,
    createTestLogger()
  );

  const result = await layer.execute(createOpenAction());

  assert.equal(result.status, "skipped");
  assert.match(result.message, /已处理/);
  assert.equal(executed, false);
  assert.equal(metrics.actionResults.length, 0);
});

test("ExecutionLayer 在 close_only 下会拒绝 open / claim / rebalance", async () => {
  let executed = false;
  const state = new SharedState({
    initialSnapshot: {
      mode: SystemMode.CLOSE_ONLY,
      availableCapitalSol: 5,
      allPositions: []
    }
  });
  const metrics = createMetricsServiceSpy();
  const backend = {
    getStatus() {
      return {
        mode: "live_sdk" as const,
        backend: "fake",
        dryRun: false,
        healthy: true,
        supportedActions: ["open" as const],
        submissionStrategy: "rpc" as const
      };
    },
    async execute() {
      executed = true;
      throw new Error("should not execute");
    }
  };

  const layer = new ExecutionLayer(state, metrics as never, backend, createTestLogger());
  const result = await layer.execute(createOpenAction());

  assert.equal(result.status, "skipped");
  assert.match(result.message, /close_only/);
  assert.equal(executed, false);
});

test("ExecutionLayer 会在执行前无法持久化 pending action 时阻断真实执行", async () => {
  let executed = false;
  const state = new SharedState({
    initialSnapshot: {
      availableCapitalSol: 5,
      allPositions: []
    },
    onChange: async () => {
      throw new Error("persist failed");
    },
    logger: createTestLogger(),
    persistFailureStrategy: "close_only_then_pause"
  });
  const metrics = createMetricsServiceSpy();
  const backend = {
    getStatus() {
      return {
        mode: "live_sdk" as const,
        backend: "fake",
        dryRun: false,
        healthy: true,
        supportedActions: ["open" as const],
        submissionStrategy: "rpc" as const
      };
    },
    async execute() {
      executed = true;
      return {
        actionId: "action-open-1",
        type: "open" as const,
        status: "success" as const,
        message: "ok",
        txSignatures: ["tx-1"],
        latencyMs: 1,
        stateOperations: []
      };
    }
  };

  const layer = new ExecutionLayer(state, metrics as never, backend, createTestLogger());
  const result = await layer.execute(createOpenAction());

  assert.equal(result.status, "failed");
  assert.match(result.message, /执行前无法持久化处理中动作/);
  assert.equal(executed, false);
  assert.equal(state.isManualPause(), false);
  assert.equal(state.getMode(), SystemMode.CLOSE_ONLY);
});
