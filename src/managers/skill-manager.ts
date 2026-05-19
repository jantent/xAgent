import { SkillStatus } from "../domain/models.js";
import type { PoolCandidate, SkillMeta } from "../domain/models.js";
import { percentRoll } from "../utils/async.js";
import { deepMerge } from "../utils/object.js";

interface SkillManagerOptions {
  runtimeSkills?: SkillMeta[];
  onChange?: (skills: SkillMeta[]) => void;
}

interface SkillPatch {
  params?: Partial<SkillMeta["params"]>;
  riskLimits?: Partial<SkillMeta["riskLimits"]>;
}

function specificityScore(skill: SkillMeta): number {
  let score = 0;

  score += skill.applicability.lifecycleStages.length;
  score += skill.applicability.minMcap ? 1 : 0;
  score += skill.applicability.maxMcap ? 1 : 0;
  score += skill.applicability.minLincolnScore > 0 ? 1 : 0;
  score += skill.applicability.minSafetyScore > 0 ? 1 : 0;

  return score;
}

/**
 * SkillManager 负责解决两个问题：
 * 1. 生命周期管理：哪些策略当前可调度；
 * 2. 池子匹配：面对同一个池子时，选哪一个 Skill 更合适。
 */
export class SkillManager {
  private readonly skills: SkillMeta[];
  private readonly onChange?: (skills: SkillMeta[]) => void;

  constructor(skills: SkillMeta[], options: SkillManagerOptions = {}) {
    this.skills = this.mergeSkills(skills, options.runtimeSkills ?? []);
    this.onChange = options.onChange;
  }

  listAll(): SkillMeta[] {
    return this.skills.map((skill) => structuredClone(skill));
  }

  listSchedulable(): SkillMeta[] {
    return this.skills.filter((skill) => skill.status === SkillStatus.ACTIVE || skill.status === SkillStatus.CANARY);
  }

  getSkill(skillId: string, version?: string): SkillMeta | null {
    const matched = this.skills.find((skill) => skill.id === skillId && (version ? skill.version === version : true));
    return matched ? structuredClone(matched) : null;
  }

  disableSkill(skillId: string): SkillMeta | null {
    const targets = this.skills.filter((skill) => skill.id === skillId);
    if (targets.length === 0) {
      return null;
    }

    const now = new Date();
    for (const target of targets) {
      target.status = SkillStatus.DISABLED;
      target.disabledAt = now;
      target.updatedAt = now;
    }
    this.emitChange();
    return structuredClone(this.getLatestSkill(skillId)!);
  }

  enableSkill(skillId: string, options?: { canaryPercent?: number }): SkillMeta | null {
    const target = this.getLatestSkill(skillId);
    if (!target) {
      return null;
    }

    const now = new Date();
    const canaryPercent = options?.canaryPercent ?? 0;
    this.deactivateSiblingVersions(skillId, target.version, now);
    target.status = canaryPercent > 0 ? SkillStatus.CANARY : SkillStatus.ACTIVE;
    target.canaryPercent = canaryPercent;
    target.enabledAt = now;
    target.updatedAt = now;
    target.disabledAt = undefined;
    this.emitChange();
    return structuredClone(target);
  }

  updateSkillParams(skillId: string, updater: (skill: SkillMeta) => SkillMeta): SkillMeta | null {
    const index = this.skills.findIndex((skill) => skill.id === skillId);
    if (index < 0) {
      return null;
    }

    const currentSkill = this.skills[index];
    if (!currentSkill) {
      return null;
    }

    const updatedSkill = updater(structuredClone(currentSkill));
    updatedSkill.updatedAt = new Date();
    this.skills[index] = updatedSkill;
    this.emitChange();
    return structuredClone(updatedSkill);
  }

  patchSkillParams(skillId: string, paramsPatch: Partial<SkillMeta["params"]>): SkillMeta | null {
    return this.patchSkillConfig(skillId, { params: paramsPatch });
  }

  patchSkillConfig(skillId: string, patch: SkillPatch, version?: string): SkillMeta | null {
    const index = this.skills.findIndex((skill) => skill.id === skillId && (version ? skill.version === version : true));
    if (index < 0) {
      return null;
    }

    const currentSkill = this.skills[index];
    if (!currentSkill) {
      return null;
    }

    const updatedSkill: SkillMeta = {
      ...currentSkill,
      params: patch.params ? deepMerge(currentSkill.params, patch.params) : currentSkill.params,
      riskLimits: patch.riskLimits ? deepMerge(currentSkill.riskLimits, patch.riskLimits) : currentSkill.riskLimits,
      updatedAt: new Date()
    };
    this.skills[index] = updatedSkill;
    this.emitChange();
    return structuredClone(updatedSkill);
  }

