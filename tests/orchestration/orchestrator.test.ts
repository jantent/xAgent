import assert from "node:assert/strict";
import test from "node:test";

import { SharedState } from "../../src/core/shared-state.js";
import { SystemMode } from "../../src/domain/models.js";
import { Orchestrator } from "../../src/orchestration/orchestrator.js";
import { createAgentConfig, createOpenAction, createPlan, createPositionRecord, createReviewedPlan } from "../helpers/factories.js";
import { createAuditLoggerSpy, createMetricsServiceSpy, createNotifierSpy } from "../helpers/fakes.js";
import { createTestLogger } from "../helpers/logger.js";

test("Orchestrator 在 EMERGENCY_PAUSED 时短路主循环", async () => {
  const state = new SharedState();
  const audit = createAuditLoggerSpy();
  const notifier = createNotifierSpy();
  const metrics = createMetricsServiceSpy();
  let scanned = false;

  const orchestrator = new Orchestrator(
    createAgentConfig(),
    state,
    {
      async discoverAndScore() {
        scanned = true;
        return [];
      }
    } as never,
    {
      async matchSkills() {
        return [];
      }
    } as never,
    {
      buildPortfolioHealth() {
        return {
          dailyLossPct: 0,
          activePositions: 0,
          totalExposurePct: 0,
          totalExposureSol: 0
        };
      },
      review() {
        return [];
      },
      inspectActivePositions() {
        return [];
      }
    } as never,
    {
      optimize() {
        return [];
      }
    } as never,
    {
      async execute() {
        throw new Error("should not execute");
      }
    } as never,
    {
      valuate() {
        return {
          enabled: true,
          updated: 0,
          stale: 0,
          skipped: 0,
          snapshots: []
        };
      }
    } as never,
    {
      async healthCheck() {
        return {
          hasAnyProvider: true,
          hasPrimaryProvider: true,
          providerStatuses: []
        };
      },
      getHealthSnapshot() {
        return {
          hasAnyProvider: true,
          hasPrimaryProvider: true,
          providerStatuses: []
        };
      }
    } as never,
    {
      async healthCheck() {},
      getHealth() {
        return {
          activeName: "primary",
          canWrite: true,
          statuses: []
        };
      }
    } as never,
    {
      evaluateMode() {
        return SystemMode.EMERGENCY_PAUSED;
      }
    } as never,
    metrics as never,
    audit,
    notifier,
    createTestLogger()
  );

  const result = await orchestrator.runMainCycle();

  assert.equal(result.mode, SystemMode.EMERGENCY_PAUSED);
  assert.equal(scanned, false);
  assert.equal(metrics.cycleResults.length, 1);
  assert.equal(notifier.summaries.length, 0);
});

