import assert from "node:assert/strict";
import test from "node:test";

import { StrategySelector } from "../../src/modules/strategy-selector.js";
import { SkillManager } from "../../src/managers/skill-manager.js";
import { createPlan, createSkill } from "../helpers/factories.js";
import { createTestLogger } from "../helpers/logger.js";

test("StrategySelector 会在规则范围内应用 LLM 微调建议", async () => {
  const skill = createSkill();
  const selector = new StrategySelector(
    new SkillManager([skill]),
    {
      async chat() {
        return {
          content: JSON.stringify({
            summary: "热度和安全分匹配，允许小幅加仓。",
            scoreDelta: 0.5,
            amountMultiplier: 1.2
          })
        };
      }
    } as never,
    createTestLogger()
  );

  const candidate = createPlan({ skill: { id: skill.id, version: skill.version } }).pool;
  const plans = await selector.matchSkills([candidate], "cycle-1");
  const plan = plans[0];

  assert.ok(plan);
  assert.ok((plan?.score ?? 0) > 0);
  assert.ok((plan?.suggestedAmountSol ?? 0) >= 0.1);
  assert.ok((plan?.suggestedAmountSol ?? 0) <= 0.45);
  assert.match(plan?.llmSummary ?? "", /热度和安全分匹配/);
});
