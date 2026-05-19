import assert from "node:assert/strict";
import test from "node:test";

import type { AppRuntime } from "../../src/app/runtime.js";
import { createApiApp, startApiServer } from "../../src/api/server.js";
import type { AuditEventQuery, AuditEventRecord } from "../../src/audit/contracts.js";
import type { PaperPositionSnapshot, SkillOptimizationRecommendation } from "../../src/domain/models.js";
import { SystemMode } from "../../src/domain/models.js";
import { createAgentConfig, createPositionRecord, createSkill } from "../helpers/factories.js";

async function withEnv(
  values: Record<string, string | undefined>,
  fn: () => Promise<void>
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

interface RuntimeStubOptions {
  calls?: string[];
  positions?: ReturnType<typeof createPositionRecord>[];
  auditEvents?: AuditEventRecord[];
  paperSnapshots?: PaperPositionSnapshot[];
  recommendations?: SkillOptimizationRecommendation[];
}

function assertApprox(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

function createRuntimeStub(options: RuntimeStubOptions = {}): AppRuntime {
  const config = createAgentConfig();
  const activePosition = createPositionRecord({
    walletAddress: config.wallet.active_address
  });
  const positions = options.positions ?? [activePosition];
  const skills = [createSkill()];
  const auditEvents = options.auditEvents ?? [];
  const calls = options.calls ?? [];
  const recommendations: SkillOptimizationRecommendation[] = options.recommendations ?? [
    {
      skillId: "bread_n_butter",
      skillVersion: "1.0.0",
      evaluatedAt: new Date("2026-01-01T00:02:00.000Z"),
      suggestedAction: "hold" as const,
      confidence: 0,
      reason: "样本不足。"
    }
  ];
  const paperPositionSnapshots = options.paperSnapshots ?? [
    {
      id: "paper-1",
      positionId: activePosition.id,
      skillId: activePosition.skillId,
      skillVersion: activePosition.skillVersion,
      poolAddress: activePosition.poolAddress,
      tokenMint: activePosition.tokenMint,
      tokenSymbol: activePosition.tokenSymbol,
      timestamp: new Date("2026-01-01T00:01:00.000Z"),
      activeBinId: 8_000,
      valueSol: 1.2,
      valueUsd: 180,
      pnlPercent: 0,
      feeAccruedSol: 0,
      unclaimedFeesSol: 0,
      inRange: true,
      source: "meteora_http",
      stale: false
    }
  ];
  const snapshot = {
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    manualPause: false,
    lastPauseReason: undefined,
    mode: SystemMode.NORMAL,
    availableCapitalSol: 10,
    activePositions: positions.filter((position) => position.status === "active"),
    allPositions: positions,
    lastMainCycleAt: undefined,
    lastHighFreqTickAt: undefined,
    lastCycleResult: undefined,
    pendingActions: [],
    paperPositionSnapshots
  };

  return {
    config,
    configPath: "/tmp/config.yaml",
    skillsPath: "/tmp/skills",
    samplePoolPath: "/tmp/sample-pools.json",
    auditDir: "/tmp/audit",
    stateSnapshotPath: "/tmp/state.json",
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
      getLastPersistError() {
        return null;
      },
      getActivePositions() {
        return snapshot.activePositions;
      },
      getAllPositions() {
        return snapshot.allPositions;
      },
      getPaperPositionSnapshots() {
        return snapshot.paperPositionSnapshots;
      }
    } as never,
    skillManager: {
      listAll() {
        return skills;
      },
      disableSkill(skillId: string) {
        calls.push(`disable:${skillId}`);
        const skill = skills.find((item) => item.id === skillId);
        if (!skill) {
          return null;
        }
        skill.status = "disabled" as never;
        return skill;
      },
      enableSkill(skillId: string, options?: { canaryPercent?: number }) {
        calls.push(`enable:${skillId}:${options?.canaryPercent ?? ""}`);
        const skill = skills.find((item) => item.id === skillId);
        if (!skill) {
          return null;
        }
        skill.status = "active" as never;
        skill.canaryPercent = options?.canaryPercent;
        return skill;
      },
      patchSkillParams(skillId: string, patch: Record<string, unknown>) {
        calls.push(`params:${skillId}:${Object.keys(patch).sort().join(",")}`);
        const skill = skills.find((item) => item.id === skillId);
        if (!skill) {
          return null;
        }
        skill.params = {
          ...skill.params,
          ...patch
        } as never;
        return skill;
      },
      patchSkillConfig(
        skillId: string,
        patch: { params?: Record<string, unknown>; riskLimits?: Record<string, unknown> },
        version?: string
      ) {
        calls.push(
          `patch:${skillId}:${version ?? ""}:params=${Object.keys(patch.params ?? {}).sort().join(",")}:risk=${Object.keys(
            patch.riskLimits ?? {}
          )
            .sort()
            .join(",")}`
        );
        const skill = skills.find((item) => item.id === skillId && (version ? item.version === version : true));
        if (!skill) {
          return null;
        }
        skill.params = {
          ...skill.params,
          ...patch.params
        } as never;
        skill.riskLimits = {
          ...skill.riskLimits,
          ...patch.riskLimits
        } as never;
        return skill;
      },
      rollback(skillId: string, version?: string) {
        calls.push(`rollback:${skillId}:${version ?? ""}`);
        const skill = skills.find((item) => item.id === skillId);
        return skill ?? null;
      }
    } as never,
    skillStatsService: {
      listStats() {
        return [];
      },
      enrichSkills(skills: unknown[]) {
        return skills;
      }
    } as never,
    skillOptimizerService: {
      listRecommendations() {
        return recommendations;
      },
      evaluateAndStore() {
        calls.push("optimizer:evaluate");
        return recommendations;
      },
      getSummary() {
        return {
          enabled: true,
          recommendationCount: recommendations.length,
          lastEvaluatedAt: recommendations[0]?.evaluatedAt
        };
      }
    } as never,
    dataProviderManager: {
      getHealthSnapshot() {
        return {
          hasAnyProvider: true,
          hasPrimaryProvider: true,
          providerStatuses: []
        };
      }
    } as never,
    rpcManager: {
      getHealth() {
        return {
          activeName: "primary",
          canWrite: true,
          statuses: []
        };
      }
    } as never,
    metricsService: {
      renderPrometheus() {
        return "# HELP xagent_test test\n# TYPE xagent_test gauge\nxagent_test 1\n";
      }
    } as never,
    executionLayer: {
      getStatus() {
        return {
          mode: "dry_run" as const,
          backend: "dry_run",
          dryRun: true,
          healthy: true,
          supportedActions: ["open", "close", "rebalance", "claim", "emergency_exit"],
          submissionStrategy: "gateway_managed" as const
        };
      },
      async execute(action: { id: string; type: string; positionId?: string }) {
        calls.push(`execute:${action.type}:${action.positionId ?? ""}`);
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
    paperTradingService: {
      getSummary() {
        return {
          enabled: true,
          snapshotCount: snapshot.paperPositionSnapshots.length,
          stalePositions: 0
        };
      }
    } as never,
    telegramBot: null,
    auditReader: {
      async readRecent(limit = 30) {
        return auditEvents.slice(0, limit);
      },
      async queryEvents(query: AuditEventQuery = {}) {
        const source = query.source;
        const cycleId = query.cycleId;
        const search = query.q?.toLowerCase();
        const since = query.since ? new Date(query.since).getTime() : undefined;
        const until = query.until ? new Date(query.until).getTime() : undefined;
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 30;
        return auditEvents
          .filter((event) => {
            const eventCycleId = typeof event.payload.cycleId === "string" ? event.payload.cycleId : undefined;
            const timestamp = event.timestamp ? new Date(event.timestamp).getTime() : 0;
            if (source && event.source !== source) {
              return false;
            }
            if (cycleId && eventCycleId !== cycleId) {
              return false;
            }
            if (since !== undefined && timestamp < since) {
              return false;
            }
            if (until !== undefined && timestamp > until) {
              return false;
            }
            if (search && !`${event.source} ${eventCycleId ?? ""} ${JSON.stringify(event.payload)}`.toLowerCase().includes(search)) {
              return false;
            }
            return true;
          })
          .slice(offset, offset + limit);
      }
    } as never,
    orchestrator: {
      isRunning() {
        return false;
      },
      async pause(reason?: string) {
        calls.push(`pause:${reason ?? ""}`);
      },
      async resume() {
        calls.push("resume");
      },
      async runMainCycle() {
        calls.push("runMainCycle");
        return {
          actions: [],
          results: []
        };
      }
    } as never,
    async shutdown() {}
  };
}

async function requestApi(
  path: string,
  init: RequestInit | undefined,
  host = "127.0.0.1",
  runtime = createRuntimeStub()
): Promise<Response> {
  const app = createApiApp(runtime, {
    host,
    port: 8787
  });

  return await app.fetch(new Request(`http://${host}${path}`, init));
}

test("startApiServer 在 loopback 下允许无 token 访问受保护接口", async () => {
  await withEnv(
    {
      XAGENT_API_TOKEN: undefined
    },
    async () => {
      const response = await requestApi("/status", undefined);
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.mode, "normal");
      assert.equal(payload.execution.backend, "dry_run");
    }
  );
});

test("GET /paper-trading/snapshots 返回 paper snapshots", async () => {
  const response = await requestApi("/paper-trading/snapshots?positionId=position-1&limit=10", undefined);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.snapshots.length, 1);
  assert.equal(payload.snapshots[0].positionId, "position-1");
});

test("GET /status 返回组合权益和 24h mark 变化", async () => {
  const position = createPositionRecord({
    currentValueUsd: 110,
    depositedSol: 1,
    totalFeesClaimedSol: 0.05,
    paper: {
      currentValueSol: 1.1,
      unclaimedFeesSol: 0,
      lastValuationAt: new Date("2026-01-01T00:02:00.000Z")
    }
  });
  const runtime = createRuntimeStub({
    positions: [position],
    paperSnapshots: [
      {
        id: "paper-recent",
        positionId: position.id,
        skillId: position.skillId,
        skillVersion: position.skillVersion,
        poolAddress: position.poolAddress,
        tokenMint: position.tokenMint,
        tokenSymbol: position.tokenSymbol,
        timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000),
        activeBinId: 8_000,
        valueSol: 1,
        valueUsd: 100,
        pnlPercent: 0,
        feeAccruedSol: 0,
        unclaimedFeesSol: 0,
        inRange: true,
        source: "meteora_http",
        stale: false
      }
    ]
  });

  const response = await requestApi("/status", undefined, "127.0.0.1", runtime);
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.portfolio.activeValueSol, 1.1);
  assert.equal(payload.portfolio.activeClaimedFeesSol, 0.05);
  assertApprox(payload.portfolio.activePnlSol, 0.15);
  assert.equal(payload.portfolio.totalEquitySol, 11.15);
  assertApprox(payload.portfolio.totalEquityUsd, 1115);
  assertApprox(payload.portfolio.activeMarkChange24hSol, 0.1);
  assert.equal(payload.portfolio.markChangeIncludesClaimedFees, false);
});

