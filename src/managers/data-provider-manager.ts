import { CircuitBreaker } from "../core/circuit-breaker.js";
import type { IDataProvider } from "../domain/contracts.js";
import type {
  OHLCV,
  ProviderHealthSnapshot,
  ProviderHealthStatus,
  SmartMoneyData,
  TokenSafetyData,
  TrendingToken,
  UrgentSignalSummary
} from "../domain/models.js";
import type { AgentConfig } from "../config/types.js";
import type { ICacheStore } from "../persistence/contracts.js";
import { withTimeout } from "../utils/async.js";
import type { Logger } from "../utils/logger.js";

/**
 * DataProviderManager 是整个系统的“故障隔离层”。
 * 所有外部数据源必须先经过它，才能进入评分、风控与执行逻辑。
 */
export class DataProviderManager {
  private readonly circuitBreakers = new Map<string, CircuitBreaker>();
  private readonly lastHealth = new Map<string, ProviderHealthStatus>();
  private lastAnyProviderOkAt?: Date;

  constructor(
    private readonly providers: IDataProvider[],
    private readonly config: AgentConfig["data_providers"],
    private readonly cacheStore: ICacheStore,
    private readonly logger: Logger
  ) {
    for (const provider of providers) {
      const matchedConfig = this.getProviderConfig(provider);
      const failureThreshold = matchedConfig?.circuit_breaker.failure_threshold ?? 5;
      const recoveryTimeMs = matchedConfig?.circuit_breaker.recovery_time_ms ?? 60_000;
      this.circuitBreakers.set(provider.name, new CircuitBreaker(provider.name, failureThreshold, recoveryTimeMs));
    }
  }

  async getTokenSafety(mint: string): Promise<TokenSafetyData> {
    return this.executeWithFallback<TokenSafetyData>({
      operation: "getTokenSafety",
      cacheKey: `safety:${mint}`,
      ttlMs: this.config.cache.stale_tolerance_ms,
      conservativeFallback: () => ({
        mint,
        safetyScore: 0,
        verdict: "UNKNOWN",
        source: "default_fallback",
        isStale: true
      }),
      executor: (provider) => provider.getTokenSafety(mint)
    });
  }

  async getSmartMoneyFlow(mint: string): Promise<SmartMoneyData> {
    return this.executeWithFallback<SmartMoneyData>({
      operation: "getSmartMoneyFlow",
      cacheKey: `smart-money:${mint}`,
      ttlMs: this.config.cache.stale_tolerance_ms,
      conservativeFallback: () => ({
        mint,
        buy24h: 0,
        sell24h: 0,
        net24h: 0,
        source: "default_fallback",
        isStale: true
      }),
      executor: (provider) => provider.getSmartMoneyFlow(mint)
    });
  }

  async getTrendingTokens(chain: string, period: string): Promise<TrendingToken[]> {
    return this.executeWithFallback<TrendingToken[]>({
      operation: "getTrendingTokens",
      cacheKey: `trending:${chain}:${period}`,
      ttlMs: this.config.cache.stale_tolerance_ms,
      conservativeFallback: () => [],
      executor: (provider) => provider.getTrendingTokens(chain, period)
    });
  }

  async getOHLCV(mint: string, interval: string): Promise<OHLCV[]> {
    return this.executeWithFallback<OHLCV[]>({
      operation: "getOHLCV",
      cacheKey: `ohlcv:${mint}:${interval}`,
      ttlMs: this.config.cache.stale_tolerance_ms,
      conservativeFallback: () => [],
      executor: (provider) => provider.getOHLCV(mint, interval)
    });
  }

  async getUrgentSignals(tokenMints: string[]): Promise<UrgentSignalSummary> {
    const signals = [];

    for (const provider of this.providers) {
      const breaker = this.circuitBreakers.get(provider.name);
      if (breaker?.isOpen()) {
        continue;
      }

      if (!provider.getUrgentSignals) {
        continue;
      }

      try {
        const providerSignals = await withTimeout(
          provider.getUrgentSignals(tokenMints),
          this.getProviderTimeoutMs(provider),
          `${provider.name}:getUrgentSignals`
        );

        breaker?.recordSuccess();
        signals.push(...providerSignals);
      } catch (error) {
        breaker?.recordFailure(error);
        this.logger.warn("获取紧急信号失败", { provider: provider.name, error });
      }
    }

    return {
      hasDevSell: signals.some((signal) => signal.signalType === "dev_sell"),
      hasRug: signals.some((signal) => signal.signalType === "rug"),
      signals
    };
  }

  async healthCheck(): Promise<ProviderHealthSnapshot> {
    const statuses: ProviderHealthStatus[] = [];

    for (const provider of this.providers) {
      const breaker = this.circuitBreakers.get(provider.name);
      const startedAt = Date.now();

      try {
        const status = await withTimeout(
          provider.healthCheck(),
          this.getProviderTimeoutMs(provider),
          `${provider.name}:healthCheck`
        );
        if (status.ok) {
          breaker?.recordSuccess();
        } else {
          breaker?.recordFailure(status.lastError ?? `${provider.name}:healthCheck returned not ok`);
        }
        const normalizedStatus: ProviderHealthStatus = {
          ...status,
          latencyMs: status.latencyMs ?? Date.now() - startedAt,
          lastCheckedAt: status.lastCheckedAt ?? new Date(),
          consecutiveFailures: breaker?.getConsecutiveFailures() ?? status.consecutiveFailures
        };
        if (normalizedStatus.ok) {
          this.lastAnyProviderOkAt = normalizedStatus.lastCheckedAt;
        }
        this.lastHealth.set(provider.name, normalizedStatus);
        statuses.push(normalizedStatus);
      } catch (error) {
        breaker?.recordFailure(error);
        const failedStatus: ProviderHealthStatus = {
          provider: provider.name,
          ok: false,
          canRead: false,
          canWrite: false,
          latencyMs: Date.now() - startedAt,
          lastCheckedAt: new Date(),
          lastError: error instanceof Error ? error.message : String(error),
          consecutiveFailures: breaker?.getConsecutiveFailures() ?? 0
        };
        this.lastHealth.set(provider.name, failedStatus);
        statuses.push(failedStatus);
        this.logger.warn("数据源健康检查失败", {
          provider: provider.name,
          error
        });
      }
    }

    return this.buildHealthSnapshot(statuses);
  }

