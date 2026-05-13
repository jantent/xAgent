import { createRequire } from "node:module";

import type { LbPosition, StrategyParameters } from "@meteora-ag/dlmm";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  VersionedTransaction
} from "@solana/web3.js";
import BN from "bn.js";

import type { AgentConfig, ExecutionJupiterConfig, LiveExecutionConfig } from "../../config/types.js";
import type { IExecutionBackend } from "../../domain/contracts.js";
import type {
  ActionExecutionResult,
  ActionType,
  ExecutionBackendStatus,
  ExecutionContext,
  PlannedAction,
  PositionRecord
} from "../../domain/models.js";
import type { RPCManager } from "../../managers/rpc-manager.js";
import { createId } from "../../utils/async.js";
import type { Logger } from "../../utils/logger.js";
import { estimateUsdFromSol, getConfiguredSolPriceUsd } from "../../utils/valuation.js";
import type { LoadedWalletSecret } from "../../wallet/wallet-secret-manager.js";
import type { ExecutionJournal } from "../execution-journal.js";
import type { JitoBlockEngineClient } from "../clients/jito-block-engine-client.js";
import type { JupiterMetisClient } from "../clients/jupiter-metis-client.js";
import { getTransactionSignatureBase58, isNativeMintAddress, loadKeypairFromSecret } from "../solana/signer-utils.js";

type DlmmModule = typeof import("@meteora-ag/dlmm") & {
  create: typeof import("@meteora-ag/dlmm").default.create;
};

const require = createRequire(import.meta.url);
const DlmmSdk = require("@meteora-ag/dlmm") as DlmmModule;

type DlmmPool = Awaited<ReturnType<DlmmModule["create"]>>;
type TransactionLike = Transaction | VersionedTransaction;

interface TokenContext {
  mint: string;
  tokenProgram: PublicKey;
}

interface PoolContext {
  dlmmPool: DlmmPool;
  tokenX: TokenContext;
  tokenY: TokenContext;
}

interface OpenInvestmentPlan {
  investableLamports: bigint;
  directXLamports: bigint;
  directYLamports: bigint;
  swapToXLamports: bigint;
  swapToYLamports: bigint;
}

const LIVE_SDK_SUPPORTED_ACTIONS: ActionType[] = ["open", "close", "rebalance", "claim", "emergency_exit"];
const FULL_LIQUIDITY_BPS = new BN(10_000);
const OPEN_FEE_BUFFER_LAMPORTS = 10_000_000n;
const MIN_SWEEP_AMOUNT = 10_000n;

function amountToLamports(amountSol: number): bigint {
  return BigInt(Math.max(0, Math.round(amountSol * LAMPORTS_PER_SOL)));
}

