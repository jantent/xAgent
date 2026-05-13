import type { DataProviderConfig } from "../../config/types.js";
import type { IDataProvider } from "../../domain/contracts.js";
import type {
  AlertLevel,
  OHLCV,
  ProviderHealthStatus,
  SmartMoneyData,
  TokenSafetyData,
  TrendingToken,
  UrgentSignal
} from "../../domain/models.js";
import type { Logger } from "../../utils/logger.js";
import {
  asRecord,
  buildUrl,
  normalizeFraction,
  normalizeTimestamp,
  readArray,
  readBoolean,
  readNumber,
  readObject,
  readString,
  selectEntity,
  selectEntityList
} from "../shared/http-source-utils.js";

interface HttpMarketDataProviderOptions {
  name: string;
  priority: number;
  baseUrl: string;
  apiKey?: string;
  apiKeyHeader?: string;
  timeoutMs?: number;
  config: DataProviderConfig;
  logger: Logger;
}

/**
 * 统一 HTTP Data Provider，把不同服务的返回值收敛到当前领域模型。
 * 这里不假设某个供应商的固定 JSON 结构，而是优先消费一组常见字段名。
 */
export class HttpMarketDataProvider implements IDataProvider {
  readonly name: string;
  readonly priority: number;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly apiKeyHeader: string;
  private readonly timeoutMs: number;
  private readonly config: DataProviderConfig;
  private readonly logger: Logger;

  constructor(options: HttpMarketDataProviderOptions) {
    this.name = options.name;
    this.priority = options.priority;
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.apiKeyHeader = options.apiKeyHeader ?? "x-api-key";
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.config = options.config;
    this.logger = options.logger;
  }

  async getTokenSafety(mint: string): Promise<TokenSafetyData> {
    const payload = await this.requestJson(this.requirePath("token_safety_path"), { mint });
    const entity = selectEntity(payload, mint);
    if (!entity) {
      throw new Error(`${this.name} token safety payload missing entity`);
    }

    const rugProbability = normalizeFraction(
      readNumber(entity, "rugProbability", "rug_probability", "rugScore", "rug_score")
    );
    const safetyScore =
      readNumber(entity, "safetyScore", "safety_score", "score", "securityScore") ??
      this.deriveSafetyScoreFromRisk(rugProbability);

    return {
      mint,
      safetyScore,
      verdict: this.normalizeSafetyVerdict(
        readString(entity, "verdict", "safetyVerdict", "status", "riskLevel"),
        safetyScore,
        rugProbability
      ),
      source: this.name,
      topHolderPct: normalizeFraction(
        readNumber(entity, "topHolderPct", "top_holder_pct", "top_holders_pct", "holderConcentration")
      ),
      rugProbability,
      isStale: readBoolean(entity, "isStale", "stale") ?? false
    };
  }

  async getSmartMoneyFlow(mint: string): Promise<SmartMoneyData> {
    const payload = await this.requestJson(this.requirePath("smart_money_path"), { mint });
    const entity = selectEntity(payload, mint);
    if (!entity) {
      throw new Error(`${this.name} smart money payload missing entity`);
    }

    const buy24h = readNumber(entity, "buy24h", "smartBuy24h", "smart_buy_24h", "buy_volume_24h") ?? 0;
    const sell24h = readNumber(entity, "sell24h", "smartSell24h", "smart_sell_24h", "sell_volume_24h") ?? 0;

    return {
      mint,
      buy24h,
      sell24h,
      net24h: readNumber(entity, "net24h", "smartNet24h", "smart_net_24h", "net_flow_24h") ?? buy24h - sell24h,
      source: this.name,
      isStale: readBoolean(entity, "isStale", "stale") ?? false
    };
  }

  async getTrendingTokens(chain: string, period: string): Promise<TrendingToken[]> {
    const payload = await this.requestJson(this.requirePath("trending_path"), { chain, period });
    return selectEntityList(payload)
      .map((item, index) => {
        const mint = readString(item, "mint", "tokenMint", "address", "tokenAddress");
        if (!mint) {
          return undefined;
        }

        return {
          mint,
          symbol: readString(item, "symbol", "tokenSymbol", "ticker") ?? mint.slice(0, 6),
          rank: readNumber(item, "rank", "position") ?? index + 1,
          volume24h: readNumber(item, "volume24h", "volume_24h", "vol24h", "volume") ?? 0,
          source: this.name
        } satisfies TrendingToken;
      })
      .filter((item): item is TrendingToken => Boolean(item));
  }

