import { SystemMode } from "../domain/models.js";
import type { PlannedAction, PositionRecord, ReviewedPlan } from "../domain/models.js";
import { createId } from "../utils/async.js";
import type { Logger } from "../utils/logger.js";

/**
 * PortfolioManager 的职责不是“挑最聪明的计划”，而是把已经过风控审核的计划
 * 转换成可执行动作，并控制资金消耗顺序。
 */
export class PortfolioManager {
  constructor(private readonly logger: Logger) {}

  optimize(
    reviewedPlans: ReviewedPlan[],
    activePositions: PositionRecord[],
    availableCapitalSol: number,
    mode: SystemMode
  ): PlannedAction[] {
    if (mode !== SystemMode.NORMAL) {
      this.logger.info("当前系统模式不允许新开仓，组合管理仅返回空动作集", { mode });
      return [];
    }

    const actions: PlannedAction[] = [];
    const occupiedPools = new Set(activePositions.map((position) => position.poolAddress));
    let capitalLeft = availableCapitalSol;

    for (const plan of reviewedPlans.filter((item) => item.approved).sort((left, right) => right.score - left.score)) {
      if (occupiedPools.has(plan.pool.address)) {
        continue;
      }

      if (capitalLeft < 0.3) {
        break;
      }

      const amountSol = Math.min(plan.suggestedAmountSol, capitalLeft);
      if (amountSol < 0.3) {
        continue;
      }

      actions.push({
        id: createId("action"),
        type: "open",
        trigger: "scheduled",
        reason: plan.reason,
        pool: plan.pool,
        skill: plan.skill,
        amountSol,
        newRange: plan.range,
        metadata: {
          score: plan.score,
          llmSummary: plan.llmSummary
        }
      });

      capitalLeft -= amountSol;
      occupiedPools.add(plan.pool.address);
    }

    this.logger.info("组合管理完成", {
      approvedPlans: reviewedPlans.filter((item) => item.approved).length,
      actions: actions.length,
      capitalLeft
    });

    return actions;
  }
}
