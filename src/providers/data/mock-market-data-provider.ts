import type { IDataProvider } from "../../domain/contracts.js";
import type {
  OHLCV,
  ProviderHealthStatus,
  SmartMoneyData,
  TokenSafetyData,
  TrendingToken,
  UrgentSignal
} from "../../domain/models.js";
import type { Logger } from "../../utils/logger.js";
import { loadSampleDataset } from "./sample-data.js";

function estimateUnknownMintScore(mint: string): number {
  const checksum = Array.from(mint).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return 52 + (checksum % 9);
}

/**
 * Mock Provider 的目标不是伪造所有外部服务，而是给主流程一套稳定、可重复的输入。
 * 这样一来，后续接入真实 GMGN / Birdeye 时，业务逻辑就能复用。
 */
export class MockMarketDataProvider implements IDataProvider {
  constructor(
    readonly name: string,
    readonly priority: number,
    private readonly datasetPath: string,
    private readonly logger: Logger
  ) {}

  async getTokenSafety(mint: string): Promise<TokenSafetyData> {
    const dataset = await loadSampleDataset(this.datasetPath);
    const result = dataset.tokenSafetyByMint[mint];
    if (!result) {
      return {
        mint,
        safetyScore: estimateUnknownMintScore(mint),
        verdict: "WARNING",
        source: this.name,
        isStale: true
      };
    }

    return result;
  }

  async getSmartMoneyFlow(mint: string): Promise<SmartMoneyData> {
    const dataset = await loadSampleDataset(this.datasetPath);
    const result = dataset.smartMoneyByMint[mint];
    if (!result) {
      return {
        mint,
        buy24h: 0,
        sell24h: 0,
        net24h: 0,
        source: this.name,
        isStale: true
      };
    }

    return result;
  }

  async getTrendingTokens(_chain: string, _period: string): Promise<TrendingToken[]> {
    const dataset = await loadSampleDataset(this.datasetPath);
    const tokens = dataset.pools
      .slice()
      .sort((left, right) => right.vol24h - left.vol24h)
      .map((pool, index) => ({
        mint: pool.tokenMint,
        symbol: pool.tokenSymbol,
        rank: index + 1,
        volume24h: pool.vol24h,
        source: this.name
      }));

    return tokens;
  }

  async getOHLCV(mint: string, _interval: string): Promise<OHLCV[]> {
    const dataset = await loadSampleDataset(this.datasetPath);
    const targetPool = dataset.pools.find((pool) => pool.tokenMint === mint);
    if (!targetPool) {
      throw new Error(`Mock pool not found for OHLCV: ${mint}`);
    }

    const basePrice = Math.max(targetPool.mcap / 1_000_000, 0.01);
    const candles: OHLCV[] = Array.from({ length: 12 }, (_, index) => {
      const timestamp = Date.now() - (12 - index) * 60 * 60 * 1000;
      const drift = (index - 6) * 0.015;
      const open = basePrice * (1 + drift);
      const close = open * 1.01;
      const high = close * 1.02;
      const low = open * 0.98;
      const volume = targetPool.vol24h / 12;

      return {
        timestamp,
        open,
        high,
        low,
        close,
        volume
      };
    });

    return candles;
  }

  async getUrgentSignals(tokenMints: string[]): Promise<UrgentSignal[]> {
    const dataset = await loadSampleDataset(this.datasetPath);
    const signals = dataset.urgentSignals.filter((signal) => tokenMints.includes(signal.tokenMint));
    this.logger.debug("读取紧急信号", { tokenCount: tokenMints.length, signalCount: signals.length });
    return signals;
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
