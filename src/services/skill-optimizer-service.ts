import type { AgentConfig } from "../config/types.js";
import type { SharedState } from "../core/shared-state.js";
import type {
  PaperPositionSnapshot,
  PositionRecord,
  SkillMeta,
  SkillOptimizationRecommendation,
  SkillOptimizationSuggestedAction,
  SkillRuntimeStats
} from "../domain/models.js";
import type { SkillManager } from "../managers/skill-manager.js";
import type { SkillStatsService } from "./skill-stats-service.js";

interface SkillEvidence {
  skill: SkillMeta;
  stats?: SkillRuntimeStats;
  positions: PositionRecord[];
  snapshots: PaperPositionSnapshot[];
}

const STALE_RATIO_LIMIT = 0.35;

export interface AppliedSkillOptimization {
  skillId: string;
  skillVersion: string;
  suggestedAction: SkillOptimizationSuggestedAction;
  confidence: number;
  patch: {
    params?: NonNullable<SkillOptimizationRecommendation["paramsPatch"]>;
    riskLimits?: NonNullable<SkillOptimizationRecommendation["riskLimitsPatch"]>;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function changeByPercent(value: number, percent: number): number {
  return value * (1 + percent / 100);
}

function limitPercent(config: AgentConfig): number {
  return clamp(config.skill_optimizer?.max_patch_pct ?? 20, 1, 50);
}

function roundPatchValue(value: number): number {
  return Math.max(1, Math.round(value));
}

function countOutOfRangeSnapshots(snapshots: PaperPositionSnapshot[]): number {
  return snapshots.filter((snapshot) => !snapshot.inRange).length;
}

function buildHold(
  evidence: SkillEvidence,
  evaluatedAt: Date,
  reason: string,
  disabledReason?: string
): SkillOptimizationRecommendation {
  return {
    skillId: evidence.skill.id,
    skillVersion: evidence.skill.version,
    evaluatedAt,
    suggestedAction: "hold",
    confidence: 0,
    reason,
    ...(disabledReason ? { disabledReason } : {})
  };
}

/**
 * SkillOptimizerService 默认只生成建议；只有配置显式开启 auto_apply 时，才会在 dry_run 下自动应用高置信度 patch。
 */
export class SkillOptimizerService {
  constructor(
    private readonly config: AgentConfig,
    private readonly state: SharedState,
    private readonly skillStatsService: SkillStatsService,
    private readonly skillManager: SkillManager
  ) {}

  listRecommendations(): SkillOptimizationRecommendation[] {
    return this.state.getSkillOptimizationRecommendations();
  }

  evaluate(): SkillOptimizationRecommendation[] {
    const evaluatedAt = new Date();
    const skills = this.skillManager.listAll();
    const disabledReason = this.getDisabledReason();
    const statsBySkill = new Map(
      this.skillStatsService.listStats().map((stats) => [`${stats.skillId}:${stats.skillVersion}`, stats])
    );
    const snapshot = this.state.getSnapshot();

    return skills.map((skill) => {
      const key = `${skill.id}:${skill.version}`;
      const evidence: SkillEvidence = {
        skill,
        stats: statsBySkill.get(key),
        positions: snapshot.allPositions.filter(
          (position) => position.skillId === skill.id && position.skillVersion === skill.version
        ),
        snapshots: (snapshot.paperPositionSnapshots ?? []).filter(
          (item) => item.skillId === skill.id && item.skillVersion === skill.version
        )
      };

      if (disabledReason) {
        return buildHold(evidence, evaluatedAt, disabledReason, disabledReason);
      }

      return this.evaluateSkill(evidence, evaluatedAt);
    });
  }

  evaluateAndStore(): SkillOptimizationRecommendation[] {
    const recommendations = this.evaluate();
    this.state.setSkillOptimizationRecommendations(recommendations);
    return recommendations;
  }

  applyEligibleRecommendations(
    recommendations = this.listRecommendations()
  ): AppliedSkillOptimization[] {
    if (this.config.skill_optimizer?.auto_apply !== true || this.getDisabledReason()) {
      return [];
    }

    const minConfidence = this.config.skill_optimizer.min_auto_apply_confidence ?? 0.7;
    const minClosedPositions = this.config.skill_optimizer.min_auto_apply_closed_positions ?? 10;
    const allowedActions = new Set(
      this.config.skill_optimizer.auto_apply_actions ?? ["tighten", "widen", "reduce_risk"]
    );
    const closedCountBySkill = new Map<string, number>();
    for (const position of this.state.getAllPositions()) {
      if (position.status === "active") {
        continue;
      }

      const key = `${position.skillId}:${position.skillVersion}`;
      closedCountBySkill.set(key, (closedCountBySkill.get(key) ?? 0) + 1);
    }

    const applied: AppliedSkillOptimization[] = [];
    for (const recommendation of recommendations) {
      const paramsPatch = recommendation.paramsPatch ?? {};
      const riskLimitsPatch = recommendation.riskLimitsPatch ?? {};
      const hasPatch = Object.keys(paramsPatch).length > 0 || Object.keys(riskLimitsPatch).length > 0;
      const closedCount = closedCountBySkill.get(`${recommendation.skillId}:${recommendation.skillVersion}`) ?? 0;
      if (
        recommendation.disabledReason ||
        !hasPatch ||
        recommendation.confidence < minConfidence ||
        closedCount < minClosedPositions ||
        !allowedActions.has(recommendation.suggestedAction)
      ) {
        continue;
      }

      const skill = this.skillManager.patchSkillConfig(
        recommendation.skillId,
        {
          params: recommendation.paramsPatch,
          riskLimits: recommendation.riskLimitsPatch
        },
        recommendation.skillVersion
      );
      if (!skill) {
        continue;
      }

      applied.push({
        skillId: recommendation.skillId,
        skillVersion: recommendation.skillVersion,
        suggestedAction: recommendation.suggestedAction,
        confidence: recommendation.confidence,
        patch: {
          ...(Object.keys(paramsPatch).length > 0 ? { params: paramsPatch } : {}),
          ...(Object.keys(riskLimitsPatch).length > 0 ? { riskLimits: riskLimitsPatch } : {})
        }
      });
    }

    return applied;
  }

  getSummary(): Record<string, unknown> {
    const disabledReason = this.getDisabledReason();
    const recommendations = this.listRecommendations();
    return {
      enabled: !disabledReason,
      disabledReason,
      autoApply: this.config.skill_optimizer?.auto_apply === true && !disabledReason,
      recommendationCount: recommendations.length,
      lastEvaluatedAt: recommendations.reduce<Date | undefined>(
        (latest, item) => (!latest || item.evaluatedAt.getTime() > latest.getTime() ? item.evaluatedAt : latest),
        undefined
      )
    };
  }

  private getDisabledReason(): string | undefined {
    if (this.config.skill_optimizer?.enabled === false) {
      return "Skill Optimizer 已在配置中关闭。";
    }

    if ((this.config.execution?.mode ?? "dry_run") !== "dry_run") {
      return "Skill Optimizer 第一版只在 dry_run 模式生成建议。";
    }

    if (this.config.paper_trading?.enabled === false) {
      return "Skill Optimizer 需要启用 paper_trading。";
    }

    return undefined;
  }

  private evaluateSkill(evidence: SkillEvidence, evaluatedAt: Date): SkillOptimizationRecommendation {
    const minClosedPositions = this.config.skill_optimizer?.min_closed_positions ?? 5;
    const minSnapshots = this.config.skill_optimizer?.min_snapshots ?? 20;
    const closedPositions = evidence.positions.filter((position) => position.status !== "active");

    if (closedPositions.length === 0) {
      return buildHold(evidence, evaluatedAt, "缺少已关闭仓位，暂不生成参数建议。", "缺少已关闭仓位。");
    }

    if (closedPositions.length < minClosedPositions && evidence.snapshots.length < minSnapshots) {
      return buildHold(
        evidence,
        evaluatedAt,
        `样本不足：closed=${closedPositions.length}, snapshots=${evidence.snapshots.length}。`,
        "样本不足。"
      );
    }

    if (evidence.snapshots.length > 0) {
      const staleRatio = evidence.snapshots.filter((snapshot) => snapshot.stale).length / evidence.snapshots.length;
      if (staleRatio > STALE_RATIO_LIMIT) {
        return buildHold(
          evidence,
          evaluatedAt,
          `paper snapshot stale 比例 ${(staleRatio * 100).toFixed(1)}% 过高，暂不建议调参。`,
          "paper snapshot stale 比例过高。"
        );
      }
    }

    return this.buildPatchRecommendation(evidence, evaluatedAt);
  }

  private buildPatchRecommendation(evidence: SkillEvidence, evaluatedAt: Date): SkillOptimizationRecommendation {
    const stats = evidence.stats;
    const skill = evidence.skill;
    const patchLimit = limitPercent(this.config);
    const outOfRangeRatio =
      evidence.snapshots.length > 0 ? countOutOfRangeSnapshots(evidence.snapshots) / evidence.snapshots.length : 0;
    const winRate = stats?.winRate ?? 0;
    const maxDrawdown = stats?.maxDrawdownPercent ?? 0;
    const estimatedPnlUsd = stats?.estimatedPnlUsd ?? 0;
    const paperFees = stats?.paperFeesAccruedSol ?? 0;
    const averagePositionHours = stats?.averagePositionHours ?? 0;

    if (maxDrawdown >= skill.riskLimits.stopLossPercent * 0.75 || (winRate < 45 && estimatedPnlUsd < 0)) {
      return {
        skillId: skill.id,
        skillVersion: skill.version,
        evaluatedAt,
        suggestedAction: "reduce_risk",
        confidence: clamp((maxDrawdown / Math.max(1, skill.riskLimits.stopLossPercent)) * 0.7 + 0.2, 0.35, 0.9),
        reason: `回撤 ${maxDrawdown.toFixed(2)}% / 胜率 ${winRate.toFixed(2)}%，建议收缩风险参数。`,
        paramsPatch: {
          binCount: roundPatchValue(changeByPercent(skill.params.binCount, -patchLimit))
        },
        riskLimitsPatch: {
          stopLossPercent: Math.max(3, Number(changeByPercent(skill.riskLimits.stopLossPercent, -patchLimit).toFixed(2))),
          maxAliveHours: roundPatchValue(changeByPercent(skill.riskLimits.maxAliveHours, -patchLimit))
        }
      };
    }

    if (outOfRangeRatio >= 0.35 && (estimatedPnlUsd > 0 || paperFees > 0)) {
      return {
        skillId: skill.id,
        skillVersion: skill.version,
        evaluatedAt,
        suggestedAction: "widen",
        confidence: clamp(outOfRangeRatio, 0.35, 0.85),
        reason: `出界 snapshot 占比 ${(outOfRangeRatio * 100).toFixed(1)}%，但收益/手续费为正，建议适度放宽 range。`,
        paramsPatch: {
          binCount: roundPatchValue(changeByPercent(skill.params.binCount, patchLimit))
        },
        riskLimitsPatch: {
          maxDailyRebalances: roundPatchValue(changeByPercent(skill.riskLimits.maxDailyRebalances, patchLimit))
        }
      };
    }

    if (averagePositionHours > skill.riskLimits.maxAliveHours * 0.8 && estimatedPnlUsd <= 0) {
      return {
        skillId: skill.id,
        skillVersion: skill.version,
        evaluatedAt,
        suggestedAction: "tighten",
        confidence: 0.55,
        reason: `平均持仓 ${averagePositionHours.toFixed(1)}h 接近生命周期上限且收益未改善，建议缩短最大存活时间。`,
        riskLimitsPatch: {
          maxAliveHours: roundPatchValue(changeByPercent(skill.riskLimits.maxAliveHours, -patchLimit))
        }
      };
    }

    if (winRate >= 60 && estimatedPnlUsd > 0 && maxDrawdown < skill.riskLimits.stopLossPercent * 0.5) {
      return {
        skillId: skill.id,
        skillVersion: skill.version,
        evaluatedAt,
        suggestedAction: "increase_canary",
        confidence: 0.65,
        reason: `胜率 ${winRate.toFixed(2)}%、估算 PnL 为正且回撤可控，可考虑人工提高 Canary。`
      };
    }

    return buildHold(evidence, evaluatedAt, "当前样本未触发确定性优化规则，建议保持现有参数。");
  }
}
