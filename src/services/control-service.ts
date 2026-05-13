import type { AppRuntime } from "../app/runtime.js";
import type { PlannedAction } from "../domain/models.js";
import { createId } from "../utils/async.js";
import { rootLogger } from "../utils/logger.js";

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
      execution: this.runtime.executionLayer.getStatus(),
      paperTrading: this.runtime.paperTradingService.getSummary(),
      skillOptimizer: this.runtime.skillOptimizerService.getSummary(),
      rpc: rpcHealth,
      dataProviders: dataHealth
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
