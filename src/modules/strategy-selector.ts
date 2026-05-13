import type { PoolCandidate, PositionPlan, SkillMeta } from "../domain/models.js";
import { createId, clamp } from "../utils/async.js";
import type { LLMManager } from "../managers/llm-manager.js";
import type { SkillManager } from "../managers/skill-manager.js";
import type { Logger } from "../utils/logger.js";

interface LLMPlanRefinement {
  score: number;
  suggestedAmountSol: number;
  summary?: string;
}

function extractActiveBinId(pool: PoolCandidate): number {
  const raw = pool.meta?.activeBinId;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }

  return 8_000;
}

function ensureValidRange(range: { minBinId: number; maxBinId: number }): { minBinId: number; maxBinId: number } {
  if (!Number.isSafeInteger(range.minBinId) || !Number.isSafeInteger(range.maxBinId)) {
    throw new Error("策略生成的 bin range 必须是安全整数");
  }

  if (range.minBinId > range.maxBinId) {
    throw new Error(`策略生成的 bin range 非法: ${range.minBinId} > ${range.maxBinId}`);
  }

  return range;
}

/**
 * StrategySelector 把“这个池子值得做”转换成“应该用哪个 Skill、什么 bin range、投多少钱”。
 * 这里允许 LLM 提供解释，但最终参数计算必须是可复现的。
 */
export class StrategySelector {
  constructor(
    private readonly skillManager: SkillManager,
    private readonly llmManager: LLMManager,
    private readonly logger: Logger
  ) {}

  async matchSkills(candidates: PoolCandidate[], cycleId: string): Promise<PositionPlan[]> {
    const plans: PositionPlan[] = [];

    for (const candidate of candidates) {
      const skill = this.skillManager.selectSkillForPool(candidate);
      if (!skill) {
        continue;
      }

      const range = this.calculateRange(candidate, skill);
      const initialSuggestedAmountSol = this.calculateSuggestedAmount(candidate, skill);
      const initialScore = this.calculatePlanScore(candidate, skill);
      const refinement = await this.refinePlanWithLLM(candidate, skill, initialSuggestedAmountSol, initialScore, cycleId);

      plans.push({
        id: createId("plan"),
        pool: candidate,
        skill,
        score: refinement.score,
        reason: `池子 ${candidate.tokenSymbol} 命中 Skill ${skill.id}，综合评分 ${refinement.score.toFixed(2)}。`,
        range,
        suggestedAmountSol: refinement.suggestedAmountSol,
        ...(refinement.summary ? { llmSummary: refinement.summary } : {})
      });
    }

    const sortedPlans = plans.sort((left, right) => right.score - left.score);
    this.logger.info("策略匹配完成", {
      candidates: candidates.length,
      plans: sortedPlans.length
    });
    return sortedPlans;
  }

  private calculateRange(pool: PoolCandidate, skill: SkillMeta): { minBinId: number; maxBinId: number } {
    const activeBinId = extractActiveBinId(pool);
    const binCount = Math.max(1, skill.params.binCount);

    if (skill.params.direction === "below") {
      return ensureValidRange({
        minBinId: activeBinId - binCount,
        maxBinId: activeBinId - 1
      });
    }

    if (skill.params.direction === "above") {
      return ensureValidRange({
        minBinId: activeBinId + 1,
        maxBinId: activeBinId + binCount
      });
    }

    const half = Math.floor(binCount / 2);
    return ensureValidRange({
      minBinId: activeBinId - half,
      maxBinId: activeBinId + half
    });
  }

  private calculateSuggestedAmount(pool: PoolCandidate, skill: SkillMeta): number {
    const base = clamp(skill.riskLimits.maxPositionSizePercent * 0.2, 0.1, 0.4);
    const gradeBoost = pool.grade === "S" ? 0.08 : pool.grade === "A" ? 0.04 : 0;
    const smartMoneyBoost = pool.smartMoneyNet > 50_000 ? 0.08 : pool.smartMoneyNet > 0 ? 0.04 : 0;
    return clamp(base + gradeBoost + smartMoneyBoost, 0.1, 0.45);
  }

  private calculatePlanScore(pool: PoolCandidate, skill: SkillMeta): number {
    const feeScore = clamp(pool.feeTvlRatio24h, 0, 10) * 0.35;
    const safetyScore = clamp(pool.safetyScore / 10, 0, 10) * 0.25;
    const lincolnScore = clamp(pool.lincolnScore, 0, 10) * 0.3;
    const canaryPenalty = skill.status === "canary" ? 0.7 : 0;
    return feeScore + safetyScore + lincolnScore - canaryPenalty;
  }

  private async refinePlanWithLLM(
    pool: PoolCandidate,
    skill: SkillMeta,
    suggestedAmountSol: number,
    score: number,
    cycleId: string
  ): Promise<LLMPlanRefinement> {
    try {
      const response = await this.llmManager.chat(
        "default",
        {
          messages: [
            {
              role: "user",
              content:
                `你是 LP 策略副驾驶。请根据池子特征和选中的 Skill 输出 JSON，字段只允许包含 ` +
                `"summary"、"scoreDelta"、"amountMultiplier"。要求：scoreDelta 只能在 -1 到 1 之间，` +
                `amountMultiplier 只能在 0.75 到 1.25 之间；不要推翻规则引擎，只能做小幅微调。\n` +
                `池子=${pool.tokenSymbol} feeTvl=${pool.feeTvlRatio24h} safety=${pool.safetyScore} ` +
                `lincoln=${pool.lincolnScore} smartMoney=${pool.smartMoneyNet} stage=${pool.lifecycleStage}\n` +
                `skill=${skill.id} direction=${skill.params.direction} binCount=${skill.params.binCount} ` +
                `riskStopLoss=${skill.riskLimits.stopLossPercent}`
            }
          ],
          jsonMode: true,
          temperature: 0.2,
          maxTokens: 200
        },
        cycleId
      );

      const parsed = JSON.parse(response.content) as Record<string, unknown>;
      const scoreDelta = typeof parsed.scoreDelta === "number" ? clamp(parsed.scoreDelta, -1, 1) : 0;
      const amountMultiplier =
        typeof parsed.amountMultiplier === "number" ? clamp(parsed.amountMultiplier, 0.75, 1.25) : 1;
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : undefined;

      return {
        score: clamp(score + scoreDelta, 0, 10),
        suggestedAmountSol: clamp(suggestedAmountSol * amountMultiplier, 0.1, 0.45),
        summary
      };
    } catch (error) {
      this.logger.warn("策略微调生成失败，忽略 LLM 建议", {
        pool: pool.address,
        skill: skill.id,
        error
      });
      return {
        score,
        suggestedAmountSol
      };
    }
  }
}
