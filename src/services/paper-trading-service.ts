import type { AgentConfig, PaperTradingConfig } from "../config/types.js";
import type { SharedState } from "../core/shared-state.js";
import type { IPoolSource } from "../domain/contracts.js";
import type { PaperPositionSnapshot, PoolCandidate, PositionRecord } from "../domain/models.js";
import { createId, clamp } from "../utils/async.js";
import type { Logger } from "../utils/logger.js";
import { estimateUsdFromSol } from "../utils/valuation.js";

export interface PaperTradingSummary {
  enabled: boolean;
  lastValuationAt?: Date;
  snapshotCount: number;
  stalePositions: number;
}

export interface PaperValuationResult {
  enabled: boolean;
  updated: number;
  stale: number;
  skipped: number;
  lookedUp: number;
  resolvedPools: PoolCandidate[];
  snapshots: PaperPositionSnapshot[];
  lastValuationAt?: Date;
}

const DEFAULT_CONFIG: Required<PaperTradingConfig> = {
  enabled: true,
  valuation_interval_ms: 300_000,
  fee_capture_rate: 0.35,
  max_fee_tvl_ratio_24h: 250,
  price_exposure: 0.5,
  out_of_range_penalty_pct_per_bin_width: 2,
  max_out_of_range_penalty_pct: 35,
  snapshot_retention: 5_000
};
const MAX_STALE_MARK_MULTIPLIER = 5;
const MAX_STALE_MARK_PNL_PERCENT = 500;
const MAX_REPORTABLE_MARK_MULTIPLIER = 5;
const MAX_REPORTABLE_MARK_PNL_PERCENT = 500;
const MAX_PRICE_RATIO = 20;
const MIN_PRICE_RATIO = 0.05;

