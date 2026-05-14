import type { AppRuntime } from "../app/runtime.js";
import type { AuditEventRecord } from "../audit/contracts.js";
import type { SharedStateSnapshot } from "../core/shared-state.js";
import type { ActionType, PaperPositionSnapshot, PlannedAction, PositionRecord } from "../domain/models.js";
import { createId } from "../utils/async.js";
import { rootLogger } from "../utils/logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface PortfolioReportOptions {
  days: number;
  timezoneOffsetMinutes: number;
  now?: Date;
}

export interface TradeHistoryOptions {
  limit: number;
  offset: number;
  actionType?: ActionType;
  status?: "success" | "failed" | "skipped";
  token?: string;
  since?: string;
  until?: string;
}

interface TradeHistoryItem {
  id: string;
  cycleId?: string;
  timestamp?: string;
  actionId?: string;
  actionType: string;
  trigger?: string;
  status?: string;
  tokenSymbol?: string;
  tokenMint?: string;
  poolAddress?: string;
  positionId?: string;
  positionPubkey?: string;
  skillId?: string;
  skillVersion?: string;
  depositedSol?: number;
  recoveredSol?: number;
  capitalDeltaSol?: number;
  realizedPnlSol?: number;
  realizedPnlPercent?: number;
  feesClaimedSol?: number;
  totalFeesClaimedSol?: number;
  valueUsd?: number;
  txSignatures: string[];
  latencyMs?: number;
  message?: string;
  backend?: string;
}

