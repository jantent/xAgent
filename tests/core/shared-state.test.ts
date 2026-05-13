import assert from "node:assert/strict";
import test from "node:test";

import { SharedState } from "../../src/core/shared-state.js";
import { SystemMode } from "../../src/domain/models.js";
import { createOpenAction, createPositionRecord } from "../helpers/factories.js";
import { createTestLogger } from "../helpers/logger.js";

test("SharedState 会记录持久化错误并在 flush 时抛出", async () => {
  const state = new SharedState({
    onChange: async () => {
      throw new Error("persist failed");
    },
    logger: createTestLogger()
  });

  state.setAvailableCapitalSol(42);

  await assert.rejects(state.flush(), /persist failed/);
  assert.equal(state.getLastPersistError(), "persist failed");
});

test("SharedState 会把 pending action 写入快照并支持增量补充 tx/meta", () => {
  const state = new SharedState();
  const action = createOpenAction({ id: "action-open-pending" });
  const position = createPositionRecord({ id: "position-pending" });

  state.beginPendingAction({
    action,
    startedAt: new Date("2026-03-31T12:00:00.000Z"),
    availableCapitalSol: 8,
    positionSnapshot: position
  });
  state.updatePendingAction(action.id, {
    txSignatures: ["tx-1", "tx-2"],
    metadata: {
      positionPubkey: "position-pubkey-new"
    }
  });

  const pending = state.getSnapshot().pendingActions ?? [];
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0]?.txSignatures, ["tx-1", "tx-2"]);
  assert.equal(pending[0]?.positionSnapshot?.id, position.id);
  assert.equal(pending[0]?.metadata?.positionPubkey, "position-pubkey-new");
});

test("SharedState 会在连续持久化失败时升级到 close_only 再 pause", async () => {
  const state = new SharedState({
    onChange: async () => {
      throw new Error("persist failed");
    },
    logger: createTestLogger(),
    persistFailureStrategy: "close_only_then_pause"
  });

  state.setAvailableCapitalSol(42);
  await assert.rejects(state.flush(), /persist failed/);
  assert.equal(state.getMode(), SystemMode.CLOSE_ONLY);
  assert.equal(state.isManualPause(), false);

  state.setAvailableCapitalSol(43);
  await assert.rejects(state.flush(), /persist failed/);
  assert.equal(state.getMode(), SystemMode.CLOSE_ONLY);
  assert.equal(state.isManualPause(), true);
});