function lamportsToSol(amountLamports: bigint): number {
  return Number(amountLamports) / LAMPORTS_PER_SOL;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LiveSdkExecutionBackend implements IExecutionBackend {
  private readonly signer: Keypair | null;
  private status: ExecutionBackendStatus;

  constructor(
    private readonly config: AgentConfig,
    private readonly rpcManager: RPCManager,
    private readonly walletSecret: LoadedWalletSecret | null,
    private readonly jupiterClient: JupiterMetisClient,
    private readonly jitoClient: JitoBlockEngineClient,
    private readonly logger: Logger,
    private readonly executionJournal?: ExecutionJournal
  ) {
    const liveConfig = this.requireLiveConfig();
    this.signer = this.tryLoadSigner();
    if (!getConfiguredSolPriceUsd(this.config)) {
      this.logger.warn("未配置 SOL/USD 估值，currentValueUsd 将回退为 0", {
        solPriceEnv: this.config.valuation?.sol_price_usd_env
      });
    }
    const hasRpcUrl =
      Boolean(process.env[this.config.rpc.primary.url_env]) || Boolean(process.env[this.config.rpc.backup.url_env]);

    const initialError = !hasRpcUrl
      ? "live_sdk 缺少可写 RPC URL"
      : !this.signer
        ? "live_sdk 未加载可用的钱包密钥"
        : undefined;

    this.status = {
      mode: "live_sdk",
      backend: "meteora_sdk_jupiter_jito",
      dryRun: false,
      healthy: !initialError,
      supportedActions: liveConfig.supported_actions,
      submissionStrategy: liveConfig.submission_strategy,
      target: this.rpcManager.getActiveEndpoint().name,
      ...(initialError
        ? {
            lastError: initialError,
            lastErrorAt: new Date()
          }
        : {})
    };
  }

  getStatus(): ExecutionBackendStatus {
    return this.status;
  }

  async execute(action: PlannedAction, context: ExecutionContext): Promise<ActionExecutionResult> {
    const startedAt = Date.now();

    try {
      const liveConfig = this.requireLiveConfig();
      if (!liveConfig.supported_actions.includes(action.type)) {
        return {
          actionId: action.id,
          type: action.type,
          status: "skipped",
          message: `live_sdk 未启用 ${action.type} 动作，已跳过。`,
          txSignatures: [],
          latencyMs: Date.now() - startedAt,
          metadata: {
            backend: "live_sdk",
            submissionStrategy: liveConfig.submission_strategy
          }
        };
      }

      switch (action.type) {
        case "open":
          return await this.executeOpen(action, context, startedAt);
        case "close":
        case "emergency_exit":
          return await this.executeClose(action, context, startedAt);
        case "claim":
          return await this.executeClaim(action, context, startedAt);
        case "rebalance":
          return await this.executeRebalance(action, context, startedAt);
        default:
          return {
            actionId: action.id,
            type: action.type,
            status: "skipped",
            message: "当前 action 类型未实现，已跳过。",
            txSignatures: [],
            latencyMs: Date.now() - startedAt,
            metadata: {
              backend: "live_sdk"
            }
          };
      }
    } catch (error) {
      this.markFailure(extractErrorMessage(error));
      throw error;
    }
  }

  private async executeOpen(
    action: PlannedAction,
    context: ExecutionContext,
    startedAt: number
  ): Promise<ActionExecutionResult> {
    if (!action.pool || !action.skill || !action.amountSol || !action.newRange) {
      throw new Error("open action 缺少必要字段");
    }

    if (context.availableCapitalSol < action.amountSol) {
      throw new Error("可用资金不足，无法执行开仓");
    }

    const signer = this.requireSigner();
    const connection = this.createConnection();
    const nativeBefore = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));

    const poolContext = await this.loadPoolContext(connection, action.pool.address);
    const baseline = await this.snapshotTokenBalances(connection, signer.publicKey, [poolContext.tokenX, poolContext.tokenY]);

    let txSignatures: string[] = [];
    let createdPositionKeypair: Keypair | null = null;

    try {
      const plan = this.planOpenInvestment(poolContext, action.amountSol);
      txSignatures.push(...(await this.swapForOpenIfNeeded(action.id, connection, signer, poolContext, plan)));

      const currentDeltas = await this.getPositiveTokenDeltas(connection, signer.publicKey, baseline, [
        poolContext.tokenX,
        poolContext.tokenY
      ]);

      const totalXAmount = isNativeMintAddress(poolContext.tokenX.mint)
        ? plan.directXLamports
        : currentDeltas.get(poolContext.tokenX.mint) ?? 0n;
      const totalYAmount = isNativeMintAddress(poolContext.tokenY.mint)
        ? plan.directYLamports
        : currentDeltas.get(poolContext.tokenY.mint) ?? 0n;

      if (totalXAmount <= 0n && totalYAmount <= 0n) {
        throw new Error("开仓前未准备好可用的 token 余额");
      }

      createdPositionKeypair = Keypair.generate();
      await this.recordPendingMetadata(action.id, {
        positionPubkey: createdPositionKeypair.publicKey.toBase58()
      });
      const strategy = this.buildStrategy(
        action.skill.params.distributionType,
        action.newRange,
        totalXAmount,
        totalYAmount
      );
      const meteoraTx = await poolContext.dlmmPool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: createdPositionKeypair.publicKey,
        totalXAmount: new BN(totalXAmount.toString()),
        totalYAmount: new BN(totalYAmount.toString()),
        strategy,
        user: signer.publicKey,
        slippage: Math.max(1, Math.ceil((this.requireJupiterConfig().slippage_bps ?? 100) / 100))
      });

      txSignatures.push(
        await this.sendLegacyTransaction(action.id, connection, signer, meteoraTx, {
          additionalSigners: [createdPositionKeypair]
        })
      );

      txSignatures.push(
        ...(await this.sweepPositiveTokenDeltasToSol(action.id, connection, signer, baseline, [poolContext.tokenX, poolContext.tokenY]))
      );

      const livePosition = await poolContext.dlmmPool.getPosition(createdPositionKeypair.publicKey);
      const range = this.extractLiveRange(livePosition);
      const nativeAfter = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
      const capitalDeltaSol = lamportsToSol(nativeAfter - nativeBefore);

      const position: PositionRecord = {
        id: createId("position"),
        positionPubkey: createdPositionKeypair.publicKey.toBase58(),
        poolAddress: action.pool.address,
        tokenMint: action.pool.tokenMint,
        tokenSymbol: action.pool.tokenSymbol,
        walletAddress: signer.publicKey.toBase58(),
        skillId: action.skill.id,
        skillVersion: action.skill.version,
        direction: action.skill.params.direction,
        fromBinId: range.minBinId,
        toBinId: range.maxBinId,
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
        ...(action.pool.narrative ? { narrative: action.pool.narrative } : {})
      };

      this.markSuccess();
      return {
        actionId: action.id,
        type: action.type,
        status: "success",
        message: `真实开仓成功，Meteora 仓位 ${createdPositionKeypair.publicKey.toBase58()} 已建立。`,
        txSignatures,
        latencyMs: Date.now() - startedAt,
        metadata: {
          backend: "live_sdk",
          positionId: position.id,
          positionPubkey: position.positionPubkey,
          rpcProvider: this.rpcManager.getActiveEndpoint().name,
          submissionStrategy: this.requireLiveConfig().submission_strategy
        },
        stateOperations: [
          {
            kind: "adjust_capital",
            deltaSol: capitalDeltaSol
          },
          {
            kind: "upsert_position",
            position
          }
        ]
      };
    } catch (error) {
      txSignatures.push(
        ...(await this.sweepPositiveTokenDeltasToSol(action.id, connection, signer, baseline, [poolContext.tokenX, poolContext.tokenY]))
      );
      const nativeAfter = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
      const capitalDeltaSol = lamportsToSol(nativeAfter - nativeBefore);
      this.markFailure(extractErrorMessage(error));

      return {
        actionId: action.id,
        type: action.type,
        status: "failed",
        message: extractErrorMessage(error),
        txSignatures: unique(txSignatures),
        latencyMs: Date.now() - startedAt,
        metadata: {
          backend: "live_sdk",
          rpcProvider: this.rpcManager.getActiveEndpoint().name,
          positionPubkey: createdPositionKeypair?.publicKey.toBase58()
        },
        ...(capitalDeltaSol === 0
          ? {}
          : {
              stateOperations: [
                {
                  kind: "adjust_capital",
                  deltaSol: capitalDeltaSol
                }
              ]
            })
      };
    }
  }

  private async executeClose(
    action: PlannedAction,
    context: ExecutionContext,
    startedAt: number
  ): Promise<ActionExecutionResult> {
    if (!action.positionId) {
      throw new Error("close action 缺少 positionId");
    }

    if (!context.position) {
      return {
        actionId: action.id,
        type: action.type,
        status: "skipped",
        message: `仓位 ${action.positionId} 不存在，已跳过。`,
        txSignatures: [],
        latencyMs: Date.now() - startedAt,
        metadata: {
          backend: "live_sdk"
        }
      };
    }

    const signer = this.requireSigner();
    const connection = this.createConnection();
    const nativeBefore = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
    const poolContext = await this.loadPoolContext(connection, context.position.poolAddress);
    const baseline = await this.snapshotTokenBalances(connection, signer.publicKey, [poolContext.tokenX, poolContext.tokenY]);

    try {
      const livePosition = await poolContext.dlmmPool.getPosition(new PublicKey(context.position.positionPubkey));
      const range = this.extractLiveRange(livePosition);
      const closeTransactions = await poolContext.dlmmPool.removeLiquidity({
        user: signer.publicKey,
        position: livePosition.publicKey,
        fromBinId: range.minBinId,
        toBinId: range.maxBinId,
        bps: FULL_LIQUIDITY_BPS,
        shouldClaimAndClose: true
      });

      const txSignatures = await this.sendLegacyTransactions(action.id, connection, signer, closeTransactions);
      txSignatures.push(
        ...(await this.sweepPositiveTokenDeltasToSol(action.id, connection, signer, baseline, [poolContext.tokenX, poolContext.tokenY]))
      );

      const nativeAfter = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
      const recoveredSol = lamportsToSol(nativeAfter - nativeBefore);
      const pnlPercent =
        context.position.depositedSol > 0
          ? ((recoveredSol - context.position.depositedSol) / context.position.depositedSol) * 100
          : context.position.pnlPercent;
      const closedPosition: PositionRecord = {
        ...context.position,
        status: "closed",
        closedAt: new Date(),
        isInRange: false,
        pnlPercent,
        currentValueUsd: estimateUsdFromSol(this.config, recoveredSol)
      };

      this.markSuccess();
      return {
        actionId: action.id,
        type: action.type,
        status: "success",
        message: `真实平仓成功，回收 ${recoveredSol.toFixed(4)} SOL。`,
        txSignatures: unique(txSignatures),
        latencyMs: Date.now() - startedAt,
        metadata: {
          backend: "live_sdk",
          positionId: context.position.id,
          rpcProvider: this.rpcManager.getActiveEndpoint().name,
          submissionStrategy: this.requireLiveConfig().submission_strategy
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
    } catch (error) {
      const txSignatures = await this.sweepPositiveTokenDeltasToSol(action.id, connection, signer, baseline, [
        poolContext.tokenX,
        poolContext.tokenY
      ]);
      const nativeAfter = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
      const capitalDeltaSol = lamportsToSol(nativeAfter - nativeBefore);
      const positionStillExists = await this.positionAccountExists(connection, context.position.positionPubkey);
      this.markFailure(extractErrorMessage(error));

      return {
        actionId: action.id,
        type: action.type,
        status: "failed",
        message: extractErrorMessage(error),
        txSignatures,
        latencyMs: Date.now() - startedAt,
        metadata: {
          backend: "live_sdk",
          rpcProvider: this.rpcManager.getActiveEndpoint().name,
          positionStillExists
        },
        ...(capitalDeltaSol !== 0 || !positionStillExists
          ? {
              stateOperations: [
                ...(capitalDeltaSol === 0
                  ? []
                  : [
                      {
                        kind: "adjust_capital" as const,
                        deltaSol: capitalDeltaSol
                      }
                    ]),
                ...(!positionStillExists
                  ? [
                      {
                        kind: "upsert_position" as const,
                        position: {
                          ...context.position,
                          status: "closed" as const,
                          closedAt: new Date(),
                          isInRange: false
                        }
                      }
                    ]
                  : [])
              ]
            }
          : {})
      };
    }
  }

  private async executeClaim(
    action: PlannedAction,
    context: ExecutionContext,
    startedAt: number
  ): Promise<ActionExecutionResult> {
    if (!action.positionId) {
      throw new Error("claim action 缺少 positionId");
    }

    if (!context.position) {
      return {
        actionId: action.id,
        type: action.type,
        status: "skipped",
        message: `仓位 ${action.positionId} 不存在，已跳过。`,
        txSignatures: [],
        latencyMs: Date.now() - startedAt,
        metadata: {
          backend: "live_sdk"
        }
      };
    }

    const signer = this.requireSigner();
    const connection = this.createConnection();
    const nativeBefore = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
    const poolContext = await this.loadPoolContext(connection, context.position.poolAddress);
    const baseline = await this.snapshotTokenBalances(connection, signer.publicKey, [poolContext.tokenX, poolContext.tokenY]);

    try {
      const livePosition = await poolContext.dlmmPool.getPosition(new PublicKey(context.position.positionPubkey));
      const claimTransactions = [
        ...(await poolContext.dlmmPool.claimSwapFee({
          owner: signer.publicKey,
          position: livePosition
        })),
        ...(await poolContext.dlmmPool.claimAllRewardsByPosition({
          owner: signer.publicKey,
          position: livePosition
        }))
      ];

      if (claimTransactions.length === 0) {
        const checkedPosition: PositionRecord = {
          ...context.position,
          lastFeeCheckAt: new Date()
        };
        return {
          actionId: action.id,
          type: action.type,
          status: "skipped",
          message: `仓位 ${action.positionId} 当前没有可领取的手续费或奖励。`,
          txSignatures: [],
          latencyMs: Date.now() - startedAt,
          metadata: {
            backend: "live_sdk"
          },
          stateOperations: [
            {
              kind: "upsert_position",
              position: checkedPosition
            }
          ]
        };
      }

      const txSignatures = await this.sendLegacyTransactions(action.id, connection, signer, claimTransactions);
      txSignatures.push(
        ...(await this.sweepPositiveTokenDeltasToSol(action.id, connection, signer, baseline, [poolContext.tokenX, poolContext.tokenY]))
      );

      const nativeAfter = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
      const claimedSol = lamportsToSol(maxBigInt(nativeAfter - nativeBefore, 0n));
      const claimTimestamp = new Date();
      const updatedPosition: PositionRecord = {
        ...context.position,
        totalFeesClaimedSol: context.position.totalFeesClaimedSol + claimedSol,
        lastClaimedAt: claimTimestamp,
        lastFeeCheckAt: claimTimestamp
      };

      this.markSuccess();
      return {
        actionId: action.id,
        type: action.type,
        status: "success",
        message: `真实提取成功，新增 ${claimedSol.toFixed(4)} SOL。`,
        txSignatures: unique(txSignatures),
        latencyMs: Date.now() - startedAt,
        metadata: {
          backend: "live_sdk",
          positionId: context.position.id,
          rpcProvider: this.rpcManager.getActiveEndpoint().name
        },
        stateOperations: [
          {
            kind: "adjust_capital",
            deltaSol: claimedSol
          },
          {
            kind: "upsert_position",
            position: updatedPosition
          }
        ]
      };
    } catch (error) {
      const txSignatures = await this.sweepPositiveTokenDeltasToSol(action.id, connection, signer, baseline, [
        poolContext.tokenX,
        poolContext.tokenY
      ]);
      const nativeAfter = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
      const capitalDeltaSol = lamportsToSol(nativeAfter - nativeBefore);
      this.markFailure(extractErrorMessage(error));

      return {
        actionId: action.id,
        type: action.type,
        status: "failed",
        message: extractErrorMessage(error),
        txSignatures,
        latencyMs: Date.now() - startedAt,
        metadata: {
          backend: "live_sdk",
          rpcProvider: this.rpcManager.getActiveEndpoint().name
        },
        ...(capitalDeltaSol === 0
          ? {}
          : {
              stateOperations: [
                {
                  kind: "adjust_capital",
                  deltaSol: capitalDeltaSol
                }
              ]
            })
      };
    }
  }

  private async executeRebalance(
    action: PlannedAction,
    context: ExecutionContext,
    startedAt: number
  ): Promise<ActionExecutionResult> {
    if (!action.positionId || !action.newRange) {
      throw new Error("rebalance action 缺少必要字段");
    }

    if (!context.position) {
      throw new Error(`待重平衡仓位不存在: ${action.positionId}`);
    }

    const signer = this.requireSigner();
    const connection = this.createConnection();
    const nativeBefore = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
    const poolContext = await this.loadPoolContext(connection, context.position.poolAddress);
    const baseline = await this.snapshotTokenBalances(connection, signer.publicKey, [poolContext.tokenX, poolContext.tokenY]);

    let txSignatures: string[] = [];
    let replacementPositionPubkey: string | undefined;

    try {
      const livePosition = await poolContext.dlmmPool.getPosition(new PublicKey(context.position.positionPubkey));
      const currentRange = this.extractLiveRange(livePosition);
      txSignatures.push(
        ...(
          await this.sendLegacyTransactions(
            action.id,
            connection,
            signer,
            await poolContext.dlmmPool.removeLiquidity({
              user: signer.publicKey,
              position: livePosition.publicKey,
              fromBinId: currentRange.minBinId,
              toBinId: currentRange.maxBinId,
              bps: FULL_LIQUIDITY_BPS,
              shouldClaimAndClose: true
            })
          )
        )
      );

      txSignatures.push(
        ...(await this.sweepPositiveTokenDeltasToSol(action.id, connection, signer, baseline, [poolContext.tokenX, poolContext.tokenY]))
      );

      const nativeMid = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
      const reopenAmountSol = lamportsToSol(maxBigInt(nativeMid - nativeBefore, 0n));
      if (reopenAmountSol <= 0.02) {
        throw new Error("rebalance 平仓后可用资金不足，无法重建仓位");
      }

      const reopenBaseline = await this.snapshotTokenBalances(connection, signer.publicKey, [
        poolContext.tokenX,
        poolContext.tokenY
      ]);
      const plan = this.planOpenInvestment(poolContext, reopenAmountSol);
      txSignatures.push(...(await this.swapForOpenIfNeeded(action.id, connection, signer, poolContext, plan)));

      const reopenDeltas = await this.getPositiveTokenDeltas(connection, signer.publicKey, reopenBaseline, [
        poolContext.tokenX,
        poolContext.tokenY
      ]);
      const totalXAmount = isNativeMintAddress(poolContext.tokenX.mint)
        ? plan.directXLamports
        : reopenDeltas.get(poolContext.tokenX.mint) ?? 0n;
      const totalYAmount = isNativeMintAddress(poolContext.tokenY.mint)
        ? plan.directYLamports
        : reopenDeltas.get(poolContext.tokenY.mint) ?? 0n;

      const replacementKeypair = Keypair.generate();
      replacementPositionPubkey = replacementKeypair.publicKey.toBase58();
      await this.recordPendingMetadata(action.id, {
        replacementPositionPubkey
      });
      const strategy = this.buildStrategy(
        action.skill?.params.distributionType ?? "Spot",
        action.newRange,
        totalXAmount,
        totalYAmount
      );

      const meteoraTx = await poolContext.dlmmPool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: replacementKeypair.publicKey,
        totalXAmount: new BN(totalXAmount.toString()),
        totalYAmount: new BN(totalYAmount.toString()),
        strategy,
        user: signer.publicKey,
        slippage: Math.max(1, Math.ceil((this.requireJupiterConfig().slippage_bps ?? 100) / 100))
      });
      txSignatures.push(
        await this.sendLegacyTransaction(action.id, connection, signer, meteoraTx, {
          additionalSigners: [replacementKeypair]
        })
      );
      txSignatures.push(
        ...(await this.sweepPositiveTokenDeltasToSol(action.id, connection, signer, reopenBaseline, [poolContext.tokenX, poolContext.tokenY]))
      );

      const liveReplacement = await poolContext.dlmmPool.getPosition(replacementKeypair.publicKey);
      const replacementRange = this.extractLiveRange(liveReplacement);
      const nativeAfter = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
      const capitalDeltaSol = lamportsToSol(nativeAfter - nativeBefore);
      const updatedPosition: PositionRecord = {
        ...context.position,
        positionPubkey: replacementKeypair.publicKey.toBase58(),
        fromBinId: replacementRange.minBinId,
        toBinId: replacementRange.maxBinId,
        rebalanceCount: context.position.rebalanceCount + 1,
        isInRange: true,
        outOfRangeSince: undefined,
        depositedSol: reopenAmountSol,
        currentValueUsd: estimateUsdFromSol(this.config, reopenAmountSol)
      };

      this.markSuccess();
      return {
        actionId: action.id,
        type: action.type,
        status: "success",
        message: `真实重平衡成功，新仓位 ${replacementKeypair.publicKey.toBase58()} 已接管。`,
        txSignatures: unique(txSignatures),
        latencyMs: Date.now() - startedAt,
        metadata: {
          backend: "live_sdk",
          positionId: context.position.id,
          replacementPositionPubkey: replacementKeypair.publicKey.toBase58(),
          rpcProvider: this.rpcManager.getActiveEndpoint().name
        },
        stateOperations: [
          {
            kind: "adjust_capital",
            deltaSol: capitalDeltaSol
          },
          {
            kind: "upsert_position",
            position: updatedPosition
          }
        ]
      };
    } catch (error) {
      const nativeAfter = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
      const capitalDeltaSol = lamportsToSol(nativeAfter - nativeBefore);
      const oldPositionExists = await this.positionAccountExists(connection, context.position.positionPubkey);
      const replacementExists = replacementPositionPubkey
        ? await this.positionAccountExists(connection, replacementPositionPubkey)
        : false;
      this.markFailure(extractErrorMessage(error));

      return {
        actionId: action.id,
        type: action.type,
        status: "failed",
        message: extractErrorMessage(error),
        txSignatures: unique(txSignatures),
        latencyMs: Date.now() - startedAt,
        metadata: {
          backend: "live_sdk",
          rpcProvider: this.rpcManager.getActiveEndpoint().name,
          oldPositionExists,
          replacementExists,
          replacementPositionPubkey
        },
        ...(capitalDeltaSol !== 0 || !oldPositionExists
          ? {
              stateOperations: [
                ...(capitalDeltaSol === 0
                  ? []
                  : [
                      {
                        kind: "adjust_capital" as const,
                        deltaSol: capitalDeltaSol
                      }
                    ]),
                ...(!oldPositionExists
                  ? [
                      {
                        kind: "upsert_position" as const,
                        position: {
                          ...context.position,
                          status: "closed" as const,
                          closedAt: new Date(),
                          isInRange: false
                        }
                      }
                    ]
                  : [])
              ]
            }
          : {})
      };
    }
  }

  private buildStrategy(
    distributionType: "Spot" | "Curve" | "BidAsk",
    range: { minBinId: number; maxBinId: number },
    totalXAmount: bigint,
    totalYAmount: bigint
  ): StrategyParameters {
    const strategyType =
      distributionType === "Curve"
        ? DlmmSdk.StrategyType.Curve
        : distributionType === "BidAsk"
          ? DlmmSdk.StrategyType.BidAsk
          : DlmmSdk.StrategyType.Spot;

    return {
      minBinId: range.minBinId,
      maxBinId: range.maxBinId,
      strategyType,
      ...(totalXAmount === 0n && totalYAmount > 0n
        ? { singleSidedX: false }
        : totalYAmount === 0n && totalXAmount > 0n
          ? { singleSidedX: true }
          : {})
    };
  }

  private planOpenInvestment(poolContext: PoolContext, amountSol: number): OpenInvestmentPlan {
    const totalLamports = amountToLamports(amountSol);
    const reserveLamports = totalLamports > OPEN_FEE_BUFFER_LAMPORTS * 2n ? OPEN_FEE_BUFFER_LAMPORTS : totalLamports / 10n;
    const investableLamports = maxBigInt(totalLamports - reserveLamports, 0n);
    if (investableLamports <= OPEN_FEE_BUFFER_LAMPORTS / 2n) {
      throw new Error("开仓金额过小，扣除手续费缓冲后不足以执行");
    }

    const half = investableLamports / 2n;
    if (isNativeMintAddress(poolContext.tokenX.mint)) {
      return {
        investableLamports,
        directXLamports: investableLamports - half,
        directYLamports: 0n,
        swapToXLamports: 0n,
        swapToYLamports: half
      };
    }

    if (isNativeMintAddress(poolContext.tokenY.mint)) {
      return {
        investableLamports,
        directXLamports: 0n,
        directYLamports: investableLamports - half,
        swapToXLamports: half,
        swapToYLamports: 0n
      };
    }

    return {
      investableLamports,
      directXLamports: 0n,
      directYLamports: 0n,
      swapToXLamports: half,
      swapToYLamports: investableLamports - half
    };
  }

  private async swapForOpenIfNeeded(
    actionId: string,
    connection: Connection,
    signer: Keypair,
    poolContext: PoolContext,
    plan: OpenInvestmentPlan
  ): Promise<string[]> {
    const signatures: string[] = [];

    if (plan.swapToXLamports > MIN_SWEEP_AMOUNT) {
      signatures.push(
        await this.executeSwap(actionId, connection, signer, poolContext.tokenX.mint, plan.swapToXLamports, this.requireJupiterConfig())
      );
    }

    if (plan.swapToYLamports > MIN_SWEEP_AMOUNT) {
      signatures.push(
        await this.executeSwap(actionId, connection, signer, poolContext.tokenY.mint, plan.swapToYLamports, this.requireJupiterConfig())
      );
    }

    return signatures;
  }

  private async executeSwap(
    actionId: string,
    connection: Connection,
    signer: Keypair,
    outputMint: string,
    inputAmountLamports: bigint,
    jupiterConfig: ExecutionJupiterConfig,
    inputMint = "So11111111111111111111111111111111111111112"
  ): Promise<string> {
    const quote = await this.jupiterClient.quoteExactIn(jupiterConfig, {
      inputMint,
      outputMint,
      amount: inputAmountLamports
    });
    const swap = await this.jupiterClient.buildSwapTransaction(jupiterConfig, {
      quoteResponse: quote,
      userPublicKey: signer.publicKey.toBase58()
    });
    const transaction = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
    transaction.sign([signer]);

    return this.sendVersionedTransaction(actionId, connection, transaction, {
      lastValidBlockHeight: swap.lastValidBlockHeight
    });
  }

  private async sweepPositiveTokenDeltasToSol(
    actionId: string,
    connection: Connection,
    signer: Keypair,
    baseline: Map<string, bigint>,
    tokens: TokenContext[]
  ): Promise<string[]> {
    const deltas = await this.getPositiveTokenDeltas(connection, signer.publicKey, baseline, tokens);
    const signatures: string[] = [];

    for (const token of tokens) {
      if (isNativeMintAddress(token.mint)) {
        continue;
      }

      const delta = deltas.get(token.mint) ?? 0n;
      if (delta <= MIN_SWEEP_AMOUNT) {
        continue;
      }

      try {
        signatures.push(
          await this.executeSwap(actionId, connection, signer, "So11111111111111111111111111111111111111112", delta, this.requireJupiterConfig(), token.mint)
        );
      } catch (error) {
        this.logger.warn("剩余 token 回收为 SOL 失败，忽略 dust", {
          mint: token.mint,
          amount: delta.toString(),
          error: extractErrorMessage(error)
        });
      }
    }

    return unique(signatures);
  }

  private async loadPoolContext(connection: Connection, poolAddress: string): Promise<PoolContext> {
    const dlmmPool = await DlmmSdk.create(connection, new PublicKey(poolAddress));
    return {
      dlmmPool,
      tokenX: {
        mint: dlmmPool.tokenX.publicKey.toBase58(),
        tokenProgram: dlmmPool.tokenX.owner
      },
      tokenY: {
        mint: dlmmPool.tokenY.publicKey.toBase58(),
        tokenProgram: dlmmPool.tokenY.owner
      }
    };
  }

  private extractLiveRange(position: LbPosition): { minBinId: number; maxBinId: number } {
    const rangeWithLiquidity = DlmmSdk.getPositionLowerUpperBinIdWithLiquidity(position.positionData);
    if (rangeWithLiquidity) {
      return {
        minBinId: rangeWithLiquidity.lowerBinId.toNumber(),
        maxBinId: rangeWithLiquidity.upperBinId.toNumber()
      };
    }

    return {
      minBinId: position.positionData.lowerBinId,
      maxBinId: position.positionData.upperBinId
    };
  }

  private async snapshotTokenBalances(
    connection: Connection,
    owner: PublicKey,
    tokens: TokenContext[]
  ): Promise<Map<string, bigint>> {
    const snapshot = new Map<string, bigint>();
    for (const token of tokens) {
      if (isNativeMintAddress(token.mint)) {
        continue;
      }

      snapshot.set(token.mint, await this.getTokenBalance(connection, owner, token));
    }

    return snapshot;
  }

  private async getPositiveTokenDeltas(
    connection: Connection,
    owner: PublicKey,
    baseline: Map<string, bigint>,
    tokens: TokenContext[]
  ): Promise<Map<string, bigint>> {
    const deltas = new Map<string, bigint>();
    for (const token of tokens) {
      if (isNativeMintAddress(token.mint)) {
        continue;
      }

      const before = baseline.get(token.mint) ?? 0n;
      const after = await this.getTokenBalance(connection, owner, token);
      if (after > before) {
        deltas.set(token.mint, after - before);
      }
    }

    return deltas;
  }

  private async getTokenBalance(connection: Connection, owner: PublicKey, token: TokenContext): Promise<bigint> {
    const mint = new PublicKey(token.mint);
    const ata = getAssociatedTokenAddressSync(mint, owner, false, token.tokenProgram);
    const accountInfo = await connection.getAccountInfo(ata, "confirmed");
    if (!accountInfo) {
      return 0n;
    }

    const balance = await connection.getTokenAccountBalance(ata, "confirmed");
    return BigInt(balance.value.amount);
  }

  private async sendLegacyTransactions(
    actionId: string,
    connection: Connection,
    signer: Keypair,
    transactions: Transaction[]
  ): Promise<string[]> {
    const signatures: string[] = [];
    for (const transaction of transactions) {
      signatures.push(await this.sendLegacyTransaction(actionId, connection, signer, transaction));
    }
    return signatures;
  }

  private async sendLegacyTransaction(
    actionId: string,
    connection: Connection,
    signer: Keypair,
    transaction: Transaction,
    options: {
      additionalSigners?: Keypair[];
    } = {}
  ): Promise<string> {
    const latestBlockhash = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = latestBlockhash.blockhash;
    transaction.feePayer = signer.publicKey;

    if (options.additionalSigners?.length) {
      transaction.partialSign(...options.additionalSigners);
    }
    transaction.sign(signer);

    const signature = await this.sendSerializedTransaction(
      connection,
      transaction,
      latestBlockhash.lastValidBlockHeight
    );
    await connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
      },
      "confirmed"
    );
    await this.recordPendingTxSignatures(actionId, [signature]);
    return signature;
  }

  private async sendVersionedTransaction(
    actionId: string,
    connection: Connection,
    transaction: VersionedTransaction,
    options: {
      lastValidBlockHeight?: number;
    } = {}
  ): Promise<string> {
    const signature = await this.sendSerializedTransaction(connection, transaction, options.lastValidBlockHeight);
    await connection.confirmTransaction(signature, "confirmed");
    await this.recordPendingTxSignatures(actionId, [signature]);
    return signature;
  }

  private async sendSerializedTransaction(
    connection: Connection,
    transaction: TransactionLike,
    lastValidBlockHeight?: number
  ): Promise<string> {
    const liveConfig = this.requireLiveConfig();
    const serialized = Buffer.from(transaction.serialize()).toString("base64");
    const rpcProvider = this.rpcManager.getActiveEndpoint().name;
    const fallbackRpcSend = async () =>
      connection.sendRawTransaction(Buffer.from(serialized, "base64"), {
        skipPreflight: false,
        maxRetries: this.config.rpc.jito.max_retries
      });

    if (liveConfig.submission_strategy === "rpc") {
      return fallbackRpcSend();
    }

    const jitoApiKey = this.config.rpc.jito.auth_key_env
      ? process.env[this.config.rpc.jito.auth_key_env]
      : undefined;
    try {
      const { signature } = await this.jitoClient.sendTransaction(serialized, {
        endpoint: this.config.rpc.jito.endpoint,
        apiKey: jitoApiKey
      });
      this.logger.info("交易已通过 Jito 发送", {
        signature,
        rpcProvider,
        lastValidBlockHeight
      });
      return signature;
    } catch (error) {
      if (liveConfig.submission_strategy === "jito") {
        throw error;
      }

      this.logger.warn("Jito 发送失败，回退到 RPC", {
        error: extractErrorMessage(error),
        rpcProvider
      });
      return fallbackRpcSend();
    }
  }

  private async positionAccountExists(connection: Connection, positionPubkey: string): Promise<boolean> {
    try {
      const account = await connection.getAccountInfo(new PublicKey(positionPubkey), "confirmed");
      return Boolean(account);
    } catch {
      return false;
    }
  }

  private createConnection(): Connection {
    const endpoint = this.rpcManager.getActiveEndpoint();
    if (!endpoint.url || endpoint.url.startsWith("simulated://")) {
      throw new Error("live_sdk 缺少真实 RPC 连接");
    }

    this.status = {
      ...this.status,
      target: `${endpoint.name}:${endpoint.url}`
    };
    return new Connection(endpoint.url, "confirmed");
  }

  private requireSigner(): Keypair {
    if (!this.signer) {
      throw new Error("live_sdk 未加载可用的钱包密钥");
    }

    return this.signer;
  }

  private tryLoadSigner(): Keypair | null {
    if (!this.walletSecret?.secret) {
      return null;
    }

    try {
      return loadKeypairFromSecret(this.walletSecret.secret);
    } catch (error) {
      this.logger.warn("wallet secret 无法解析为 Solana Keypair", {
        source: this.walletSecret.source,
        error: extractErrorMessage(error)
      });
      return null;
    }
  }

  private requireLiveConfig(): LiveExecutionConfig {
    if (!this.config.execution?.live) {
      throw new Error("execution.mode=live_sdk 但 execution.live 未配置");
    }

    return this.config.execution.live;
  }

  private requireJupiterConfig(): ExecutionJupiterConfig {
    const config = this.requireLiveConfig().jupiter;
    if (!config) {
      throw new Error("live_sdk 缺少 execution.live.jupiter 配置");
    }

    return config;
  }

  private markSuccess(): void {
    this.status = {
      ...this.status,
      healthy: true,
      lastSuccessAt: new Date(),
      lastError: undefined,
      lastErrorAt: undefined
    };
  }

  private markFailure(message: string): void {
    this.status = {
      ...this.status,
      healthy: false,
      lastError: message,
      lastErrorAt: new Date()
    };
  }

  private async recordPendingTxSignatures(actionId: string, txSignatures: string[]): Promise<void> {
    if (!this.executionJournal || txSignatures.length === 0) {
      return;
    }

    await this.executionJournal.recordTxSignatures(actionId, txSignatures);
  }

  private async recordPendingMetadata(actionId: string, metadata: Record<string, unknown>): Promise<void> {
    if (!this.executionJournal || Object.keys(metadata).length === 0) {
      return;
    }

    await this.executionJournal.recordMetadata(actionId, metadata);
  }
}