function resolveConfig(config: AgentConfig): Required<PaperTradingConfig> {
  return {
    ...DEFAULT_CONFIG,
    ...(config.paper_trading ?? {})
  };
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeFinite(value: unknown, fallback = 0): number {
  const finite = readFiniteNumber(value);
  return finite === undefined ? fallback : Math.max(0, finite);
}

function isMockSource(source: string | undefined): boolean {
  return !source || source.toLowerCase().includes("mock");
}

function isInRange(position: PositionRecord, activeBinId: number): boolean {
  return activeBinId >= position.fromBinId && activeBinId <= position.toBinId;
}

function calculateRangePenaltyPct(
  position: PositionRecord,
  activeBinId: number,
  config: Required<PaperTradingConfig>
): number {
  if (isInRange(position, activeBinId)) {
    return 0;
  }

  const nearestBoundary = activeBinId < position.fromBinId ? position.fromBinId : position.toBinId;
  const distance = Math.abs(activeBinId - nearestBoundary);
  const binWidth = Math.max(1, position.toBinId - position.fromBinId + 1);
  const penalty = (distance / binWidth) * config.out_of_range_penalty_pct_per_bin_width;
  return clamp(penalty, 0, config.max_out_of_range_penalty_pct);
}

function pnlPercentFromValue(position: PositionRecord, valueSol: number): number {
  return position.depositedSol > 0 ? ((valueSol - position.depositedSol) / position.depositedSol) * 100 : 0;
}

function resolveStaleValueSol(position: PositionRecord, currentValueSol: unknown): number {
  const previousValueSol = readFiniteNumber(currentValueSol);
  const depositedSol = Math.max(0, position.depositedSol);
  if (previousValueSol === undefined || previousValueSol < 0) {
    return depositedSol;
  }

  const pnlPercent = pnlPercentFromValue(position, previousValueSol);
  const maxPreservedValue = depositedSol * MAX_STALE_MARK_MULTIPLIER;
  if (
    previousValueSol <= maxPreservedValue &&
    Math.abs(pnlPercent) <= MAX_STALE_MARK_PNL_PERCENT
  ) {
    return previousValueSol;
  }

  return depositedSol;
}

function hasUnrealisticPriceRatio(entryPrice?: number, currentPrice?: number): boolean {
  if (
    entryPrice === undefined ||
    currentPrice === undefined ||
    entryPrice <= 0 ||
    currentPrice <= 0 ||
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(currentPrice)
  ) {
    return false;
  }

  const ratio = currentPrice / entryPrice;
  return !Number.isFinite(ratio) || ratio > MAX_PRICE_RATIO || ratio < MIN_PRICE_RATIO;
}

function hasUnrealisticMark(position: PositionRecord, valueSol: number, pnlPercent: number): boolean {
  const depositedSol = Math.max(0, position.depositedSol);
  if (!Number.isFinite(valueSol) || valueSol < 0 || !Number.isFinite(pnlPercent)) {
    return true;
  }
  if (depositedSol <= 0) {
    return valueSol !== 0;
  }

  return (
    valueSol > depositedSol * MAX_REPORTABLE_MARK_MULTIPLIER ||
    Math.abs(pnlPercent) > MAX_REPORTABLE_MARK_PNL_PERCENT
  );
}

function createSnapshot(options: {
  position: PositionRecord;
  timestamp: Date;
  activeBinId?: number;
  valueSol: number;
  valueUsd: number;
  pnlPercent: number;
  feeAccruedSol: number;
  unclaimedFeesSol: number;
  inRange: boolean;
  source: string;
  stale: boolean;
  staleReason?: string;
}): PaperPositionSnapshot {
  return {
    id: createId("paper"),
    positionId: options.position.id,
    skillId: options.position.skillId,
    skillVersion: options.position.skillVersion,
    poolAddress: options.position.poolAddress,
    tokenMint: options.position.tokenMint,
    tokenSymbol: options.position.tokenSymbol,
    timestamp: options.timestamp,
    activeBinId: options.activeBinId,
    valueSol: options.valueSol,
    valueUsd: options.valueUsd,
    pnlPercent: options.pnlPercent,
    feeAccruedSol: options.feeAccruedSol,
    unclaimedFeesSol: options.unclaimedFeesSol,
    inRange: options.inRange,
    source: options.source,
    stale: options.stale,
    staleReason: options.staleReason
  };
}

export class PaperTradingService {
  constructor(
    private readonly config: AgentConfig,
    private readonly state: SharedState,
    private readonly logger: Logger,
    private readonly poolSource?: IPoolSource
  ) {}

  isEnabled(): boolean {
    const paperConfig = resolveConfig(this.config);
    return paperConfig.enabled && (this.config.execution?.mode ?? "dry_run") === "dry_run";
  }

  getSummary(): PaperTradingSummary {
    const snapshots = this.state.getPaperPositionSnapshots();
    return {
      enabled: this.isEnabled(),
      lastValuationAt: snapshots[0]?.timestamp,
      snapshotCount: snapshots.length,
      stalePositions: this.state.getActivePositions().filter((position) => position.paper?.staleReason).length
    };
  }

  async valuate(candidates: PoolCandidate[], now = new Date()): Promise<PaperValuationResult> {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        updated: 0,
        stale: 0,
        skipped: 0,
        lookedUp: 0,
        resolvedPools: [],
        snapshots: []
      };
    }

    const paperConfig = resolveConfig(this.config);
    const candidatesByPool = new Map(candidates.map((candidate) => [candidate.address, candidate]));
    const activePositions = this.state.getActivePositions();
    const snapshots: PaperPositionSnapshot[] = [];
    let updated = 0;
    let stale = 0;
    let skipped = 0;
    let lookedUp = 0;
    const resolvedPools: PoolCandidate[] = [];

    for (const position of activePositions) {
      if (
        position.paper?.lastValuationAt &&
        now.getTime() - position.paper.lastValuationAt.getTime() < paperConfig.valuation_interval_ms
      ) {
        skipped += 1;
        continue;
      }

      const poolBeforeLookup = candidatesByPool.get(position.poolAddress);
      const pool = await this.resolvePool(position, candidatesByPool);
      if (pool && pool !== poolBeforeLookup && !resolvedPools.some((candidate) => candidate.address === pool.address)) {
        resolvedPools.push(pool);
        lookedUp += 1;
      }
      const activeBinId = readFiniteNumber(pool?.meta?.activeBinId);
      const currentPrice = readFiniteNumber(pool?.meta?.currentPrice);
      const basePaper = {
        unclaimedFeesSol: 0,
        currentValueSol: position.depositedSol,
        ...(position.paper ?? {})
      };
      const currentUnclaimedFeesSol = nonNegativeFinite(basePaper.unclaimedFeesSol);
      const staleReason = !pool
        ? "paper valuation 缺少当前池子数据"
        : isMockSource(pool.dataSource)
          ? "paper valuation 跳过 mock 池子数据"
          : activeBinId === undefined
            ? "paper valuation 缺少 activeBinId"
            : hasUnrealisticPriceRatio(basePaper.entryPrice, currentPrice)
              ? "paper valuation 价格偏离超过保护阈值"
              : undefined;

      if (staleReason || !pool || activeBinId === undefined) {
        const valueSol = resolveStaleValueSol(position, basePaper.currentValueSol);
        const valueUsd = estimateUsdFromSol(this.config, valueSol);
        const pnlPercent = pnlPercentFromValue(position, valueSol);
        const stalePosition: PositionRecord = {
          ...position,
          currentValueUsd: valueUsd,
          pnlPercent,
          paper: {
            ...basePaper,
            currentValueSol: valueSol,
            unclaimedFeesSol: currentUnclaimedFeesSol,
            lastSource: pool?.dataSource ?? "missing_pool",
            staleReason
          }
        };
        const snapshot = createSnapshot({
          position: stalePosition,
          timestamp: now,
          activeBinId,
          valueSol,
          valueUsd,
          pnlPercent,
          feeAccruedSol: 0,
          unclaimedFeesSol: currentUnclaimedFeesSol,
          inRange: stalePosition.isInRange,
          source: pool?.dataSource ?? "missing_pool",
          stale: true,
          staleReason
        });
        this.state.upsertPosition(stalePosition);
        snapshots.push(snapshot);
        stale += 1;
        continue;
      }

      const lastValuationAt = position.paper?.lastValuationAt ?? position.openedAt;
      const elapsedHours = Math.max(0, now.getTime() - lastValuationAt.getTime()) / (60 * 60 * 1000);
      const feeTvlRatio24h = clamp(Math.max(0, pool.feeTvlRatio24h), 0, paperConfig.max_fee_tvl_ratio_24h);
      const feeAccruedSol =
        position.depositedSol * (feeTvlRatio24h / 100) * (elapsedHours / 24) * paperConfig.fee_capture_rate;
      const unclaimedFeesSol = currentUnclaimedFeesSol + feeAccruedSol;
      const entryPrice = basePaper.entryPrice ?? currentPrice;
      const priceReturn = entryPrice && currentPrice ? currentPrice / entryPrice - 1 : 0;
      const rangePenaltyPct = calculateRangePenaltyPct(position, activeBinId, paperConfig);
      const markWithoutFees =
        position.depositedSol * (1 + priceReturn * paperConfig.price_exposure - rangePenaltyPct / 100);
      const valueSol = Math.max(0, markWithoutFees + unclaimedFeesSol);
      const valueUsd = estimateUsdFromSol(this.config, valueSol);
      const pnlPercent = pnlPercentFromValue(position, valueSol);
      if (hasUnrealisticMark(position, valueSol, pnlPercent)) {
        const staleValueSol = resolveStaleValueSol(position, basePaper.currentValueSol);
        const staleValueUsd = estimateUsdFromSol(this.config, staleValueSol);
        const stalePnlPercent = pnlPercentFromValue(position, staleValueSol);
        const stalePosition: PositionRecord = {
          ...position,
          currentValueUsd: staleValueUsd,
          pnlPercent: stalePnlPercent,
          paper: {
            ...basePaper,
            currentValueSol: staleValueSol,
            unclaimedFeesSol: currentUnclaimedFeesSol,
            lastSource: pool.dataSource,
            staleReason: "paper valuation 估值超过保护阈值"
          }
        };
        const snapshot = createSnapshot({
          position: stalePosition,
          timestamp: now,
          activeBinId,
          valueSol: staleValueSol,
          valueUsd: staleValueUsd,
          pnlPercent: stalePnlPercent,
          feeAccruedSol: 0,
          unclaimedFeesSol: currentUnclaimedFeesSol,
          inRange: stalePosition.isInRange,
          source: pool.dataSource,
          stale: true,
          staleReason: "paper valuation 估值超过保护阈值"
        });

        this.state.upsertPosition(stalePosition);
        snapshots.push(snapshot);
        stale += 1;
        continue;
      }
      const currentInRange = isInRange(position, activeBinId);
      const updatedPosition: PositionRecord = {
        ...position,
        currentValueUsd: valueUsd,
        pnlPercent,
        isInRange: currentInRange,
        outOfRangeSince: currentInRange ? undefined : position.outOfRangeSince ?? now,
        paper: {
          entryActiveBinId: basePaper.entryActiveBinId ?? activeBinId,
          entryPrice,
          currentValueSol: valueSol,
          unclaimedFeesSol,
          lastValuationAt: now,
          lastActiveBinId: activeBinId,
          lastSource: pool.dataSource,
          staleReason: undefined
        }
      };
      const snapshot = createSnapshot({
        position: updatedPosition,
        timestamp: now,
        activeBinId,
        valueSol,
        valueUsd,
        pnlPercent,
        feeAccruedSol,
        unclaimedFeesSol,
        inRange: currentInRange,
        source: pool.dataSource,
        stale: false
      });

      this.state.upsertPosition(updatedPosition);
      snapshots.push(snapshot);
      updated += 1;
    }

    this.state.appendPaperPositionSnapshots(snapshots, paperConfig.snapshot_retention);
    this.logger.info("paper trading 估值完成", {
      updated,
      stale,
      skipped,
      lookedUp,
      resolvedPools: resolvedPools.length,
      snapshots: snapshots.length
    });

    return {
      enabled: true,
      updated,
      stale,
      skipped,
      lookedUp,
      resolvedPools,
      snapshots,
      lastValuationAt: snapshots[0]?.timestamp
    };
  }

  private async resolvePool(
    position: PositionRecord,
    candidatesByPool: Map<string, PoolCandidate>
  ): Promise<PoolCandidate | undefined> {
    const pool = candidatesByPool.get(position.poolAddress);
    const activeBinId = readFiniteNumber(pool?.meta?.activeBinId);
    if (pool && !isMockSource(pool.dataSource) && activeBinId !== undefined) {
      return pool;
    }

    if (!this.poolSource?.getPool) {
      return pool;
    }

    try {
      const lookedUpPool = await this.poolSource.getPool(position.poolAddress);
      if (!lookedUpPool) {
        return pool;
      }

      candidatesByPool.set(lookedUpPool.address, lookedUpPool);
      return lookedUpPool;
    } catch (error) {
      this.logger.warn("paper trading 按 pool address 回查失败，保留本轮候选池数据", {
        positionId: position.id,
        poolAddress: position.poolAddress,
        error
      });
      return pool;
    }
  }
}
