import { SystemMode } from "../domain/models.js";
import type {
  CycleResult,
  PlannedAction
} from "../domain/models.js";
import type { IAuditLogger, INotifier } from "../domain/contracts.js";
import type { SharedState } from "../core/shared-state.js";
import type { DataProviderManager } from "../managers/data-provider-manager.js";
import type { MetricsService } from "../metrics/metrics-service.js";
import type { RPCManager } from "../managers/rpc-manager.js";
import type { SystemModeManager } from "../managers/system-mode-manager.js";
import type { PoolScout } from "../modules/pool-scout.js";
import type { PortfolioManager } from "../modules/portfolio-manager.js";
import type { RiskSentinel } from "../modules/risk-sentinel.js";
import type { StrategySelector } from "../modules/strategy-selector.js";
import type { ExecutionLayer } from "../execution/execution-layer.js";
import type { AgentConfig } from "../config/types.js";
import type { PaperTradingService } from "../services/paper-trading-service.js";
import type { SkillOptimizerService } from "../services/skill-optimizer-service.js";
import { createId, sleep } from "../utils/async.js";
import type { Logger } from "../utils/logger.js";

/**
 * Orchestrator 是整个系统的总调度中心。
 * 这里的关键原则有两个：
 * 1. 单次循环出错不能把整个进程打死；
 * 2. 所有阶段都必须留下审计痕迹。
 */
export class Orchestrator {
  private running = false;
  private mainCyclePromise?: Promise<CycleResult>;
  private highFreqPromise?: Promise<void>;

  constructor(
    private readonly config: AgentConfig,
    private readonly state: SharedState,
    private readonly poolScout: PoolScout,
    private readonly strategySelector: StrategySelector,
    private readonly riskSentinel: RiskSentinel,
    private readonly portfolioManager: PortfolioManager,
    private readonly executionLayer: ExecutionLayer,
    private readonly paperTradingService: PaperTradingService,
    private readonly dataProviderManager: DataProviderManager,
    private readonly rpcManager: RPCManager,
    private readonly systemModeManager: SystemModeManager,
    private readonly metricsService: MetricsService,
    private readonly auditLogger: IAuditLogger,
    private readonly notifier: INotifier,
    private readonly logger: Logger,
    private readonly skillOptimizerService?: SkillOptimizerService
  ) {}

  async runMainCycle(): Promise<CycleResult> {
    if (this.mainCyclePromise) {
      this.logger.warn("主循环已在执行中，复用当前任务");
      return this.mainCyclePromise;
    }

    this.mainCyclePromise = this.runMainCycleInternal();
    try {
      return await this.mainCyclePromise;
    } finally {
      this.mainCyclePromise = undefined;
    }
  }

