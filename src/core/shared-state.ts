import { SystemMode } from "../domain/models.js";
import type {
  CycleResult,
  PaperPositionSnapshot,
  PlannedAction,
  PositionRecord,
  SkillMeta,
  SkillOptimizationRecommendation
} from "../domain/models.js";
import type { Logger } from "../utils/logger.js";

export interface PendingActionRecord {
  action: PlannedAction;
  startedAt: Date;
  availableCapitalSol: number;
  txSignatures?: string[];
  metadata?: Record<string, unknown>;
  positionSnapshot?: PositionRecord;
}

export interface SharedStateSnapshot {
  startedAt: Date;
  mode: SystemMode;
  manualPause: boolean;
  availableCapitalSol: number;
  activePositions: PositionRecord[];
  allPositions: PositionRecord[];
  lastCycleResult?: CycleResult;
  lastMainCycleAt?: Date;
  lastHighFreqTickAt?: Date;
  lastPauseReason?: string;
  appliedActionIds?: string[];
  runtimeSkills?: SkillMeta[];
  pendingActions?: PendingActionRecord[];
  paperPositionSnapshots?: PaperPositionSnapshot[];
  skillOptimizationRecommendations?: SkillOptimizationRecommendation[];
}

interface SharedStateOptions {
  initialSnapshot?: Partial<SharedStateSnapshot>;
  onChange?: (snapshot: SharedStateSnapshot) => void | Promise<void>;
  logger?: Logger;
  persistFailureStrategy?: "off" | "close_only" | "close_only_then_pause";
}

/**
 * 目前先用进程内状态承载运行时数据。
 * 后续如果接入 Redis，只需要让这个类切换到底层存储实现，业务模块不需要大改。
 */
export class SharedState {
  private readonly positions = new Map<string, PositionRecord>();
  private readonly startedAt: Date;
  private manualPause = false;
  private mode = SystemMode.NORMAL;
  private availableCapitalSol = 100;
  private lastCycleResult?: CycleResult;
  private lastMainCycleAt?: Date;
  private lastHighFreqTickAt?: Date;
  private lastPauseReason?: string;
  private readonly onChange?: SharedStateOptions["onChange"];
  private readonly logger?: Logger;
  private pendingChange: Promise<void> = Promise.resolve();
  private readonly appliedActionIds: string[] = [];
  private readonly appliedActionSet = new Set<string>();
  private runtimeSkills: SkillMeta[] = [];
  private readonly pendingActions = new Map<string, PendingActionRecord>();
  private paperPositionSnapshots: PaperPositionSnapshot[] = [];
  private skillOptimizationRecommendations: SkillOptimizationRecommendation[] = [];
  private lastPersistError?: string;
  private readonly persistFailureStrategy: NonNullable<SharedStateOptions["persistFailureStrategy"]>;
  private consecutivePersistFailures = 0;

  constructor(options: SharedStateOptions = {}) {
    const initial = options.initialSnapshot;
    this.startedAt = initial?.startedAt ?? new Date();
    this.manualPause = initial?.manualPause ?? false;
    this.mode = initial?.mode ?? SystemMode.NORMAL;
    this.availableCapitalSol = initial?.availableCapitalSol ?? this.availableCapitalSol;
    this.lastCycleResult = initial?.lastCycleResult;
    this.lastMainCycleAt = initial?.lastMainCycleAt;
    this.lastHighFreqTickAt = initial?.lastHighFreqTickAt;
    this.lastPauseReason = initial?.lastPauseReason;
    this.onChange = options.onChange;
    this.logger = options.logger;
    this.persistFailureStrategy = options.persistFailureStrategy ?? "off";
    this.runtimeSkills = (initial?.runtimeSkills ?? []).map((skill) => structuredClone(skill));
    this.paperPositionSnapshots = (initial?.paperPositionSnapshots ?? []).map((snapshot) => structuredClone(snapshot));
    this.skillOptimizationRecommendations = (initial?.skillOptimizationRecommendations ?? []).map((recommendation) =>
      structuredClone(recommendation)
    );

    for (const position of initial?.allPositions ?? []) {
      this.positions.set(position.id, position);
    }

    for (const actionId of initial?.appliedActionIds ?? []) {
      if (typeof actionId !== "string" || actionId.length === 0 || this.appliedActionSet.has(actionId)) {
        continue;
      }

      this.appliedActionIds.push(actionId);
      this.appliedActionSet.add(actionId);
    }

    for (const pendingAction of initial?.pendingActions ?? []) {
      if (!pendingAction?.action?.id) {
        continue;
      }

      this.pendingActions.set(pendingAction.action.id, {
        action: structuredClone(pendingAction.action),
        startedAt: new Date(pendingAction.startedAt),
        availableCapitalSol: pendingAction.availableCapitalSol,
        txSignatures: pendingAction.txSignatures ? [...pendingAction.txSignatures] : undefined,
        metadata: pendingAction.metadata ? structuredClone(pendingAction.metadata) : undefined,
        positionSnapshot: pendingAction.positionSnapshot ? structuredClone(pendingAction.positionSnapshot) : undefined
      });
    }
  }

