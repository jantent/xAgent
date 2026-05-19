import assert from "node:assert/strict";
import test from "node:test";

import {
  enforceRuntimeGuardrails,
  resolveRuntimeGuardrails,
  validateMirroredActivePositions
} from "../../src/app/runtime-guardrails.js";
import { loadKeypairFromSecret } from "../../src/execution/solana/signer-utils.js";
import { createAgentConfig, createPositionRecord } from "../helpers/factories.js";

function createRpcManager(canWrite: boolean, lastError?: string) {
  return {
    async healthCheck() {},
    getHealth() {
      return {
        canWrite,
        statuses: [
          {
            provider: "rpc_primary",
            ...(lastError ? { lastError } : {})
          }
        ]
      };
    }
  };
}

function enableStrictLivePreflightConfig(config: ReturnType<typeof createAgentConfig>): void {
  config.cost_model = {
    ...config.cost_model,
    enabled: true
  };
  config.risk.filters = {
    enabled: true
  };
}

test("resolveRuntimeGuardrails 在未配置时返回兼容默认值", () => {
  const config = createAgentConfig();
  delete config.guardrails;

  assert.deepEqual(resolveRuntimeGuardrails(config), {
    allow_mock_data: true,
    allow_mock_llm: true,
    require_live_preflight: false,
    active_position_reconcile: "fail",
    persist_failure_strategy: "close_only_then_pause"
  });
});

test("enforceRuntimeGuardrails 会在 live preflight 下拒绝未加载钱包", async () => {
  const config = createAgentConfig();
  config.execution!.mode = "live_sdk";
  config.guardrails = {
    require_live_preflight: true
  };
  enableStrictLivePreflightConfig(config);

  await assert.rejects(
    enforceRuntimeGuardrails(config, {
      walletSecret: null,
      rpcManager: createRpcManager(true),
      storage: {
        stateStoreKind: "sqlite"
      }
    }),
    /钱包 secret 未加载/
  );
});

test("enforceRuntimeGuardrails 会校验 active_address 与 signer 一致", async () => {
  const config = createAgentConfig();
  config.execution!.mode = "live_sdk";
  config.guardrails = {
    require_live_preflight: true
  };
  enableStrictLivePreflightConfig(config);

  const secret = JSON.stringify(Array.from({ length: 32 }, (_, index) => index + 1));
  const signer = loadKeypairFromSecret(secret);
  config.wallet.active_address = signer.publicKey.toBase58();

  await assert.doesNotReject(
    enforceRuntimeGuardrails(config, {
      walletSecret: {
        secret,
        source: "plaintext_env",
        allowSecretForwarding: false
      },
      rpcManager: createRpcManager(true),
      storage: {
        stateStoreKind: "sqlite"
      }
    })
  );

  config.wallet.active_address = "mismatched-address";
  await assert.rejects(
    enforceRuntimeGuardrails(config, {
      walletSecret: {
        secret,
        source: "plaintext_env",
        allowSecretForwarding: false
      },
      rpcManager: createRpcManager(true),
      storage: {
        stateStoreKind: "sqlite"
      }
    }),
    /不一致/
  );
});

test("enforceRuntimeGuardrails 会在 live preflight 下拒绝不可写 RPC", async () => {
  const config = createAgentConfig();
  config.execution!.mode = "live_sdk";
  config.guardrails = {
    require_live_preflight: true
  };
  enableStrictLivePreflightConfig(config);

  const secret = JSON.stringify(Array.from({ length: 32 }, (_, index) => index + 1));
  const signer = loadKeypairFromSecret(secret);
  config.wallet.active_address = signer.publicKey.toBase58();

  await assert.rejects(
    enforceRuntimeGuardrails(config, {
      walletSecret: {
        secret,
        source: "plaintext_env",
        allowSecretForwarding: false
      },
      rpcManager: createRpcManager(false, "rpc_primary timeout"),
      storage: {
        stateStoreKind: "sqlite"
      }
    }),
    /无可写 RPC/
  );
});

test("enforceRuntimeGuardrails 会在主数据源不可用时拒绝启动", async () => {
  const config = createAgentConfig();
  config.execution!.mode = "live_sdk";
  config.guardrails = {
    require_live_preflight: true
  };
  enableStrictLivePreflightConfig(config);

  const secret = JSON.stringify(Array.from({ length: 32 }, (_, index) => index + 1));
  const signer = loadKeypairFromSecret(secret);
  config.wallet.active_address = signer.publicKey.toBase58();

  await assert.rejects(
    enforceRuntimeGuardrails(config, {
      walletSecret: {
        secret,
        source: "plaintext_env",
        allowSecretForwarding: false
      },
      rpcManager: createRpcManager(true),
      checkDataProviders: async () => ({
        hasAnyProvider: true,
        hasPrimaryProvider: false,
        providerErrors: ["gmgn: timeout"]
      }),
      storage: {
        stateStoreKind: "sqlite"
      }
    }),
    /主数据源不可用/
  );
});

