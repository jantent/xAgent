import assert from "node:assert/strict";
import test from "node:test";

import { LiveGatewayExecutionBackend } from "../../src/execution/backends/live-gateway-execution-backend.js";
import type { LoadedWalletSecret } from "../../src/wallet/wallet-secret-manager.js";
import { createAgentConfig, createOpenAction, createPositionRecord } from "../helpers/factories.js";
import { createTestLogger } from "../helpers/logger.js";

async function withEnv(
  values: Record<string, string | undefined>,
  fn: () => Promise<void>
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function createRpcManager(url = "https://rpc.example") {
  return {
    getActiveEndpoint() {
      return {
        name: "primary",
        url
      };
    }
  };
}

test("LiveGatewayExecutionBackend 在缺少 gateway 地址时标记 unhealthy", async () => {
  await withEnv(
    {
      EXECUTION_GATEWAY_URL: undefined
    },
    async () => {
      const config = createAgentConfig();
      config.execution!.mode = "live_gateway";

      const backend = new LiveGatewayExecutionBackend(
        config,
        createRpcManager() as never,
        null,
        {
          async healthCheck() {
            throw new Error("should not be called");
          },
          async execute() {
            throw new Error("should not be called");
          }
        } as never,
        createTestLogger()
      );

      const status = backend.getStatus();
      assert.equal(status.healthy, false);
      assert.match(status.lastError ?? "", /EXECUTION_GATEWAY_URL/);
    }
  );
});

test("LiveGatewayExecutionBackend 会在 health check 失败时拒绝执行", async () => {
  await withEnv(
    {
      EXECUTION_GATEWAY_URL: "https://gateway.example",
      EXECUTION_GATEWAY_API_KEY: "gateway-key"
    },
    async () => {
      const config = createAgentConfig();
      config.execution!.mode = "live_gateway";
      let executeCalled = false;

      const backend = new LiveGatewayExecutionBackend(
        config,
        createRpcManager() as never,
        null,
        {
          async healthCheck(options: { baseUrl: string; apiKey?: string }) {
            assert.equal(options.baseUrl, "https://gateway.example");
            assert.equal(options.apiKey, "gateway-key");
            return {
              healthy: false,
              error: "gateway down"
            };
          },
          async execute() {
            executeCalled = true;
            throw new Error("should not be called");
          }
        } as never,
        createTestLogger()
      );

      await assert.rejects(
        () => backend.execute(createOpenAction(), { availableCapitalSol: 10 }),
        /gateway down/
      );
      assert.equal(executeCalled, false);
      assert.equal(backend.getStatus().healthy, false);
      assert.match(backend.getStatus().lastError ?? "", /gateway down/);
    }
  );
});

test("LiveGatewayExecutionBackend 会拒绝向不安全地址透传钱包密钥", async () => {
  await withEnv(
    {
      EXECUTION_GATEWAY_URL: "http://gateway.example"
    },
    async () => {
      const config = createAgentConfig();
      config.execution!.mode = "live_gateway";
      const walletSecret: LoadedWalletSecret = {
        secret: "sensitive-wallet-secret",
        source: "plaintext_env",
        keyVersion: "v1",
        allowSecretForwarding: true
      };
      let healthCheckCalled = false;

      const backend = new LiveGatewayExecutionBackend(
        config,
        createRpcManager() as never,
        walletSecret,
        {
          async healthCheck() {
            healthCheckCalled = true;
            return {
              healthy: true
            };
          },
          async execute() {
            throw new Error("should not be called");
          }
        } as never,
        createTestLogger()
      );

      await assert.rejects(
        () => backend.execute(createOpenAction(), { availableCapitalSol: 10 }),
        /拒绝透传钱包密钥/
      );
      assert.equal(healthCheckCalled, false);
      assert.equal(backend.getStatus().healthy, false);
      assert.match(backend.getStatus().lastError ?? "", /拒绝透传钱包密钥/);
    }
  );
});

test("LiveGatewayExecutionBackend 会调用 gateway 并补充执行元数据", async () => {
  await withEnv(
    {
      EXECUTION_GATEWAY_URL: "https://gateway.example",
      EXECUTION_GATEWAY_API_KEY: "gateway-key"
    },
    async () => {
      const config = createAgentConfig();
      config.execution!.mode = "live_gateway";
      let capturedPayload: Record<string, unknown> | undefined;
      let capturedBaseUrl: string | undefined;

      const backend = new LiveGatewayExecutionBackend(
        config,
        createRpcManager() as never,
        null,
        {
          async healthCheck(options: { baseUrl: string }) {
            capturedBaseUrl = options.baseUrl;
            return {
              healthy: true
            };
          },
          async execute(options: { payload: Record<string, unknown> }) {
            capturedPayload = options.payload;
            return {
              actionId: options.payload.action && (options.payload.action as { id: string }).id,
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
                  position: createPositionRecord({
                    id: "position-opened",
                    walletAddress: config.wallet.active_address
                  })
                }
              ]
            };
          }
        } as never,
        createTestLogger()
      );

      const result = await backend.execute(createOpenAction(), { availableCapitalSol: 10 });

      assert.equal(capturedBaseUrl, "https://gateway.example");
      assert.equal(result.status, "success");
      assert.equal((result.metadata as Record<string, unknown>).backend, "live_gateway");
      assert.equal((result.metadata as Record<string, unknown>).gatewayTarget, "https://gateway.example");
      assert.equal((result.metadata as Record<string, unknown>).rpcProvider, "primary");

      const executionPayload = ((capturedPayload?.execution ?? {}) as Record<string, unknown>);
      const walletPayload = ((executionPayload.wallet ?? {}) as Record<string, unknown>);
      assert.equal(walletPayload.activeAddress, config.wallet.active_address);
      assert.equal(walletPayload.secret, undefined);

      const status = backend.getStatus();
      assert.equal(status.healthy, true);
      assert.ok(status.lastSuccessAt instanceof Date);
      assert.equal(status.lastError, undefined);
    }
  );
});
