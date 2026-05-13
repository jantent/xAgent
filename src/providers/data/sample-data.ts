import { promises as fs } from "node:fs";
import path from "node:path";

import type { PoolCandidate, SmartMoneyData, TokenSafetyData, UrgentSignal } from "../../domain/models.js";

export interface SampleMarketDataset {
  pools: Array<Omit<PoolCandidate, "reasons" | "narrative">>;
  tokenSafetyByMint: Record<string, TokenSafetyData>;
  smartMoneyByMint: Record<string, SmartMoneyData>;
  urgentSignals: UrgentSignal[];
}

export async function loadSampleDataset(filePath: string): Promise<SampleMarketDataset> {
  const resolvedPath = path.resolve(filePath);
  const raw = await fs.readFile(resolvedPath, "utf8");
  return JSON.parse(raw) as SampleMarketDataset;
}