  getHealthSnapshot(): ProviderHealthSnapshot {
    const providerStatuses = this.providers.map((provider) => {
      const cached = this.lastHealth.get(provider.name);
      if (cached) {
        return cached;
      }

      return {
        provider: provider.name,
        ok: false,
        canRead: false,
        canWrite: false,
        lastCheckedAt: new Date(),
        lastError: "provider health not checked yet",
        consecutiveFailures: 0
      };
    });

    return this.buildHealthSnapshot(providerStatuses);
  }

  private async executeWithFallback<T>(options: {
    operation: string;
    cacheKey: string;
    ttlMs: number;
    conservativeFallback: () => T;
    executor: (provider: IDataProvider) => Promise<T>;
  }): Promise<T> {
    const freshCached = await this.getCache<T>(options.cacheKey, false);
    if (freshCached !== undefined) {
      return freshCached;
    }

    let staleCached = await this.getCache<T>(options.cacheKey, true);

    for (const provider of this.providers) {
      const breaker = this.circuitBreakers.get(provider.name);
      if (breaker?.isOpen()) {
        continue;
      }

      const startedAt = Date.now();
      try {
        const result = await withTimeout(
          options.executor(provider),
          this.getProviderTimeoutMs(provider),
          `${provider.name}:${options.operation}`
        );

        breaker?.recordSuccess();
        this.lastHealth.set(provider.name, {
          provider: provider.name,
          ok: true,
          canRead: true,
          canWrite: false,
          latencyMs: Date.now() - startedAt,
          lastCheckedAt: new Date(),
          consecutiveFailures: breaker?.getConsecutiveFailures() ?? 0
        });
        this.lastAnyProviderOkAt = new Date();

        await this.cacheStore.set(options.cacheKey, {
          valueJson: JSON.stringify(result),
          expiresAt: Date.now() + options.ttlMs
        });

        return result;
      } catch (error) {
        staleCached ??= await this.getCache<T>(options.cacheKey, true);
        breaker?.recordFailure(error);
        this.lastHealth.set(provider.name, {
          provider: provider.name,
          ok: false,
          canRead: false,
          canWrite: false,
          latencyMs: Date.now() - startedAt,
          lastCheckedAt: new Date(),
          lastError: error instanceof Error ? error.message : String(error),
          consecutiveFailures: breaker?.getConsecutiveFailures() ?? 0
        });

        this.logger.warn("数据源调用失败，尝试下一个 provider", {
          operation: options.operation,
          provider: provider.name,
          error
        });
      }
    }

    if (staleCached !== undefined) {
      this.logger.warn("所有 provider 失败，回退到过期缓存", {
        operation: options.operation,
        cacheKey: options.cacheKey
      });
      return staleCached;
    }

    return options.conservativeFallback();
  }

  private async getCache<T>(key: string, allowStale: boolean): Promise<T | undefined> {
    const entry = await this.cacheStore.get(key);
    if (!entry) {
      return undefined;
    }

    if (allowStale || entry.expiresAt > Date.now()) {
      return JSON.parse(entry.valueJson) as T;
    }

    return undefined;
  }

  private buildHealthSnapshot(providerStatuses: ProviderHealthStatus[]): ProviderHealthSnapshot {
    const lastSuccessfulStatus = providerStatuses
      .filter((status) => status.ok)
      .sort((left, right) => right.lastCheckedAt.getTime() - left.lastCheckedAt.getTime())[0];
    if (lastSuccessfulStatus && (!this.lastAnyProviderOkAt || lastSuccessfulStatus.lastCheckedAt > this.lastAnyProviderOkAt)) {
      this.lastAnyProviderOkAt = lastSuccessfulStatus.lastCheckedAt;
    }

    const hasAnyProvider = providerStatuses.some((status) => status.ok);
    return {
      hasAnyProvider,
      hasPrimaryProvider: providerStatuses.some((status) => status.ok && status.provider === this.providers[0]?.name),
      providerStatuses,
      lastAnyProviderOkAt: this.lastAnyProviderOkAt,
      allProvidersDownForMs:
        !hasAnyProvider && this.lastAnyProviderOkAt
          ? Math.max(0, Date.now() - this.lastAnyProviderOkAt.getTime())
          : 0
    };
  }

  private getProviderConfig(provider: IDataProvider) {
    return provider.priority === this.config.gmgn?.priority
      ? this.config.gmgn
      : provider.priority === this.config.provider_a?.priority
        ? this.config.provider_a
        : provider.priority === this.config.provider_b?.priority
          ? this.config.provider_b
          : undefined;
  }

  private getProviderTimeoutMs(provider: IDataProvider): number {
    return this.getProviderConfig(provider)?.timeout_ms ?? 5_000;
  }
}
