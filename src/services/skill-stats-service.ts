import type { SharedState } from "../core/shared-state.js";
import type { SkillMeta, SkillRuntimeStats } from "../domain/models.js";

function estimatePnlUsd(currentValueUsd: number, pnlPercent: number): number {
  const ratio = 1 + pnlPercent / 100;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return 0;
  }

  const estimatedEntryValueUsd = currentValueUsd / ratio;
  return currentValueUsd - estimatedEntryValueUsd;
}

export class SkillStatsService {
  constructor(private readonly state: SharedState) {}

  listStats(): SkillRuntimeStats[] {
    const snapshot = this.state.getSnapshot();
    const grouped = new Map<string, SkillRuntimeStats>();

    for (const position of snapshot.allPositions) {
      const key = `${position.skillId}:${position.skillVersion}`;
      const existing =
        grouped.get(key) ??
        {
          skillId: position.skillId,
          skillVersion: position.skillVersion,
          totalPositions: 0,
          activePositions: 0,
          closedPositions: 0,
          estimatedPnlUsd: 0,
          totalFeesClaimedSol: 0,
          paperFeesAccruedSol: 0,
          activeMarkPnlUsd: 0,
          averagePositionHours: 0,
          winRate: 0,
          worstPnlPercent: 0,
          maxDrawdownPercent: 0,
          updatedAt: new Date()
        };
      const previousTotalPositions = existing.totalPositions;

      existing.totalPositions += 1;
      if (position.status === "active") {
        existing.activePositions += 1;
      } else {
        existing.closedPositions += 1;
      }

      existing.estimatedPnlUsd += estimatePnlUsd(position.currentValueUsd, position.pnlPercent);
      existing.totalFeesClaimedSol += position.totalFeesClaimedSol;
      existing.paperFeesAccruedSol += position.totalFeesClaimedSol + (position.paper?.unclaimedFeesSol ?? 0);
      if (position.status === "active") {
        existing.activeMarkPnlUsd += estimatePnlUsd(position.currentValueUsd, position.pnlPercent);
      }
      existing.averagePositionHours += this.calculatePositionHours(position.openedAt, position.closedAt);
      existing.worstPnlPercent =
        previousTotalPositions === 0 ? position.pnlPercent : Math.min(existing.worstPnlPercent, position.pnlPercent);
      existing.updatedAt = new Date();
      grouped.set(key, existing);
    }

    return Array.from(grouped.values())
      .map((stats) => {
        const relatedPositions = snapshot.allPositions.filter(
          (position) => position.skillId === stats.skillId && position.skillVersion === stats.skillVersion
        );
        const completed = relatedPositions.filter((position) => position.status !== "active");
        const profitable = (completed.length > 0 ? completed : relatedPositions).filter((position) => position.pnlPercent > 0);
        const worstSnapshotPnl = (snapshot.paperPositionSnapshots ?? [])
          .filter((item) => item.skillId === stats.skillId && item.skillVersion === stats.skillVersion)
          .reduce<number | undefined>(
            (worst, item) => (worst === undefined ? item.pnlPercent : Math.min(worst, item.pnlPercent)),
            undefined
          );

        return {
          ...stats,
          averagePositionHours: stats.totalPositions > 0 ? stats.averagePositionHours / stats.totalPositions : 0,
          maxDrawdownPercent: Math.max(0, -(worstSnapshotPnl ?? stats.worstPnlPercent)),
          winRate:
            (completed.length > 0 ? profitable.length / completed.length : relatedPositions.length > 0 ? profitable.length / relatedPositions.length : 0) *
            100
        };
      })
      .sort((left, right) => right.totalPositions - left.totalPositions);
  }

  listStatsBySkill(): Map<string, SkillRuntimeStats> {
    return new Map(this.listStats().map((stats) => [`${stats.skillId}:${stats.skillVersion}`, stats]));
  }

  enrichSkills(skills: SkillMeta[]): Array<SkillMeta & { stats?: SkillRuntimeStats }> {
    const statsMap = this.listStatsBySkill();
    return skills.map((skill) => ({
      ...skill,
      stats: statsMap.get(`${skill.id}:${skill.version}`)
    }));
  }

  private calculatePositionHours(openedAt: Date, closedAt?: Date): number {
    const end = closedAt ?? new Date();
    return Math.max(0, end.getTime() - openedAt.getTime()) / (1000 * 60 * 60);
  }
}