  rollback(skillId: string, version?: string): SkillMeta | null {
    const candidates = this.skills
      .filter((skill) => skill.id === skillId)
      .sort((left, right) => right.version.localeCompare(left.version));

    const activeCandidate = candidates.find((skill) => skill.status === SkillStatus.ACTIVE || skill.status === SkillStatus.CANARY);
    const target = version
      ? candidates.find((skill) => skill.version === version)
      : activeCandidate?.previousVersion
        ? candidates.find((skill) => skill.version === activeCandidate.previousVersion)
        : candidates.find((skill) => skill.version !== activeCandidate?.version) ?? candidates[0];
    if (!target) {
      return null;
    }

    const now = new Date();
    this.deactivateSiblingVersions(skillId, target.version, now);
    target.status = SkillStatus.ACTIVE;
    target.canaryPercent = 0;
    target.enabledAt = now;
    target.disabledAt = undefined;
    target.updatedAt = now;
    this.emitChange();
    return structuredClone(target);
  }

  selectSkillForPool(pool: PoolCandidate): SkillMeta | null {
    const eligible = this.listSchedulable();
    const matched = eligible.filter((skill) => {
      if (pool.lincolnScore < skill.applicability.minLincolnScore) {
        return false;
      }

      if (pool.safetyScore < skill.applicability.minSafetyScore) {
        return false;
      }

      if (skill.applicability.minMcap !== undefined && pool.mcap < skill.applicability.minMcap) {
        return false;
      }

      if (skill.applicability.maxMcap !== undefined && pool.mcap > skill.applicability.maxMcap) {
        return false;
      }

      return skill.applicability.lifecycleStages.includes(pool.lifecycleStage);
    });

    if (matched.length === 0) {
      return null;
    }

    const sorted = matched.sort((left, right) => {
      if (left.status === SkillStatus.ACTIVE && right.status === SkillStatus.CANARY) {
        return -1;
      }

      if (left.status === SkillStatus.CANARY && right.status === SkillStatus.ACTIVE) {
        return 1;
      }

      return specificityScore(right) - specificityScore(left);
    });

    const selected = sorted[0];
    if (!selected) {
      return null;
    }

    if (selected.status === SkillStatus.CANARY) {
      const shouldUseCanary = percentRoll(selected.canaryPercent ?? 0);
      if (!shouldUseCanary) {
        return sorted.find((skill) => skill.status === SkillStatus.ACTIVE) ?? null;
      }
    }

    return structuredClone(selected);
  }

  private mergeSkills(loadedSkills: SkillMeta[], runtimeSkills: SkillMeta[]): SkillMeta[] {
    const merged = loadedSkills.map((skill) => structuredClone(skill));
    const indexByKey = new Map<string, number>();

    for (const [index, skill] of merged.entries()) {
      indexByKey.set(this.getSkillKey(skill.id, skill.version), index);
    }

    for (const runtimeSkill of runtimeSkills) {
      const key = this.getSkillKey(runtimeSkill.id, runtimeSkill.version);
      const existingIndex = indexByKey.get(key);
      if (existingIndex === undefined) {
        merged.push(structuredClone(runtimeSkill));
        indexByKey.set(key, merged.length - 1);
        continue;
      }

      merged[existingIndex] = structuredClone(runtimeSkill);
    }

    return merged;
  }

  private getLatestSkill(skillId: string): SkillMeta | undefined {
    return this.skills
      .filter((skill) => skill.id === skillId)
      .sort((left, right) => right.version.localeCompare(left.version))[0];
  }

  private deactivateSiblingVersions(skillId: string, keepVersion: string, timestamp: Date): void {
    for (const skill of this.skills) {
      if (skill.id !== skillId || skill.version === keepVersion) {
        continue;
      }

      if (skill.status === SkillStatus.ACTIVE || skill.status === SkillStatus.CANARY) {
        skill.status = SkillStatus.DISABLED;
        skill.disabledAt = timestamp;
        skill.updatedAt = timestamp;
      }
    }
  }

  private emitChange(): void {
    this.onChange?.(this.listAll());
  }

  private getSkillKey(skillId: string, version: string): string {
    return `${skillId}:${version}`;
  }
}