  getSnapshot(): SharedStateSnapshot {
    return {
      startedAt: this.startedAt,
      mode: this.mode,
      manualPause: this.manualPause,
      availableCapitalSol: this.availableCapitalSol,
      activePositions: this.getActivePositions(),
      allPositions: this.getAllPositions(),
      lastCycleResult: this.lastCycleResult,
      lastMainCycleAt: this.lastMainCycleAt,
      lastHighFreqTickAt: this.lastHighFreqTickAt,
      lastPauseReason: this.lastPauseReason,
      appliedActionIds: [...this.appliedActionIds],
      runtimeSkills: this.runtimeSkills.map((skill) => structuredClone(skill)),
      pendingActions: this.getPendingActions(),
      paperPositionSnapshots: this.getPaperPositionSnapshots(),
      skillOptimizationRecommendations: this.getSkillOptimizationRecommendations()
    };
  }

  getStartedAt(): Date {
    return this.startedAt;
  }

  getMode(): SystemMode {
    return this.mode;
  }

  setMode(mode: SystemMode): void {
    this.mode = mode;
    this.emitChange();
  }

  isManualPause(): boolean {
    return this.manualPause;
  }

  setManualPause(value: boolean): void {
    this.manualPause = value;
    this.emitChange();
  }

  setPauseReason(reason?: string): void {
    this.lastPauseReason = reason;
    this.emitChange();
  }

  getAvailableCapitalSol(): number {
    return this.availableCapitalSol;
  }

  setAvailableCapitalSol(value: number): void {
    this.availableCapitalSol = value;
    this.emitChange();
  }

  adjustAvailableCapitalSol(delta: number): void {
    this.availableCapitalSol += delta;
    this.emitChange();
  }

  upsertPosition(position: PositionRecord): void {
    this.positions.set(position.id, position);
    this.emitChange();
  }

  getPosition(id: string): PositionRecord | undefined {
    return this.positions.get(id);
  }

  getAllPositions(): PositionRecord[] {
    return Array.from(this.positions.values()).sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
  }

  getActivePositions(): PositionRecord[] {
    return this.getAllPositions().filter((position) => position.status === "active");
  }

  closePosition(id: string, closedAt: Date): void {
    const existing = this.positions.get(id);
    if (!existing) {
      return;
    }

    this.positions.set(id, {
      ...existing,
      status: "closed",
      closedAt,
      isInRange: false
    });
    this.emitChange();
  }

  setLastCycleResult(result: CycleResult): void {
    this.lastCycleResult = result;
    this.emitChange();
  }

  setLastMainCycleAt(timestamp: Date): void {
    this.lastMainCycleAt = timestamp;
    this.emitChange();
  }

  setLastHighFreqTickAt(timestamp: Date): void {
    this.lastHighFreqTickAt = timestamp;
    this.emitChange();
  }

  async flush(): Promise<void> {
    await this.pendingChange;
  }

  hasAppliedAction(actionId: string): boolean {
    return this.appliedActionSet.has(actionId);
  }

  markActionApplied(actionId: string): boolean {
    const normalized = actionId.trim();
    if (!normalized || this.appliedActionSet.has(normalized)) {
      return false;
    }

    this.appliedActionSet.add(normalized);
    this.appliedActionIds.push(normalized);
    while (this.appliedActionIds.length > 512) {
      const removed = this.appliedActionIds.shift();
      if (removed) {
        this.appliedActionSet.delete(removed);
      }
    }

    this.emitChange();
    return true;
  }

  getLastPersistError(): string | undefined {
    return this.lastPersistError;
  }

  getRuntimeSkills(): SkillMeta[] {
    return this.runtimeSkills.map((skill) => structuredClone(skill));
  }

  setRuntimeSkills(skills: SkillMeta[]): void {
    this.runtimeSkills = skills.map((skill) => structuredClone(skill));
    this.emitChange();
  }

  getSkillOptimizationRecommendations(): SkillOptimizationRecommendation[] {
    return this.skillOptimizationRecommendations.map((recommendation) => structuredClone(recommendation));
  }

  setSkillOptimizationRecommendations(recommendations: SkillOptimizationRecommendation[]): void {
    this.skillOptimizationRecommendations = recommendations.map((recommendation) => structuredClone(recommendation));
    this.emitChange();
  }

  getPendingActions(): PendingActionRecord[] {
    return Array.from(this.pendingActions.values())
      .map((record) => ({
        action: structuredClone(record.action),
        startedAt: new Date(record.startedAt),
        availableCapitalSol: record.availableCapitalSol,
        txSignatures: record.txSignatures ? [...record.txSignatures] : undefined,
        metadata: record.metadata ? structuredClone(record.metadata) : undefined,
        positionSnapshot: record.positionSnapshot ? structuredClone(record.positionSnapshot) : undefined
      }))
      .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
  }