test("GET /portfolio/report 返回区间盈亏日历和交易次数", async () => {
  const now = new Date();
  const position = createPositionRecord({
    currentValueUsd: 120,
    depositedSol: 1,
    paper: {
      currentValueSol: 1.2,
      unclaimedFeesSol: 0,
      lastValuationAt: now
    }
  });
  const today = now.toISOString().slice(0, 10);
  const runtime = createRuntimeStub({
    positions: [position],
    paperSnapshots: [
      {
        id: "paper-start",
        positionId: position.id,
        skillId: position.skillId,
        skillVersion: position.skillVersion,
        poolAddress: position.poolAddress,
        tokenMint: position.tokenMint,
        tokenSymbol: position.tokenSymbol,
        timestamp: new Date(`${today}T00:05:00.000Z`),
        activeBinId: 8_000,
        valueSol: 1,
        valueUsd: 100,
        pnlPercent: 0,
        feeAccruedSol: 0,
        unclaimedFeesSol: 0,
        inRange: true,
        source: "meteora_http",
        stale: false
      },
      {
        id: "paper-end",
        positionId: position.id,
        skillId: position.skillId,
        skillVersion: position.skillVersion,
        poolAddress: position.poolAddress,
        tokenMint: position.tokenMint,
        tokenSymbol: position.tokenSymbol,
        timestamp: new Date(`${today}T00:10:00.000Z`),
        activeBinId: 8_001,
        valueSol: 1.2,
        valueUsd: 120,
        pnlPercent: 20,
        feeAccruedSol: 0,
        unclaimedFeesSol: 0,
        inRange: true,
        source: "meteora_http",
        stale: false
      },
      {
        id: "paper-outlier",
        positionId: position.id,
        skillId: position.skillId,
        skillVersion: position.skillVersion,
        poolAddress: position.poolAddress,
        tokenMint: position.tokenMint,
        tokenSymbol: position.tokenSymbol,
        timestamp: new Date(`${today}T00:12:00.000Z`),
        activeBinId: 8_001,
        valueSol: 100_000,
        valueUsd: 10_000_000,
        pnlPercent: 9_999_900,
        feeAccruedSol: 0,
        unclaimedFeesSol: 0,
        inRange: true,
        source: "meteora_http",
        stale: false
      }
    ],
    auditEvents: [
      {
        source: "actions",
        timestamp: new Date(`${today}T00:11:00.000Z`).toISOString(),
        payload: {
          cycleId: "cycle-report",
          timestamp: new Date(`${today}T00:11:00.000Z`).toISOString(),
          action: { type: "claim" },
          result: { status: "success" }
        }
      }
    ]
  });

  const response = await requestApi("/portfolio/report?days=7&timezoneOffsetMinutes=0", undefined, "127.0.0.1", runtime);
  assert.equal(response.status, 200);
  const payload = await response.json();
  const todayBucket = payload.days.find((day: { date: string }) => day.date === today);

  assert.equal(payload.range.days, 7);
  assert.equal(payload.summary.tradeCount, 1);
  assertApprox(payload.summary.totalPnlSol, 0.2);
  assertApprox(todayBucket.pnlSol, 0.2);
  assert.equal(todayBucket.tradeCount, 1);
  assert.equal(todayBucket.snapshotCount, 3);
  assert.equal(todayBucket.rejectedSnapshotCount, 1);
  assert.equal(payload.summary.dataQuality.snapshotCount, 3);
  assert.equal(payload.summary.dataQuality.rejectedSnapshotCount, 1);
  assert.equal(payload.summary.dataQuality.hasRejectedSnapshots, true);
});

