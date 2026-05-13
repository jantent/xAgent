import assert from "node:assert/strict";
import test from "node:test";

import type { AuditEventRecord } from "../../src/audit/contracts.js";
import { SharedState } from "../../src/core/shared-state.js";
import { reconcileStartupState } from "../../src/app/startup-reconciliation.js";
import { loadKeypairFromSecret } from "../../src/execution/solana/signer-utils.js";
import { createAgentConfig, createOpenAction, createPositionRecord } from "../helpers/factories.js";
import { createAuditLoggerSpy } from "../helpers/fakes.js";
import { createTestLogger } from "../helpers/logger.js";

test("reconcileStartupState 会在 close_missing 策略下自动关闭链上已不存在的活跃仓位", async () => {
  const config = createAgentConfig();
  config.execution!.mode = "live_sdk";
  config.guardrails = {
    ...config.guardrails,
    active_position_reconcile: "close_missing"
  };

  const secret = JSON.stringify(Array.from({ length: 32 }, (_, index) => index + 1));
  const signer = loadKeypairFromSecret(secret);
  config.wallet.active_address = signer.publicKey.toBase58();

  const missingPosition = createPositionRecord({
    id: "position-missing",
    positionPubkey: "position-pubkey-missing",
    walletAddress: signer.publicKey.toBase58()
  });
  const existingPosition = createPositionRecord({
    id: "position-existing",
    positionPubkey: "position-pubkey-existing",
    walletAddress: signer.publicKey.toBase58()
  });

  const state = new SharedState({
    initialSnapshot: {
      allPositions: [missingPosition, existingPosition]
    }
  });
  const auditLogger = createAuditLoggerSpy();

  await reconcileStartupState(config, {
    walletSecret: {
      secret,
      source: "plaintext_env",
      allowSecretForwarding: false
    },
    state,
    auditLogger,
    logger: createTestLogger(),
    checkPositionAccountExists: async (positionPubkey) => positionPubkey === existingPosition.positionPubkey
  });

  assert.equal(state.getActivePositions().length, 1);
  assert.equal(state.getActivePositions()[0]?.id, existingPosition.id);
  assert.equal(state.getPosition(missingPosition.id)?.status, "closed");
  assert.equal(auditLogger.phases.length, 1);
  assert.equal(auditLogger.phases[0]?.phase, "startup_reconcile");
  assert.deepEqual(auditLogger.phases[0]?.metadata.reconciledMissingPositionIds, [missingPosition.id]);
});

test("reconcileStartupState 在危险漂移下不会静默修复", async () => {
  const config = createAgentConfig();
  config.execution!.mode = "live_sdk";
  config.guardrails = {
    ...config.guardrails,
    active_position_reconcile: "close_missing"
  };

  const secret = JSON.stringify(Array.from({ length: 32 }, (_, index) => index + 1));
  const signer = loadKeypairFromSecret(secret);
  config.wallet.active_address = signer.publicKey.toBase58();

  const state = new SharedState({
    initialSnapshot: {
      allPositions: [
        createPositionRecord({
          id: "position-1",
          positionPubkey: "position-pubkey-1",
          walletAddress: "wrong-wallet"
        })
      ]
    }
  });

  await assert.rejects(
    reconcileStartupState(config, {
      walletSecret: {
        secret,
        source: "plaintext_env",
        allowSecretForwarding: false
      },
      state,
      auditLogger: createAuditLoggerSpy(),
      logger: createTestLogger(),
      checkPositionAccountExists: async () => false
    }),
    /walletAddress=.*与 signer=.*不一致/
  );
});

test("reconcileStartupState 在 fail 策略下保持只读", async () => {
  const config = createAgentConfig();
  config.execution!.mode = "live_sdk";
  config.guardrails = {
    ...config.guardrails,
    active_position_reconcile: "fail"
  };

  const secret = JSON.stringify(Array.from({ length: 32 }, (_, index) => index + 1));
  const signer = loadKeypairFromSecret(secret);
  config.wallet.active_address = signer.publicKey.toBase58();

  const position = createPositionRecord({
    id: "position-1",
    positionPubkey: "position-pubkey-1",
    walletAddress: signer.publicKey.toBase58()
  });
  const state = new SharedState({
    initialSnapshot: {
      allPositions: [position]
    }
  });
  const auditLogger = createAuditLoggerSpy();

  await reconcileStartupState(config, {
    walletSecret: {
      secret,
      source: "plaintext_env",
      allowSecretForwarding: false
    },
    state,
    auditLogger,
    logger: createTestLogger(),
    checkPositionAccountExists: async () => false
  });

  assert.equal(state.getPosition(position.id)?.status, "active");
  assert.equal(auditLogger.phases.length, 0);
});

