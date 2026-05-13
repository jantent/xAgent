import type { AuditEventRecord, IAuditReader } from "../audit/contracts.js";
import type { SharedState } from "../core/shared-state.js";
import type { PendingActionRecord } from "../core/shared-state.js";
import type { IAuditLogger } from "../domain/contracts.js";
import type { ExecutionStateOperation, PlannedAction, PositionRecord } from "../domain/models.js";
import type { Logger } from "../utils/logger.js";
import type { LoadedWalletSecret } from "../wallet/wallet-secret-manager.js";
import type { AgentConfig } from "../config/types.js";
import {
  deriveSignerAddress,
  resolveRuntimeGuardrails,
  validateActivePositionLocalInvariants
} from "./runtime-guardrails.js";
import { applyStateOperations } from "../execution/state-operations.js";
import { estimateUsdFromSol } from "../utils/valuation.js";

export interface StartupTransactionInspection {
  signature: string;
  confirmed: boolean;
  confirmedAt?: Date;
  walletDeltaSol?: number;
}

export interface StartupReconciliationContext {
  walletSecret: LoadedWalletSecret | null;
  state: SharedState;
  auditLogger: IAuditLogger;
  auditReader?: IAuditReader;
  logger: Logger;
  checkPositionAccountExists?: (positionPubkey: string) => Promise<boolean>;
  inspectTransactions?: (signatures: string[]) => Promise<StartupTransactionInspection[]>;
  listMirroredActivePositions?: () => Promise<PositionRecord[]>;
}

interface RecoveryEvidence {
  actionId: string;
  action: PlannedAction;
  txSignatures: string[];
  metadata?: Record<string, unknown>;
  stateOperations?: ExecutionStateOperation[];
  positionSnapshot?: PositionRecord;
  startedAt: Date;
  source: "pending" | "audit";
}

interface PendingRecoveryOutcome {
  recovered: string[];
  abandoned: string[];
  unresolved: string[];
}

function buildCycleId(): string {
  return `startup-reconcile-${Date.now()}`;
}