test("GET /trades 返回交易历史和已实现盈亏统计", async () => {
  const closedPosition = createPositionRecord({
    id: "closed-rkc",
    tokenSymbol: "RKC",
    tokenMint: "mint-rkc",
    poolAddress: "pool-rkc",
    status: "closed",
    depositedSol: 1,
    pnlPercent: 25,
    totalFeesClaimedSol: 0.05,
    currentValueUsd: 125,
    closedAt: new Date("2026-01-03T00:00:00.000Z")
  });
  const runtime = createRuntimeStub({
    auditEvents: [
      {
        source: "actions",
        timestamp: "2026-01-03T00:00:00.000Z",
        payload: {
          cycleId: "cycle-trades",
          timestamp: "2026-01-03T00:00:00.000Z",
          action: {
            id: "action-close",
            type: "close",
            trigger: "stop_loss",
            positionId: closedPosition.id
          },
          result: {
            actionId: "action-close",
            type: "close",
            status: "success",
            message: "模拟平仓成功，回收 1.2500 SOL。",
            txSignatures: ["tx-close-rkc"],
            latencyMs: 12,
            metadata: {
              backend: "dry_run",
              recoveredSol: 1.25,
              positionId: closedPosition.id
            },
            stateOperations: [
              { kind: "adjust_capital", deltaSol: 1.25 },
              { kind: "upsert_position", position: closedPosition }
            ]
          }
        }
      }
    ]
  });

  const response = await requestApi("/trades?actionType=close&status=success&token=rkc&limit=10", undefined, "127.0.0.1", runtime);
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.trades.length, 1);
  assert.equal(payload.trades[0].actionType, "close");
  assert.equal(payload.trades[0].tokenSymbol, "RKC");
  assert.equal(payload.trades[0].recoveredSol, 1.25);
  assertApprox(payload.trades[0].realizedPnlSol, 0.25);
  assertApprox(payload.trades[0].realizedPnlPercent, 25);
  assert.equal(payload.summary.total, 1);
  assertApprox(payload.summary.totalRealizedPnlSol, 0.25);
  assert.equal(payload.summary.winningTrades, 1);
});

