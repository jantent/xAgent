import { execFile } from "node:child_process";

import type { IDataProvider } from "../../domain/contracts.js";
import type {
  AlertLevel,
  OHLCV,
  ProviderHealthStatus,
  SmartMoneyData,
  TokenSafetyData,
  TrendingToken,
  UrgentSignal
} from "../../domain/models.js";
import type { Logger } from "../../utils/logger.js";
import {
  asRecord,
  normalizeFraction,
  normalizeTimestamp,
  readBoolean,
  readNumber,
  readString,
  selectEntity,
  selectEntityList
} from "../shared/http-source-utils.js";

export interface GmgnCliCommandResult {
  stdout: string;
  stderr?: string;
}

export type GmgnCliCommandRunner = (
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
  }
) => Promise<GmgnCliCommandResult>;

export interface GmgnCliDataProviderOptions {
  name: string;
  priority: number;
  command?: string;
  chain?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  timeoutMs?: number;
  logger: Logger;
  runCommand?: GmgnCliCommandRunner;
}

type JsonRecord = Record<string, unknown>;

const DEFAULT_COMMAND = "gmgn-cli";
const DEFAULT_CHAIN = "sol";

/**
 * GMGN 官方现在推荐通过 gmgn-cli / OpenAPI 获取结构化数据。
 * 这里把 CLI 的 raw JSON 输出收敛到 IDataProvider，避免继续抓取 gmgn.ai 网页接口。
 */
export class GmgnCliDataProvider implements IDataProvider {
  readonly name: string;
  readonly priority: number;

  private readonly command: string;
  private readonly chain: string;
  private readonly apiKeyEnv?: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly runCommand: GmgnCliCommandRunner;

  constructor(options: GmgnCliDataProviderOptions) {
    this.name = options.name;
    this.priority = options.priority;
    this.command = options.command?.trim() || DEFAULT_COMMAND;
    this.chain = options.chain?.trim() || DEFAULT_CHAIN;
    this.apiKeyEnv = options.apiKeyEnv;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.logger = options.logger;
    this.runCommand = options.runCommand ?? runExecFile;
  }

  async getTokenSafety(mint: string): Promise<TokenSafetyData> {
    const payload = await this.runJson(["token", "security", "--chain", this.chain, "--address", mint, "--raw"]);
    const entity = selectEntity(payload, mint);
    if (!entity) {
      throw new Error(`${this.name} token security payload missing entity`);
    }

    const stat = asRecord(entity.stat);
    const dev = asRecord(entity.dev);
    const records = [entity, stat, dev].filter((item): item is JsonRecord => Boolean(item));
    const rugProbability = normalizeFraction(
      readFirstNumber(records, "rug_ratio", "rugRatio", "rug_probability", "rugProbability", "rug_score", "rugScore")
    );
    const topHolderPct = normalizeFraction(
      readFirstNumber(records, "top_10_holder_rate", "top10HolderRate", "topHolderPct", "top_holder_pct")
    );
    const isHoneypot = readFirstBoolean(records, "is_honeypot", "isHoneypot", "honeypot") ?? false;
    const safetyScore =
      normalizeDirectScore(readFirstNumber(records, "safetyScore", "safety_score", "securityScore", "security_score")) ??
      deriveSafetyScore({
        rugProbability,
        topHolderPct,
        isHoneypot,
        renouncedMint: readFirstBoolean(records, "renounced_mint", "renouncedMint"),
        renouncedFreeze: readFirstBoolean(records, "renounced_freeze_account", "renouncedFreezeAccount")
      });

    return {
      mint,
      safetyScore,
      verdict: normalizeSafetyVerdict(
        readFirstString(records, "verdict", "safetyVerdict", "status", "riskLevel"),
        safetyScore,
        rugProbability,
        isHoneypot
      ),
      source: this.name,
      topHolderPct,
      rugProbability,
      isStale: readFirstBoolean(records, "isStale", "stale") ?? false
    };
  }

