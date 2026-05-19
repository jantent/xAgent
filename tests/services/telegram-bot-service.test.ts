import assert from "node:assert/strict";
import test from "node:test";

import type { AppRuntime } from "../../src/app/runtime.js";
import type { AuditEventQuery, AuditEventRecord } from "../../src/audit/contracts.js";
import { SystemMode } from "../../src/domain/models.js";
import { TelegramBotService } from "../../src/services/telegram-bot-service.js";
import { rootLogger } from "../../src/utils/logger.js";
import { createAgentConfig, createPositionRecord, createSkill } from "../helpers/factories.js";

function createRuntimeStub(): AppRuntime {
  const config = createAgentConfig();
  const positions = [
    createPositionRecord({
      id: "position-1778697306867-pugxh0",
      tokenSymbol: "BONK",
      pnlPercent: 4.2,
      openedAt: new Date("2026-01-02T00:00:00.000Z")
    }),
    createPositionRecord({
      id: "closed-rkc",
      tokenSymbol: "RKC",
      status: "closed",
      pnlPercent: -3,
      openedAt: new Date("2026-01-01T00:00:00.000Z"),
      closedAt: new Date("2026-01-03T00:00:00.000Z")
    })
  ];
  const auditEvents: AuditEventRecord[] = [
    {
      source: "actions",
      timestamp: "2026-01-03T00:00:00.000Z",
      payload: {
        cycleId: "cycle-2",
        action: { type: "close", trigger: "stop_loss", positionId: "closed-rkc" },
        result: { status: "success", message: "closed RKC" }
      }
    },
    {
      source: "errors",
      timestamp: "2026-01-02T00:00:00.000Z",
      payload: { cycleId: "cycle-1", error: { message: "provider timeout" } }
    }
  ];
  const snapshot = {
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    mode: SystemMode.NORMAL,
    manualPause: false,
    lastPauseReason: undefined,
    availableCapitalSol: 10,
    activePositions: positions.filter((position) => position.status === "active"),
    allPositions: positions,
    lastMainCycleAt: new Date("2026-01-03T00:00:00.000Z"),
    lastHighFreqTickAt: new Date("2026-01-03T00:01:00.000Z"),
    lastCycleResult: undefined,
    pendingActions: [],
    runtimeSkills: [],
    paperPositionSnapshots: []
  };
  const skills = [createSkill()];
  const recommendations = [
    {
      skillId: "bread_n_butter",
      skillVersion: "1.0.0",
      evaluatedAt: new Date("2026-01-03T00:00:00.000Z"),
      suggestedAction: "hold" as const,
      confidence: 0.7,
      reason: "样本稳定。"
    }
  ];

  return {
    config,
    poolSourceName: "mock_meteora",
    storage: {
      stateStoreKind: "file",
      auditStoreKind: "file",
      cacheStoreKind: "memory",
      sqliteConfigured: false
    },
    wallet: {
      activeAddress: config.wallet.active_address,
      secretLoaded: false,
      allowSecretForwarding: false
    },
    lock: null,
    state: {
      getSnapshot() {
        return snapshot;
      },
      getActivePositions() {
        return snapshot.activePositions;
      },
      getAllPositions() {
        return snapshot.allPositions;
      },
      getLastPersistError() {
        return undefined;
      }
    },
    skillManager: {
      listAll() {
        return skills;
      }
    },
    skillStatsService: {
      listStats() {
        return [
          {
            skillId: "bread_n_butter",
            skillVersion: "1.0.0",
            totalPositions: 2,
            activePositions: 1,
            closedPositions: 1,
            estimatedPnlUsd: 12,
            activeMarkPnlUsd: 4,
            averagePositionHours: 8,
            winRate: 50,
            worstPnlPercent: -3,
            maxDrawdownPercent: 3,
            updatedAt: new Date("2026-01-03T00:00:00.000Z")
          }
        ];
      },
      enrichSkills(items: unknown[]) {
        return items.map((item) => ({
          ...(item as Record<string, unknown>),
          stats: this.listStats()[0]
        }));
      }
    },
    skillOptimizerService: {
      listRecommendations() {
        return recommendations;
      },
      evaluateAndStore() {
        return recommendations;
      },
      getSummary() {
        return {
          enabled: true,
          autoApply: false,
          recommendationCount: recommendations.length,
          lastEvaluatedAt: recommendations[0]?.evaluatedAt
        };
      }
    },
    executionLayer: {
      getStatus() {
        return {
          mode: "dry_run",
          backend: "dry_run",
          dryRun: true,
          healthy: true,
          supportedActions: ["open", "close", "rebalance", "claim", "emergency_exit"],
          submissionStrategy: "gateway_managed"
        };
      }
    },
    orchestrator: {
      isRunning() {
        return false;
      }
    },
    rpcManager: {
      getHealth() {
        return {
          activeName: "primary",
          canWrite: true,
          statuses: []
        };
      }
    },
    dataProviderManager: {
      getHealthSnapshot() {
        return {
          hasAnyProvider: true,
          hasPrimaryProvider: true,
          providerStatuses: []
        };
      }
    },
    paperTradingService: {
      getSummary() {
        return {
          enabled: true,
          snapshotCount: 2,
          stalePositions: 0
        };
      }
    },
    auditReader: {
      async readRecent(limit = 30) {
        return auditEvents.slice(0, limit);
      },
      async queryEvents(query: AuditEventQuery = {}) {
        const source = query.source;
        const search = query.q?.toLowerCase();
        return auditEvents
          .filter((event) => {
            if (source && event.source !== source) {
              return false;
            }
            return search ? JSON.stringify(event).toLowerCase().includes(search) : true;
          })
          .slice(0, query.limit ?? 30);
      }
    }
  } as unknown as AppRuntime;
}

