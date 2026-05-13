import { SystemMode } from "../domain/models.js";
import type {
  PoolCandidate,
  PositionDirection,
  PlannedAction,
  PortfolioHealth,
  PositionPlan,
  PositionRecord,
  ReviewedPlan,
  SkillMeta,
  UrgentSignalSummary
} from "../domain/models.js";
import type { AgentConfig } from "../config/types.js";
import type { SharedStateSnapshot } from "../core/shared-state.js";
import type { SkillManager } from "../managers/skill-manager.js";
import { createId } from "../utils/async.js";
import type { Logger } from "../utils/logger.js";

/**
 * RiskSentinel 是系统里最不应该“想当然”的模块。
 * 它的职责是明确拒绝危险计划，并在持仓变坏时给出确定性的退出/重平衡动作。
 */
export class RiskSentinel {
  constructor(
    private readonly config: AgentConfig,
    private readonly skillManager: SkillManager,
    private readonly logger: Logger
  ) {}

  review(plans: PositionPlan[], state: SharedStateSnapshot, mode: SystemMode): ReviewedPlan[] {
    const activePositions = state.activePositions;
    const reviewed: ReviewedPlan[] = [];
    const portfolioTotalSol = state.availableCapitalSol + activePositions.reduce((sum, position) => sum + position.depositedSol, 0);
    let projectedExposureSol = activePositions.reduce((sum, position) => sum + position.depositedSol, 0);
    const openedSolLast24h = state.allPositions
      .filter((position) => Date.now() - position.openedAt.getTime() <= 24 * 60 * 60 * 1000)
      .reduce((sum, position) => sum + position.depositedSol, 0);
    const narrativeCounts = new Map<string, number>();

    for (const position of activePositions) {
      if (position.narrative) {
        narrativeCounts.set(position.narrative, (narrativeCounts.get(position.narrative) ?? 0) + 1);
      }
    }

    for (const plan of plans) {
      let rejectionReason: string | undefined;

      if (mode !== SystemMode.NORMAL) {
        rejectionReason = `当前系统模式为 ${mode}，禁止新开仓。`;
      }

      const sameSkillCount = activePositions.filter((position) => position.skillId === plan.skill.id).length;
      if (!rejectionReason && sameSkillCount >= plan.skill.riskLimits.maxConcurrentPositions) {
        rejectionReason = `Skill ${plan.skill.id} 已达到并发持仓上限。`;
      }

      if (!rejectionReason && activePositions.length >= this.config.system.max_concurrent_positions) {
        rejectionReason = `系统活跃仓位数已达到 ${this.config.system.max_concurrent_positions} 上限。`;
      }

      const maxPositionPct = Math.min(this.config.risk.max_position_pct, plan.skill.riskLimits.maxPositionSizePercent);
      const nextPositionPct = portfolioTotalSol > 0 ? (plan.suggestedAmountSol / portfolioTotalSol) * 100 : 0;
      if (!rejectionReason && nextPositionPct > maxPositionPct) {
        rejectionReason = `单仓敞口 ${nextPositionPct.toFixed(2)}% 超过上限 ${maxPositionPct.toFixed(2)}%。`;
      }

      const tokenExposureSol = activePositions
        .filter((position) => position.tokenMint === plan.pool.tokenMint)
        .reduce((sum, position) => sum + position.depositedSol, 0);
      const tokenExposurePct = portfolioTotalSol > 0 ? ((tokenExposureSol + plan.suggestedAmountSol) / portfolioTotalSol) * 100 : 0;
      if (!rejectionReason && tokenExposurePct > this.config.risk.max_token_exposure_pct) {
        rejectionReason = `同 token 敞口 ${tokenExposurePct.toFixed(2)}% 超过上限。`;
      }

      const sameSkillExposureSol = activePositions
        .filter((position) => position.skillId === plan.skill.id)
        .reduce((sum, position) => sum + position.depositedSol, 0);
      const sameSkillExposurePct =
        portfolioTotalSol > 0 ? ((sameSkillExposureSol + plan.suggestedAmountSol) / portfolioTotalSol) * 100 : 0;
      if (!rejectionReason && sameSkillExposurePct > plan.skill.riskLimits.maxTotalExposurePercent) {
        rejectionReason = `Skill ${plan.skill.id} 敞口 ${sameSkillExposurePct.toFixed(2)}% 超过策略上限。`;
      }

      const narrative = plan.pool.narrative ?? "unknown";
      const narrativeCount = narrativeCounts.get(narrative) ?? 0;
      if (!rejectionReason && narrativeCount >= this.config.risk.max_narrative_pools) {
        rejectionReason = `同 narrative 池数量已达到 ${this.config.risk.max_narrative_pools}。`;
      }

      const nextExposurePct = portfolioTotalSol > 0 ? ((projectedExposureSol + plan.suggestedAmountSol) / portfolioTotalSol) * 100 : 0;
      if (!rejectionReason && nextExposurePct > this.config.risk.max_total_lp_pct) {
        rejectionReason = `总 LP 敞口 ${nextExposurePct.toFixed(2)}% 超过全局上限。`;
      }

      if (!rejectionReason && plan.suggestedAmountSol > this.config.wallet.limits.per_transaction_max_sol) {
        rejectionReason = "单笔计划金额超过钱包限额。";
      }

      if (!rejectionReason && openedSolLast24h + plan.suggestedAmountSol > this.config.wallet.limits.daily_cumulative_max_sol) {
        rejectionReason = "近 24 小时累计开仓金额超过钱包日限额。";
      }

      const approved = !rejectionReason;
      reviewed.push({
        ...plan,
        approved,
        ...(rejectionReason ? { rejectionReason } : {})
      });

      if (approved) {
        projectedExposureSol += plan.suggestedAmountSol;
        narrativeCounts.set(narrative, narrativeCount + 1);
      }
    }

    this.logger.info("风控审核完成", {
      totalPlans: plans.length,
      approvedPlans: reviewed.filter((item) => item.approved).length,
      rejectedPlans: reviewed.filter((item) => !item.approved).length
    });

    return reviewed;
  }

