import assert from "node:assert/strict";
import test from "node:test";

import { SystemMode } from "../../src/domain/models.js";
import { SystemModeManager } from "../../src/managers/system-mode-manager.js";
import { createTestLogger } from "../helpers/logger.js";

test("SystemModeManager 手动暂停优先级最高", () => {
  const manager = new SystemModeManager(5, 600_000, createTestLogger());
  const mode = manager.evaluateMode({
    manualPaused: true,
    rpcHealth: { canWrite: true },
    dataHealth: {
      hasAnyProvider: true,
      hasPrimaryProvider: true,
      providerStatuses: []
    },
    portfolioHealth: {
      dailyLossPct: 0,
      activePositions: 0,
      totalExposurePct: 0,
      totalExposureSol: 0
    }
  });

  assert.equal(mode, SystemMode.EMERGENCY_PAUSED);
});

test("SystemModeManager 在 fallback provider 可用时保持 NORMAL", () => {
  const manager = new SystemModeManager(5, 600_000, createTestLogger());
  const mode = manager.evaluateMode({
    manualPaused: false,
    rpcHealth: { canWrite: true },
    dataHealth: {
      hasAnyProvider: true,
      hasPrimaryProvider: false,
      providerStatuses: []
    },
    portfolioHealth: {
      dailyLossPct: 0,
      activePositions: 1,
      totalExposurePct: 10,
      totalExposureSol: 1
    }
  });

  assert.equal(mode, SystemMode.NORMAL);
});

test("SystemModeManager 会在全量 provider 长时间不可用时进入 CLOSE_ONLY", () => {
  const manager = new SystemModeManager(5, 600_000, createTestLogger());
  const mode = manager.evaluateMode({
    manualPaused: false,
    rpcHealth: { canWrite: true },
    dataHealth: {
      hasAnyProvider: false,
      hasPrimaryProvider: false,
      providerStatuses: [],
      allProvidersDownForMs: 601_000
    },
    portfolioHealth: {
      dailyLossPct: 0,
      activePositions: 2,
      totalExposurePct: 20,
      totalExposureSol: 2
    }
  });

  assert.equal(mode, SystemMode.CLOSE_ONLY);
});
