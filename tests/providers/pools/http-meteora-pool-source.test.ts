import assert from "node:assert/strict";
import test from "node:test";

import type { AgentConfig } from "../../../src/config/types.js";
import { HttpMeteoraPoolSource } from "../../../src/providers/pools/http-meteora-pool-source.js";
import { createTestLogger } from "../../helpers/logger.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

function createPoolPayload(address: string, symbol = "AAA") {
  return {
    address,
    current_price: 0.0025,
    fee_tvl_ratio: { "24h": 12.5 },
    fees: { "24h": 2500 },
    volume: { "24h": 250000 },
    pool_config: { bin_step: 20, base_fee_pct: 0.2 },
    token_x: {
      address: `${symbol}TokenMint1111111111111111111111111111`,
      symbol,
      market_cap: 500000
    },
    token_y: {
      address: SOL_MINT,
      symbol: "SOL"
    },
    tvl: 100000,
    is_blacklisted: false
  };
}

test("HttpMeteoraPoolSource 会按官方 datapi 参数请求并映射 token_x/token_y 响应", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    return new Response(
      JSON.stringify({
        data: [
          {
            address: "PoolA",
            current_price: 0.0025,
            fee_tvl_ratio: { "24h": 12.5 },
            fees: { "24h": 2500 },
            volume: { "24h": 250000 },
            pool_config: { bin_step: 20, base_fee_pct: 0.2 },
            token_x: {
              address: "TokenMintA1111111111111111111111111111111",
              symbol: "AAA",
              market_cap: 500000
            },
            token_y: {
              address: SOL_MINT,
              symbol: "SOL"
            },
            tvl: 100000,
            is_blacklisted: false
          }
        ]
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  }) as typeof fetch;

  try {
    const config: NonNullable<AgentConfig["meteora"]> = {
      base_url: "https://dlmm.datapi.meteora.ag",
      discovery_path: "/pools",
      discovery_limit: 25,
      discovery_sort_by: "fee_tvl_ratio_24h:desc",
      discovery_min_volume_24h: 10_000,
      discovery_min_tvl: 5_000,
      quote_mint: SOL_MINT
    };
    const source = new HttpMeteoraPoolSource({
      baseUrl: config.base_url!,
      config,
      logger: createTestLogger("meteora")
    });

    const pools = await source.discoverPools();

    assert.equal(pools.length, 1);
    assert.match(requestedUrls[0] ?? "", /page_size=25/);
    assert.match(requestedUrls[0] ?? "", /sort_by=fee_tvl_ratio_24h%3Adesc/);
    assert.match(requestedUrls[0] ?? "", /filter_by=is_blacklisted%3Dfalse/);
    assert.match(requestedUrls[0] ?? "", /volume_24h%3E10000/);
    assert.match(requestedUrls[0] ?? "", /tvl%3E5000/);
    assert.equal(pools[0]?.address, "PoolA");
    assert.equal(pools[0]?.tokenMint, "TokenMintA1111111111111111111111111111111");
    assert.equal(pools[0]?.tokenSymbol, "AAA");
    assert.equal(pools[0]?.quoteMint, SOL_MINT);
    assert.equal(pools[0]?.vol24h, 250000);
    assert.equal(pools[0]?.feeTvlRatio24h, 12.5);
    assert.equal(pools[0]?.binStep, 20);
    assert.equal(pools[0]?.feeRatePct, 0.2);
    assert.equal(pools[0]?.mcap, 500000);
    assert.equal(pools[0]?.meta?.currentPrice, 0.0025);
    assert.equal(typeof pools[0]?.meta?.activeBinId, "number");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HttpMeteoraPoolSource 按地址回查不会把列表首项误当成目标池子", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrls.push(String(input));
    return new Response(
      JSON.stringify({
        data: [createPoolPayload("PoolA", "AAA")]
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  }) as typeof fetch;

  try {
    const config: NonNullable<AgentConfig["meteora"]> = {
      base_url: "https://dlmm.datapi.meteora.ag",
      discovery_path: "/pools",
      discovery_limit: 25,
      quote_mint: SOL_MINT
    };
    const source = new HttpMeteoraPoolSource({
      baseUrl: config.base_url!,
      config,
      logger: createTestLogger("meteora")
    });

    const pool = await source.getPool("TargetPool");

    assert.equal(pool, undefined);
    assert.match(requestedUrls[0] ?? "", /address=TargetPool/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HttpMeteoraPoolSource detail_path 回查必须命中精确地址", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [createPoolPayload("PoolA", "AAA")]
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    )) as typeof fetch;

  try {
    const config: NonNullable<AgentConfig["meteora"]> = {
      base_url: "https://dlmm.datapi.meteora.ag",
      pool_detail_path: "/pool/{address}",
      quote_mint: SOL_MINT
    };
    const source = new HttpMeteoraPoolSource({
      baseUrl: config.base_url!,
      config,
      logger: createTestLogger("meteora")
    });

    const pool = await source.getPool("TargetPool");

    assert.equal(pool, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
