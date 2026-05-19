import type { IPoolSource } from "../../domain/contracts.js";
import type { PoolCandidate, ProviderHealthStatus } from "../../domain/models.js";
import type { Logger } from "../../utils/logger.js";

/**
 * 多个池子发现源的串行降级器。
 * 主源失败或返回空结果时，会自动尝试下一个源。
 */
export class FallbackPoolSource implements IPoolSource {
  readonly name = "fallback_pool_source";

  constructor(
    private readonly sources: IPoolSource[],
    private readonly logger: Logger
  ) {}

  async discoverPools(): Promise<PoolCandidate[]> {
    let lastError: unknown;

    for (const source of this.sources) {
      try {
        const pools = await source.discoverPools();
        if (pools.length > 0) {
          return pools;
        }

        this.logger.warn("池子发现源返回空列表，尝试降级", { source: source.name });
      } catch (error) {
        lastError = error;
        this.logger.warn("池子发现源调用失败，尝试降级", { source: source.name, error });
      }
    }

    if (lastError) {
      throw lastError;
    }

    return [];
  }

  async getPool(address: string): Promise<PoolCandidate | undefined> {
    let lastError: unknown;

    for (const source of this.sources) {
      try {
        const pool = source.getPool
          ? await source.getPool(address)
          : (await source.discoverPools()).find((item) => item.address === address);
        if (pool) {
          return pool;
        }

        this.logger.warn("池子回查源未返回目标池，尝试降级", { source: source.name, address });
      } catch (error) {
        lastError = error;
        this.logger.warn("池子回查源调用失败，尝试降级", { source: source.name, address, error });
      }
    }

    if (lastError) {
      throw lastError;
    }

    return undefined;
  }

  async healthCheck(): Promise<ProviderHealthStatus> {
    const statuses: ProviderHealthStatus[] = [];

    for (const source of this.sources) {
      try {
        const status = await source.healthCheck();
        statuses.push(status);
        if (status.ok) {
          return status;
        }
      } catch (error) {
        statuses.push({
          provider: source.name,
          ok: false,
          canRead: false,
          canWrite: false,
          lastCheckedAt: new Date(),
          lastError: error instanceof Error ? error.message : String(error),
          consecutiveFailures: 0
        });
      }
    }

    return (
      statuses[statuses.length - 1] ?? {
        provider: this.name,
        ok: false,
        canRead: false,
        canWrite: false,
        lastCheckedAt: new Date(),
        lastError: "no pool source configured",
        consecutiveFailures: 0
      }
    );
  }
}
