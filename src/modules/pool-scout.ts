import type { IPoolSource } from "../domain/contracts.js";
import type { PoolCandidate } from "../domain/models.js";
import { clamp } from "../utils/async.js";
import type { DataProviderManager } from "../managers/data-provider-manager.js";
import type { LLMManager } from "../managers/llm-manager.js";
import type { Logger } from "../utils/logger.js";

function shouldUsePoolSafetyFallback(pool: PoolCandidate, safetyScore: number, source: string): boolean {
  return source === "default_fallback" && safetyScore <= 0 && pool.safetyScore > 0;
}

function shouldUsePoolSmartMoneyFallback(pool: PoolCandidate, source: string): boolean {
  return source === "default_fallback" && pool.smartMoneyNet !== 0;
}

function toGrade(score: number): string {
  if (score >= 8.5) {
    return "S";
  }

  if (score >= 6.8) {
    return "A";
  }

  if (score >= 5.0) {
    return "B";
  }

  return "C";
}

/**
 * PoolScout 负责“发现 + 初筛 + 打分”。
 * 它的输出必须尽量结构化，避免把含糊判断留给后面的风控和组合管理模块。
 */
export class PoolScout {
  constructor(
    private readonly poolSource: IPoolSource,
    private readonly dataProviderManager: DataProviderManager,
    private readonly llmManager: LLMManager,
    private readonly logger: Logger
  ) {}

  async discoverAndScore(cycleId: string): Promise<PoolCandidate[]> {
    const rawPools = await this.poolSource.discoverPools();
    const enrichedPools: PoolCandidate[] = [];

    for (const rawPool of rawPools) {
      const safety = await this.dataProviderManager.getTokenSafety(rawPool.tokenMint);
      const smartMoney = await this.dataProviderManager.getSmartMoneyFlow(rawPool.tokenMint);
      const safetyScore = shouldUsePoolSafetyFallback(rawPool, safety.safetyScore, safety.source)
        ? rawPool.safetyScore
        : safety.safetyScore;
      const smartMoneyNet = shouldUsePoolSmartMoneyFallback(rawPool, smartMoney.source)
        ? rawPool.smartMoneyNet
        : smartMoney.net24h;
      const reasons: string[] = [];

      if (safetyScore >= 70) {
        reasons.push("安全分较高，基础 Rug 风险相对可控。");
      } else if (safetyScore >= 50) {
        reasons.push("安全分中等，需要通过仓位和退出规则控制风险。");
      } else {
        reasons.push("安全分偏低，只能视为高风险候选池。");
      }

      if (rawPool.feeTvlRatio24h >= 5) {
        reasons.push("24h fee/TVL 比极高，说明手续费结构具备吸引力。");
      } else if (rawPool.feeTvlRatio24h >= 2) {
        reasons.push("24h fee/TVL 比尚可，可以进入候选列表。");
      }

      if (smartMoneyNet > 0) {
        reasons.push("Smart Money 近 24 小时净流入为正。");
      } else {
        reasons.push("Smart Money 净流入不佳，需要谨慎。");
      }

      const normalizedScore =
        rawPool.lincolnScore * 0.45 +
        clamp(safetyScore / 12, 0, 8) * 0.25 +
        clamp(rawPool.organicScore / 15, 0, 8) * 0.15 +
        clamp(rawPool.feeTvlRatio24h, 0, 10) * 0.15;

      const narrative = await this.classifyNarrative(rawPool, cycleId);

      enrichedPools.push({
        ...rawPool,
        safetyScore,
        smartMoneyNet,
        grade: toGrade(normalizedScore),
        reasons,
        ...(narrative ? { narrative } : {})
      });
    }

    const sortedPools = enrichedPools.sort((left, right) => {
      if (right.grade !== left.grade) {
        return right.grade!.localeCompare(left.grade!);
      }

      return right.lincolnScore - left.lincolnScore;
    });

    this.logger.info("池子发现与评分完成", {
      scanned: rawPools.length,
      scored: sortedPools.length
    });

    return sortedPools;
  }

  private async classifyNarrative(pool: PoolCandidate, cycleId: string): Promise<string | undefined> {
    const description = typeof pool.meta?.description === "string" ? pool.meta.description : undefined;
    if (!description) {
      return pool.narrative;
    }

    try {
      const response = await this.llmManager.chat(
        "classification",
        {
          messages: [
            {
              role: "user",
              content: `请用一句中文概括该 meme token 的 narrative 与情绪状态：${description}`
            }
          ],
          temperature: 0.1,
          maxTokens: 120
        },
        cycleId
      );

      return response.content.trim();
    } catch (error) {
      this.logger.warn("叙事分类失败，回退到静态 narrative", {
        pool: pool.address,
        error
      });
      return pool.narrative;
    }
  }
}
