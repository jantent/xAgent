import type { AgentConfig } from "../../config/types.js";
import type { IPoolSource } from "../../domain/contracts.js";
import type { LifecycleStage, PoolCandidate, ProviderHealthStatus } from "../../domain/models.js";
import { clamp } from "../../utils/async.js";
import type { Logger } from "../../utils/logger.js";
import {
  buildUrl,
  normalizeTimestamp,
  readArray,
  readNumber,
  readObject,
  readString,
  selectEntityList
} from "../shared/http-source-utils.js";

interface HttpMeteoraPoolSourceOptions {
  baseUrl: string;
  timeoutMs?: number;
  config: NonNullable<AgentConfig["meteora"]>;
  logger: Logger;
}

/**
 * 真实池子发现源。优先读取 Meteora REST 风格接口，拿不到的字段再做保守推导。
 */
export class HttpMeteoraPoolSource implements IPoolSource {
  readonly name = "meteora_http";

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly config: NonNullable<AgentConfig["meteora"]>;
  private readonly logger: Logger;

  constructor(options: HttpMeteoraPoolSourceOptions) {
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs ?? 6_000;
    this.config = options.config;
    this.logger = options.logger;
  }

  async discoverPools(): Promise<PoolCandidate[]> {
    const path = this.config.discovery_path ?? "/pools";
    const filters = ["is_blacklisted=false"];
    if (this.config.discovery_min_volume_24h !== undefined) {
      filters.push(`volume_24h>${this.config.discovery_min_volume_24h}`);
    }
    if (this.config.discovery_min_tvl !== undefined) {
      filters.push(`tvl>${this.config.discovery_min_tvl}`);
    }
    const filterBy = filters.join(" && ");
    const payload = await this.requestJson(path, {
      page: 1,
      page_size: this.config.discovery_limit ?? 50,
      sort_by: this.config.discovery_sort_by ?? "fee_tvl_ratio_24h:desc",
      filter_by: filterBy
    });

    const pools = selectEntityList(payload)
      .map((item) => this.mapPool(item))
      .filter((item): item is PoolCandidate => Boolean(item));

    this.logger.info("读取真实池子发现结果", { count: pools.length, source: this.name });
    return pools;
  }

  async healthCheck(): Promise<ProviderHealthStatus> {
    const startedAt = Date.now();

    try {
      if (this.config.health_path) {
        const response = await this.request(buildUrl(this.baseUrl, this.config.health_path));
        if (!response.ok) {
          throw new Error(`health check failed with status ${response.status}`);
        }
      } else {
        const response = await this.request(this.baseUrl);
        if (!response.ok) {
          throw new Error(`health check failed with status ${response.status}`);
        }
      }

      return {
        provider: this.name,
        ok: true,
        canRead: true,
        canWrite: false,
        latencyMs: Date.now() - startedAt,
        lastCheckedAt: new Date(),
        consecutiveFailures: 0
      };
    } catch (error) {
      return {
        provider: this.name,
        ok: false,
        canRead: false,
        canWrite: false,
        latencyMs: Date.now() - startedAt,
        lastCheckedAt: new Date(),
        lastError: error instanceof Error ? error.message : String(error),
        consecutiveFailures: 0
      };
    }
  }