test("Orchestrator 会串起 scan -> risk -> execute -> notify 主流程", async () => {
  const state = new SharedState();
  const audit = createAuditLoggerSpy();
  const notifier = createNotifierSpy();
  const metrics = createMetricsServiceSpy();
  const plan = createPlan();
  const executionCalls: string[] = [];

  const orchestrator = new Orchestrator(
    createAgentConfig(),
    state,
    {
      async discoverAndScore() {
        return [plan.pool];
      }
    } as never,
    {
      async matchSkills() {
        return [plan];
      }
    } as never,
    {
      buildPortfolioHealth() {
        return {
          dailyLossPct: 0,
          activePositions: 0,
          totalExposurePct: 0,
          totalExposureSol: 0
        };
      },
      review() {
        return [createReviewedPlan({ ...plan, approved: true })];
      },
      inspectActivePositions() {
        return [
          {
            id: "maintenance-1",
            type: "claim",
            trigger: "interval",
            reason: "claim fees",
            positionId: "position-1"
          }
        ];
      }
    } as never,
    {
      optimize() {
        return [createOpenAction({ id: "portfolio-open-1" })];
      }
    } as never,
    {
      async execute(action: { id: string; type: string }) {
        executionCalls.push(action.id);
        return {
          actionId: action.id,
          type: action.type,
          status: "success",
          message: "ok",
          txSignatures: [],
          latencyMs: 1
        };
      }
    } as never,
    {
      valuate() {
        return {
          enabled: true,
          updated: 0,
          stale: 0,
          skipped: 0,
          snapshots: []
        };
      }
    } as never,
    {
      async healthCheck() {
        return {
          hasAnyProvider: true,
          hasPrimaryProvider: true,
          providerStatuses: []
        };
      },
      getHealthSnapshot() {
        return {
          hasAnyProvider: true,
          hasPrimaryProvider: true,
          providerStatuses: []
        };
      }
    } as never,
    {
      async healthCheck() {},
      getHealth() {
        return {
          activeName: "primary",
          canWrite: true,
          statuses: []
        };
      }
    } as never,
    {
      evaluateMode() {
        return SystemMode.NORMAL;
      }
    } as never,
    metrics as never,
    audit,
    notifier,
    createTestLogger()
  );

  const result = await orchestrator.runMainCycle();

  assert.equal(result.mode, SystemMode.NORMAL);
  assert.equal(result.actions.length, 2);
  assert.deepEqual(executionCalls, ["maintenance-1", "portfolio-open-1"]);
  assert.equal(audit.actions.length, 2);
  assert.equal(notifier.summaries.length, 1);
  assert.equal(metrics.cycleResults.length, 1);
});

test("Orchestrator 会在所有 provider 长时间不可用时自动全撤", async () => {
  const activePosition = createPositionRecord({
    id: "position-1",
    maxAliveUntil: new Date("2026-12-31T00:00:00.000Z")
  });
  const state = new SharedState({
    initialSnapshot: {
      allPositions: [activePosition]
    }
  });
  const audit = createAuditLoggerSpy();
  const notifier = createNotifierSpy();
  const metrics = createMetricsServiceSpy();
  let scanned = false;
  const executionCalls: string[] = [];

  const orchestrator = new Orchestrator(
    createAgentConfig(),
    state,
    {
      async discoverAndScore() {
        scanned = true;
        return [];
      }
    } as never,
    {
      async matchSkills() {
        return [];
      }
    } as never,
    {
      buildPortfolioHealth() {
        return {
          dailyLossPct: 0,
          activePositions: 1,
          totalExposurePct: 10,
          totalExposureSol: 1
        };
      },
      review() {
        return [];
      },
      inspectActivePositions() {
        return [];
      }
    } as never,
    {
      optimize() {
        return [];
      }
    } as never,
    {
      async execute(action: { id: string; type: string }) {
        executionCalls.push(action.type);
        return {
          actionId: action.id,
          type: action.type,
          status: "success",
          message: "ok",
          txSignatures: [],
          latencyMs: 1
        };
      }
    } as never,
    {
      valuate() {
        return {
          enabled: true,
          updated: 0,
          stale: 0,
          skipped: 0,
          snapshots: []
        };
      }
    } as never,
    {
      async healthCheck() {
        return {
          hasAnyProvider: false,
          hasPrimaryProvider: false,
          providerStatuses: [],
          allProvidersDownForMs: 31 * 60 * 1000
        };
      },
      getHealthSnapshot() {
        return {
          hasAnyProvider: false,
          hasPrimaryProvider: false,
          providerStatuses: [],
          allProvidersDownForMs: 31 * 60 * 1000
        };
      }
    } as never,
    {
      async healthCheck() {},
      getHealth() {
        return {
          activeName: "primary",
          canWrite: true,
          statuses: []
        };
      }
    } as never,
    {
      evaluateMode() {
        return SystemMode.CLOSE_ONLY;
      }
    } as never,
    metrics as never,
    audit,
    notifier,
    createTestLogger()
  );

  const result = await orchestrator.runMainCycle();

  assert.equal(scanned, false);
  assert.equal(result.actions.length, 1);
  assert.deepEqual(executionCalls, ["emergency_exit"]);
  assert.equal(notifier.alerts.length, 1);
});