  inspectActivePositions(
    activePositions: PositionRecord[],
    activeBinByPool = new Map<string, number>(),
    poolByAddress = new Map<string, PoolCandidate>()
  ): PlannedAction[] {
    const actions: PlannedAction[] = [];

    for (const position of activePositions) {
      const skill = this.findSkill(position.skillId, position.skillVersion);
      const ageHours = (Date.now() - position.openedAt.getTime()) / (60 * 60 * 1000);
      const currentPool = poolByAddress.get(position.poolAddress);

      if (position.pnlPercent <= -this.config.risk.stop_loss_pct) {
        actions.push({
          id: createId("action"),
          type: "close",
          trigger: "stop_loss",
          reason: `仓位 ${position.id} 触发全局止损线。`,
          positionId: position.id
        });
        continue;
      }

      if (skill && position.pnlPercent <= -skill.riskLimits.stopLossPercent) {
        actions.push({
          id: createId("action"),
          type: "close",
          trigger: "skill_stop_loss",
          reason: `仓位 ${position.id} 触发 Skill 止损线。`,
          positionId: position.id
        });
        continue;
      }

      if (currentPool && currentPool.lincolnScore < this.config.risk.lincoln_exit_threshold) {
        actions.push({
          id: createId("action"),
          type: "close",
          trigger: "lincoln_exit",
          reason: `仓位 ${position.id} 当前 Lincoln Score 低于退出阈值。`,
          positionId: position.id
        });
        continue;
      }

      if (ageHours >= this.config.risk.max_alive_hours || position.maxAliveUntil.getTime() <= Date.now()) {
        actions.push({
          id: createId("action"),
          type: "close",
          trigger: "max_alive",
          reason: `仓位 ${position.id} 已超过最大存活时间。`,
          positionId: position.id
        });
        continue;
      }

      const claimReferenceAt = position.lastFeeCheckAt ?? position.lastClaimedAt ?? position.openedAt;
      const dueForClaim =
        this.config.risk.fee_claim_interval_hours > 0 &&
        Date.now() - claimReferenceAt.getTime() >= this.config.risk.fee_claim_interval_hours * 60 * 60 * 1000;
      if (dueForClaim && position.isInRange) {
        actions.push({
          id: createId("action"),
          type: "claim",
          trigger: "fee_interval",
          reason: `仓位 ${position.id} 到达手续费检查/提取周期。`,
          positionId: position.id
        });
      }

      if (!position.isInRange && position.outOfRangeSince && Date.now() - position.outOfRangeSince.getTime() > 5 * 60 * 1000) {
        if (skill && position.rebalanceCount >= skill.riskLimits.maxDailyRebalances) {
          actions.push({
            id: createId("action"),
            type: "close",
            trigger: "rebalance_limit",
            reason: `仓位 ${position.id} 重平衡次数已达到 Skill 上限，执行平仓。`,
            positionId: position.id
          });
          continue;
        }

        const activeBinId = activeBinByPool.get(position.poolAddress);
        if (activeBinId === undefined) {
          this.logger.warn("仓位出界，但当前未拿到 active bin，跳过自动重平衡", {
            positionId: position.id,
            poolAddress: position.poolAddress
          });
          continue;
        }

        actions.push({
          id: createId("action"),
          type: "rebalance",
          trigger: "out_of_range",
          reason: `仓位 ${position.id} 已持续出界超过 5 分钟。`,
          positionId: position.id,
          newRange: this.buildRangeAroundActiveBin(position.direction, position.fromBinId, position.toBinId, activeBinId)
        });
      }
    }

    return actions;
  }