test("GET /pnl/ledger 返回按仓位归集的账本盈亏", async () => {
  const closedPosition = createPositionRecord({
    id: "closed-ledger",
    status: "closed",
    depositedSol: 1,
    costsPaidSol: 0.01,
    closedAt: new Date("2026-01-03T00:00:00.000Z")
  });
  const runtime = createRuntimeStub({
    positions: [closedPosition],
    auditEvents: [
      {
        source: "actions",
        timestamp: "2026-01-03T00:00:00.000Z",
        payload: {
          cycleId: "cycle-ledger",
          action: {
            id: "action-open",
            type: "open"
          },
          result: {
            actionId: "action-open",
            status: "success",
            stateOperations: [{ kind: "upsert_position", position: closedPosition }]
          }
        }
      },
      {
        source: "actions",
        timestamp: "2026-01-03T00:01:00.000Z",
        payload: {
          cycleId: "cycle-ledger",
          action: {
            id: "action-close",
            type: "close",
            positionId: "closed-ledger"
          },
          result: {
            actionId: "action-close",
            status: "success",
            metadata: {
              recoveredSol: 1.2,
              positionId: "closed-ledger"
            },
            stateOperations: [
              { kind: "adjust_capital", deltaSol: 1.2 },
              { kind: "upsert_position", position: closedPosition }
            ]
          }
        }
      }
    ]
  });

  const response = await requestApi("/pnl/ledger", undefined, "127.0.0.1", runtime);
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.positions[0].positionId, "closed-ledger");
  assert.equal(payload.positions[0].completeness, "complete");
  assertApprox(payload.positions[0].realizedPnlSol, 0.2);
  assertApprox(payload.summary.realizedPnlSol, 0.2);
  assert.equal(payload.summary.missingCloseActionCount, 0);
  assert.equal(payload.summary.partialPositionCount, 0);

  const statusResponse = await requestApi("/status", undefined, "127.0.0.1", runtime);
  assert.equal(statusResponse.status, 200);
  const statusPayload = await statusResponse.json();
  assertApprox(statusPayload.pnlLedger.realizedPnlSol, payload.summary.realizedPnlSol);
  assertApprox(statusPayload.pnlLedger.totalPnlSol, payload.summary.totalPnlSol);
  assert.equal(statusPayload.pnlLedger.missingCloseActionCount, payload.summary.missingCloseActionCount);
});