  async getOHLCV(mint: string, interval: string): Promise<OHLCV[]> {
    const payload = await this.requestJson(this.requirePath("ohlcv_path"), { mint, interval });
    return selectEntityList(payload)
      .map((item) => {
        const timestamp =
          normalizeTimestamp(item.timestamp) ??
          normalizeTimestamp(item.time) ??
          normalizeTimestamp(item.openTime) ??
          normalizeTimestamp(item.startTime);
        const open = readNumber(item, "open", "o");
        const high = readNumber(item, "high", "h");
        const low = readNumber(item, "low", "l");
        const close = readNumber(item, "close", "c");
        const volume = readNumber(item, "volume", "v", "volume24h");

        if (
          timestamp === undefined ||
          open === undefined ||
          high === undefined ||
          low === undefined ||
          close === undefined ||
          volume === undefined
        ) {
          return undefined;
        }

        return {
          timestamp,
          open,
          high,
          low,
          close,
          volume
        } satisfies OHLCV;
      })
      .filter((item): item is OHLCV => Boolean(item));
  }

  async getUrgentSignals(tokenMints: string[]): Promise<UrgentSignal[]> {
    const path = this.config.urgent_signals_path;
    if (!path) {
      return [];
    }

    const payload = await this.requestJson(path, { mints: tokenMints });
    return selectEntityList(payload)
      .map((item) => {
        const tokenMint = readString(item, "tokenMint", "mint", "address", "tokenAddress");
        if (!tokenMint) {
          return undefined;
        }

        return {
          provider: readString(item, "provider", "source") ?? this.name,
          signalType: readString(item, "signalType", "type", "signal", "event") ?? "unknown",
          tokenMint,
          severity: this.normalizeAlertLevel(readString(item, "severity", "level", "priority")),
          message: readString(item, "message", "title", "reason", "description") ?? "urgent signal"
        } satisfies UrgentSignal;
      })
      .filter((item): item is UrgentSignal => Boolean(item));
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

  private requirePath(key: keyof Pick<
    DataProviderConfig,
    "token_safety_path" | "smart_money_path" | "trending_path" | "ohlcv_path"
  >): string {
    const path = this.config[key];
    if (!path) {
      throw new Error(`${this.name} missing config path: ${key}`);
    }

    return path;
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
      return {};
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      this.logger.warn("数据源返回了非 JSON 响应", { provider: this.name, url, error });
      throw new Error(`${this.name} returned non-json response`);
    }
  }

  private async request(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      this.logger.debug("发起数据源请求", { provider: this.name, url });
      return await fetch(url, {
        method: "GET",
        headers: this.buildHeaders(),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private buildHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      accept: "application/json"
    };

    if (this.apiKey) {
      headers[this.apiKeyHeader] = this.apiKey;
    }

    return headers;
  }

  private deriveSafetyScoreFromRisk(rugProbability?: number): number {
    if (rugProbability === undefined) {
      return 0;
    }

    return Math.max(0, Math.min(100, Math.round((1 - rugProbability) * 100)));
  }

  private normalizeSafetyVerdict(
    rawVerdict: string | undefined,
    safetyScore: number,
    rugProbability?: number
  ): TokenSafetyData["verdict"] {
    const normalized = rawVerdict?.trim().toUpperCase();
    if (normalized === "SAFE" || normalized === "WARNING" || normalized === "DANGER" || normalized === "UNKNOWN") {
      return normalized;
    }

    if (rugProbability !== undefined && rugProbability >= 0.5) {
      return "DANGER";
    }

    if (safetyScore >= 70) {
      return "SAFE";
    }

    if (safetyScore >= 45) {
      return "WARNING";
    }

    if (safetyScore <= 0) {
      return "UNKNOWN";
    }

    return "DANGER";
  }

  private normalizeAlertLevel(rawLevel?: string): AlertLevel {
    const normalized = rawLevel?.trim().toLowerCase();
    if (normalized === "critical" || normalized === "high" || normalized === "medium" || normalized === "low") {
      return normalized;
    }

    return "high";
  }
}
