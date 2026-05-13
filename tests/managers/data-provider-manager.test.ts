import assert from "node:assert/strict";
import test from "node:test";

import type { IDataProvider } from "../../src/domain/contracts.js";
import { DataProviderManager } from "../../src/managers/data-provider-manager.js";
import { MemoryCacheStore } from "../../src/persistence/memory-cache-store.js";
import { createAgentConfig } from "../helpers/factories.js";
import { createTestLogger } from "../helpers/logger.js";

function createProvider(name: string, priority: number, options: {
  getTokenSafety?: (mint: string) => Promise<unknown>;
  getSmartMoneyFlow?: (mint: string) => Promise<unknown>;
  getUrgentSignals?: (tokenMints: string[]) => Promise<unknown>;
  healthCheck?: () => Promise<unknown>;
}): IDataProvider {
  return {
    name,
    priority,
    async getTokenSafety(mint) {
      if (!options.getTokenSafety) {
        throw new Error(`${name}:getTokenSafety not implemented`);
      }

      return await options.getTokenSafety(mint) as never;
    },
    async getSmartMoneyFlow(mint) {
      if (!options.getSmartMoneyFlow) {
        throw new Error(`${name}:getSmartMoneyFlow not implemented`);
      }

      return await options.getSmartMoneyFlow(mint) as never;
    },
    async getTrendingTokens() {
      return [];
    },
    async getOHLCV() {
      return [];
    },
    async getUrgentSignals(tokenMints) {
      if (!options.getUrgentSignals) {
        return [];
      }

      return await options.getUrgentSignals(tokenMints) as never;
    },
    async healthCheck() {
      if (!options.healthCheck) {
        return {
          provider: name,
          ok: true,
          canRead: true,
          canWrite: false,
          lastCheckedAt: new Date(),
          consecutiveFailures: 0
        };
      }

      return await options.healthCheck() as never;
    }
  };
}

test("DataProviderManager 会回退到下一个 provider，并复用缓存", async () => {
  const config = createAgentConfig();
  const cacheStore = new MemoryCacheStore();
  let secondaryCalls = 0;
  const manager = new DataProviderManager(
    [
      createProvider("gmgn", 1, {
        async getTokenSafety() {
          throw new Error("primary failed");
        },
        async getSmartMoneyFlow() {
          throw new Error("primary failed");
        }
      }),
      createProvider("provider_a", 2, {
        async getTokenSafety(mint) {
          secondaryCalls += 1;
          return {
            mint,
            safetyScore: 88,
            verdict: "SAFE",
            source: "provider_a"
          };
        },
        async getSmartMoneyFlow(mint) {
          return {
            mint,
            buy24h: 10,
            sell24h: 4,
            net24h: 6,
            source: "provider_a"
          };
        }
      })
    ],
    config.data_providers,
    cacheStore,
    createTestLogger()
  );

  const first = await manager.getTokenSafety("MINT-1");
  const second = await manager.getTokenSafety("MINT-1");

  assert.equal(first.source, "provider_a");
  assert.equal(second.source, "provider_a");
  assert.equal(secondaryCalls, 1);
});

test("DataProviderManager 在所有 provider 失败时回退到过期缓存", async () => {
  const config = createAgentConfig();
  const cacheStore = new MemoryCacheStore();
  await cacheStore.set("safety:MINT-STALE", {
    valueJson: JSON.stringify({
      mint: "MINT-STALE",
      safetyScore: 55,
      verdict: "WARNING",
      source: "stale-cache"
    }),
    expiresAt: Date.now() - 1_000
  });

  const manager = new DataProviderManager(
    [
      createProvider("gmgn", 1, {
        async getTokenSafety() {
          throw new Error("boom");
        },
        async getSmartMoneyFlow() {
          throw new Error("boom");
        }
      })
    ],
    config.data_providers,
    cacheStore,
    createTestLogger()
  );

  const result = await manager.getTokenSafety("MINT-STALE");

  assert.equal(result.source, "stale-cache");
  assert.equal(result.safetyScore, 55);
});

test("DataProviderManager 会聚合紧急信号并忽略失败 provider", async () => {
  const config = createAgentConfig();
  const manager = new DataProviderManager(
    [
      createProvider("gmgn", 1, {
        async getTokenSafety() {
          throw new Error("not used");
        },
        async getSmartMoneyFlow() {
          throw new Error("not used");
        },
        async getUrgentSignals(tokenMints) {
          return [
            {
              provider: "gmgn",
              signalType: "rug",
              tokenMint: tokenMints[0],
              severity: "critical",
              message: "rug"
            }
          ];
        }
      }),
      createProvider("provider_a", 2, {
        async getTokenSafety() {
          throw new Error("not used");
        },
        async getSmartMoneyFlow() {
          throw new Error("not used");
        },
        async getUrgentSignals() {
          throw new Error("provider_a failed");
        }
      })
    ],
    config.data_providers,
    new MemoryCacheStore(),
    createTestLogger()
  );

  const summary = await manager.getUrgentSignals(["MINT-RUG"]);

  assert.equal(summary.hasRug, true);
  assert.equal(summary.signals.length, 1);
  assert.equal(summary.signals[0]?.tokenMint, "MINT-RUG");
});

test("DataProviderManager 会在健康快照中暴露连续全量不可用时长", async () => {
  const config = createAgentConfig();
  const now = Date.now();
  const manager = new DataProviderManager(
    [
      createProvider("gmgn", 1, {
        async healthCheck() {
          return {
            provider: "gmgn",
            ok: true,
            canRead: true,
            canWrite: false,
            lastCheckedAt: new Date(now - 20 * 60 * 1000),
            consecutiveFailures: 0
          };
        }
      })
    ],
    config.data_providers,
    new MemoryCacheStore(),
    createTestLogger()
  );

  await manager.healthCheck();
  const degraded = new DataProviderManager(
    [
      createProvider("gmgn", 1, {
        async healthCheck() {
          return {
            provider: "gmgn",
            ok: false,
            canRead: false,
            canWrite: false,
            lastCheckedAt: new Date(now),
            consecutiveFailures: 3
          };
        }
      })
    ],
    config.data_providers,
    new MemoryCacheStore(),
    createTestLogger()
  );

  (degraded as any).lastAnyProviderOkAt = new Date(now - 15 * 60 * 1000);
  const snapshot = await degraded.healthCheck();

  assert.equal(snapshot.hasAnyProvider, false);
  assert.ok((snapshot.allProvidersDownForMs ?? 0) >= 15 * 60 * 1000);
});
