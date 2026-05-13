import assert from "node:assert/strict";
import test from "node:test";

import {
  GmgnCliDataProvider,
  type GmgnCliCommandRunner
} from "../../../src/providers/data/gmgn-cli-data-provider.js";
import { createTestLogger } from "../../helpers/logger.js";

function createProvider(outputs: Record<string, unknown>) {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const runner: GmgnCliCommandRunner = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    const key = args.slice(0, 2).join(" ");
    const output = outputs[key];
    if (output === undefined) {
      throw new Error(`missing fake output for ${key}`);
    }

    return {
      stdout: typeof output === "string" ? output : JSON.stringify(output)
    };
  };

  return {
    provider: new GmgnCliDataProvider({
      name: "gmgn",
      priority: 1,
      command: "gmgn-cli",
      chain: "sol",
      apiKeyEnv: "GMGN_API_KEY",
      apiKey: "test-key",
      timeoutMs: 1000,
      logger: createTestLogger("gmgn_cli"),
      runCommand: runner
    }),
    calls
  };
}

test("GmgnCliDataProvider 会用 gmgn-cli trending 健康检查并注入 API key", async () => {
  const { provider, calls } = createProvider({
    "market trending": { data: { rank: [{ address: "MintA", symbol: "AAA", volume_1h: 12 }] } }
  });

  const health = await provider.healthCheck();

  assert.equal(health.ok, true);
  assert.equal(calls[0]?.command, "gmgn-cli");
  assert.match(calls[0]?.env.NODE_OPTIONS ?? "", /--dns-result-order=ipv4first/);
  assert.deepEqual(calls[0]?.args, [
    "market",
    "trending",
    "--chain",
    "sol",
    "--interval",
    "1h",
    "--limit",
    "1",
    "--raw"
  ]);
  assert.equal(calls[0]?.env.GMGN_API_KEY, "test-key");
});

test("GmgnCliDataProvider 会映射 token security 为安全分数", async () => {
  const { provider } = createProvider({
    "token security": {
      data: {
        address: "MintA",
        rug_ratio: 0.12,
        is_honeypot: "no",
        top_10_holder_rate: 0.22,
        renounced_mint: true,
        renounced_freeze_account: true
      }
    }
  });

  const safety = await provider.getTokenSafety("MintA");

  assert.equal(safety.mint, "MintA");
  assert.equal(safety.source, "gmgn");
  assert.equal(safety.rugProbability, 0.12);
  assert.equal(safety.topHolderPct, 0.22);
  assert.equal(safety.safetyScore, 88);
  assert.equal(safety.verdict, "SAFE");
});

test("GmgnCliDataProvider 会汇总 smart_degen trader 买卖流", async () => {
  const { provider, calls } = createProvider({
    "token traders": {
      data: {
        list: [
          { address: "WalletA", buy_volume_cur: 100, sell_volume_cur: 30 },
          { address: "WalletB", buy_volume_cur: "20", sell_volume_cur: "5" }
        ]
      }
    }
  });

  const flow = await provider.getSmartMoneyFlow("MintA");

  assert.equal(flow.buy24h, 120);
  assert.equal(flow.sell24h, 35);
  assert.equal(flow.net24h, 85);
  assert.equal(flow.isStale, false);
  assert.deepEqual(calls[0]?.args.slice(0, 10), [
    "token",
    "traders",
    "--chain",
    "sol",
    "--address",
    "MintA",
    "--tag",
    "smart_degen",
    "--limit",
    "50"
  ]);
});

test("GmgnCliDataProvider 会映射 trending 和 kline raw JSON", async () => {
  const { provider } = createProvider({
    "market trending": {
      data: {
        rank: [
          { address: "MintA", symbol: "AAA", volume_24h: 1000 },
          { token_address: "MintB", symbol: "BBB", volume_1h: 200 }
        ]
      }
    },
    "market kline": {
      data: {
        list: [{ timestamp: 1778550000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 99 }]
      }
    }
  });

  const trending = await provider.getTrendingTokens("sol", "1h");
  const candles = await provider.getOHLCV("MintA", "1h");

  assert.deepEqual(trending.map((item) => item.mint), ["MintA", "MintB"]);
  assert.equal(trending[0]?.rank, 1);
  assert.equal(trending[0]?.volume24h, 1000);
  assert.equal(candles.length, 1);
  assert.equal(candles[0]?.open, 1);
  assert.equal(candles[0]?.timestamp, 1778550000 * 1000);
});

test("GmgnCliDataProvider 获取 market signal 时不传不支持的 limit 参数", async () => {
  const { provider, calls } = createProvider({
    "market signal": {
      data: {
        list: [{ address: "MintA", signal_type: "dev_sell", message: "dev sold" }]
      }
    }
  });

  const signals = await provider.getUrgentSignals(["MintA"]);

  assert.equal(signals.length, 1);
  assert.deepEqual(calls[0]?.args, ["market", "signal", "--chain", "sol", "--raw"]);
});

test("GmgnCliDataProvider 会把 CLI 失败反映到健康检查", async () => {
  const runner: GmgnCliCommandRunner = async () => {
    throw new Error("gmgn-cli failed: 403");
  };
  const provider = new GmgnCliDataProvider({
    name: "gmgn",
    priority: 1,
    logger: createTestLogger("gmgn_cli"),
    runCommand: runner
  });

  const health = await provider.healthCheck();

  assert.equal(health.ok, false);
  assert.match(health.lastError ?? "", /403/);
});
