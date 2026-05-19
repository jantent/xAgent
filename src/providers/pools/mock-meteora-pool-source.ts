import type { IPoolSource } from "../../domain/contracts.js";
import type { PoolCandidate, ProviderHealthStatus } from "../../domain/models.js";
import type { Logger } from "../../utils/logger.js";
import { loadSampleDataset } from "../data/sample-data.js";

/**
 * 这里用本地样例文件模拟 Meteora REST 的池子发现结果。
 * 这样既能完整演示编排流程，又不会在没有外网的环境里把开发体验卡死。
 */
export class MockMeteoraPoolSource implements IPoolSource {
  readonly name = "mock_meteora";

  constructor(
    private readonly datasetPath: string,
    private readonly logger: Logger
  ) {}

  async discoverPools(): Promise<PoolCandidate[]> {
    const dataset = await loadSampleDataset(this.datasetPath);
    const pools = dataset.pools.map((pool) => ({
      ...pool,
      reasons: [],
      narrative: typeof pool.meta?.narrative === "string" ? pool.meta.narrative : undefined
    }));

    this.logger.info("从本地样例数据加载候选池", { count: pools.length });
    return pools;
  }

  async getPool(address: string): Promise<PoolCandidate | undefined> {
    const pools = await this.discoverPools();
    return pools.find((pool) => pool.address === address);
  }

  async healthCheck(): Promise<ProviderHealthStatus> {
    return {
      provider: this.name,
      ok: true,
      canRead: true,
      canWrite: false,
      lastCheckedAt: new Date(),
      consecutiveFailures: 0,
      simulated: true
    };
  }
}