test("enforceRuntimeGuardrails 会在 execution dependency 校验失败时拒绝启动", async () => {
  const config = createAgentConfig();
  config.execution!.mode = "live_sdk";
  config.guardrails = {
    require_live_preflight: true
  };
  enableStrictLivePreflightConfig(config);

  const secret = JSON.stringify(Array.from({ length: 32 }, (_, index) => index + 1));
  const signer = loadKeypairFromSecret(secret);
  config.wallet.active_address = signer.publicKey.toBase58();

  await assert.rejects(
    enforceRuntimeGuardrails(config, {
      walletSecret: {
        secret,
        source: "plaintext_env",
        allowSecretForwarding: false
      },
      rpcManager: createRpcManager(true),
      checkDataProviders: async () => ({
        hasAnyProvider: true,
        hasPrimaryProvider: true
      }),
      checkPoolSource: async () => ({
        provider: "meteora_http",
        ok: true
      }),
      checkExecutionDependencies: async () => {
        throw new Error("Jupiter quote failed");
      },
      storage: {
        stateStoreKind: "sqlite"
      }
    }),
    /Jupiter quote failed/
  );
});

test("enforceRuntimeGuardrails 会校验活跃仓位与 signer / 链上账户一致", async () => {
  const config = createAgentConfig();
  config.execution!.mode = "live_sdk";
  config.guardrails = {
    require_live_preflight: true
  };
  enableStrictLivePreflightConfig(config);

  const secret = JSON.stringify(Array.from({ length: 32 }, (_, index) => index + 1));
  const signer = loadKeypairFromSecret(secret);
  config.wallet.active_address = signer.publicKey.toBase58();

  const activePosition = {
    id: "position-1",
    positionPubkey: "9xQeWvG816bUx9EPfEZm2sEJ7kT4tG8Sdt2d4n9AqA6Y",
    poolAddress: "DLMM111111111111111111111111111111111111111",
    tokenMint: "Mint111111111111111111111111111111111111111",
    tokenSymbol: "BONK",
    walletAddress: signer.publicKey.toBase58(),
    skillId: "bread_n_butter",
    skillVersion: "1.0.0",
    direction: "both" as const,
    fromBinId: -10,
    toBinId: 10,
    depositedSol: 1,
    currentValueUsd: 100,
    pnlPercent: 0,
    isInRange: true,
    totalFeesClaimedSol: 0,
    rebalanceCount: 0,
    status: "active" as const,
    entryLincolnScore: 8,
    openedAt: new Date("2026-01-01T00:00:00.000Z"),
    maxAliveUntil: new Date("2026-01-02T00:00:00.000Z")
  };

  await assert.doesNotReject(
    enforceRuntimeGuardrails(config, {
      walletSecret: {
        secret,
        source: "plaintext_env",
        allowSecretForwarding: false
      },
      rpcManager: createRpcManager(true),
      activePositions: [activePosition],
      checkDataProviders: async () => ({
        hasAnyProvider: true,
        hasPrimaryProvider: true
      }),
      checkPoolSource: async () => ({
        provider: "meteora_http",
        ok: true
      }),
      checkExecutionDependencies: async () => undefined,
      checkPositionAccountExists: async () => true,
      storage: {
        stateStoreKind: "sqlite"
      }
    })
  );

  await assert.rejects(
    enforceRuntimeGuardrails(config, {
      walletSecret: {
        secret,
        source: "plaintext_env",
        allowSecretForwarding: false
      },
      rpcManager: createRpcManager(true),
      activePositions: [
        {
          ...activePosition,
          walletAddress: "different-wallet"
        }
      ],
      checkDataProviders: async () => ({
        hasAnyProvider: true,
        hasPrimaryProvider: true
      }),
      checkPoolSource: async () => ({
        provider: "meteora_http",
        ok: true
      }),
      checkExecutionDependencies: async () => undefined,
      checkPositionAccountExists: async () => true,
      storage: {
        stateStoreKind: "sqlite"
      }
    }),
    /walletAddress/
  );

  await assert.rejects(
    enforceRuntimeGuardrails(config, {
      walletSecret: {
        secret,
        source: "plaintext_env",
        allowSecretForwarding: false
      },
      rpcManager: createRpcManager(true),
      activePositions: [activePosition],
      checkDataProviders: async () => ({
        hasAnyProvider: true,
        hasPrimaryProvider: true
      }),
      checkPoolSource: async () => ({
        provider: "meteora_http",
        ok: true
      }),
      checkExecutionDependencies: async () => undefined,
      checkPositionAccountExists: async () => false,
      storage: {
        stateStoreKind: "sqlite"
      }
    }),
    /链上账户/
  );
});

test("validateMirroredActivePositions 会要求 gateway 端活跃仓位与本地完全一致", () => {
  const signerAddress = "wallet-1";
  const localPosition = createPositionRecord({
    id: "position-1",
    positionPubkey: "position-pubkey-1",
    walletAddress: signerAddress
  });
  const mirroredPosition = createPositionRecord({
    id: "position-1",
    positionPubkey: "position-pubkey-1",
    walletAddress: signerAddress
  });

  assert.doesNotThrow(() => {
    validateMirroredActivePositions("execution gateway", signerAddress, [localPosition], [mirroredPosition]);
  });

  assert.throws(
    () =>
      validateMirroredActivePositions("execution gateway", signerAddress, [localPosition], [
        createPositionRecord({
          id: "position-2",
          positionPubkey: "position-pubkey-2",
          walletAddress: signerAddress
        })
      ]),
    /execution gateway/
  );
});
