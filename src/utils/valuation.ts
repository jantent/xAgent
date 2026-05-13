import type { AgentConfig } from "../config/types.js";

function resolveConfiguredNumber(config: AgentConfig): number | undefined {
  const envKey = config.valuation?.sol_price_usd_env;
  if (envKey) {
    const raw = process.env[envKey];
    if (raw) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  const configured = config.valuation?.sol_price_usd;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : undefined;
}

export function getConfiguredSolPriceUsd(config: AgentConfig): number | undefined {
  return resolveConfiguredNumber(config);
}

export function estimateUsdFromSol(config: AgentConfig, amountSol: number): number {
  const price = resolveConfiguredNumber(config);
  if (!price || !Number.isFinite(amountSol) || amountSol <= 0) {
    return 0;
  }

  return Number((amountSol * price).toFixed(6));
}
