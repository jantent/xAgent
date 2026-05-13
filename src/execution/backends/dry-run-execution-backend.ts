import type { IExecutionBackend } from "../../domain/contracts.js";
import type {
  ActionExecutionResult,
  ActionType,
  ExecutionBackendStatus,
  ExecutionContext,
  PlannedAction,
  PositionRecord
} from "../../domain/models.js";
import type { AgentConfig } from "../../config/types.js";
import type { RPCManager } from "../../managers/rpc-manager.js";
import { createId } from "../../utils/async.js";
import type { Logger } from "../../utils/logger.js";
import { estimateUsdFromSol } from "../../utils/valuation.js";

const DRY_RUN_SUPPORTED_ACTIONS: ActionType[] = ["open", "close", "rebalance", "claim", "emergency_exit"];

function isPaperTradingEnabled(config: AgentConfig): boolean {
  return config.paper_trading?.enabled !== false && (config.execution?.mode ?? "dry_run") === "dry_run";
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function currentPaperValueSol(position: PositionRecord): number {
  if (typeof position.paper?.currentValueSol === "number" && Number.isFinite(position.paper.currentValueSol)) {
    return Math.max(0, position.paper.currentValueSol);
  }

  return Math.max(0, position.depositedSol * (1 + position.pnlPercent / 100));
}

function hasPaperMark(config: AgentConfig, position: PositionRecord): boolean {
  return isPaperTradingEnabled(config) && Boolean(position.paper);
}

/**
 * 保留原有 dry-run 语义，但不再直接写 SharedState，
 * 而是返回标准化的状态操作，方便和 live backend 走同一条落账路径。
 */
export class DryRunExecutionBackend implements IExecutionBackend {
  constructor(
    private readonly config: AgentConfig,
    private readonly rpcManager: RPCManager,
    private readonly logger: Logger
  ) {}

  getStatus(): ExecutionBackendStatus {
    return {
      mode: "dry_run",
      backend: "dry_run",
      dryRun: true,
      healthy: true,
      supportedActions: DRY_RUN_SUPPORTED_ACTIONS,
      submissionStrategy: "gateway_managed"
    };
  }

  async execute(action: PlannedAction, context: ExecutionContext): Promise<ActionExecutionResult> {
    const startedAt = Date.now();

    switch (action.type) {
      case "open":
        return this.executeOpen(action, context, startedAt);
      case "close":
      case "emergency_exit":
        return this.executeClose(action, context, startedAt);
      case "rebalance":
        return this.executeRebalance(action, context, startedAt);
      case "claim":
        return this.executeClaim(action, context, startedAt);
      default:
        this.logger.debug("dry-run backend 跳过未支持动作", {
          actionId: action.id,
          actionType: action.type
        });
        return {
          actionId: action.id,
          type: action.type,
          status: "skipped",
          message: "当前 action 类型未实现，已跳过。",
          txSignatures: [],
          latencyMs: Date.now() - startedAt,
          metadata: {
            backend: "dry_run"
          }
        };
    }
  }

  private executeOpen(action: PlannedAction, context: ExecutionContext, startedAt: number): ActionExecutionResult {
    if (!action.pool || !action.skill || !action.amountSol || !action.newRange) {
      throw new Error("open action 缺少必要字段");
    }

    if (context.availableCapitalSol < action.amountSol) {
      throw new Error("可用资金不足，无法执行开仓");
    }

    const position: PositionRecord = {
      id: createId("position"),
      positionPubkey: createId("pubkey"),
      poolAddress: action.pool.address,
      tokenMint: action.pool.tokenMint,
      tokenSymbol: action.pool.tokenSymbol,
      walletAddress: this.config.wallet.active_address,
      skillId: action.skill.id,
      skillVersion: action.skill.version,
      direction: action.skill.params.direction,
      fromBinId: action.newRange.minBinId,
      toBinId: action.newRange.maxBinId,
      depositedSol: action.amountSol,
      currentValueUsd: estimateUsdFromSol(this.config, action.amountSol),
      pnlPercent: 0,
      isInRange: true,
      totalFeesClaimedSol: 0,
      rebalanceCount: 0,
      status: "active",
      entryLincolnScore: action.pool.lincolnScore,
      openedAt: new Date(),
      maxAliveUntil: new Date(Date.now() + action.skill.riskLimits.maxAliveHours * 60 * 60 * 1000),
      ...(isPaperTradingEnabled(this.config)
        ? {
            paper: {
              entryActiveBinId: readFiniteNumber(action.pool.meta?.activeBinId),
              entryPrice: readFiniteNumber(action.pool.meta?.currentPrice),
              currentValueSol: action.amountSol,
              unclaimedFeesSol: 0,
              lastSource: action.pool.dataSource
            }
          }
        : {}),
      ...(action.pool.narrative ? { narrative: action.pool.narrative } : {})
    };

    return {
      actionId: action.id,
      type: action.type,
      status: "success",
      message: `模拟开仓成功，仓位 ${position.id} 已建立。`,
      txSignatures: [createId("tx")],
      latencyMs: Date.now() - startedAt,
      metadata: {
        backend: "dry_run",
        positionId: position.id,
        rpcProvider: this.rpcManager.getActiveEndpoint().name
      },
      stateOperations: [
        {
          kind: "adjust_capital",
          deltaSol: -action.amountSol
        },
        {
          kind: "upsert_position",
          position
        }
      ]
    };
  }

  private executeClose(action: PlannedAction, context: ExecutionContext, startedAt: number): ActionExecutionResult {
    const position = context.position;
    if (!action.positionId) {
      throw new Error("close action 缺少 positionId");
    }

    if (!position) {
      return {
        actionId: action.id,
        type: action.type,
        status: "skipped",
        message: `仓位 ${action.positionId} 不存在，已跳过。`,
        txSignatures: [],
        latencyMs: Date.now() - startedAt,
        metadata: {
          backend: "dry_run"
        }
      };
    }

    const recoveredSol = hasPaperMark(this.config, position)
      ? currentPaperValueSol(position) + position.totalFeesClaimedSol
      : position.depositedSol * (1 + position.pnlPercent / 100) + position.totalFeesClaimedSol;
    const closedPosition: PositionRecord = {
      ...position,
      status: "closed",
      closedAt: new Date(),
      isInRange: false,
      currentValueUsd: estimateUsdFromSol(this.config, recoveredSol),
      paper: position.paper
        ? {
            ...position.paper,
            currentValueSol: hasPaperMark(this.config, position) ? currentPaperValueSol(position) : position.paper.currentValueSol
          }
        : undefined
    };

    return {
      actionId: action.id,
      type: action.type,
      status: "success",
      message: `模拟平仓成功，回收 ${recoveredSol.toFixed(4)} SOL。`,
      txSignatures: [createId("tx")],
      latencyMs: Date.now() - startedAt,
      metadata: {
        backend: "dry_run",
        positionId: position.id,
        recoveredSol,
        rpcProvider: this.rpcManager.getActiveEndpoint().name
      },
      stateOperations: [
        {
          kind: "adjust_capital",
          deltaSol: recoveredSol
        },
        {
          kind: "upsert_position",
          position: closedPosition
        }
      ]
    };
  }

  private executeRebalance(action: PlannedAction, context: ExecutionContext, startedAt: number): ActionExecutionResult {
    if (!action.positionId || !action.newRange) {
      throw new Error("rebalance action 缺少必要字段");
    }

    if (!context.position) {
      throw new Error(`待重平衡仓位不存在: ${action.positionId}`);
    }

    const updatedPosition: PositionRecord = {
      ...context.position,
      fromBinId: action.newRange.minBinId,
      toBinId: action.newRange.maxBinId,
      rebalanceCount: context.position.rebalanceCount + 1,
      isInRange: true,
      outOfRangeSince: undefined,
      currentValueUsd: estimateUsdFromSol(this.config, context.position.depositedSol)
    };

    return {
      actionId: action.id,
      type: action.type,
      status: "success",
      message: `模拟重平衡成功，仓位 ${context.position.id} bin range 已更新。`,
      txSignatures: [createId("tx")],
      latencyMs: Date.now() - startedAt,
      metadata: {
        backend: "dry_run",
        positionId: context.position.id,
        rpcProvider: this.rpcManager.getActiveEndpoint().name
      },
      stateOperations: [
        {
          kind: "upsert_position",
          position: updatedPosition
        }
      ]
    };
  }

  private executeClaim(action: PlannedAction, context: ExecutionContext, startedAt: number): ActionExecutionResult {
    if (!action.positionId) {
      throw new Error("claim action 缺少 positionId");
    }

    if (!context.position) {
      throw new Error(`待提取手续费仓位不存在: ${action.positionId}`);
    }

    const paperEnabled = hasPaperMark(this.config, context.position);
    const claimedFee = paperEnabled ? (context.position.paper?.unclaimedFeesSol ?? 0) : 0.02;
    const claimTimestamp = new Date();
    const paperValueAfterClaim = paperEnabled ? Math.max(0, currentPaperValueSol(context.position) - claimedFee) : undefined;
    const updatedPosition: PositionRecord = {
      ...context.position,
      totalFeesClaimedSol: context.position.totalFeesClaimedSol + claimedFee,
      currentValueUsd: paperValueAfterClaim !== undefined
        ? estimateUsdFromSol(this.config, paperValueAfterClaim)
        : context.position.currentValueUsd,
      pnlPercent: paperValueAfterClaim !== undefined && context.position.depositedSol > 0
        ? ((paperValueAfterClaim - context.position.depositedSol) / context.position.depositedSol) * 100
        : context.position.pnlPercent,
      lastClaimedAt: claimTimestamp,
      lastFeeCheckAt: claimTimestamp,
      paper: paperEnabled
        ? {
            ...(context.position.paper ?? { unclaimedFeesSol: 0 }),
            currentValueSol: paperValueAfterClaim ?? context.position.paper?.currentValueSol,
            unclaimedFeesSol: 0,
            staleReason: undefined
          }
        : context.position.paper
    };

    return {
      actionId: action.id,
      type: action.type,
      status: "success",
      message: `模拟提取手续费成功，新增 ${claimedFee} SOL。`,
      txSignatures: [createId("tx")],
      latencyMs: Date.now() - startedAt,
      metadata: {
        backend: "dry_run",
        positionId: context.position.id,
        rpcProvider: this.rpcManager.getActiveEndpoint().name
      },
      stateOperations: [
        {
          kind: "upsert_position",
          position: updatedPosition
        }
      ]
    };
  }
}