  private mapPool(item: Record<string, unknown>): PoolCandidate | undefined {
    const address = readString(item, "address", "poolAddress", "id");
    const tokenX = readObject(item, "token_x", "tokenX");
    const tokenY = readObject(item, "token_y", "tokenY");
    const tokenPair = this.resolveTokenPair(item, tokenX, tokenY);
    const tokenMint =
      tokenPair?.baseMint ?? readString(item, "tokenMint", "baseMint", "mint", "tokenAddress");
    const tokenSymbol =
      tokenPair?.baseSymbol ??
      readString(item, "tokenSymbol", "baseSymbol", "symbol", "ticker") ??
      readString(readObject(item, "token", "baseToken") ?? {}, "symbol", "ticker");
    const quoteMint =
      tokenPair?.quoteMint ??
      readString(item, "quoteMint", "quoteTokenMint", "quoteMintAddress", "quote") ??
      readString(readObject(item, "quoteToken") ?? {}, "mint", "address");

    if (!address || !tokenMint || !tokenSymbol || !quoteMint) {
      return undefined;
    }

    const tvl = readNumber(item, "tvl", "tvlUsd", "liquidity", "liquidityUsd") ?? 0;
    const volume = readObject(item, "volume");
    const fees = readObject(item, "fees");
    const feeTvlRatio = readObject(item, "fee_tvl_ratio", "feeTvlRatio");
    const poolConfig = readObject(item, "pool_config", "poolConfig");
    const baseToken = tokenPair?.baseToken;
    const vol24h =
      readNumber(item, "vol24h", "volume24h", "volume_24h", "dailyVolumeUsd") ??
      readNumber(volume ?? {}, "24h") ??
      0;
    const fee24h =
      readNumber(item, "fee24h", "fees24h", "fees_24h", "dailyFeeUsd") ??
      readNumber(fees ?? {}, "24h") ??
      0;
    const feeTvlRatio24h =
      readNumber(item, "feeTvlRatio24h", "fee_tvl_ratio", "fee_tvl_ratio_24h") ??
      readNumber(feeTvlRatio ?? {}, "24h") ??
      (tvl > 0 ? (fee24h / tvl) * 100 : 0);
    const binStep = Math.round(
      readNumber(item, "binStep", "bin_step", "binSize") ?? readNumber(poolConfig ?? {}, "bin_step", "binStep") ?? 1
    );
    const feeRatePct =
      readNumber(item, "feeRatePct", "fee_rate_pct", "feeRate", "feeBps") ??
      readNumber(item, "dynamic_fee_pct") ??
      readNumber(poolConfig ?? {}, "base_fee_pct", "baseFeePct") ??
      (readNumber(item, "feeBps") ?? 0) / 100;
    const mcap =
      readNumber(item, "mcap", "marketCap", "market_cap", "fdv") ??
      readNumber(baseToken ?? {}, "market_cap", "marketCap") ??
      0;
    const txCount24h = readNumber(item, "txCount24h", "transactions24h", "tx_count_24h") ?? 0;
    const currentPrice = readNumber(item, "currentPrice", "price", "priceUsd", "current_price");
    const activeBinId =
      readNumber(item, "activeBinId", "active_bin_id", "active_bin", "activeBin") ??
      this.deriveActiveBinId(currentPrice, binStep);
    const narrative = this.extractNarrative(item);
    const lifecycleStage = this.normalizeLifecycleStage(
      readString(item, "lifecycleStage", "lifecycle_stage", "stage"),
      vol24h,
      tvl,
      mcap
    );
    const organicScore =
      readNumber(item, "organicScore", "organic_score") ??
      this.deriveOrganicScore(vol24h, tvl, txCount24h);
    const lincolnScore =
      readNumber(item, "lincolnScore", "lincoln_score") ??
      this.deriveLincolnScore(feeTvlRatio24h, vol24h, tvl, mcap);

    const description =
      readString(item, "description", "summary") ??
      readString(readObject(item, "meta", "token", "baseToken") ?? {}, "description");
    const createdAt =
      normalizeTimestamp(item.createdAt) ??
      normalizeTimestamp(item.created_at) ??
      normalizeTimestamp(item.launchTime);

    return {
      address,
      tokenMint,
      tokenSymbol,
      quoteMint,
      binStep,
      feeRatePct,
      lincolnScore,
      safetyScore: readNumber(item, "safetyScore", "safety_score") ?? 0,
      organicScore,
      grade: readString(item, "grade"),
      lifecycleStage,
      tvl,
      vol24h,
      feeTvlRatio24h,
      mcap,
      smartMoneyNet: readNumber(item, "smartMoneyNet", "smart_money_net") ?? 0,
      dataSource: this.name,
      narrative,
      reasons: [],
      meta: {
        ...(description ? { description } : {}),
        ...(activeBinId !== undefined ? { activeBinId } : {}),
        ...(currentPrice !== undefined ? { currentPrice } : {}),
        ...(createdAt !== undefined ? { createdAt } : {})
      }
    };
  }