  async getSmartMoneyFlow(mint: string): Promise<SmartMoneyData> {
    const payload = await this.runJson([
      "token",
      "traders",
      "--chain",
      this.chain,
      "--address",
      mint,
      "--tag",
      "smart_degen",
      "--limit",
      "50",
      "--raw"
    ]);
    const items = selectEntityList(payload);
    const totals = items.reduce<{ buy24h: number; sell24h: number }>(
      (acc, item) => {
        const buy =
          readNumber(item, "buy24h", "buy_volume_24h", "buy_volume_cur", "buyVolumeCur", "smartBuy24h") ?? 0;
        const sell =
          readNumber(item, "sell24h", "sell_volume_24h", "sell_volume_cur", "sellVolumeCur", "smartSell24h") ?? 0;
        return {
          buy24h: acc.buy24h + buy,
          sell24h: acc.sell24h + sell
        };
      },
      { buy24h: 0, sell24h: 0 }
    );

    return {
      mint,
      buy24h: totals.buy24h,
      sell24h: totals.sell24h,
      net24h: totals.buy24h - totals.sell24h,
      source: this.name,
      isStale: false
    };
  }

  async getTrendingTokens(chain: string, period: string): Promise<TrendingToken[]> {
    const payload = await this.runJson([
      "market",
      "trending",
      "--chain",
      chain || this.chain,
      "--interval",
      period,
      "--order-by",
      "volume",
      "--limit",
      "50",
      "--raw"
    ]);

    return selectEntityList(payload)
      .map((item, index) => {
        const mint = readString(item, "address", "mint", "tokenAddress", "token_address");
        if (!mint) {
          return undefined;
        }

        return {
          mint,
          symbol: readString(item, "symbol", "tokenSymbol", "ticker") ?? mint.slice(0, 6),
          rank: readNumber(item, "rank", "position") ?? index + 1,
          volume24h: readNumber(item, "volume24h", "volume_24h", "vol24h", "volume", "volume_1h") ?? 0,
          source: this.name
        } satisfies TrendingToken;
      })
      .filter((item): item is TrendingToken => Boolean(item));
  }

  async getOHLCV(mint: string, interval: string): Promise<OHLCV[]> {
    const payload = await this.runJson([
      "market",
      "kline",
      "--chain",
      this.chain,
      "--address",
      mint,
      "--resolution",
      interval,
      "--raw"
    ]);

    return selectEntityList(payload)
      .map((item) => {
        const timestamp =
          normalizeTimestamp(item.timestamp) ??
          normalizeTimestamp(item.time) ??
          normalizeTimestamp(item.open_time) ??
          normalizeTimestamp(item.openTime) ??
          normalizeTimestamp(item.startTime);
        const open = readNumber(item, "open", "o");
        const high = readNumber(item, "high", "h");
        const low = readNumber(item, "low", "l");
        const close = readNumber(item, "close", "c");
        const volume = readNumber(item, "volume", "v", "volume_usd", "volumeUsd");

        if (
          timestamp === undefined ||
          open === undefined ||
          high === undefined ||
          low === undefined ||
          close === undefined ||
          volume === undefined
        ) {
          return undefined;
        }

        return {
          timestamp,
          open,
          high,
          low,
          close,
          volume
        } satisfies OHLCV;
      })
      .filter((item): item is OHLCV => Boolean(item));
  }

  async getUrgentSignals(tokenMints: string[]): Promise<UrgentSignal[]> {
    const payload = await this.runJson(["market", "signal", "--chain", this.chain, "--raw"]);
    const tokenSet = new Set(tokenMints);
    return selectEntityList(payload)
      .map((item) => {
        const tokenMint = readString(item, "tokenMint", "token_mint", "mint", "address", "token_address");
        if (!tokenMint || (tokenSet.size > 0 && !tokenSet.has(tokenMint))) {
          return undefined;
        }

        return {
          provider: this.name,
          signalType: readString(item, "signalType", "signal_type", "type", "event") ?? "gmgn_signal",
          tokenMint,
          severity: normalizeAlertLevel(readString(item, "severity", "level", "priority")),
          message: readString(item, "message", "title", "reason", "description") ?? "GMGN signal"
        } satisfies UrgentSignal;
      })
      .filter((item): item is UrgentSignal => Boolean(item));
  }

  async healthCheck(): Promise<ProviderHealthStatus> {
    const startedAt = Date.now();
    try {
      await this.runJson([
        "market",
        "trending",
        "--chain",
        this.chain,
        "--interval",
        "1h",
        "--limit",
        "1",
        "--raw"
      ]);

      return {
        provider: this.name,
        ok: true,
        canRead: true,
        canWrite: false,
        latencyMs: Date.now() - startedAt,
        lastCheckedAt: new Date(),
        consecutiveFailures: 0
      };
    } catch (error) {
      return {
        provider: this.name,
        ok: false,
        canRead: false,
        canWrite: false,
        latencyMs: Date.now() - startedAt,
        lastCheckedAt: new Date(),
        lastError: error instanceof Error ? error.message : String(error),
        consecutiveFailures: 0
      };
    }
  }

