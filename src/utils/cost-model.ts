import type { AgentConfig } from "../config/types.js";
import type { ActionType } from "../domain/models.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface ActionCostEstimate {
  enabled: boolean;
  totalSol: number;
  networkFeeSol: number;
  priorityFeeSol: number;
  jitoTipSol: number;
  rentSol: number;
  slippageSol: number;
  failedTxFeeSol: number;
}

function lamportsToSol(lamports: number | undefined): number {
  return Math.max(0, lamports ?? 0) / LAMPORTS_PER_SOL;
}

function readNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function usesJito(config: AgentConfig): boolean {
  const strategy = config.execution?.live?.submission_strategy;
  return strategy === "jito" || strategy === "jito_then_rpc";
}

export function estimateActionCostSol(
  config: AgentConfig,
  actionType: ActionType,
  amountSol = 0
): ActionCostEstimate {
  const costModel = config.cost_model;
  if (costModel?.enabled !== true) {
    return {
      enabled: false,
      totalSol: 0,
      networkFeeSol: 0,
      priorityFeeSol: 0,
      jitoTipSol: 0,
      rentSol: 0,
      slippageSol: 0,
      failedTxFeeSol: 0
    };
  }

  const networkFeeSol = lamportsToSol(readNonNegative(costModel.network_fee_lamports, 5_000));
  const priorityFeeSol = lamportsToSol(
    readNonNegative(
      costModel.priority_fee_lamports,
      config.execution?.live?.jupiter?.prioritization_fee_lamports ?? 0
    )
  );
  const jitoTipSol = usesJito(config)
    ? lamportsToSol(readNonNegative(costModel.jito_tip_lamports, config.rpc.jito.tip_lamports))
    : 0;
  const rentSol = actionType === "open" ? readNonNegative(costModel.rent_per_position_sol, 0) : 0;
  const slippageBps =
    actionType === "rebalance"
      ? readNonNegative(costModel.rebalance_slippage_bps, costModel.slippage_bps ?? 0)
      : readNonNegative(costModel.slippage_bps, config.execution?.live?.jupiter?.slippage_bps ?? 0);
  const slippageSol = amountSol > 0 ? amountSol * (slippageBps / 10_000) : 0;
  const failedTxFeeSol = actionType === "emergency_exit" ? lamportsToSol(costModel.failed_tx_fee_lamports) : 0;
  const totalSol = networkFeeSol + priorityFeeSol + jitoTipSol + rentSol + slippageSol + failedTxFeeSol;

  return {
    enabled: true,
    totalSol,
    networkFeeSol,
    priorityFeeSol,
    jitoTipSol,
    rentSol,
    slippageSol,
    failedTxFeeSol
  };
}