test("GET /skills/experiments 返回策略实验状态", async () => {
  const response = await requestApi("/skills/experiments", undefined);
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.experiments[0].skillId, "bread_n_butter");
  assert.equal(payload.summary.total, 1);
});

test("GET /positions 支持状态、搜索、排序和分页", async () => {
  const positions = [
    createPositionRecord({
      id: "active-bonk",
      tokenSymbol: "BONK",
      tokenMint: "mint-bonk",
      skillId: "sawtooth",
      pnlPercent: 3,
      openedAt: new Date("2026-01-02T00:00:00.000Z")
    }),
    createPositionRecord({
      id: "closed-rkc",
      tokenSymbol: "RKC",
      tokenMint: "mint-rkc",
      skillId: "sawtooth",
      status: "closed",
      pnlPercent: -5,
      openedAt: new Date("2026-01-01T00:00:00.000Z"),
      closedAt: new Date("2026-01-03T00:00:00.000Z")
    }),
    createPositionRecord({
      id: "error-hanta",
      tokenSymbol: "HANTA",
      tokenMint: "mint-hanta",
      skillId: "other",
      status: "error",
      pnlPercent: 1,
      openedAt: new Date("2026-01-04T00:00:00.000Z")
    })
  ];
  const runtime = createRuntimeStub({ positions });

  const response = await requestApi(
    "/positions?status=closed&token=rkc&sort=pnlPercent&order=asc&limit=1&offset=0",
    undefined,
    "127.0.0.1",
    runtime
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(
    payload.positions.map((position: { id: string }) => position.id),
    ["closed-rkc"]
  );
  assert.equal(payload.counts.total, 3);
  assert.equal(payload.counts.active, 1);
  assert.equal(payload.counts.closed, 1);
  assert.equal(payload.counts.error, 1);
  assert.equal(payload.page.total, 1);

  const active = await requestApi("/positions?active=true", undefined, "127.0.0.1", runtime);
  const activePayload = await active.json();
  assert.deepEqual(
    activePayload.positions.map((position: { id: string }) => position.id),
    ["active-bonk"]
  );
});

test("GET /audit/events 支持 source、cycleId、q、时间和 offset 分页", async () => {
  const auditEvents: AuditEventRecord[] = [
    {
      source: "actions",
      timestamp: "2026-01-03T00:00:00.000Z",
      payload: { cycleId: "cycle-2", action: { type: "close" }, result: { message: "closed RKC" } }
    },
    {
      source: "errors",
      timestamp: "2026-01-02T00:00:00.000Z",
      payload: { cycleId: "cycle-1", error: { message: "provider timeout" } }
    },
    {
      source: "actions",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: { cycleId: "cycle-1", action: { type: "open" }, result: { message: "opened BONK" } }
    }
  ];
  const runtime = createRuntimeStub({ auditEvents });

  const response = await requestApi(
    "/audit/events?source=actions&cycleId=cycle-1&q=bonk&since=2026-01-01T00:00:00.000Z&until=2026-01-02T00:00:00.000Z&limit=1&offset=0",
    undefined,
    "127.0.0.1",
    runtime
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.events.length, 1);
  assert.equal(payload.events[0].source, "actions");
  assert.equal(payload.events[0].payload.cycleId, "cycle-1");
  assert.equal(payload.page.hasMore, false);

  const paged = await requestApi("/audit/events?limit=1&offset=1", undefined, "127.0.0.1", runtime);
  const pagedPayload = await paged.json();
  assert.equal(pagedPayload.events.length, 1);
  assert.equal(pagedPayload.page.nextOffset, 2);
  assert.equal(pagedPayload.page.hasMore, true);
});

test("startApiServer 在非 loopback 下要求 Bearer Token", async () => {
  await withEnv(
    {
      XAGENT_API_TOKEN: undefined
    },
    async () => {
      await assert.rejects(
        () => startApiServer(createRuntimeStub(), { host: "0.0.0.0", port: 0 }),
        /不是 loopback，但未配置 Bearer Token/
      );
    }
  );
});

test("startApiServer 会保护 /status 但保留 /health 无鉴权", async () => {
  await withEnv(
    {
      XAGENT_API_TOKEN: "test-token"
    },
    async () => {
      const health = await requestApi("/health", undefined);
      assert.equal(health.status, 200);

      const unauthorized = await requestApi("/status", undefined);
      assert.equal(unauthorized.status, 401);

      const authorized = await requestApi("/status", {
        headers: {
          Authorization: "Bearer test-token"
        }
      });
      assert.equal(authorized.status, 200);
    }
  );
});

test("Dashboard Prometheus 文本端点复用 Bearer Token 认证", async () => {
  await withEnv(
    {
      XAGENT_API_TOKEN: "metrics-token"
    },
    async () => {
      const unauthorized = await requestApi("/dashboard/prometheus", undefined);
      assert.equal(unauthorized.status, 401);

      const authorized = await requestApi("/dashboard/prometheus", {
        headers: {
          Authorization: "Bearer metrics-token"
        }
      });
      assert.equal(authorized.status, 200);
      assert.match(authorized.headers.get("content-type") ?? "", /text\/plain/);
      assert.match(await authorized.text(), /xagent_test 1/);
    }
  );
});

test("startApiServer 允许 SSE 路由使用 query token", async () => {
  await withEnv(
    {
      XAGENT_API_TOKEN: "stream-token"
    },
    async () => {
      const controller = new AbortController();
      const response = await requestApi(
        "/events/status?token=stream-token",
        {
          signal: controller.signal
        }
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

      const reader = response.body?.getReader();
      assert.ok(reader);
      const chunk = await reader!.read();
      assert.equal(chunk.done, false);
      const text = Buffer.from(chunk.value ?? new Uint8Array()).toString("utf8");
      assert.match(text, /event: status/);
      controller.abort();
      await reader!.cancel();
    }
  );
});

test("control mutation 路由会调用 orchestrator 和 execution layer", async () => {
  await withEnv(
    {
      XAGENT_API_TOKEN: undefined
    },
    async () => {
      const calls: string[] = [];
      const runtime = createRuntimeStub({ calls });

      const pause = await requestApi(
        "/control/pause",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ reason: "test_pause" })
        },
        "127.0.0.1",
        runtime
      );
      assert.equal(pause.status, 200);

      const resume = await requestApi("/control/resume", { method: "POST" }, "127.0.0.1", runtime);
      assert.equal(resume.status, 200);
      const resumePayload = await resume.json();
      assert.equal(resumePayload.resumed, true);

      const cycle = await requestApi("/control/run-main-cycle", { method: "POST" }, "127.0.0.1", runtime);
      assert.equal(cycle.status, 200);

      const forceExit = await requestApi("/positions/position-1/force-exit", { method: "POST" }, "127.0.0.1", runtime);
      assert.equal(forceExit.status, 200);

      const emergency = await requestApi("/control/emergency-exit-all", { method: "POST" }, "127.0.0.1", runtime);
      assert.equal(emergency.status, 200);

      assert.deepEqual(calls, [
        "pause:test_pause",
        "resume",
        "runMainCycle",
        "runMainCycle",
        "execute:close:position-1",
        "pause:emergency_exit_all",
        "execute:emergency_exit:position-1"
      ]);
    }
  );
});

