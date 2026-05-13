import assert from "node:assert/strict";
import test from "node:test";

import { SystemMode } from "../../src/domain/models.js";
import { PortfolioManager } from "../../src/modules/portfolio-manager.js";
import { createPoolCandidate, createPositionRecord, createReviewedPlan, createSkill } from "../helpers/factories.js";
import { createTestLogger } from "../helpers/logger.js";

test("PortfolioManager 在非 normal 模式不生成新开仓动作", () => {
  const manager = new PortfolioManager(createTestLogger());
  const actions = manager.optimize(
    [createReviewedPlan({ approved: true })],
    [],
    10,
    SystemMode.CLOSE_ONLY
  );

  assert.deepEqual(actions, []);
});

test("PortfolioManager 按评分和资金顺序生成开仓动作，并跳过重复池子", () => {
  const manager = new PortfolioManager(createTestLogger());
  const sharedSkill = createSkill();
  const occupied = createPositionRecord({
    poolAddress: "pool-occupied"
  });
  const actions = manager.optimize(
    [
      createReviewedPlan({
        approved: true,
        id: "plan-top",
        score: 9,
        suggestedAmountSol: 0.7,
        pool: createPoolCandidate({
          address: "pool-top",
          tokenMint: "mint-top"
        }),
        skill: sharedSkill
      }),
      createReviewedPlan({
        approved: true,
        id: "plan-duplicate",
        score: 8.8,
        suggestedAmountSol: 1,
        pool: createPoolCandidate({
          address: "pool-occupied",
          tokenMint: "mint-occupied"
        }),
        skill: sharedSkill
      }),
      createReviewedPlan({
        approved: true,
        id: "plan-tail",
        score: 7.5,
        suggestedAmountSol: 0.6,
        pool: createPoolCandidate({
          address: "pool-tail",
          tokenMint: "mint-tail"
        }),
        skill: sharedSkill
      })
    ],
    [occupied],
    1,
    SystemMode.NORMAL
  );

  assert.equal(actions.length, 2);
  assert.equal(actions[0]?.pool?.address, "pool-top");
  assert.equal(actions[0]?.amountSol, 0.7);
  assert.equal(actions[1]?.pool?.address, "pool-tail");
  assert.ok(Math.abs((actions[1]?.amountSol ?? 0) - 0.3) < 1e-9);
});