  private resolveTokenPair(
    item: Record<string, unknown>,
    tokenX?: Record<string, unknown>,
    tokenY?: Record<string, unknown>
  ): {
    baseToken?: Record<string, unknown>;
    baseMint?: string;
    baseSymbol?: string;
    quoteMint?: string;
  } | undefined {
    if (!tokenX || !tokenY) {
      return undefined;
    }

    const tokenXAddress = readString(tokenX, "address", "mint");
    const tokenYAddress = readString(tokenY, "address", "mint");
    const configuredQuote = this.config.quote_mint;
    const quoteIsX = Boolean(configuredQuote && tokenXAddress === configuredQuote);
    const quoteIsY = Boolean(configuredQuote && tokenYAddress === configuredQuote);
    const quoteToken = quoteIsX ? tokenX : quoteIsY ? tokenY : tokenY;
    const baseToken = quoteToken === tokenX ? tokenY : tokenX;

    return {
      baseToken,
      baseMint:
        readString(item, "baseMint", "tokenMint", "tokenAddress") ??
        readString(baseToken, "address", "mint"),
      baseSymbol: readString(item, "baseSymbol", "tokenSymbol") ?? readString(baseToken, "symbol", "ticker"),
      quoteMint:
        readString(item, "quoteMint", "quoteTokenMint", "quoteMintAddress") ??
        readString(quoteToken, "address", "mint")
    };
  }

  private deriveActiveBinId(currentPrice: number | undefined, binStep: number): number | undefined {
    if (!currentPrice || currentPrice <= 0 || !Number.isFinite(currentPrice) || binStep <= 0) {
      return undefined;
    }

    const binBase = 1 + binStep / 10_000;
    const activeBinId = Math.round(Math.log(currentPrice) / Math.log(binBase));
    return Number.isSafeInteger(activeBinId) ? activeBinId : undefined;
  }

  private extractNarrative(item: Record<string, unknown>): string | undefined {
    const directNarrative = readString(item, "narrative", "category", "sector", "tag");
    if (directNarrative) {
      return directNarrative;
    }

    const tags = readArray(item, "tags", "labels");
    if (tags && tags.length > 0) {
      return tags
        .map((tag) => String(tag).trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(", ");
    }

    return undefined;
  }

  private normalizeLifecycleStage(
    rawStage: string | undefined,
    vol24h: number,
    tvl: number,
    mcap: number
  ): LifecycleStage {
    const normalized = rawStage?.trim().toLowerCase();
    if (normalized === "birth" || normalized === "hype" || normalized === "plateau" || normalized === "decline") {
      return normalized;
    }

    const volumeTvlRatio = tvl > 0 ? vol24h / tvl : 0;
    if (mcap > 0 && mcap < 1_000_000) {
      return "birth";
    }

    if (volumeTvlRatio >= 3 || (mcap > 0 && mcap <= 10_000_000)) {
      return "hype";
    }

    if (volumeTvlRatio >= 1) {
      return "plateau";
    }

    return "decline";
  }

  private deriveOrganicScore(vol24h: number, tvl: number, txCount24h: number): number {
    const volumeTvlRatio = tvl > 0 ? vol24h / tvl : 0;
    return clamp(volumeTvlRatio * 16 + Math.min(txCount24h / 25, 25), 0, 100);
  }

  private deriveLincolnScore(feeTvlRatio24h: number, vol24h: number, tvl: number, mcap: number): number {
    const volumeTvlRatio = tvl > 0 ? vol24h / tvl : 0;
    const liquidityScore = tvl >= 250_000 ? 2 : tvl >= 100_000 ? 1.5 : tvl >= 50_000 ? 1 : 0.5;
    const mcapScore = mcap > 0 && mcap <= 20_000_000 ? 1.5 : mcap > 20_000_000 ? 1 : 0.5;
    return clamp(feeTvlRatio24h * 0.55 + Math.min(volumeTvlRatio, 6) * 0.45 + liquidityScore + mcapScore, 0, 10);
  }

  private async requestJson(
    path: string,
    query?: Record<string, string | number | Array<string | number> | undefined>
  ): Promise<unknown> {
    const url = path.startsWith("http://") || path.startsWith("https://") ? path : buildUrl(this.baseUrl, path, query);
    const response = await this.request(url);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`${this.name} request failed: ${response.status} ${text.slice(0, 180)}`);
    }

    if (!text.trim()) {
      return [];
    }

    return JSON.parse(text);
  }

  private async request(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      this.logger.debug("发起池子发现请求", { provider: this.name, url });
      return await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json"
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
