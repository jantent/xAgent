import assert from "node:assert/strict";
import test from "node:test";

import { Keypair } from "@solana/web3.js";

import { LiveSdkExecutionBackend } from "../../src/execution/backends/live-sdk-execution-backend.js";
import type { LoadedWalletSecret } from "../../src/wallet/wallet-secret-manager.js";
import { createAgentConfig, createOpenAction } from "../helpers/factories.js";
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

function createRpcManager(url: string) {
  return {
    getActiveEndpoint() {
      return {
        name: "primary",
        url
      };
    }
  };
}

function createWalletSecret(): LoadedWalletSecret {
  return {
    secret: JSON.stringify(Array.from(Keypair.generate().secretKey)),
    source: "plaintext_env",
    keyVersion: "v1",
    allowSecretForwarding: false
  };
}

test("LiveSdkExecutionBackend 在缺少真实 RPC 配置时标记 unhealthy", async () => {
  await withEnv(
    {
      PRIMARY_RPC_URL: undefined,
      HELIUS_RPC_URL: undefined
    },
    async () => {
      const config = createAgentConfig();
      config.execution!.mode = "live_sdk";

      const backend = new LiveSdkExecutionBackend(
        config,
        createRpcManager("simulated://primary") as never,
        null,
        {} as never,
        {} as never,
        createTestLogger()
      );

      const status = backend.getStatus();
      assert.equal(status.healthy, false);
      assert.match(status.lastError ?? "", /缺少可写 RPC URL/);
    }
  );
});

test("LiveSdkExecutionBackend 会在缺少 signer 时拒绝开仓", async () => {
  await withEnv(
    {
      PRIMARY_RPC_URL: "https://rpc.example"
    },
    async () => {
      const config = createAgentConfig();
      config.execution!.mode = "live_sdk";

      const backend = new LiveSdkExecutionBackend(
        config,
        createRpcManager("https://rpc.example") as never,
        null,
        {} as never,
        {} as never,
        createTestLogger()
      );

      await assert.rejects(
        () => backend.execute(createOpenAction(), { availableCapitalSol: 10 }),
        /未加载可用的钱包密钥/
      );

      const status = backend.getStatus();
      assert.equal(status.healthy, false);
      assert.match(status.lastError ?? "", /未加载可用的钱包密钥/);
    }
  );
});

test("LiveSdkExecutionBackend 会在当前 endpoint 仍是 simulated RPC 时拒绝执行", async () => {
  await withEnv(
    {
      PRIMARY_RPC_URL: "https://rpc.example"
    },
    async () => {
      const config = createAgentConfig();
      config.execution!.mode = "live_sdk";

      const backend = new LiveSdkExecutionBackend(
        config,
        createRpcManager("simulated://primary") as never,
        createWalletSecret(),
        {} as never,
        {} as never,
        createTestLogger()
      );

      await assert.rejects(
        () => backend.execute(createOpenAction(), { availableCapitalSol: 10 }),
        /缺少真实 RPC 连接/
      );

      const status = backend.getStatus();
      assert.equal(status.healthy, false);
      assert.match(status.lastError ?? "", /缺少真实 RPC 连接/);
    }
  );
});

test("LiveSdkExecutionBackend 会在动作未启用时直接跳过", async () => {
  await withEnv(
    {
      PRIMARY_RPC_URL: "https://rpc.example"
    },
    async () => {
      const config = createAgentConfig();
      config.execution!.mode = "live_sdk";
      config.execution!.live!.supported_actions = ["close"];

      const backend = new LiveSdkExecutionBackend(
        config,
        createRpcManager("simulated://primary") as never,
        null,
        {} as never,
        {} as never,
        createTestLogger()
      );

      const result = await backend.execute(createOpenAction(), { availableCapitalSol: 10 });

      assert.equal(result.status, "skipped");
      assert.match(result.message, /未启用 open 动作/);
    }
  );
});
