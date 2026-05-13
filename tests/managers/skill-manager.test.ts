import assert from "node:assert/strict";
import test from "node:test";

import { SkillStatus } from "../../src/domain/models.js";
import { SkillManager } from "../../src/managers/skill-manager.js";
import { createSkill } from "../helpers/factories.js";

test("SkillManager 会用运行时快照覆盖磁盘 Skill，并在变更后触发回调", () => {
  const changes = [];
  const loaded = createSkill({
    id: "sniper",
    version: "3.0.0",
    status: SkillStatus.CANARY,
    canaryPercent: 20
  });
  const persisted = createSkill({
    id: "sniper",
    version: "3.0.0",
    status: SkillStatus.DISABLED,
    canaryPercent: 0,
    params: {
      binCount: 42
    }
  });

  const manager = new SkillManager([loaded], {
    runtimeSkills: [persisted],
    onChange(skills) {
      changes.push(skills);
    }
  });

  assert.equal(manager.getSkill("sniper")?.status, SkillStatus.DISABLED);
  assert.equal(manager.getSkill("sniper")?.params.binCount, 42);

  manager.enableSkill("sniper", { canaryPercent: 10 });

  assert.equal(manager.getSkill("sniper")?.status, SkillStatus.CANARY);
  assert.equal(changes.length, 1);
});

test("SkillManager.rollback 会激活目标版本并停用同 id 的其他版本", () => {
  const older = createSkill({
    id: "bread_n_butter",
    version: "1.0.0",
    status: SkillStatus.DISABLED
  });
  const newer = createSkill({
    id: "bread_n_butter",
    version: "2.0.0",
    status: SkillStatus.ACTIVE,
    previousVersion: "1.0.0"
  });

  const manager = new SkillManager([older, newer]);
  const rolled = manager.rollback("bread_n_butter");

  assert.equal(rolled?.version, "1.0.0");
  assert.equal(manager.getSkill("bread_n_butter", "1.0.0")?.status, SkillStatus.ACTIVE);
  assert.equal(manager.getSkill("bread_n_butter", "2.0.0")?.status, SkillStatus.DISABLED);
});