  async runHighFreqTick(): Promise<void> {
    if (this.highFreqPromise) {
      return this.highFreqPromise;
    }

    this.highFreqPromise = this.runHighFreqTickInternal();
    try {
      await this.highFreqPromise;
    } finally {
      this.highFreqPromise = undefined;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private async runMainCycleInternal(): Promise<CycleResult> {
    const cycleId = createId("cycle");
    const startedAt = new Date();

    await this.auditLogger.startCycle(cycleId, { type: "main" });

    try {
      await this.rpcManager.healthCheck();
      const dataHealth = await this.dataProviderManager.healthCheck();
      const rpcHealth = this.rpcManager.getHealth();

      const snapshot = this.state.getSnapshot();
      const portfolioHealth = this.riskSentinel.buildPortfolioHealth(
        snapshot.activePositions,
        snapshot.availableCapitalSol
      );
      const mode = this.systemModeManager.evaluateMode({
        manualPaused: snapshot.manualPause,
        rpcHealth,
        dataHealth,
        portfolioHealth
      });
      this.state.setMode(mode);

      if (mode === SystemMode.EMERGENCY_PAUSED) {
        const pausedResult: CycleResult = {
          cycleId,
          mode,
          scanned: 0,
          plans: 0,
          approved: 0,
          executed: 0,
          failed: 0,
          actions: [],
          results: [],
          startedAt,
          finishedAt: new Date()
        };
      this.state.setLastCycleResult(pausedResult);
      this.state.setLastMainCycleAt(new Date());
      this.metricsService.recordCycle("main", pausedResult);
      this.refreshSkillOptimizationRecommendations();
      await this.auditLogger.finishCycle(cycleId, pausedResult);
      return pausedResult;
      }

      if (this.shouldAutoExitOnProviderDegradation(dataHealth) && snapshot.activePositions.length > 0) {
        const autoExitResult = await this.executeAutoExitCycle(cycleId, startedAt, snapshot.activePositions, dataHealth.allProvidersDownForMs ?? 0);
        this.state.setLastCycleResult(autoExitResult);
        this.state.setLastMainCycleAt(autoExitResult.finishedAt);
        this.metricsService.recordCycle("main", autoExitResult);
        this.refreshSkillOptimizationRecommendations();
        await this.auditLogger.finishCycle(cycleId, autoExitResult);
        await this.notifier.sendCycleSummary(autoExitResult);
        return autoExitResult;
      }

      const candidates = await this.poolScout.discoverAndScore(cycleId);
      await this.auditLogger.recordPhase(cycleId, "scan", { candidates: candidates.length });

      const paperValuation = this.paperTradingService.valuate(candidates);
      await this.auditLogger.recordPhase(cycleId, "paper_valuation", {
        enabled: paperValuation.enabled,
        updated: paperValuation.updated,
        stale: paperValuation.stale,
        skipped: paperValuation.skipped
      });

      const plans = await this.strategySelector.matchSkills(candidates, cycleId);
      await this.auditLogger.recordPhase(cycleId, "evaluate", { plans: plans.length });

      const reviewedPlans = this.riskSentinel.review(plans, this.state.getSnapshot(), mode);
      await this.auditLogger.recordPhase(cycleId, "risk_review", {
        approved: reviewedPlans.filter((item) => item.approved).length,
        rejected: reviewedPlans.filter((item) => !item.approved).length
      });

      const activeBinByPool = new Map<string, number>(
        candidates.flatMap((candidate) =>
          typeof candidate.meta?.activeBinId === "number" && Number.isFinite(candidate.meta.activeBinId)
            ? [[candidate.address, Math.trunc(candidate.meta.activeBinId)]]
            : []
        )
      );
      const candidateByPoolAddress = new Map<string, CycleResult["actions"][number]["pool"]>(
        candidates.map((candidate) => [candidate.address, candidate])
      );
      const maintenanceActions = this.riskSentinel.inspectActivePositions(
        this.state.getActivePositions(),
        activeBinByPool,
        candidateByPoolAddress as Map<string, any>
      );
      const portfolioActions = this.portfolioManager.optimize(
        reviewedPlans,
        this.state.getActivePositions(),
        this.state.getAvailableCapitalSol(),
        mode
      );
      const actions: PlannedAction[] = [...maintenanceActions, ...portfolioActions];

      await this.auditLogger.recordPhase(cycleId, "portfolio", {
        maintenanceActions: maintenanceActions.length,
        portfolioActions: portfolioActions.length,
        totalActions: actions.length
      });

      const results = [];
      for (const action of actions) {
        const result = await this.executionLayer.execute(action);
        results.push(result);
        await this.auditLogger.recordAction(cycleId, action, result);
      }

      const failed = results.filter((result) => result.status === "failed").length;
      const cycleResult: CycleResult = {
        cycleId,
        mode,
        scanned: candidates.length,
        plans: plans.length,
        approved: reviewedPlans.filter((item) => item.approved).length,
        executed: results.filter((result) => result.status === "success").length,
        failed,
        actions,
        results,
        startedAt,
        finishedAt: new Date()
      };

      this.state.setLastCycleResult(cycleResult);
      this.state.setLastMainCycleAt(cycleResult.finishedAt);
      this.metricsService.recordCycle("main", cycleResult);
      this.refreshSkillOptimizationRecommendations();
      await this.auditLogger.finishCycle(cycleId, cycleResult);
      await this.notifier.sendCycleSummary(cycleResult);

      return cycleResult;
    } catch (error) {
      await this.auditLogger.recordError(cycleId, error, { phase: "main_cycle" });

      const failedResult: CycleResult = {
        cycleId,
        mode: this.state.getMode(),
        scanned: 0,
        plans: 0,
        approved: 0,
        executed: 0,
        failed: 1,
        actions: [],
        results: [],
        startedAt,
        finishedAt: new Date()
      };

      this.state.setLastCycleResult(failedResult);
      this.state.setLastMainCycleAt(failedResult.finishedAt);
      this.metricsService.recordCycle("main", failedResult);
      this.refreshSkillOptimizationRecommendations();
      await this.auditLogger.finishCycle(cycleId, failedResult);
      this.logger.error("主循环执行失败", { cycleId, error });
      return failedResult;
    }
  }

  private shouldAutoExitOnProviderDegradation(dataHealth: { hasAnyProvider: boolean; allProvidersDownForMs?: number }): boolean {
    return !dataHealth.hasAnyProvider && (dataHealth.allProvidersDownForMs ?? 0) >= this.config.data_providers.cache.auto_exit_ms;
  }

  private refreshSkillOptimizationRecommendations(): void {
    try {
      this.skillOptimizerService?.evaluateAndStore();
    } catch (error) {
      this.logger.warn("Skill Optimizer 评估失败，保留上一轮建议", { error });
    }
  }

  private async executeAutoExitCycle(
    cycleId: string,
    startedAt: Date,
    activePositions: ReturnType<SharedState["getActivePositions"]>,
    allProvidersDownForMs: number
  ): Promise<CycleResult> {
    const actions: PlannedAction[] = activePositions.map((position) => ({
      id: createId("action"),
      type: "emergency_exit",
      trigger: "provider_auto_exit",
      reason: "所有数据源长时间不可用，触发自动全撤。",
      positionId: position.id
    }));

    await this.auditLogger.recordPhase(cycleId, "provider_auto_exit", {
      actions: actions.length,
      allProvidersDownForMs
    });

    const results = [];
    for (const action of actions) {
      const result = await this.executionLayer.execute(action);
      results.push(result);
      await this.auditLogger.recordAction(cycleId, action, result);
    }

    await this.notifier.sendAlert(
      "critical",
      "所有数据源长时间不可用，已自动全撤",
      `已触发 ${actions.length} 个 emergency_exit 动作。`,
      {
        cycleId,
        allProvidersDownForMs
      }
    );

    return {
      cycleId,
      mode: this.state.getMode(),
      scanned: 0,
      plans: 0,
      approved: actions.length,
      executed: results.filter((result) => result.status === "success").length,
      failed: results.filter((result) => result.status === "failed").length,
      actions,
      results,
      startedAt,
      finishedAt: new Date()
    };
  }

  private async runHighFreqTickInternal(): Promise<void> {
    if (this.state.isManualPause()) {
      return;
    }

    const activePositions = this.state.getActivePositions();
    if (activePositions.length === 0) {
      return;
    }

    const tickId = createId("highfreq");
    await this.auditLogger.startCycle(tickId, { type: "high_freq" });

    try {
      const urgentSignals = await this.dataProviderManager.getUrgentSignals(
        activePositions.map((position) => position.tokenMint)
      );
      const actions = this.riskSentinel.buildEmergencyExitActions(urgentSignals, activePositions);

      if (actions.length === 0) {
        const result = {
          cycleId: tickId,
          mode: this.state.getMode(),
          scanned: 0,
          plans: 0,
          approved: 0,
          executed: 0,
          failed: 0,
          actions: [],
          results: [],
          startedAt: new Date(),
          finishedAt: new Date()
        };
        this.state.setLastHighFreqTickAt(result.finishedAt);
        this.metricsService.recordCycle("high_freq", result);
        await this.auditLogger.finishCycle(tickId, result);
        return;
      }

      const results = [];
      for (const action of actions) {
        const result = await this.executionLayer.execute(action);
        results.push(result);
        await this.auditLogger.recordAction(tickId, action, result);
      }

      await this.notifier.sendAlert(
        "critical",
        "检测到紧急信号",
        `高频循环触发 ${actions.length} 个紧急撤出动作。`,
        {
          tickId,
          signalCount: urgentSignals.signals.length
        }
      );

      const cycleResult = {
        cycleId: tickId,
        mode: this.state.getMode(),
        scanned: 0,
        plans: 0,
        approved: actions.length,
        executed: results.filter((result) => result.status === "success").length,
        failed: results.filter((result) => result.status === "failed").length,
        actions,
        results,
        startedAt: new Date(),
        finishedAt: new Date()
      };
      this.state.setLastHighFreqTickAt(cycleResult.finishedAt);
      this.metricsService.recordCycle("high_freq", cycleResult);
      await this.auditLogger.finishCycle(tickId, cycleResult);
    } catch (error) {
      await this.auditLogger.recordError(tickId, error, { phase: "high_freq" });
      this.logger.error("高频循环执行失败", { tickId, error });
    }
  }

  async pause(reason = "manual"): Promise<void> {
    this.state.setManualPause(true);
    this.state.setPauseReason(reason);
    this.logger.warn("编排器已暂停", { reason });
  }

  async resume(): Promise<void> {
    this.state.setManualPause(false);
    this.state.setPauseReason(undefined);
    this.logger.info("编排器已恢复");
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.logger.info("编排器开始运行");

    void this.runMainLoop();
    void this.runHighFreqLoop();
  }

  stop(): void {
    this.running = false;
    this.logger.warn("编排器停止运行");
  }

  private async runMainLoop(): Promise<void> {
    while (this.running) {
      await this.runMainCycle();
      await sleep(this.config.system.main_loop_interval_ms);
    }
  }

  private async runHighFreqLoop(): Promise<void> {
    while (this.running) {
      await this.runHighFreqTick();
      await sleep(this.config.system.high_freq_interval_ms);
    }
  }
}
