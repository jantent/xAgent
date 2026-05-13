import assert from "node:assert/strict";
import test from "node:test";

import { PoolScout } from "../../src/modules/pool-scout.js";
import { createPoolCandidate } from "../helpers/factories.js";
import { createTestLogger } from "../helpers/logger.js";

test("PoolScout 在 provider 默认兜底时保留池子源自带分数", async () => {
  const pool = createPoolCandidate({
    safetyScore: 76,
    smartMoneyNet: 42_000
  });
  const scout = new PoolScout(
    {
      name: "pool_source",
      async discoverPools() {
        return [pool];
      },
      async healthCheck() {
        return {
          provider: "pool_source",
          ok: true,
          canRead: true,
          canWrite: false,
          lastCheckedAt: new Date(),
          consecutiveFailures: 0
        };
      }
    },
    {
      async getTokenSafety(mint: string) {
        return {
          mint,
          safetyScore: 0,
          verdict: "UNKNOWN" as const,
          source: "default_fallback",
          isStale: true
        };
      },
      async getSmartMoneyFlow(mint: string) {
        return {
          mint,
          buy24h: 0,
          sell24h: 0,
          net24h: 0,
          source: "default_fallback",
          isStale: true
        };
      }
    } as any,
    {
      async chat() {
        return {
          id: "mock",
          provider: "mock",
          model: "mock",
          content: "静态叙事",
          latencyMs: 0
        };
      }
    } as any,
    createTestLogger()
  );

  const candidates = await scout.discoverAndScore("cycle-test");

  assert.equal(candidates[0]?.safetyScore, 76);
  assert.equal(candidates[0]?.smartMoneyNet, 42_000);
  assert.match(candidates[0]?.reasons.join(" ") ?? "", /安全分较高/);
});