  private async runJson(args: string[]): Promise<unknown> {
    this.logger.debug("执行 GMGN CLI", { provider: this.name, command: this.command, args });
    const env = { ...process.env };
    if (this.apiKeyEnv && this.apiKey) {
      env[this.apiKeyEnv] = this.apiKey;
    }
    env.NODE_OPTIONS = withIpv4FirstNodeOption(env.NODE_OPTIONS);

    const result = await this.runCommand(this.command, args, {
      timeoutMs: this.timeoutMs,
      env
    });

    return parseJsonOutput(result.stdout);
  }
}

function withIpv4FirstNodeOption(existing?: string): string {
  const option = "--dns-result-order=ipv4first";
  if (!existing?.trim()) {
    return option;
  }

  return existing.includes(option) ? existing : `${existing} ${option}`;
}

function runExecFile(
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
  }
): Promise<GmgnCliCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 4 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          const suffix = stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : "";
          reject(new Error(`${error.message}${suffix}`));
          return;
        }

        resolve({ stdout, stderr });
      }
    );
  });
}

function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    const extracted = extractJson(text);
    if (extracted) {
      return JSON.parse(extracted);
    }

    throw new Error(`gmgn-cli returned non-json output: ${text.slice(0, 180)}`);
  }
}

function extractJson(text: string): string | undefined {
  const candidates = [
    { start: text.indexOf("{"), end: text.lastIndexOf("}") },
    { start: text.indexOf("["), end: text.lastIndexOf("]") }
  ].filter((item) => item.start >= 0 && item.end > item.start);

  candidates.sort((left, right) => left.start - right.start);
  return candidates[0] ? text.slice(candidates[0].start, candidates[0].end + 1) : undefined;
}

function readFirstNumber(records: JsonRecord[], ...keys: string[]): number | undefined {
  for (const record of records) {
    const value = readNumber(record, ...keys);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function readFirstString(records: JsonRecord[], ...keys: string[]): string | undefined {
  for (const record of records) {
    const value = readString(record, ...keys);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function readFirstBoolean(records: JsonRecord[], ...keys: string[]): boolean | undefined {
  for (const record of records) {
    for (const key of keys) {
      const raw = record[key];
      if (typeof raw === "number") {
        if (raw === 1) {
          return true;
        }
        if (raw === 0) {
          return false;
        }
      }
      if (typeof raw === "string") {
        const normalized = raw.trim().toLowerCase();
        if (normalized === "yes" || normalized === "true" || normalized === "1") {
          return true;
        }
        if (normalized === "no" || normalized === "false" || normalized === "0" || normalized === "") {
          return false;
        }
      }
    }

    const value = readBoolean(record, ...keys);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function normalizeDirectScore(value?: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const score = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function deriveSafetyScore(input: {
  rugProbability?: number;
  topHolderPct?: number;
  isHoneypot: boolean;
  renouncedMint?: boolean;
  renouncedFreeze?: boolean;
}): number {
  let score = 100;
  if (input.rugProbability !== undefined) {
    score -= input.rugProbability * 100;
  }
  if (input.topHolderPct !== undefined && input.topHolderPct > 0.3) {
    score -= Math.min(25, (input.topHolderPct - 0.3) * 100);
  }
  if (input.isHoneypot) {
    score -= 70;
  }
  if (input.renouncedMint === false) {
    score -= 10;
  }
  if (input.renouncedFreeze === false) {
    score -= 10;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function normalizeSafetyVerdict(
  rawVerdict: string | undefined,
  safetyScore: number,
  rugProbability?: number,
  isHoneypot?: boolean
): TokenSafetyData["verdict"] {
  const normalized = rawVerdict?.trim().toUpperCase();
  if (normalized === "SAFE" || normalized === "WARNING" || normalized === "DANGER" || normalized === "UNKNOWN") {
    return normalized;
  }

  if (isHoneypot || (rugProbability !== undefined && rugProbability >= 0.5) || safetyScore < 45) {
    return "DANGER";
  }
  if (safetyScore < 70) {
    return "WARNING";
  }

  return "SAFE";
}

function normalizeAlertLevel(rawLevel?: string): AlertLevel {
  const normalized = rawLevel?.trim().toLowerCase();
  if (normalized === "critical" || normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }

  return "high";
}
