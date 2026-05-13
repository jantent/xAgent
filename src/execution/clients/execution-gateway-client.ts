import type { ActionExecutionResult, ExecutionStateOperation, PlannedAction, PositionRecord } from "../../domain/models.js";
import { withTimeout } from "../../utils/async.js";
import type { Logger } from "../../utils/logger.js";

interface GatewayRequestOptions {
  action: PlannedAction;
  baseUrl: string;
  apiKey?: string;
  executePath?: string;
  timeoutMs: number;
  payload: Record<string, unknown>;
}

interface GatewayHealthOptions {
  baseUrl: string;
  apiKey?: string;
  healthPath?: string;
  timeoutMs: number;
}

interface GatewayPositionsOptions {
  baseUrl: string;
  apiKey?: string;
  positionsPath?: string;
  timeoutMs: number;
  walletAddress?: string;
  activeOnly?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`gateway 响应缺少有效字段 ${key}`);
  }

  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`gateway 响应缺少有效数字字段 ${key}`);
  }

  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`gateway 响应缺少有效布尔字段 ${key}`);
  }

  return value;
}

function requireDate(record: Record<string, unknown>, key: string): Date {
  const value = record[key];
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`gateway 响应缺少有效日期字段 ${key}`);
  }

  return date;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalDate(record: Record<string, unknown>, key: string): Date | undefined {
  const value = record[key];
  if (!value) {
    return undefined;
  }

  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizePositionRecord(raw: unknown): PositionRecord {
  if (!isRecord(raw)) {
    throw new Error("gateway 返回的 position 结构无效");
  }

  return {
    id: requireString(raw, "id"),
    positionPubkey: requireString(raw, "positionPubkey"),
    poolAddress: requireString(raw, "poolAddress"),
    tokenMint: requireString(raw, "tokenMint"),
    tokenSymbol: requireString(raw, "tokenSymbol"),
    walletAddress: requireString(raw, "walletAddress"),
    skillId: requireString(raw, "skillId"),
    skillVersion: requireString(raw, "skillVersion"),
    direction: requireString(raw, "direction") as PositionRecord["direction"],
    fromBinId: requireNumber(raw, "fromBinId"),
    toBinId: requireNumber(raw, "toBinId"),
    depositedSol: requireNumber(raw, "depositedSol"),
    currentValueUsd: requireNumber(raw, "currentValueUsd"),
    pnlPercent: requireNumber(raw, "pnlPercent"),
    isInRange: requireBoolean(raw, "isInRange"),
    totalFeesClaimedSol: requireNumber(raw, "totalFeesClaimedSol"),
    rebalanceCount: requireNumber(raw, "rebalanceCount"),
    status: requireString(raw, "status") as PositionRecord["status"],
    entryLincolnScore: requireNumber(raw, "entryLincolnScore"),
    openedAt: requireDate(raw, "openedAt"),
    maxAliveUntil: requireDate(raw, "maxAliveUntil"),
    closedAt: optionalDate(raw, "closedAt"),
    narrative: optionalString(raw, "narrative"),
    outOfRangeSince: optionalDate(raw, "outOfRangeSince"),
    lastClaimedAt: optionalDate(raw, "lastClaimedAt"),
    lastFeeCheckAt: optionalDate(raw, "lastFeeCheckAt")
  };
}

function normalizeStateOperations(raw: unknown): ExecutionStateOperation[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const operations: ExecutionStateOperation[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      throw new Error("gateway 返回的 stateOperations 包含非法元素");
    }

    if (item.kind === "adjust_capital") {
      operations.push({
        kind: "adjust_capital",
        deltaSol: requireNumber(item, "deltaSol")
      });
      continue;
    }

    if (item.kind === "upsert_position") {
      operations.push({
        kind: "upsert_position",
        position: normalizePositionRecord(item.position)
      });
      continue;
    }

    throw new Error(`gateway 返回了未知状态操作: ${String(item.kind)}`);
  }

  return operations;
}