  beginPendingAction(record: PendingActionRecord): void {
    this.pendingActions.set(record.action.id, {
      action: structuredClone(record.action),
      startedAt: new Date(record.startedAt),
      availableCapitalSol: record.availableCapitalSol,
      txSignatures: record.txSignatures ? [...record.txSignatures] : undefined,
      metadata: record.metadata ? structuredClone(record.metadata) : undefined,
      positionSnapshot: record.positionSnapshot ? structuredClone(record.positionSnapshot) : undefined
    });
    this.emitChange();
  }

  updatePendingAction(
    actionId: string,
    patch: {
      txSignatures?: string[];
      metadata?: Record<string, unknown>;
      positionSnapshot?: PositionRecord;
    }
  ): void {
    const existing = this.pendingActions.get(actionId);
    if (!existing) {
      return;
    }

    const nextTxSignatures = uniqueStrings([...(existing.txSignatures ?? []), ...(patch.txSignatures ?? [])]);
    this.pendingActions.set(actionId, {
      ...existing,
      txSignatures: nextTxSignatures.length > 0 ? nextTxSignatures : undefined,
      metadata: patch.metadata
        ? {
            ...(existing.metadata ?? {}),
            ...structuredClone(patch.metadata)
          }
        : existing.metadata,
      positionSnapshot: patch.positionSnapshot ? structuredClone(patch.positionSnapshot) : existing.positionSnapshot
    });
    this.emitChange();
  }

  clearPendingAction(actionId: string): void {
    if (!this.pendingActions.delete(actionId)) {
      return;
    }

    this.emitChange();
  }

  appendPaperPositionSnapshots(snapshots: PaperPositionSnapshot[], retention: number): void {
    if (snapshots.length === 0) {
      return;
    }

    const normalizedRetention = Math.max(0, Math.trunc(retention));
    this.paperPositionSnapshots.push(...snapshots.map((snapshot) => structuredClone(snapshot)));
    if (normalizedRetention === 0) {
      this.paperPositionSnapshots = [];
    } else if (this.paperPositionSnapshots.length > normalizedRetention) {
      this.paperPositionSnapshots = this.paperPositionSnapshots.slice(-normalizedRetention);
    }
    this.emitChange();
  }

  getPaperPositionSnapshots(filters: {
    positionId?: string;
    skillId?: string;
    limit?: number;
  } = {}): PaperPositionSnapshot[] {
    let snapshots = this.paperPositionSnapshots;
    if (filters.positionId) {
      snapshots = snapshots.filter((snapshot) => snapshot.positionId === filters.positionId);
    }
    if (filters.skillId) {
      snapshots = snapshots.filter((snapshot) => snapshot.skillId === filters.skillId);
    }

    const sorted = snapshots
      .map((snapshot) => structuredClone(snapshot))
      .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime());
    const limit = filters.limit !== undefined ? Math.max(0, Math.trunc(filters.limit)) : undefined;
    return limit !== undefined ? sorted.slice(0, limit) : sorted;
  }

  discardPendingAction(actionId: string): void {
    this.pendingActions.delete(actionId);
  }

  private emitChange(): void {
    if (!this.onChange) {
      return;
    }

    const snapshot = this.getSnapshot();
    this.pendingChange = this.pendingChange
      .catch(() => undefined)
      .then(() => Promise.resolve(this.onChange?.(snapshot)))
      .then(() => {
        this.lastPersistError = undefined;
        this.consecutivePersistFailures = 0;
      });

    void this.pendingChange.catch((error) => {
      this.lastPersistError = error instanceof Error ? error.message : String(error);
      this.consecutivePersistFailures += 1;
      this.applyPersistFailureProtection();
      this.logger?.error("共享状态持久化失败", {
        error
      });
    });
  }

  private applyPersistFailureProtection(): void {
    if (this.persistFailureStrategy === "off") {
      return;
    }

    if (this.mode !== SystemMode.EMERGENCY_PAUSED && this.mode !== SystemMode.CLOSE_ONLY) {
      this.mode = SystemMode.CLOSE_ONLY;
      this.lastPauseReason = "state_persist_failure_close_only";
      this.logger?.warn("共享状态持久化失败，系统切换到 close_only", {
        consecutiveFailures: this.consecutivePersistFailures,
        strategy: this.persistFailureStrategy,
        lastPersistError: this.lastPersistError
      });
    }

    if (
      this.persistFailureStrategy === "close_only_then_pause" &&
      this.consecutivePersistFailures >= 2 &&
      !this.manualPause
    ) {
      this.manualPause = true;
      this.lastPauseReason = "state_persist_failure_pause";
      this.logger?.error("共享状态持久化连续失败，系统切换到 emergency_paused", {
        consecutiveFailures: this.consecutivePersistFailures,
        lastPersistError: this.lastPersistError
      });
    }
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0)));
}