export async function reconcileStartupState(
  config: AgentConfig,
  context: StartupReconciliationContext
): Promise<void> {
  const guardrails = resolveRuntimeGuardrails(config);
  const mode = config.execution?.mode ?? "dry_run";

  if (mode === "dry_run" || guardrails.active_position_reconcile === "fail") {
    return;
  }

  if (!context.walletSecret) {
    throw new Error("startup reconcile 失败：钱包 secret 未加载");
  }

  let signerAddress: string;
  try {
    signerAddress = deriveSignerAddress(context.walletSecret);
  } catch (error) {
    throw new Error(
      `startup reconcile 失败：钱包 secret 无法解析为有效 signer: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (signerAddress !== config.wallet.active_address) {
    throw new Error(
      `startup reconcile 失败：wallet.active_address=${config.wallet.active_address} 与 signer=${signerAddress} 不一致`
    );
  }

  const cycleId = buildCycleId();

  try {
    if (mode === "live_gateway") {
      await reconcileLiveGatewayState(config, context, cycleId, signerAddress);
      return;
    }

    if (mode !== "live_sdk") {
      context.logger.info("跳过启动对账：当前仅对 live_sdk / live_gateway 启用 active position 自动收敛", {
        mode,
        strategy: guardrails.active_position_reconcile
      });
      return;
    }

    validateActivePositionLocalInvariants(signerAddress, context.state.getActivePositions());

    if (!context.checkPositionAccountExists) {
      throw new Error("startup reconcile 失败：未提供链上仓位账户校验器");
    }

    const recoveredFromAudit = await recoverFromRecentAudit(context);
    const pendingOutcome =
      guardrails.active_position_reconcile === "repair"
        ? await recoverPendingActions(config, context, signerAddress)
        : {
            recovered: [],
            abandoned: [],
            unresolved: []
          };

    if (pendingOutcome.unresolved.length > 0) {
      throw new Error(
        `startup reconcile 失败：仍存在未决中的交易恢复项 ${pendingOutcome.unresolved.join(", ")}`
      );
    }

    const missingPositionIds = await closeMissingOnchainPositions(context);
    if (
      recoveredFromAudit.length === 0 &&
      pendingOutcome.recovered.length === 0 &&
      pendingOutcome.abandoned.length === 0 &&
      missingPositionIds.length === 0
    ) {
      return;
    }

    await context.state.flush();
    await context.auditLogger.recordPhase(cycleId, "startup_reconcile", {
      strategy: guardrails.active_position_reconcile,
      recoveredAuditActions: recoveredFromAudit,
      recoveredPendingActions: pendingOutcome.recovered,
      abandonedPendingActions: pendingOutcome.abandoned,
      reconciledMissingPositionIds: missingPositionIds,
      reconciledAt: new Date().toISOString()
    });
  } catch (error) {
    await context.auditLogger.recordError(cycleId, error, {
      phase: "startup_reconcile",
      strategy: guardrails.active_position_reconcile
    });
    throw error;
  }
}

async function reconcileLiveGatewayState(
  config: AgentConfig,
  context: StartupReconciliationContext,
  cycleId: string,
  signerAddress: string
): Promise<void> {
  const guardrails = resolveRuntimeGuardrails(config);
  if (guardrails.active_position_reconcile !== "repair") {
    context.logger.info("跳过 live_gateway 启动对账：当前策略不执行自动镜像修复", {
      strategy: guardrails.active_position_reconcile
    });
    return;
  }

  if (!context.listMirroredActivePositions) {
    throw new Error("startup reconcile 失败：live_gateway 未提供远端活跃仓位镜像读取器");
  }

  const localPositions = context.state.getActivePositions();
  const mirroredPositions = await context.listMirroredActivePositions();
  validateActivePositionLocalInvariants(signerAddress, localPositions);
  validateActivePositionLocalInvariants(signerAddress, mirroredPositions);

  const repairPlan = buildMirrorRepairPlan(localPositions, mirroredPositions);
  if (repairPlan.closePositionIds.length === 0 && repairPlan.upsertPositions.length === 0) {
    return;
  }

  const repairedAt = new Date();
  for (const positionId of repairPlan.closePositionIds) {
    context.state.closePosition(positionId, repairedAt);
    context.logger.warn("启动对账关闭 gateway 端已不存在的本地活跃仓位", {
      positionId
    });
  }

  for (const position of repairPlan.upsertPositions) {
    context.state.upsertPosition(position);
    context.logger.warn("启动对账以 gateway 镜像修复本地活跃仓位", {
      positionId: position.id,
      positionPubkey: position.positionPubkey
    });
  }

  await context.state.flush();
  await context.auditLogger.recordPhase(cycleId, "startup_reconcile", {
    strategy: "repair",
    reason: "gateway_mirror_repair",
    repairedAt: repairedAt.toISOString(),
    closedPositionIds: repairPlan.closePositionIds,
    upsertPositionIds: repairPlan.upsertPositions.map((position) => position.id)
  });
}

function buildMirrorRepairPlan(
  localPositions: PositionRecord[],
  mirroredPositions: PositionRecord[]
): {
  closePositionIds: string[];
  upsertPositions: PositionRecord[];
} {
  const localById = new Map(localPositions.map((position) => [position.id, position]));
  const localByPubkey = new Map(localPositions.map((position) => [position.positionPubkey, position]));
  const mirroredById = new Map(mirroredPositions.map((position) => [position.id, position]));
  const mirroredByPubkey = new Map(mirroredPositions.map((position) => [position.positionPubkey, position]));
  const closePositionIds = new Set<string>();
  const upsertPositions = new Map<string, PositionRecord>();

  for (const localPosition of localPositions) {
    const mirroredBySameId = mirroredById.get(localPosition.id);
    if (mirroredBySameId) {
      if (mirroredBySameId.positionPubkey !== localPosition.positionPubkey) {
        closePositionIds.add(localPosition.id);
        upsertPositions.set(mirroredBySameId.id, mirroredBySameId);
        continue;
      }

      if (!arePositionsEquivalent(localPosition, mirroredBySameId)) {
        upsertPositions.set(mirroredBySameId.id, mirroredBySameId);
      }
      continue;
    }

    const mirroredBySamePubkey = mirroredByPubkey.get(localPosition.positionPubkey);
    if (mirroredBySamePubkey) {
      closePositionIds.add(localPosition.id);
      upsertPositions.set(mirroredBySamePubkey.id, mirroredBySamePubkey);
      continue;
    }

    closePositionIds.add(localPosition.id);
  }

  for (const mirroredPosition of mirroredPositions) {
    const localBySameId = localById.get(mirroredPosition.id);
    const localBySamePubkey = localByPubkey.get(mirroredPosition.positionPubkey);
    if (!localBySameId || !localBySamePubkey || localBySamePubkey.id !== mirroredPosition.id) {
      upsertPositions.set(mirroredPosition.id, mirroredPosition);
    }
  }

  return {
    closePositionIds: Array.from(closePositionIds),
    upsertPositions: Array.from(upsertPositions.values())
  };
}

function arePositionsEquivalent(left: PositionRecord, right: PositionRecord): boolean {
  return JSON.stringify(serializePosition(left)) === JSON.stringify(serializePosition(right));
}

function serializePosition(position: PositionRecord): Record<string, unknown> {
  return {
    ...position,
    openedAt: position.openedAt.toISOString(),
    maxAliveUntil: position.maxAliveUntil.toISOString(),
    closedAt: position.closedAt?.toISOString(),
    outOfRangeSince: position.outOfRangeSince?.toISOString(),
    lastClaimedAt: position.lastClaimedAt?.toISOString(),
    lastFeeCheckAt: position.lastFeeCheckAt?.toISOString()
  };
}

async function recoverFromRecentAudit(context: StartupReconciliationContext): Promise<string[]> {
  if (!context.auditReader) {
    return [];
  }

  const evidences = await collectAuditRecoveries(context.auditReader);
  const recovered: string[] = [];

  for (const evidence of evidences) {
    if (context.state.hasAppliedAction(evidence.actionId) || !evidence.stateOperations?.length) {
      context.state.clearPendingAction(evidence.actionId);
      continue;
    }

    applyStateOperations(context.state, evidence.stateOperations);
    context.state.markActionApplied(evidence.actionId);
    context.state.clearPendingAction(evidence.actionId);
    recovered.push(evidence.actionId);
    context.logger.warn("启动对账回放最近审计中的已确认状态回写", {
      actionId: evidence.actionId,
      source: evidence.source
    });
  }

  return recovered;
}

async function collectAuditRecoveries(auditReader: IAuditReader): Promise<RecoveryEvidence[]> {
  const records = await auditReader.readRecent(200);
  return records
    .flatMap((record) => parseAuditRecovery(record))
    .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime());
}

function parseAuditRecovery(record: AuditEventRecord): RecoveryEvidence[] {
  if (record.source !== "actions") {
    return [];
  }

  const action = asPlannedAction(record.payload.action);
  const result = asActionResult(record.payload.result);
  if (!action || !result) {
    return [];
  }

  const stateOperations = normalizeStateOperations(result.stateOperations);
  if (!stateOperations?.length) {
    return [];
  }

  return [
    {
      actionId: action.id,
      action,
      txSignatures: Array.isArray(result.txSignatures)
        ? result.txSignatures.filter((value): value is string => typeof value === "string" && value.length > 0)
        : [],
      metadata: isRecord(result.metadata) ? result.metadata : undefined,
      stateOperations,
      startedAt: record.timestamp ? new Date(record.timestamp) : new Date(0),
      source: "audit"
    }
  ];
}

async function recoverPendingActions(
  config: AgentConfig,
  context: StartupReconciliationContext,
  signerAddress: string
): Promise<PendingRecoveryOutcome> {
  const pendingActions = context.state.getPendingActions();
  if (pendingActions.length === 0) {
    return {
      recovered: [],
      abandoned: [],
      unresolved: []
    };
  }

  if (!context.checkPositionAccountExists) {
    throw new Error("startup reconcile 失败：repair 策略缺少链上仓位账户校验器");
  }

  const recovered: string[] = [];
  const abandoned: string[] = [];
  const unresolved: string[] = [];

  for (const pending of pendingActions) {
    if (context.state.hasAppliedAction(pending.action.id)) {
      context.state.clearPendingAction(pending.action.id);
      continue;
    }

    const inspections = await inspectPendingTransactions(context, pending.txSignatures ?? []);
    const confirmedSummary = summarizeConfirmedTransactions(inspections);
    const recoveredOutcome = await attemptPendingRecovery(config, context, signerAddress, pending, confirmedSummary);

    if (recoveredOutcome === "recovered") {
      recovered.push(pending.action.id);
      continue;
    }

    if (recoveredOutcome === "abandoned") {
      abandoned.push(pending.action.id);
      continue;
    }

    unresolved.push(pending.action.id);
  }

  return {
    recovered,
    abandoned,
    unresolved
  };
}

async function inspectPendingTransactions(
  context: StartupReconciliationContext,
  txSignatures: string[]
): Promise<StartupTransactionInspection[]> {
  const uniqueSignatures = Array.from(
    new Set(txSignatures.filter((signature) => typeof signature === "string" && signature.trim().length > 0))
  );
  if (uniqueSignatures.length === 0 || !context.inspectTransactions) {
    return [];
  }

  return context.inspectTransactions(uniqueSignatures);
}

function summarizeConfirmedTransactions(inspections: StartupTransactionInspection[]): {
  hasConfirmedTx: boolean;
  latestConfirmedAt?: Date;
  totalWalletDeltaSol: number;
} {
  const confirmed = inspections.filter((inspection) => inspection.confirmed);
  const latestConfirmedAt = confirmed
    .map((inspection) => inspection.confirmedAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => right.getTime() - left.getTime())[0];

  return {
    hasConfirmedTx: confirmed.length > 0,
    latestConfirmedAt,
    totalWalletDeltaSol: confirmed.reduce((sum, inspection) => sum + (inspection.walletDeltaSol ?? 0), 0)
  };
}

async function attemptPendingRecovery(
  config: AgentConfig,
  context: StartupReconciliationContext,
  signerAddress: string,
  pending: PendingActionRecord,
  summary: {
    hasConfirmedTx: boolean;
    latestConfirmedAt?: Date;
    totalWalletDeltaSol: number;
  }
): Promise<"recovered" | "abandoned" | "unresolved"> {
  switch (pending.action.type) {
    case "open":
      return recoverPendingOpen(config, context, signerAddress, pending, summary);
    case "close":
    case "emergency_exit":
      return recoverPendingClose(context, pending, summary);
    case "claim":
      return recoverPendingClaim(context, pending, summary);
    case "rebalance":
      return recoverPendingRebalance(context, pending, summary);
    default:
      context.state.clearPendingAction(pending.action.id);
      return "abandoned";
  }
}

async function recoverPendingOpen(
  config: AgentConfig,
  context: StartupReconciliationContext,
  signerAddress: string,
  pending: PendingActionRecord,
  summary: {
    hasConfirmedTx: boolean;
    latestConfirmedAt?: Date;
    totalWalletDeltaSol: number;
  }
): Promise<"recovered" | "abandoned" | "unresolved"> {
  const positionPubkey = typeof pending.metadata?.positionPubkey === "string" ? pending.metadata.positionPubkey : undefined;
  if (!positionPubkey) {
    context.state.clearPendingAction(pending.action.id);
    return "abandoned";
  }

  const exists = await context.checkPositionAccountExists!(positionPubkey);
  if (!exists && !summary.hasConfirmedTx) {
    context.state.clearPendingAction(pending.action.id);
    return "abandoned";
  }

  if (!exists) {
    return "unresolved";
  }

  if (!pending.action.pool || !pending.action.skill || !pending.action.amountSol || !pending.action.newRange) {
    return "unresolved";
  }

  const position: PositionRecord = {
    id: pending.action.id.replace(/^action-/, "position-"),
    positionPubkey,
    poolAddress: pending.action.pool.address,
    tokenMint: pending.action.pool.tokenMint,
    tokenSymbol: pending.action.pool.tokenSymbol,
    walletAddress: signerAddress,
    skillId: pending.action.skill.id,
    skillVersion: pending.action.skill.version,
    direction: pending.action.skill.params.direction,
    fromBinId: pending.action.newRange.minBinId,
    toBinId: pending.action.newRange.maxBinId,
    depositedSol: pending.action.amountSol,
    currentValueUsd: estimateUsdFromSol(config, pending.action.amountSol),
    pnlPercent: 0,
    isInRange: true,
    totalFeesClaimedSol: 0,
    rebalanceCount: 0,
    status: "active",
    entryLincolnScore: pending.action.pool.lincolnScore,
    openedAt: summary.latestConfirmedAt ?? pending.startedAt,
    maxAliveUntil: new Date(
      (summary.latestConfirmedAt ?? pending.startedAt).getTime()
      + pending.action.skill.riskLimits.maxAliveHours * 60 * 60 * 1000
    ),
    ...(pending.action.pool.narrative ? { narrative: pending.action.pool.narrative } : {})
  };

  const operations: ExecutionStateOperation[] = [
    {
      kind: "upsert_position",
      position
    }
  ];
  if (summary.totalWalletDeltaSol !== 0) {
    operations.unshift({
      kind: "adjust_capital",
      deltaSol: summary.totalWalletDeltaSol
    });
  }

  applyStateOperations(context.state, operations);
  context.state.markActionApplied(pending.action.id);
  context.state.clearPendingAction(pending.action.id);
  context.logger.warn("启动对账恢复 pending open 动作", {
    actionId: pending.action.id,
    positionPubkey
  });
  return "recovered";
}

async function recoverPendingClose(
  context: StartupReconciliationContext,
  pending: PendingActionRecord,
  summary: {
    hasConfirmedTx: boolean;
    latestConfirmedAt?: Date;
    totalWalletDeltaSol: number;
  }
): Promise<"recovered" | "abandoned" | "unresolved"> {
  const referencePosition = context.state.getPosition(pending.action.positionId ?? "") ?? pending.positionSnapshot;
  if (!referencePosition) {
    context.state.clearPendingAction(pending.action.id);
    return "abandoned";
  }

  const positionStillExists = await context.checkPositionAccountExists!(referencePosition.positionPubkey);
  if (positionStillExists && !summary.hasConfirmedTx) {
    context.state.clearPendingAction(pending.action.id);
    return "abandoned";
  }

  if (positionStillExists) {
    return "unresolved";
  }

  const closedAt = summary.latestConfirmedAt ?? new Date();
  const operations: ExecutionStateOperation[] = [
    {
      kind: "upsert_position",
      position: {
        ...referencePosition,
        status: "closed",
        closedAt,
        isInRange: false
      }
    }
  ];
  if (summary.totalWalletDeltaSol !== 0) {
    operations.unshift({
      kind: "adjust_capital",
      deltaSol: summary.totalWalletDeltaSol
    });
  }

  applyStateOperations(context.state, operations);
  context.state.markActionApplied(pending.action.id);
  context.state.clearPendingAction(pending.action.id);
  context.logger.warn("启动对账恢复 pending close 动作", {
    actionId: pending.action.id,
    positionId: referencePosition.id
  });
  return "recovered";
}

async function recoverPendingClaim(
  context: StartupReconciliationContext,
  pending: PendingActionRecord,
  summary: {
    hasConfirmedTx: boolean;
    latestConfirmedAt?: Date;
    totalWalletDeltaSol: number;
  }
): Promise<"recovered" | "abandoned" | "unresolved"> {
  const referencePosition = context.state.getPosition(pending.action.positionId ?? "") ?? pending.positionSnapshot;
  if (!referencePosition) {
    context.state.clearPendingAction(pending.action.id);
    return "abandoned";
  }

  if (!summary.hasConfirmedTx) {
    context.state.clearPendingAction(pending.action.id);
    return "abandoned";
  }

  const claimedAt = summary.latestConfirmedAt ?? new Date();
  const claimedSol = Math.max(summary.totalWalletDeltaSol, 0);
  const operations: ExecutionStateOperation[] = [
    {
      kind: "upsert_position",
      position: {
        ...referencePosition,
        totalFeesClaimedSol: referencePosition.totalFeesClaimedSol + claimedSol,
        lastClaimedAt: claimedAt,
        lastFeeCheckAt: claimedAt
      }
    }
  ];
  if (summary.totalWalletDeltaSol !== 0) {
    operations.unshift({
      kind: "adjust_capital",
      deltaSol: summary.totalWalletDeltaSol
    });
  }

  applyStateOperations(context.state, operations);
  context.state.markActionApplied(pending.action.id);
  context.state.clearPendingAction(pending.action.id);
  context.logger.warn("启动对账恢复 pending claim 动作", {
    actionId: pending.action.id,
    positionId: referencePosition.id,
    claimedSol
  });
  return "recovered";
}

async function recoverPendingRebalance(
  context: StartupReconciliationContext,
  pending: PendingActionRecord,
  summary: {
    hasConfirmedTx: boolean;
    latestConfirmedAt?: Date;
    totalWalletDeltaSol: number;
  }
): Promise<"recovered" | "abandoned" | "unresolved"> {
  const referencePosition = context.state.getPosition(pending.action.positionId ?? "") ?? pending.positionSnapshot;
  if (!referencePosition) {
    context.state.clearPendingAction(pending.action.id);
    return "abandoned";
  }

  const oldPositionExists = await context.checkPositionAccountExists!(referencePosition.positionPubkey);
  const replacementPositionPubkey =
    typeof pending.metadata?.replacementPositionPubkey === "string"
      ? pending.metadata.replacementPositionPubkey
      : undefined;
  const replacementExists = replacementPositionPubkey
    ? await context.checkPositionAccountExists!(replacementPositionPubkey)
    : false;

  if (!summary.hasConfirmedTx && oldPositionExists && !replacementExists) {
    context.state.clearPendingAction(pending.action.id);
    return "abandoned";
  }

  const operations: ExecutionStateOperation[] = [];
  if (summary.totalWalletDeltaSol !== 0) {
    operations.push({
      kind: "adjust_capital",
      deltaSol: summary.totalWalletDeltaSol
    });
  }

  if (replacementPositionPubkey && replacementExists) {
    operations.push({
      kind: "upsert_position",
      position: {
        ...referencePosition,
        positionPubkey: replacementPositionPubkey,
        fromBinId: pending.action.newRange?.minBinId ?? referencePosition.fromBinId,
        toBinId: pending.action.newRange?.maxBinId ?? referencePosition.toBinId,
        rebalanceCount: referencePosition.rebalanceCount + 1,
        isInRange: true,
        outOfRangeSince: undefined
      }
    });
  } else if (!oldPositionExists) {
    operations.push({
      kind: "upsert_position",
      position: {
        ...referencePosition,
        status: "closed",
        closedAt: summary.latestConfirmedAt ?? new Date(),
        isInRange: false
      }
    });
  } else {
    return "unresolved";
  }

  applyStateOperations(context.state, operations);
  context.state.markActionApplied(pending.action.id);
  context.state.clearPendingAction(pending.action.id);
  context.logger.warn("启动对账恢复 pending rebalance 动作", {
    actionId: pending.action.id,
    replacementPositionPubkey,
    replacementExists,
    oldPositionExists
  });
  return "recovered";
}

async function closeMissingOnchainPositions(context: StartupReconciliationContext): Promise<string[]> {
  const activePositions = context.state.getActivePositions();
  const missingPositions: PositionRecord[] = [];
  for (const position of activePositions) {
    const exists = await context.checkPositionAccountExists!(position.positionPubkey);
    if (!exists) {
      missingPositions.push(position);
    }
  }

  if (missingPositions.length === 0) {
    return [];
  }

  const reconciledAt = new Date();
  for (const position of missingPositions) {
    context.state.closePosition(position.id, reconciledAt);
    context.logger.warn("启动对账关闭链上已不存在的本地活跃仓位", {
      positionId: position.id,
      positionPubkey: position.positionPubkey,
      walletAddress: position.walletAddress
    });
  }

  return missingPositions.map((position) => position.id);
}

function asPlannedAction(value: unknown): PlannedAction | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") {
    return null;
  }

  return value as PlannedAction;
}

function asActionResult(value: unknown): {
  txSignatures?: unknown;
  metadata?: unknown;
  stateOperations?: unknown;
} | null {
  if (!isRecord(value)) {
    return null;
  }

  return value;
}

function normalizeStateOperations(value: unknown): ExecutionStateOperation[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const operations: ExecutionStateOperation[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.kind !== "string") {
      continue;
    }

    if (item.kind === "adjust_capital" && typeof item.deltaSol === "number") {
      operations.push({
        kind: "adjust_capital",
        deltaSol: item.deltaSol
      });
      continue;
    }

    if (item.kind === "upsert_position") {
      const position = normalizePositionRecord(item.position);
      if (position) {
        operations.push({
          kind: "upsert_position",
          position
        });
      }
    }
  }

  return operations.length > 0 ? operations : undefined;
}

function normalizePositionRecord(value: unknown): PositionRecord | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.positionPubkey !== "string") {
    return null;
  }

  return {
    ...(value as PositionRecord),
    openedAt: toDate(value.openedAt),
    maxAliveUntil: toDate(value.maxAliveUntil),
    ...(value.closedAt ? { closedAt: toDate(value.closedAt) } : {}),
    ...(value.outOfRangeSince ? { outOfRangeSince: toDate(value.outOfRangeSince) } : {}),
    ...(value.lastClaimedAt ? { lastClaimedAt: toDate(value.lastClaimedAt) } : {}),
    ...(value.lastFeeCheckAt ? { lastFeeCheckAt: toDate(value.lastFeeCheckAt) } : {})
  };
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