function redactSensitiveText(value: string): string {
  return value.replace(/("secret"\s*:\s*\{[^}]*"value"\s*:\s*")[^"]+(")/g, '$1[REDACTED]$2');
}

export class ExecutionGatewayClient {
  constructor(private readonly logger: Logger) {}

  async execute(options: GatewayRequestOptions): Promise<ActionExecutionResult> {
    const startedAt = Date.now();
    const url = new URL(options.executePath ?? "/v1/actions/execute", options.baseUrl).toString();
    const response = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {})
        },
        body: JSON.stringify(options.payload)
      }),
      options.timeoutMs,
      "execution-gateway.execute"
    );

    const rawText = redactSensitiveText(await response.text());
    let payload: unknown;
    try {
      payload = rawText ? (JSON.parse(rawText) as unknown) : {};
    } catch (error) {
      this.logger.error("execution gateway 返回了不可解析的 JSON", {
        url,
        status: response.status,
        error,
        rawText
      });
      throw new Error(`execution gateway 返回非法 JSON: ${response.status}`);
    }

    if (!response.ok) {
      throw new Error(
        `execution gateway 请求失败: ${response.status} ${response.statusText} ${rawText.slice(0, 240)}`.trim()
      );
    }

    if (!isRecord(payload)) {
      throw new Error("execution gateway 返回结构无效");
    }

    const status = payload.status;
    const normalizedStatus =
      status === "success" || status === "failed" || status === "skipped" ? status : "failed";
    const txSignatures = Array.isArray(payload.txSignatures)
      ? payload.txSignatures.filter((item): item is string => typeof item === "string")
      : [];

    return {
      actionId: options.action.id,
      type: options.action.type,
      status: normalizedStatus,
      message: typeof payload.message === "string" ? payload.message : "execution gateway 未返回 message",
      txSignatures,
      latencyMs: Date.now() - startedAt,
      metadata: isRecord(payload.metadata) ? payload.metadata : undefined,
      stateOperations: normalizeStateOperations(payload.stateOperations)
    };
  }

  async healthCheck(options: GatewayHealthOptions): Promise<{ healthy: boolean; error?: string }> {
    const url = new URL(options.healthPath ?? "/health", options.baseUrl).toString();

    try {
      const response = await withTimeout(
        fetch(url, {
          method: "GET",
          headers: {
            ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {})
          }
        }),
        options.timeoutMs,
        "execution-gateway.health"
      );

      if (!response.ok) {
        return {
          healthy: false,
          error: `${response.status} ${response.statusText}`.trim()
        };
      }

      return {
        healthy: true
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async listPositions(options: GatewayPositionsOptions): Promise<PositionRecord[]> {
    const url = new URL(options.positionsPath ?? "/v1/positions", options.baseUrl);
    if (options.activeOnly !== false) {
      url.searchParams.set("active", "true");
    }
    if (options.walletAddress) {
      url.searchParams.set("walletAddress", options.walletAddress);
    }

    const response = await withTimeout(
      fetch(url, {
        method: "GET",
        headers: {
          ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {})
        }
      }),
      options.timeoutMs,
      "execution-gateway.list-positions"
    );

    const rawText = redactSensitiveText(await response.text());
    let payload: unknown;
    try {
      payload = rawText ? (JSON.parse(rawText) as unknown) : [];
    } catch (error) {
      this.logger.error("execution gateway positions 返回了不可解析的 JSON", {
        url: url.toString(),
        status: response.status,
        error,
        rawText
      });
      throw new Error(`execution gateway positions 返回非法 JSON: ${response.status}`);
    }

    if (!response.ok) {
      throw new Error(
        `execution gateway positions 请求失败: ${response.status} ${response.statusText} ${rawText.slice(0, 240)}`.trim()
      );
    }

    const rawPositions = Array.isArray(payload)
      ? payload
      : isRecord(payload) && Array.isArray(payload.positions)
        ? payload.positions
        : null;

    if (!rawPositions) {
      throw new Error("execution gateway positions 返回结构无效");
    }

    return rawPositions.map((position) => normalizePositionRecord(position));
  }
}