function createService(runtime = createRuntimeStub()): TelegramBotService {
  return new TelegramBotService(runtime, {
    botToken: "telegram-token",
    allowedChatIds: ["12345"],
    dashboardUrl: "https://xagent.example/dashboard",
    apiAuthEnabled: true,
    pollIntervalMs: 1,
    pollTimeoutSeconds: 1,
    requestTimeoutMs: 1_000,
    maxPositions: 4,
    maxEvents: 4,
    logger: rootLogger.child("telegram_bot.test")
  });
}

test("TelegramBotService 只读命令返回状态、页面、仓位和事件", async () => {
  const service = createService();

  const status = await service.handleTextForTest("12345", "/status");
  assert.match(status, /mode=normal/);
  assert.match(status, /execution=dry_run\/dry_run healthy=yes/);

  const dashboard = await service.handleTextForTest("12345", "/dashboard");
  assert.match(dashboard, /https:\/\/xagent\.example\/dashboard/);
  assert.match(dashboard, /Bearer Token/);

  const positions = await service.handleTextForTest("12345", "/positions active bonk");
  assert.match(positions, /\[xAgent\] 活跃仓位 · bonk/);
  assert.match(positions, /BONK \| PnL \+4\.2%/);
  assert.match(positions, /区间内 \| bin 7995\.\.8005 \| bread n butter \| ref pugxh0/);
  assert.doesNotMatch(positions, /position-1778697306867-pugxh0/);
  assert.doesNotMatch(positions, /closed-rkc/);

  const position = await service.handleTextForTest("12345", "/position pugxh0");
  assert.match(position, /仓位详情 BONK/);
  assert.match(position, /状态 active \| 区间内/);
  assert.match(position, /短码 pugxh0/);
  assert.match(position, /内部ID position-1778697306867-pugxh0/);

  const events = await service.handleTextForTest("12345", "/events actions rkc");
  assert.match(events, /source=actions/);
  assert.match(events, /closed RKC/);
});

test("TelegramBotService 查询命令覆盖 Dashboard 主要只读视图", async () => {
  const service = createService();

  const infra = await service.handleTextForTest("12345", "/infra");
  assert.match(infra, /\[xAgent\] 基础设施/);
  assert.match(infra, /storage state=file audit=file cache=memory/);

  const trades = await service.handleTextForTest("12345", "/trades close success rkc");
  assert.match(trades, /\[xAgent\] 交易历史 action=close status=success q=rkc/);
  assert.match(trades, /RKC/);

  const report = await service.handleTextForTest("12345", "/report 7");
  assert.match(report, /\[xAgent\] 资产报告 7天/);
  assert.match(report, /snapshots=0/);

  const skills = await service.handleTextForTest("12345", "/skills bread");
  assert.match(skills, /\[xAgent\] Skill 摘要 · bread/);
  assert.match(skills, /bread_n_butter@1\.0\.0/);

  const optimizer = await service.handleTextForTest("12345", "/optimizer");
  assert.match(optimizer, /\[xAgent\] Optimizer 建议/);
  assert.match(optimizer, /bread_n_butter@1\.0\.0/);
});

test("TelegramBotService 未授权 chat 只能查看 chat_id", async () => {
  const service = createService();

  const chatId = await service.handleTextForTest("999", "/id");
  assert.equal(chatId, "chat_id=999");

  const status = await service.handleTextForTest("999", "/status");
  assert.match(status, /未授权的 Telegram chat_id: 999/);
});