interface ReportDayBucket {
  date: string;
  pnlSol: number;
  pnlUsd: number;
  baselineSol: number;
  baselineUsd: number;
  tradeCount: number;
  snapshotCount: number;
  staleSnapshotCount: number;
  hasData: boolean;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readActionType(value: unknown): ActionType | undefined {
  return value === "open" ||
    value === "close" ||
    value === "rebalance" ||
    value === "claim" ||
    value === "noop" ||
    value === "emergency_exit"
    ? value
    : undefined;
}

function currentPositionValueSol(position: PositionRecord): number {
  const paperValue = readFiniteNumber(position.paper?.currentValueSol);
  if (paperValue !== undefined) {
    return Math.max(0, paperValue);
  }

  return Math.max(0, position.depositedSol * (1 + position.pnlPercent / 100));
}

function currentPositionValueUsd(position: PositionRecord): number | undefined {
  const value = readFiniteNumber(position.currentValueUsd);
  return value !== undefined ? Math.max(0, value) : undefined;
}

function findBaselineSnapshot(
  position: PositionRecord,
  snapshots: PaperPositionSnapshot[],
  cutoffMs: number
): PaperPositionSnapshot | undefined {
  const related = snapshots
    .filter((snapshot) => snapshot.positionId === position.id && !snapshot.stale && readFiniteNumber(snapshot.valueSol) !== undefined)
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  let beforeCutoff: PaperPositionSnapshot | undefined;
  let firstAfterCutoff: PaperPositionSnapshot | undefined;

  for (const snapshot of related) {
    if (snapshot.timestamp.getTime() <= cutoffMs) {
      beforeCutoff = snapshot;
      continue;
    }

    firstAfterCutoff = snapshot;
    break;
  }

  if (beforeCutoff && cutoffMs - beforeCutoff.timestamp.getTime() <= DAY_MS) {
    return beforeCutoff;
  }

  return firstAfterCutoff;
}

function localDateKey(date: Date, timezoneOffsetMinutes: number): string {
  return new Date(date.getTime() - timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

function utcStartForLocalDate(dateKey: string, timezoneOffsetMinutes: number): number {
  return Date.parse(`${dateKey}T00:00:00.000Z`) + timezoneOffsetMinutes * 60_000;
}

function makeDateKeys(days: number, now: Date, timezoneOffsetMinutes: number): string[] {
  const localNow = new Date(now.getTime() - timezoneOffsetMinutes * 60_000);
  const start = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate() - days + 1);

  return Array.from({ length: days }, (_, index) => new Date(start + index * DAY_MS).toISOString().slice(0, 10));
}

function snapshotUsdPerSol(snapshot: PaperPositionSnapshot): number | undefined {
  return snapshot.valueSol > 0 && Number.isFinite(snapshot.valueUsd) ? snapshot.valueUsd / snapshot.valueSol : undefined;
}

function readActionStatus(record: AuditEventRecord): string | undefined {
  const result = record.payload.result;
  if (!result || typeof result !== "object") {
    return undefined;
  }

  const status = (result as { status?: unknown }).status;
  return typeof status === "string" ? status : undefined;
}

function readStateOperations(result: Record<string, unknown>): Record<string, unknown>[] {
  const raw = result.stateOperations;
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

function readPositionFromOperations(operations: Record<string, unknown>[]): Record<string, unknown> | undefined {
  for (const operation of operations) {
    if (operation.kind === "upsert_position" && isRecord(operation.position)) {
      return operation.position;
    }
  }

  return undefined;
}

function sumCapitalDelta(operations: Record<string, unknown>[]): number | undefined {
  let total = 0;
  let hasDelta = false;

  for (const operation of operations) {
    if (operation.kind !== "adjust_capital") {
      continue;
    }

    const deltaSol = readFiniteNumber(operation.deltaSol);
    if (deltaSol === undefined) {
      continue;
    }

    total += deltaSol;
    hasDelta = true;
  }

  return hasDelta ? total : undefined;
}

function readTxSignatures(result: Record<string, unknown>): string[] {
  return Array.isArray(result.txSignatures) ? result.txSignatures.filter((item): item is string => typeof item === "string") : [];
}

function deriveTradeHistoryItem(event: AuditEventRecord): TradeHistoryItem | undefined {
  if (event.source !== "actions" || !isRecord(event.payload.action) || !isRecord(event.payload.result)) {
    return undefined;
  }

  const action = event.payload.action;
  const result = event.payload.result;
  const metadata = isRecord(result.metadata) ? result.metadata : {};
  const operations = readStateOperations(result);
  const position = readPositionFromOperations(operations);
  const pool = isRecord(action.pool) ? action.pool : {};
  const skill = isRecord(action.skill) ? action.skill : {};
  const actionType = readString(action.type) ?? "action";
  const status = readString(result.status);
  const capitalDeltaSol = sumCapitalDelta(operations);
  const depositedSol = readFiniteNumber(position?.depositedSol) ?? readFiniteNumber(action.amountSol);
  const recoveredSol =
    actionType === "close" || actionType === "emergency_exit"
      ? readFiniteNumber(metadata.recoveredSol) ?? (capitalDeltaSol !== undefined && capitalDeltaSol > 0 ? capitalDeltaSol : undefined)
      : undefined;
  const realizedPnlSol =
    recoveredSol !== undefined && depositedSol !== undefined ? recoveredSol - depositedSol : undefined;
  const realizedPnlPercent =
    realizedPnlSol !== undefined && depositedSol !== undefined && depositedSol > 0
      ? (realizedPnlSol / depositedSol) * 100
      : readFiniteNumber(position?.pnlPercent);
  const feesClaimedSol =
    actionType === "claim" && capitalDeltaSol !== undefined && capitalDeltaSol > 0 ? capitalDeltaSol : undefined;

  return {
    id: `${readString(event.payload.cycleId) ?? "cycle"}:${readString(result.actionId) ?? readString(action.id) ?? createId("trade")}`,
    cycleId: readString(event.payload.cycleId),
    timestamp: event.timestamp ?? readString(event.payload.timestamp),
    actionId: readString(result.actionId) ?? readString(action.id),
    actionType,
    trigger: readString(action.trigger),
    status,
    tokenSymbol: readString(position?.tokenSymbol) ?? readString(pool.tokenSymbol),
    tokenMint: readString(position?.tokenMint) ?? readString(pool.tokenMint),
    poolAddress: readString(position?.poolAddress) ?? readString(pool.address),
    positionId: readString(position?.id) ?? readString(metadata.positionId) ?? readString(action.positionId),
    positionPubkey: readString(position?.positionPubkey),
    skillId: readString(position?.skillId) ?? readString(skill.id),
    skillVersion: readString(position?.skillVersion) ?? readString(skill.version),
    depositedSol,
    recoveredSol,
    capitalDeltaSol,
    realizedPnlSol,
    realizedPnlPercent,
    feesClaimedSol,
    totalFeesClaimedSol: readFiniteNumber(position?.totalFeesClaimedSol),
    valueUsd: readFiniteNumber(position?.currentValueUsd),
    txSignatures: readTxSignatures(result),
    latencyMs: readFiniteNumber(result.latencyMs),
    message: readString(result.message),
    backend: readString(metadata.backend)
  };
}

function matchesTradeToken(item: TradeHistoryItem, token: string | undefined): boolean {
  if (!token) {
    return true;
  }

  const normalized = token.toLowerCase();
  return [
    item.tokenSymbol,
    item.tokenMint,
    item.poolAddress,
    item.positionId,
    item.positionPubkey,
    item.skillId
  ].some((value) => value?.toLowerCase().includes(normalized));
}

function summarizePortfolio(snapshot: SharedStateSnapshot, now = new Date()): Record<string, unknown> {
  const activePositions = snapshot.activePositions;
  const cutoffMs = now.getTime() - DAY_MS;
  const paperSnapshots = snapshot.paperPositionSnapshots ?? [];
  let activeValueSol = 0;
  let activeValueUsd = 0;
  let activeDepositSol = 0;
  let activeClaimedFeesSol = 0;
  let activeMarkChange24hSol = 0;
  let baselineCount = 0;
  let oldestBaselineAt: Date | undefined;

  for (const position of activePositions) {
    const currentValueSol = currentPositionValueSol(position);
    const currentValueUsd = currentPositionValueUsd(position);
    const baselineSnapshot = findBaselineSnapshot(position, paperSnapshots, cutoffMs);
    const baselineValueSol =
      readFiniteNumber(baselineSnapshot?.valueSol) ??
      (position.openedAt.getTime() >= cutoffMs ? position.depositedSol : currentValueSol);

    activeValueSol += currentValueSol;
    activeValueUsd += currentValueUsd ?? 0;
    activeDepositSol += position.depositedSol;
    activeClaimedFeesSol += Math.max(0, readFiniteNumber(position.totalFeesClaimedSol) ?? 0);
    activeMarkChange24hSol += currentValueSol - baselineValueSol;

    if (baselineSnapshot) {
      baselineCount += 1;
      if (!oldestBaselineAt || baselineSnapshot.timestamp.getTime() < oldestBaselineAt.getTime()) {
        oldestBaselineAt = baselineSnapshot.timestamp;
      }
    }
  }

  const activePnlSol = activeValueSol + activeClaimedFeesSol - activeDepositSol;
  const totalEquitySol = snapshot.availableCapitalSol + activeValueSol + activeClaimedFeesSol;
  const solPriceUsd = activeValueSol > 0 && activeValueUsd > 0 ? activeValueUsd / activeValueSol : undefined;
  const activeMarkChange24hUsd = solPriceUsd !== undefined ? activeMarkChange24hSol * solPriceUsd : undefined;
  const activeMarkChange24hPercent =
    activeValueSol - activeMarkChange24hSol > 0
      ? (activeMarkChange24hSol / (activeValueSol - activeMarkChange24hSol)) * 100
      : undefined;

  return {
    totalEquitySol,
    totalEquityUsd: solPriceUsd !== undefined ? totalEquitySol * solPriceUsd : undefined,
    activeValueSol,
    activeValueUsd,
    activeDepositSol,
    activeClaimedFeesSol,
    activePnlSol,
    activePnlUsd: solPriceUsd !== undefined ? activePnlSol * solPriceUsd : undefined,
    activeMarkChange24hSol,
    activeMarkChange24hUsd,
    activeMarkChange24hPercent,
    changeWindowHours: 24,
    baselineSnapshotCount: baselineCount,
    baselineAt: oldestBaselineAt,
    markChangeIncludesClaimedFees: false
  };
}

function countTradesByDay(
  buckets: Map<string, ReportDayBucket>,
  events: AuditEventRecord[],
  timezoneOffsetMinutes: number
): number {
  let tradeCount = 0;

  for (const event of events) {
    if (!event.timestamp || readActionStatus(event) !== "success") {
      continue;
    }

    const bucket = buckets.get(localDateKey(new Date(event.timestamp), timezoneOffsetMinutes));
    if (!bucket) {
      continue;
    }

    bucket.tradeCount += 1;
    tradeCount += 1;
  }

  return tradeCount;
}

function buildPortfolioReport(
  snapshot: SharedStateSnapshot,
  events: AuditEventRecord[],
  options: PortfolioReportOptions
): Record<string, unknown> {
  const now = options.now ?? new Date();
  const days = Math.max(1, Math.min(90, Math.trunc(options.days)));
  const timezoneOffsetMinutes = Number.isFinite(options.timezoneOffsetMinutes) ? Math.trunc(options.timezoneOffsetMinutes) : 0;
  const dateKeys = makeDateKeys(days, now, timezoneOffsetMinutes);
  const buckets = new Map<string, ReportDayBucket>(
    dateKeys.map((date) => [
      date,
      {
        date,
        pnlSol: 0,
        pnlUsd: 0,
        baselineSol: 0,
        baselineUsd: 0,
        tradeCount: 0,
        snapshotCount: 0,
        staleSnapshotCount: 0,
        hasData: false
      }
    ])
  );
  const snapshots = (snapshot.paperPositionSnapshots ?? []).sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  const snapshotsByPosition = new Map<string, PaperPositionSnapshot[]>();
  const positionById = new Map(snapshot.allPositions.map((position) => [position.id, position]));

  for (const paperSnapshot of snapshots) {
    const bucket = buckets.get(localDateKey(paperSnapshot.timestamp, timezoneOffsetMinutes));
    if (bucket) {
      bucket.snapshotCount += 1;
      if (paperSnapshot.stale) {
        bucket.staleSnapshotCount += 1;
      }
    }

    if (paperSnapshot.stale || !Number.isFinite(paperSnapshot.valueSol)) {
      continue;
    }

    const list = snapshotsByPosition.get(paperSnapshot.positionId) ?? [];
    list.push(paperSnapshot);
    snapshotsByPosition.set(paperSnapshot.positionId, list);
  }

  for (const [positionId, positionSnapshots] of snapshotsByPosition.entries()) {
    const position = positionById.get(positionId);

    for (const date of dateKeys) {
      const bucket = buckets.get(date)!;
      const dayStart = utcStartForLocalDate(date, timezoneOffsetMinutes);
      const dayEnd = dayStart + DAY_MS;
      const inDay = positionSnapshots.filter((item) => item.timestamp.getTime() >= dayStart && item.timestamp.getTime() < dayEnd);
      if (inDay.length === 0) {
        continue;
      }

      const previous = positionSnapshots.filter((item) => item.timestamp.getTime() < dayStart).at(-1);
      const first = inDay[0]!;
      const last = inDay[inDay.length - 1]!;
      const openedInDay =
        position && position.openedAt.getTime() >= dayStart && position.openedAt.getTime() < Math.min(dayEnd, now.getTime());
      const startSol = previous?.valueSol ?? (openedInDay ? position?.depositedSol : undefined) ?? first.valueSol;
      const valuationUsdPerSol = snapshotUsdPerSol(last) ?? snapshotUsdPerSol(previous ?? first);
      const deltaSol = last.valueSol - startSol;
      const deltaUsd = valuationUsdPerSol !== undefined ? deltaSol * valuationUsdPerSol : 0;

      bucket.pnlSol += deltaSol;
      bucket.pnlUsd += deltaUsd;
      bucket.baselineSol += startSol;
      bucket.baselineUsd += valuationUsdPerSol !== undefined ? startSol * valuationUsdPerSol : 0;
      bucket.hasData = true;
    }
  }

  const tradeCount = countTradesByDay(buckets, events, timezoneOffsetMinutes);
  const reportDays = Array.from(buckets.values()).map((bucket) => ({
    ...bucket,
    pnlPercent: bucket.baselineSol > 0 ? (bucket.pnlSol / bucket.baselineSol) * 100 : undefined
  }));
  const totalPnlSol = reportDays.reduce((sum, day) => sum + day.pnlSol, 0);
  const totalPnlUsd = reportDays.reduce((sum, day) => sum + day.pnlUsd, 0);
  const totalBaselineSol = reportDays.reduce((sum, day) => sum + day.baselineSol, 0);
  const valuedDays = reportDays.filter((day) => day.hasData);
  const bestDay = valuedDays.length > 0 ? valuedDays.reduce((best, day) => (day.pnlSol > best.pnlSol ? day : best)) : undefined;
  const worstDay = valuedDays.length > 0 ? valuedDays.reduce((worst, day) => (day.pnlSol < worst.pnlSol ? day : worst)) : undefined;

  return {
    range: {
      days,
      startDate: dateKeys[0],
      endDate: dateKeys[dateKeys.length - 1],
      timezoneOffsetMinutes
    },
    summary: {
      totalPnlSol,
      totalPnlUsd,
      totalPnlPercent: totalBaselineSol > 0 ? (totalPnlSol / totalBaselineSol) * 100 : undefined,
      tradeCount,
      positiveDays: reportDays.filter((day) => day.pnlSol > 0).length,
      negativeDays: reportDays.filter((day) => day.pnlSol < 0).length,
      flatDays: reportDays.filter((day) => day.hasData && day.pnlSol === 0).length,
      dataDays: valuedDays.length,
      bestDay,
      worstDay,
      current: summarizePortfolio(snapshot, now),
      valuationMethod: "paper_mark_to_market_estimate"
    },
    days: reportDays
  };
}

export class ControlService {
  private readonly logger = rootLogger.child("control_service");

  constructor(private readonly runtime: AppRuntime) {}

  getStatus(): Record<string, unknown> {
    const snapshot = this.runtime.state.getSnapshot();
    const rpcHealth = this.runtime.rpcManager.getHealth();
    const dataHealth = this.runtime.dataProviderManager.getHealthSnapshot();

    return {
      startedAt: snapshot.startedAt,
      uptimeSeconds: Math.floor((Date.now() - snapshot.startedAt.getTime()) / 1000),
      manualPause: snapshot.manualPause,
      lastPauseReason: snapshot.lastPauseReason,
      mode: snapshot.mode,
      orchestratorRunning: this.runtime.orchestrator.isRunning(),
      availableCapitalSol: snapshot.availableCapitalSol,
      activePositions: snapshot.activePositions.length,
      totalPositions: snapshot.allPositions.length,
      lastMainCycleAt: snapshot.lastMainCycleAt,
      lastHighFreqTickAt: snapshot.lastHighFreqTickAt,
      lastCycleResult: snapshot.lastCycleResult,
      pendingActions: snapshot.pendingActions?.length ?? 0,
      poolSource: this.runtime.poolSourceName,
      storage: this.runtime.storage,
      runtimeLock: this.runtime.lock?.describe() ?? null,
      statePersistenceError: this.runtime.state.getLastPersistError(),
      wallet: this.runtime.wallet,
      portfolio: summarizePortfolio(snapshot),
      execution: this.runtime.executionLayer.getStatus(),
      paperTrading: this.runtime.paperTradingService.getSummary(),
      skillOptimizer: this.runtime.skillOptimizerService.getSummary(),
      rpc: rpcHealth,
      dataProviders: dataHealth
    };
  }

  async getPortfolioReport(options: PortfolioReportOptions): Promise<Record<string, unknown>> {
    const snapshot = this.runtime.state.getSnapshot();
    const now = options.now ?? new Date();
    const dateKeys = makeDateKeys(options.days, now, options.timezoneOffsetMinutes);
    const since = new Date(utcStartForLocalDate(dateKeys[0]!, options.timezoneOffsetMinutes)).toISOString();
    const events = this.runtime.auditReader.queryEvents
      ? await this.runtime.auditReader.queryEvents({
          source: "actions",
          since,
          until: now.toISOString(),
          limit: 5_000
        })
      : [];

    return buildPortfolioReport(snapshot, events, {
      ...options,
      now
    });
  }

  async getTradeHistory(options: TradeHistoryOptions): Promise<Record<string, unknown>> {
    const limit = Math.max(1, Math.min(200, Math.trunc(options.limit)));
    const offset = Math.max(0, Math.trunc(options.offset));
    const scanLimit = Math.min(5_000, Math.max(limit + offset + 1, 500));
    const events = this.runtime.auditReader.queryEvents
      ? await this.runtime.auditReader.queryEvents({
          source: "actions",
          q: options.token,
          since: options.since,
          until: options.until,
          limit: scanLimit
        })
      : await this.runtime.auditReader.readRecent(scanLimit);
    const filtered = events
      .map(deriveTradeHistoryItem)
      .filter((item): item is TradeHistoryItem => Boolean(item))
      .filter((item) => (options.actionType ? item.actionType === options.actionType : true))
      .filter((item) => (options.status ? item.status === options.status : true))
      .filter((item) => matchesTradeToken(item, options.token));
    const paged = filtered.slice(offset, offset + limit + 1);
    const trades = paged.slice(0, limit);
    const realizedTrades = filtered.filter((item) => item.realizedPnlSol !== undefined);
    const totalRealizedPnlSol = realizedTrades.reduce((sum, item) => sum + (item.realizedPnlSol ?? 0), 0);
    const totalFeesClaimedSol = filtered.reduce((sum, item) => sum + (item.feesClaimedSol ?? 0), 0);

    return {
      trades,
      summary: {
        total: filtered.length,
        success: filtered.filter((item) => item.status === "success").length,
        failed: filtered.filter((item) => item.status === "failed").length,
        skipped: filtered.filter((item) => item.status === "skipped").length,
        realizedCount: realizedTrades.length,
        winningTrades: realizedTrades.filter((item) => (item.realizedPnlSol ?? 0) > 0).length,
        losingTrades: realizedTrades.filter((item) => (item.realizedPnlSol ?? 0) < 0).length,
        totalRealizedPnlSol,
        totalFeesClaimedSol,
        averageRealizedPnlPercent:
          realizedTrades.length > 0
            ? realizedTrades.reduce((sum, item) => sum + (item.realizedPnlPercent ?? 0), 0) / realizedTrades.length
            : undefined
      },
      page: {
        limit,
        offset,
        nextOffset: paged.length > limit ? offset + limit : null,
        hasMore: paged.length > limit,
        total: filtered.length
      }
    };
  }

  async pause(reason = "manual_api"): Promise<Record<string, unknown>> {
    await this.runtime.orchestrator.pause(reason);
    return this.getStatus();
  }

  async resume(): Promise<Record<string, unknown>> {
    await this.runtime.orchestrator.resume();
    return this.getStatus();
  }

  async forceExitPosition(positionId: string): Promise<Record<string, unknown>> {
    const action: PlannedAction = {
      id: createId("action"),
      type: "close",
      trigger: "manual",
      reason: `通过 API 强制撤出仓位 ${positionId}`,
      positionId
    };

    const result = await this.runtime.executionLayer.execute(action);
    this.logger.warn("已执行单仓强制撤出", { positionId, status: result.status });
    return {
      action,
      result,
      status: this.getStatus()
    };
  }

  async emergencyExitAll(): Promise<Record<string, unknown>> {
    await this.runtime.orchestrator.pause("emergency_exit_all");

    const positions = this.runtime.state.getActivePositions();
    const results = [];

    for (const position of positions) {
      const action: PlannedAction = {
        id: createId("action"),
        type: "emergency_exit",
        trigger: "manual",
        reason: "通过 API 触发全仓紧急撤出",
        positionId: position.id
      };

      const result = await this.runtime.executionLayer.execute(action);
      results.push({
        action,
        result
      });
    }

    this.logger.warn("已执行全仓紧急撤出", { positionCount: positions.length });
    return {
      exitedPositions: positions.length,
      results,
      status: this.getStatus()
    };
  }

  async disableSkill(skillId: string): Promise<Record<string, unknown> | null> {
    const skill = this.runtime.skillManager.disableSkill(skillId);
    if (!skill) {
      return null;
    }

    return {
      skill
    };
  }

  async enableSkill(skillId: string, canaryPercent?: number): Promise<Record<string, unknown> | null> {
    const skill = this.runtime.skillManager.enableSkill(skillId, { canaryPercent });
    if (!skill) {
      return null;
    }

    return {
      skill
    };
  }

  async updateSkillParams(skillId: string, paramsPatch: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const skill = this.runtime.skillManager.patchSkillParams(skillId, paramsPatch);
    if (!skill) {
      return null;
    }

    return {
      skill
    };
  }

  async rollbackSkill(skillId: string, version?: string): Promise<Record<string, unknown> | null> {
    const skill = this.runtime.skillManager.rollback(skillId, version);
    if (!skill) {
      return null;
    }

    return {
      skill
    };
  }

  getSkillOptimizationRecommendations(): Record<string, unknown> {
    return {
      recommendations: this.runtime.skillOptimizerService.listRecommendations(),
      summary: this.runtime.skillOptimizerService.getSummary()
    };
  }

  evaluateSkillOptimizationRecommendations(): Record<string, unknown> {
    const recommendations = this.runtime.skillOptimizerService.evaluateAndStore();
    return {
      recommendations,
      summary: this.runtime.skillOptimizerService.getSummary()
    };
  }

  async runMainCycle(): Promise<Record<string, unknown>> {
    const result = await this.runtime.orchestrator.runMainCycle();
    return {
      result
    };
  }
}