  buildEmergencyExitActions(signals: UrgentSignalSummary, positions: PositionRecord[]): PlannedAction[] {
    if (!signals.hasDevSell && !signals.hasRug) {
      return [];
    }

    const affectedMints = new Set(signals.signals.map((signal) => signal.tokenMint));
    return positions
      .filter((position) => affectedMints.has(position.tokenMint))
      .map((position) => ({
        id: createId("action"),
        type: "emergency_exit",
        trigger: signals.hasRug ? "rug" : "dev_sell",
        reason: `仓位 ${position.id} 命中紧急信号，执行强制撤出。`,
        positionId: position.id
      }));
  }

  buildPortfolioHealth(activePositions: PositionRecord[], availableCapitalSol: number): PortfolioHealth {
    const totalExposureSol = activePositions.reduce((sum, position) => sum + position.depositedSol, 0);
    const totalCapitalSol = totalExposureSol + availableCapitalSol;
    const weightedPnl = activePositions.reduce(
      (sum, position) => sum + position.depositedSol * (position.pnlPercent / 100),
      0
    );

    return {
      dailyLossPct: totalCapitalSol > 0 ? Math.max(0, (-weightedPnl / totalCapitalSol) * 100) : 0,
      activePositions: activePositions.length,
      totalExposureSol,
      totalExposurePct: totalCapitalSol > 0 ? (totalExposureSol / totalCapitalSol) * 100 : 0
    };
  }

  private findSkill(skillId: string, version: string): SkillMeta | undefined {
    return this.skillManager.getSkill(skillId, version) ?? undefined;
  }

  private buildRangeAroundActiveBin(
    direction: PositionDirection,
    fromBinId: number,
    toBinId: number,
    activeBinId: number
  ): { minBinId: number; maxBinId: number } {
    const binCount = Math.max(1, toBinId - fromBinId + 1);
    if (direction === "below") {
      return {
        minBinId: activeBinId - binCount,
        maxBinId: activeBinId - 1
      };
    }

    if (direction === "above") {
      return {
        minBinId: activeBinId + 1,
        maxBinId: activeBinId + binCount
      };
    }

    const lowerSpan = Math.floor((binCount - 1) / 2);
    const upperSpan = binCount - 1 - lowerSpan;
    return {
      minBinId: activeBinId - lowerSpan,
      maxBinId: activeBinId + upperSpan
    };
  }
}