test("skill mutation 路由支持 enable、params、rollback 且缺失 skill 返回 404", async () => {
  await withEnv(
    {
      XAGENT_API_TOKEN: undefined
    },
    async () => {
      const calls: string[] = [];
      const runtime = createRuntimeStub({ calls });

      const enable = await requestApi(
        "/skills/bread_n_butter/enable",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ canaryPercent: 25 })
        },
        "127.0.0.1",
        runtime
      );
      assert.equal(enable.status, 200);
      const enablePayload = await enable.json();
      assert.equal(enablePayload.skill.canaryPercent, 25);

      const params = await requestApi(
        "/skills/bread_n_butter/params",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ binCount: 24 })
        },
        "127.0.0.1",
        runtime
      );
      assert.equal(params.status, 200);
      const paramsPayload = await params.json();
      assert.equal(paramsPayload.skill.params.binCount, 24);

      const config = await requestApi(
        "/skills/bread_n_butter/config",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            version: "1.0.0",
            params: { binCount: 55 },
            riskLimits: { stopLossPercent: 16, maxAliveHours: 58 }
          })
        },
        "127.0.0.1",
        runtime
      );
      assert.equal(config.status, 200);
      const configPayload = await config.json();
      assert.equal(configPayload.skill.params.binCount, 55);
      assert.equal(configPayload.skill.riskLimits.stopLossPercent, 16);
      assert.equal(configPayload.skill.riskLimits.maxAliveHours, 58);

      const invalidConfig = await requestApi(
        "/skills/bread_n_butter/config",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ riskLimits: { stopLossPercent: 120 } })
        },
        "127.0.0.1",
        runtime
      );
      assert.equal(invalidConfig.status, 400);

      const rollback = await requestApi(
        "/skills/bread_n_butter/rollback",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ version: "1.0.0" })
        },
        "127.0.0.1",
        runtime
      );
      assert.equal(rollback.status, 200);

      const missing = await requestApi("/skills/missing/disable", { method: "POST" }, "127.0.0.1", runtime);
      assert.equal(missing.status, 404);

      assert.deepEqual(calls, [
        "enable:bread_n_butter:25",
        "params:bread_n_butter:binCount",
        "patch:bread_n_butter:1.0.0:params=binCount:risk=maxAliveHours,stopLossPercent",
        "rollback:bread_n_butter:1.0.0",
        "disable:missing"
      ]);
    }
  );
});