test("reconcileStartupState 会回放最近审计中的 stateOperations 以修复本地未落盘成功动作", async () => {
  const config = createAgentConfig();
  config.execution!.mode = "live_sdk";
  config.guardrails = {
    ...config.guardrails,
    active_position_reconcile: "repair"
  };

  const secret = JSON.stringify(Array.from({ length: 32 }, (_, index) => index + 1));
  const signer = loadKeypairFromSecret(secret);
  config.wallet.active_address = signer.publicKey.toBase58();

  const recoveredPosition = createPositionRecord({
    id: "position-recovered",
    positionPubkey: "position-pubkey-recovered",
    walletAddress: signer.publicKey.toBase58()
  });
  const state = new SharedState({
    initialSnapshot: {
      availableCapitalSol: 10,
      allPositions: []
    }
  });

  const auditReader = {
    async readRecent(): Promise<AuditEventRecord[]> {
      return [
        {
          source: "actions",
          timestamp: "2026-03-31T12:00:00.000Z",
          payload: {
            action: {
              id: "action-open-recovered",
              type: "open",
              trigger: "scheduled",
              reason: "recover me"
            },
            result: {
              txSignatures: ["tx-1"],
              stateOperations: [
                {
                  kind: "adjust_capital",
                  deltaSol: -1.2
                },
                {
                  kind: "upsert_position",
                  position: {
                    ...recoveredPosition,
                    openedAt: recoveredPosition.openedAt.toISOString(),
                    maxAliveUntil: recoveredPosition.maxAliveUntil.toISOString()
                  }
                }
              ]
            }
          }
        }
      ];
    }
  };

  await reconcileStartupState(config, {
    walletSecret: {
      secret,
      source: "plaintext_env",
      allowSecretForwarding: false
    },
    state,
    auditLogger: createAuditLoggerSpy(),
    auditReader,
    logger: createTestLogger(),
    checkPositionAccountExists: async () => true
  });

  assert.equal(state.getPosition(recoveredPosition.id)?.positionPubkey, recoveredPosition.positionPubkey);
  assert.equal(state.hasAppliedAction("action-open-recovered"), true);
  assert.equal(state.getAvailableCapitalSol(), 8.8);
});

test("reconcileStartupState 会在 repair 策略下恢复 pending close 动作", async () => {
  const config = createAgentConfig();
  config.execution!.mode = "live_sdk";
  config.guardrails = {
    ...config.guardrails,
    active_position_reconcile: "repair"
  };

  const secret = JSON.stringify(Array.from({ length: 32 }, (_, index) => index + 1));
  const signer = loadKeypairFromSecret(secret);
  config.wallet.active_address = signer.publicKey.toBase58();

  const position = createPositionRecord({
    id: "position-close-pending",
    positionPubkey: "position-pubkey-close-pending",
    walletAddress: signer.publicKey.toBase58()
  });
  const state = new SharedState({
    initialSnapshot: {
      allPositions: [position],
      pendingActions: [
        {
          action: {
            id: "action-close-pending",
            type: "close",
            trigger: "manual",
            reason: "restart recovery",
            positionId: position.id
          },
          startedAt: new Date("2026-03-31T12:00:00.000Z"),
          availableCapitalSol: 10,
          positionSnapshot: position
        }
      ]
    }
  });

  await reconcileStartupState(config, {
    walletSecret: {
      secret,
      source: "plaintext_env",
      allowSecretForwarding: false
    },
    state,
    auditLogger: createAuditLoggerSpy(),
    logger: createTestLogger(),
    checkPositionAccountExists: async () => false
  });

  assert.equal(state.getPosition(position.id)?.status, "closed");
  assert.equal(state.getPendingActions().length, 0);
  assert.equal(state.hasAppliedAction("action-close-pending"), true);
});

test("reconcileStartupState 会在 live_gateway repair 策略下按远端镜像修复本地 active positions", async () => {
  const config = createAgentConfig();
  config.execution!.mode = "live_gateway";
  config.guardrails = {
    ...config.guardrails,
    active_position_reconcile: "repair"
  };

  const secret = JSON.stringify(Array.from({ length: 32 }, (_, index) => index + 1));
  const signer = loadKeypairFromSecret(secret);
  config.wallet.active_address = signer.publicKey.toBase58();

  const localOnly = createPositionRecord({
    id: "position-local-only",
    positionPubkey: "position-local-only-pubkey",
    walletAddress: signer.publicKey.toBase58()
  });
  const staleLocal = createPositionRecord({
    id: "position-shared",
    positionPubkey: "position-shared-stale",
    walletAddress: signer.publicKey.toBase58(),
    fromBinId: 1,
    toBinId: 2
  });
  const mirroredShared = createPositionRecord({
    id: "position-shared",
    positionPubkey: "position-shared-fresh",
    walletAddress: signer.publicKey.toBase58(),
    fromBinId: 10,
    toBinId: 20
  });
  const mirroredNew = createPositionRecord({
    id: "position-remote-new",
    positionPubkey: "position-remote-new-pubkey",
    walletAddress: signer.publicKey.toBase58()
  });
  const state = new SharedState({
    initialSnapshot: {
      allPositions: [localOnly, staleLocal]
    }
  });

  await reconcileStartupState(config, {
    walletSecret: {
      secret,
      source: "plaintext_env",
      allowSecretForwarding: false
    },
    state,
    auditLogger: createAuditLoggerSpy(),
    logger: createTestLogger(),
    listMirroredActivePositions: async () => [mirroredShared, mirroredNew]
  });

  assert.equal(state.getPosition(localOnly.id)?.status, "closed");
  assert.equal(state.getPosition(mirroredShared.id)?.positionPubkey, mirroredShared.positionPubkey);
  assert.equal(state.getPosition(mirroredShared.id)?.status, "active");
  assert.equal(state.getPosition(mirroredNew.id)?.status, "active");
});