test("skill optimizer 路由返回建议并支持手动评估", async () => {
  await withEnv(
    {
      XAGENT_API_TOKEN: undefined
    },
    async () => {
      const calls: string[] = [];
      const runtime = createRuntimeStub({ calls });

      const recommendations = await requestApi("/skills/optimizer/recommendations", undefined, "127.0.0.1", runtime);
      assert.equal(recommendations.status, 200);
      const recommendationsPayload = await recommendations.json();
      assert.equal(recommendationsPayload.recommendations[0].skillId, "bread_n_butter");
      assert.equal(recommendationsPayload.summary.recommendationCount, 1);

      const evaluate = await requestApi("/skills/optimizer/evaluate", { method: "POST" }, "127.0.0.1", runtime);
      assert.equal(evaluate.status, 200);
      const evaluatePayload = await evaluate.json();
      assert.equal(evaluatePayload.recommendations[0].suggestedAction, "hold");
      assert.deepEqual(calls, ["optimizer:evaluate"]);
    }
  );
});

test("skill optimizer apply 路由会应用 params 和 riskLimits patch", async () => {
  await withEnv(
    {
      XAGENT_API_TOKEN: undefined
    },
    async () => {
      const calls: string[] = [];
      const runtime = createRuntimeStub({
        calls,
        recommendations: [
          {
            skillId: "bread_n_butter",
            skillVersion: "1.0.0",
            evaluatedAt: new Date("2026-01-01T00:03:00.000Z"),
            suggestedAction: "reduce_risk",
            confidence: 0.9,
            reason: "收缩风险参数。",
            paramsPatch: {
              binCount: 55
            },
            riskLimitsPatch: {
              stopLossPercent: 16,
              maxAliveHours: 58
            }
          }
        ]
      });

      const apply = await requestApi(
        "/skills/bread_n_butter/optimizer/apply",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ version: "1.0.0" })
        },
        "127.0.0.1",
        runtime
      );
      assert.equal(apply.status, 200);
      const payload = await apply.json();
      assert.equal(payload.applied, true);
      assert.equal(payload.skill.params.binCount, 55);
      assert.equal(payload.skill.riskLimits.stopLossPercent, 16);
      assert.equal(payload.skill.riskLimits.maxAliveHours, 58);

      const missing = await requestApi("/skills/missing/optimizer/apply", { method: "POST" }, "127.0.0.1", runtime);
      assert.equal(missing.status, 404);
      assert.deepEqual(calls, ["patch:bread_n_butter:1.0.0:params=binCount:risk=maxAliveHours,stopLossPercent"]);
    }
  );
});
