import { promises as fs } from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { SkillStatus } from "../domain/models.js";
import type { SkillMeta } from "../domain/models.js";
import type { AgentConfig, DataProviderConfig, LLMRouteConfig, LiveExecutionConfig, NotificationRouteConfig } from "./types.js";

const ACTION_TYPES = new Set(["open", "close", "rebalance", "claim", "emergency_exit"]);
const EXECUTION_MODES = new Set(["dry_run", "live_gateway", "live_sdk"]);
const EXECUTION_SUBMISSION_STRATEGIES = new Set(["gateway_managed", "rpc", "jito", "jito_then_rpc"]);
const EXECUTOR_TYPES = new Set(["gateway", "sdk"]);
const DATA_PROVIDER_KINDS = new Set(["http", "gmgn_cli"]);
const WALLET_MODES = new Set(["injected", "phantom_delegate"]);
const ALERT_LEVELS = new Set(["critical", "high", "medium", "low"]);
const ACTIVE_POSITION_RECONCILE_STRATEGIES = new Set(["fail", "close_missing", "repair"]);
const PERSIST_FAILURE_STRATEGIES = new Set(["off", "close_only", "close_only_then_pause"]);
const DEFAULT_PAPER_TRADING = {
  enabled: true,
  valuation_interval_ms: 300_000,
  fee_capture_rate: 0.35,
  max_fee_tvl_ratio_24h: 250,
  price_exposure: 0.5,
  out_of_range_penalty_pct_per_bin_width: 2,
  max_out_of_range_penalty_pct: 35,
  snapshot_retention: 5_000
};
const DEFAULT_SKILL_OPTIMIZER = {
  enabled: true,
  min_closed_positions: 5,
  min_snapshots: 20,
  evaluation_interval_ms: 1_800_000,
  max_patch_pct: 20
};

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown, context: string): RawRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} 必须是对象`);
  }

  return value as RawRecord;
}

function requireRecord(record: RawRecord, key: string, context: string): RawRecord {
  return asRecord(record[key], `${context}.${key}`);
}

function optionalRecord(record: RawRecord, key: string, context: string): RawRecord | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  return asRecord(value, `${context}.${key}`);
}

function requireString(record: RawRecord, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context}.${key} 必须是非空字符串`);
  }

  return value.trim();
}

function optionalString(record: RawRecord, key: string, context: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context}.${key} 必须是字符串`);
  }

  return value.trim();
}

function requireNumber(record: RawRecord, key: string, context: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context}.${key} 必须是有限数字`);
  }

  return value;
}

function optionalNumber(record: RawRecord, key: string, context: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context}.${key} 必须是有限数字`);
  }

  return value;
}

function optionalBoolean(record: RawRecord, key: string, context: string): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`${context}.${key} 必须是布尔值`);
  }

  return value;
}

function requireStringArray(record: RawRecord, key: string, context: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${context}.${key} 必须是字符串数组`);
  }

  return value.map((item) => item.trim());
}

function requireNumberArray(record: RawRecord, key: string, context: string): number[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error(`${context}.${key} 必须是数字数组`);
  }

  return value;
}

function optionalStringArray(record: RawRecord, key: string, context: string): string[] {
  const value = record[key];
  if (value === undefined || value === null) {
    return [];
  }

  return requireStringArray(record, key, context);
}

function requireEnum(record: RawRecord, key: string, allowed: Set<string>, context: string): string {
  const value = requireString(record, key, context);
  if (!allowed.has(value)) {
    throw new Error(`${context}.${key} 必须是以下值之一: ${Array.from(allowed).join(", ")}`);
  }

  return value;
}

function asDate(value: unknown, context: string): Date | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${context} 不是有效日期`);
  }

  return date;
}

async function readYamlFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf8");
  return parse(raw);
}

function normalizeSkillStatus(value: unknown): SkillStatus {
  switch (value) {
    case SkillStatus.CANARY:
      return SkillStatus.CANARY;
    case SkillStatus.ACTIVE:
      return SkillStatus.ACTIVE;
    case SkillStatus.DISABLED:
      return SkillStatus.DISABLED;
    case SkillStatus.DEPRECATED:
      return SkillStatus.DEPRECATED;
    case SkillStatus.DRAFT:
    case undefined:
    case null:
      return SkillStatus.DRAFT;
    default:
      throw new Error(`非法 skill status: ${String(value)}`);
  }
}

function normalizeRoute(raw: RawRecord, context: string): LLMRouteConfig {
  return {
    provider: requireString(raw, "provider", context),
    model: requireString(raw, "model", context),
    api_key_env: optionalString(raw, "api_key_env", context),
    base_url: optionalString(raw, "base_url", context),
    max_tokens: optionalNumber(raw, "max_tokens", context),
    temperature: optionalNumber(raw, "temperature", context)
  };
}

function normalizeNotificationRoute(raw: RawRecord, context: string): NotificationRouteConfig {
  const levels = requireStringArray(raw, "levels", context);
  const bot = optionalRecord(raw, "bot", context);
  for (const level of levels) {
    if (!ALERT_LEVELS.has(level)) {
      throw new Error(`${context}.levels 包含非法等级 ${level}`);
    }
  }

  return {
    bot_token_env: optionalString(raw, "bot_token_env", context),
    chat_id_env: optionalString(raw, "chat_id_env", context),
    webhook_env: optionalString(raw, "webhook_env", context),
    levels,
    bot: bot
      ? {
          enabled: optionalBoolean(bot, "enabled", `${context}.bot`),
          allowed_chat_ids_env: optionalString(bot, "allowed_chat_ids_env", `${context}.bot`),
          dashboard_url: optionalString(bot, "dashboard_url", `${context}.bot`),
          dashboard_url_env: optionalString(bot, "dashboard_url_env", `${context}.bot`),
          poll_interval_ms: optionalNumber(bot, "poll_interval_ms", `${context}.bot`),
          poll_timeout_seconds: optionalNumber(bot, "poll_timeout_seconds", `${context}.bot`),
          request_timeout_ms: optionalNumber(bot, "request_timeout_ms", `${context}.bot`),
          max_positions: optionalNumber(bot, "max_positions", `${context}.bot`),
          max_events: optionalNumber(bot, "max_events", `${context}.bot`)
        }
      : undefined
  };
}

function normalizeProviderConfig(raw: RawRecord, context: string): DataProviderConfig {
  const circuitBreaker = requireRecord(raw, "circuit_breaker", context);
  const kind = optionalString(raw, "kind", context);
  if (kind && !DATA_PROVIDER_KINDS.has(kind)) {
    throw new Error(`${context}.kind 必须是以下值之一: ${Array.from(DATA_PROVIDER_KINDS).join(", ")}`);
  }

  return {
    kind: kind as DataProviderConfig["kind"],
    priority: requireNumber(raw, "priority", context),
    enabled: optionalBoolean(raw, "enabled", context),
    command: optionalString(raw, "command", context),
    chain: optionalString(raw, "chain", context),
    base_url: optionalString(raw, "base_url", context),
    base_url_env: optionalString(raw, "base_url_env", context),
    api_key_env: optionalString(raw, "api_key_env", context),
    api_key_header: optionalString(raw, "api_key_header", context),
    timeout_ms: optionalNumber(raw, "timeout_ms", context),
    health_path: optionalString(raw, "health_path", context),
    token_safety_path: optionalString(raw, "token_safety_path", context),
    smart_money_path: optionalString(raw, "smart_money_path", context),
    trending_path: optionalString(raw, "trending_path", context),
    ohlcv_path: optionalString(raw, "ohlcv_path", context),
    urgent_signals_path: optionalString(raw, "urgent_signals_path", context),
    circuit_breaker: {
      failure_threshold: requireNumber(circuitBreaker, "failure_threshold", `${context}.circuit_breaker`),
      recovery_time_ms: requireNumber(circuitBreaker, "recovery_time_ms", `${context}.circuit_breaker`)
    }
  };
}

function normalizeLiveExecution(raw: RawRecord, context: string): LiveExecutionConfig {
  const gateway = requireRecord(raw, "gateway", context);
  const jupiter = optionalRecord(raw, "jupiter", context);
  const meteora = optionalRecord(raw, "meteora", context);
  const supportedActions = requireStringArray(raw, "supported_actions", context);
  for (const action of supportedActions) {
    if (!ACTION_TYPES.has(action)) {
      throw new Error(`${context}.supported_actions 包含非法动作 ${action}`);
    }
  }

  return {
    executor: requireEnum(raw, "executor", EXECUTOR_TYPES, context) as LiveExecutionConfig["executor"],
    supported_actions: supportedActions as LiveExecutionConfig["supported_actions"],
    submission_strategy: requireEnum(raw, "submission_strategy", EXECUTION_SUBMISSION_STRATEGIES, context) as LiveExecutionConfig["submission_strategy"],
    gateway: {
      base_url_env: requireString(gateway, "base_url_env", `${context}.gateway`),
      api_key_env: optionalString(gateway, "api_key_env", `${context}.gateway`),
      timeout_ms: requireNumber(gateway, "timeout_ms", `${context}.gateway`),
      health_path: optionalString(gateway, "health_path", `${context}.gateway`),
      execute_path: optionalString(gateway, "execute_path", `${context}.gateway`),
      positions_path: optionalString(gateway, "positions_path", `${context}.gateway`)
    },
    jupiter: jupiter
      ? {
          quote_base_url: requireString(jupiter, "quote_base_url", `${context}.jupiter`),
          swap_base_url: requireString(jupiter, "swap_base_url", `${context}.jupiter`),
          slippage_bps: requireNumber(jupiter, "slippage_bps", `${context}.jupiter`),
          api_key_env: optionalString(jupiter, "api_key_env", `${context}.jupiter`),
          wrap_and_unwrap_sol: optionalBoolean(jupiter, "wrap_and_unwrap_sol", `${context}.jupiter`),
          prioritization_fee_lamports: optionalNumber(jupiter, "prioritization_fee_lamports", `${context}.jupiter`)
        }
      : undefined,
    meteora: meteora
      ? {
          dlmm_api_base_url: requireString(meteora, "dlmm_api_base_url", `${context}.meteora`)
        }
      : undefined
  };
}

function normalizeSkill(raw: RawRecord, context: string): SkillMeta {
  const params = requireRecord(raw, "params", context);
  const riskLimits = requireRecord(raw, "riskLimits", context);
  const applicability = requireRecord(raw, "applicability", context);

  return {
    id: requireString(raw, "id", context),
    version: requireString(raw, "version", context),
    name: requireString(raw, "name", context),
    description: optionalString(raw, "description", context) ?? "",
    status: normalizeSkillStatus(raw.status),
    canaryPercent: optionalNumber(raw, "canaryPercent", context),
    enabledAt: asDate(raw.enabledAt, `${context}.enabledAt`),
    disabledAt: asDate(raw.disabledAt, `${context}.disabledAt`),
    params: {
      direction: requireString(params, "direction", `${context}.params`) as SkillMeta["params"]["direction"],
      distributionType: requireString(params, "distributionType", `${context}.params`) as SkillMeta["params"]["distributionType"],
      binCount: requireNumber(params, "binCount", `${context}.params`),
      binStepPreference: requireNumberArray(params, "binStepPreference", `${context}.params`),
      feeRatePreference: requireNumberArray(params, "feeRatePreference", `${context}.params`),
      entryConditions: Array.isArray(params.entryConditions) ? params.entryConditions : [],
      exitConditions: Array.isArray(params.exitConditions) ? params.exitConditions : [],
      rebalanceRules: Array.isArray(params.rebalanceRules) ? params.rebalanceRules : []
    },
    riskLimits: {
      maxPositionSizePercent: requireNumber(riskLimits, "maxPositionSizePercent", `${context}.riskLimits`),
      maxTotalExposurePercent: requireNumber(riskLimits, "maxTotalExposurePercent", `${context}.riskLimits`),
      maxConcurrentPositions: requireNumber(riskLimits, "maxConcurrentPositions", `${context}.riskLimits`),
      stopLossPercent: requireNumber(riskLimits, "stopLossPercent", `${context}.riskLimits`),
      maxAliveHours: requireNumber(riskLimits, "maxAliveHours", `${context}.riskLimits`),
      maxDailyRebalances: requireNumber(riskLimits, "maxDailyRebalances", `${context}.riskLimits`)
    },
    applicability: {
      minLincolnScore: requireNumber(applicability, "minLincolnScore", `${context}.applicability`),
      minSafetyScore: requireNumber(applicability, "minSafetyScore", `${context}.applicability`),
      minMcap: optionalNumber(applicability, "minMcap", `${context}.applicability`),
      maxMcap: optionalNumber(applicability, "maxMcap", `${context}.applicability`),
      lifecycleStages: optionalStringArray(applicability, "lifecycleStages", `${context}.applicability`) as SkillMeta["applicability"]["lifecycleStages"]
    },
    changelog: optionalString(raw, "changelog", context) ?? "",
    previousVersion: optionalString(raw, "previousVersion", context),
    createdAt: asDate(raw.createdAt, `${context}.createdAt`) ?? new Date(),
    updatedAt: asDate(raw.updatedAt, `${context}.updatedAt`) ?? new Date()
  };
}

function normalizeAgentConfig(raw: RawRecord, context: string): AgentConfig {
  const system = requireRecord(raw, "system", context);
  const wallet = requireRecord(raw, "wallet", context);
  const walletLimits = requireRecord(wallet, "limits", `${context}.wallet`);
  const walletSecret = optionalRecord(wallet, "secret", `${context}.wallet`);
  const rpc = requireRecord(raw, "rpc", context);
  const rpcPrimary = requireRecord(rpc, "primary", `${context}.rpc`);
  const rpcBackup = requireRecord(rpc, "backup", `${context}.rpc`);
  const rpcJito = requireRecord(rpc, "jito", `${context}.rpc`);
  const dataProviders = requireRecord(raw, "data_providers", context);
  const cache = requireRecord(dataProviders, "cache", `${context}.data_providers`);
  const llm = requireRecord(raw, "llm", context);
  const risk = requireRecord(raw, "risk", context);
  const api = optionalRecord(raw, "api", context);
  const storage = optionalRecord(raw, "storage", context);
  const execution = optionalRecord(raw, "execution", context);
  const notifications = optionalRecord(raw, "notifications", context);
  const meteora = optionalRecord(raw, "meteora", context);
  const valuation = optionalRecord(raw, "valuation", context);
  const guardrails = optionalRecord(raw, "guardrails", context);
  const paperTrading = optionalRecord(raw, "paper_trading", context);
  const skillOptimizer = optionalRecord(raw, "skill_optimizer", context);

  const mode = execution ? requireEnum(execution, "mode", EXECUTION_MODES, `${context}.execution`) : "dry_run";
  const live = execution ? optionalRecord(execution, "live", `${context}.execution`) : undefined;
  if (mode !== "dry_run" && !live) {
    throw new Error(`${context}.execution.live 在 ${mode} 模式下必填`);
  }

  return {
    valuation: valuation
      ? {
          sol_price_usd: optionalNumber(valuation, "sol_price_usd", `${context}.valuation`),
          sol_price_usd_env: optionalString(valuation, "sol_price_usd_env", `${context}.valuation`)
        }
      : undefined,
    system: {
      mode: requireString(system, "mode", `${context}.system`),
      main_loop_interval_ms: requireNumber(system, "main_loop_interval_ms", `${context}.system`),
      high_freq_interval_ms: requireNumber(system, "high_freq_interval_ms", `${context}.system`),
      max_concurrent_positions: requireNumber(system, "max_concurrent_positions", `${context}.system`)
    },
    api: api
      ? {
          enabled: optionalBoolean(api, "enabled", `${context}.api`),
          host: optionalString(api, "host", `${context}.api`),
          port: optionalNumber(api, "port", `${context}.api`),
          auth: optionalRecord(api, "auth", `${context}.api`)
            ? {
                bearer_token_env: optionalString(requireRecord(api, "auth", `${context}.api`), "bearer_token_env", `${context}.api.auth`)
              }
            : undefined
        }
      : undefined,
    wallet: {
      active_address: requireString(wallet, "active_address", `${context}.wallet`),
      mode: requireEnum(wallet, "mode", WALLET_MODES, `${context}.wallet`) as AgentConfig["wallet"]["mode"],
      secret: walletSecret
        ? {
            plaintext_env: optionalString(walletSecret, "plaintext_env", `${context}.wallet.secret`),
            encrypted_file_path: optionalString(walletSecret, "encrypted_file_path", `${context}.wallet.secret`),
            encryption_key_env: optionalString(walletSecret, "encryption_key_env", `${context}.wallet.secret`),
            key_version: optionalString(walletSecret, "key_version", `${context}.wallet.secret`),
            allow_secret_forwarding: optionalBoolean(walletSecret, "allow_secret_forwarding", `${context}.wallet.secret`),
            previous_encrypted_file_path: optionalString(walletSecret, "previous_encrypted_file_path", `${context}.wallet.secret`),
            previous_key_version: optionalString(walletSecret, "previous_key_version", `${context}.wallet.secret`)
          }
        : undefined,
      limits: {
        per_transaction_max_sol: requireNumber(walletLimits, "per_transaction_max_sol", `${context}.wallet.limits`),
        daily_cumulative_max_sol: requireNumber(walletLimits, "daily_cumulative_max_sol", `${context}.wallet.limits`)
      }
    },
    rpc: {
      primary: {
        url_env: requireString(rpcPrimary, "url_env", `${context}.rpc.primary`),
        timeout_ms: requireNumber(rpcPrimary, "timeout_ms", `${context}.rpc.primary`)
      },
      backup: {
        url_env: requireString(rpcBackup, "url_env", `${context}.rpc.backup`),
        timeout_ms: requireNumber(rpcBackup, "timeout_ms", `${context}.rpc.backup`)
      },
      grpc: optionalRecord(rpc, "grpc", `${context}.rpc`)
        ? {
            url_env: requireString(requireRecord(rpc, "grpc", `${context}.rpc`), "url_env", `${context}.rpc.grpc`)
          }
        : undefined,
      jito: {
        endpoint: requireString(rpcJito, "endpoint", `${context}.rpc.jito`),
        auth_key_env: optionalString(rpcJito, "auth_key_env", `${context}.rpc.jito`),
        tip_lamports: requireNumber(rpcJito, "tip_lamports", `${context}.rpc.jito`),
        max_retries: requireNumber(rpcJito, "max_retries", `${context}.rpc.jito`)
      }
    },
    execution: execution
      ? {
          mode: mode as NonNullable<AgentConfig["execution"]>["mode"],
          live: live ? normalizeLiveExecution(live, `${context}.execution.live`) : undefined
        }
      : undefined,
    paper_trading: {
      enabled: optionalBoolean(paperTrading ?? {}, "enabled", `${context}.paper_trading`) ?? DEFAULT_PAPER_TRADING.enabled,
      valuation_interval_ms:
        optionalNumber(paperTrading ?? {}, "valuation_interval_ms", `${context}.paper_trading`) ??
        DEFAULT_PAPER_TRADING.valuation_interval_ms,
      fee_capture_rate:
        optionalNumber(paperTrading ?? {}, "fee_capture_rate", `${context}.paper_trading`) ??
        DEFAULT_PAPER_TRADING.fee_capture_rate,
      max_fee_tvl_ratio_24h:
        optionalNumber(paperTrading ?? {}, "max_fee_tvl_ratio_24h", `${context}.paper_trading`) ??
        DEFAULT_PAPER_TRADING.max_fee_tvl_ratio_24h,
      price_exposure:
        optionalNumber(paperTrading ?? {}, "price_exposure", `${context}.paper_trading`) ??
        DEFAULT_PAPER_TRADING.price_exposure,
      out_of_range_penalty_pct_per_bin_width:
        optionalNumber(paperTrading ?? {}, "out_of_range_penalty_pct_per_bin_width", `${context}.paper_trading`) ??
        DEFAULT_PAPER_TRADING.out_of_range_penalty_pct_per_bin_width,
      max_out_of_range_penalty_pct:
        optionalNumber(paperTrading ?? {}, "max_out_of_range_penalty_pct", `${context}.paper_trading`) ??
        DEFAULT_PAPER_TRADING.max_out_of_range_penalty_pct,
      snapshot_retention:
        optionalNumber(paperTrading ?? {}, "snapshot_retention", `${context}.paper_trading`) ??
        DEFAULT_PAPER_TRADING.snapshot_retention
    },
    skill_optimizer: {
      enabled: optionalBoolean(skillOptimizer ?? {}, "enabled", `${context}.skill_optimizer`) ?? DEFAULT_SKILL_OPTIMIZER.enabled,
      min_closed_positions:
        optionalNumber(skillOptimizer ?? {}, "min_closed_positions", `${context}.skill_optimizer`) ??
        DEFAULT_SKILL_OPTIMIZER.min_closed_positions,
      min_snapshots:
        optionalNumber(skillOptimizer ?? {}, "min_snapshots", `${context}.skill_optimizer`) ??
        DEFAULT_SKILL_OPTIMIZER.min_snapshots,
      evaluation_interval_ms:
        optionalNumber(skillOptimizer ?? {}, "evaluation_interval_ms", `${context}.skill_optimizer`) ??
        DEFAULT_SKILL_OPTIMIZER.evaluation_interval_ms,
      max_patch_pct:
        optionalNumber(skillOptimizer ?? {}, "max_patch_pct", `${context}.skill_optimizer`) ??
        DEFAULT_SKILL_OPTIMIZER.max_patch_pct
    },
    guardrails: guardrails
      ? {
          allow_mock_data: optionalBoolean(guardrails, "allow_mock_data", `${context}.guardrails`),
          allow_mock_llm: optionalBoolean(guardrails, "allow_mock_llm", `${context}.guardrails`),
          require_live_preflight: optionalBoolean(guardrails, "require_live_preflight", `${context}.guardrails`),
          active_position_reconcile: guardrails.active_position_reconcile !== undefined
            && guardrails.active_position_reconcile !== null
            ? (requireEnum(
                guardrails,
                "active_position_reconcile",
                ACTIVE_POSITION_RECONCILE_STRATEGIES,
                `${context}.guardrails`
              ) as NonNullable<AgentConfig["guardrails"]>["active_position_reconcile"])
            : undefined,
          persist_failure_strategy: guardrails.persist_failure_strategy !== undefined
            && guardrails.persist_failure_strategy !== null
            ? (requireEnum(
                guardrails,
                "persist_failure_strategy",
                PERSIST_FAILURE_STRATEGIES,
                `${context}.guardrails`
              ) as NonNullable<AgentConfig["guardrails"]>["persist_failure_strategy"])
            : undefined
        }
      : undefined,
    storage: storage
      ? {
          backend: optionalString(storage, "backend", `${context}.storage`) as NonNullable<AgentConfig["storage"]>["backend"],
          state_snapshot_path: optionalString(storage, "state_snapshot_path", `${context}.storage`),
          audit_dir: optionalString(storage, "audit_dir", `${context}.storage`),
          audit_query_limit: optionalNumber(storage, "audit_query_limit", `${context}.storage`),
          audit_retention: optionalRecord(storage, "audit_retention", `${context}.storage`)
            ? {
                enabled: optionalBoolean(requireRecord(storage, "audit_retention", `${context}.storage`), "enabled", `${context}.storage.audit_retention`),
                retention_days: optionalNumber(requireRecord(storage, "audit_retention", `${context}.storage`), "retention_days", `${context}.storage.audit_retention`),
                max_events_per_source: optionalNumber(requireRecord(storage, "audit_retention", `${context}.storage`), "max_events_per_source", `${context}.storage.audit_retention`),
                cleanup_interval_ms: optionalNumber(requireRecord(storage, "audit_retention", `${context}.storage`), "cleanup_interval_ms", `${context}.storage.audit_retention`)
              }
            : undefined,
          mirror_to_file: optionalBoolean(storage, "mirror_to_file", `${context}.storage`),
          runtime_lock: optionalRecord(storage, "runtime_lock", `${context}.storage`)
            ? {
                enabled: optionalBoolean(requireRecord(storage, "runtime_lock", `${context}.storage`), "enabled", `${context}.storage.runtime_lock`),
                key: optionalString(requireRecord(storage, "runtime_lock", `${context}.storage`), "key", `${context}.storage.runtime_lock`),
                file_path: optionalString(requireRecord(storage, "runtime_lock", `${context}.storage`), "file_path", `${context}.storage.runtime_lock`),
                stale_timeout_ms: optionalNumber(requireRecord(storage, "runtime_lock", `${context}.storage`), "stale_timeout_ms", `${context}.storage.runtime_lock`)
              }
            : undefined,
          sqlite: optionalRecord(storage, "sqlite", `${context}.storage`)
            ? {
                db_path: optionalString(requireRecord(storage, "sqlite", `${context}.storage`), "db_path", `${context}.storage.sqlite`)
              }
            : undefined
        }
      : undefined,
    data_providers: {
      gmgn: optionalRecord(dataProviders, "gmgn", `${context}.data_providers`)
        ? normalizeProviderConfig(requireRecord(dataProviders, "gmgn", `${context}.data_providers`), `${context}.data_providers.gmgn`)
        : undefined,
      provider_a: optionalRecord(dataProviders, "provider_a", `${context}.data_providers`)
        ? normalizeProviderConfig(requireRecord(dataProviders, "provider_a", `${context}.data_providers`), `${context}.data_providers.provider_a`)
        : undefined,
      provider_b: optionalRecord(dataProviders, "provider_b", `${context}.data_providers`)
        ? normalizeProviderConfig(requireRecord(dataProviders, "provider_b", `${context}.data_providers`), `${context}.data_providers.provider_b`)
        : undefined,
      cache: {
        stale_tolerance_ms: requireNumber(cache, "stale_tolerance_ms", `${context}.data_providers.cache`),
        full_degradation_ms: requireNumber(cache, "full_degradation_ms", `${context}.data_providers.cache`),
        auto_exit_ms: requireNumber(cache, "auto_exit_ms", `${context}.data_providers.cache`)
      }
    },
    llm: {
      default: normalizeRoute(requireRecord(llm, "default", `${context}.llm`), `${context}.llm.default`),
      classification: optionalRecord(llm, "classification", `${context}.llm`)
        ? normalizeRoute(requireRecord(llm, "classification", `${context}.llm`), `${context}.llm.classification`)
        : undefined,
      fallback: optionalRecord(llm, "fallback", `${context}.llm`)
        ? normalizeRoute(requireRecord(llm, "fallback", `${context}.llm`), `${context}.llm.fallback`)
        : undefined
    },
    risk: {
      max_position_pct: requireNumber(risk, "max_position_pct", `${context}.risk`),
      max_total_lp_pct: requireNumber(risk, "max_total_lp_pct", `${context}.risk`),
      max_token_exposure_pct: requireNumber(risk, "max_token_exposure_pct", `${context}.risk`),
      max_narrative_pools: requireNumber(risk, "max_narrative_pools", `${context}.risk`),
      stop_loss_pct: requireNumber(risk, "stop_loss_pct", `${context}.risk`),
      max_alive_hours: requireNumber(risk, "max_alive_hours", `${context}.risk`),
      daily_max_loss_pct: requireNumber(risk, "daily_max_loss_pct", `${context}.risk`),
      fee_claim_interval_hours: requireNumber(risk, "fee_claim_interval_hours", `${context}.risk`),
      lincoln_exit_threshold: requireNumber(risk, "lincoln_exit_threshold", `${context}.risk`)
    },
    notifications: {
      telegram: notifications && optionalRecord(notifications, "telegram", `${context}.notifications`)
        ? normalizeNotificationRoute(requireRecord(notifications, "telegram", `${context}.notifications`), `${context}.notifications.telegram`)
        : undefined,
      discord: notifications && optionalRecord(notifications, "discord", `${context}.notifications`)
        ? normalizeNotificationRoute(requireRecord(notifications, "discord", `${context}.notifications`), `${context}.notifications.discord`)
        : undefined
    },
    meteora: meteora
      ? {
          sample_pool_path: optionalString(meteora, "sample_pool_path", `${context}.meteora`),
          base_url: optionalString(meteora, "base_url", `${context}.meteora`),
          base_url_env: optionalString(meteora, "base_url_env", `${context}.meteora`),
          timeout_ms: optionalNumber(meteora, "timeout_ms", `${context}.meteora`),
          health_path: optionalString(meteora, "health_path", `${context}.meteora`),
          discovery_path: optionalString(meteora, "discovery_path", `${context}.meteora`),
          discovery_limit: optionalNumber(meteora, "discovery_limit", `${context}.meteora`),
          discovery_sort_by: optionalString(meteora, "discovery_sort_by", `${context}.meteora`),
          discovery_min_volume_24h: optionalNumber(meteora, "discovery_min_volume_24h", `${context}.meteora`),
          discovery_min_tvl: optionalNumber(meteora, "discovery_min_tvl", `${context}.meteora`),
          quote_mint: optionalString(meteora, "quote_mint", `${context}.meteora`)
        }
      : undefined
  };
}

export async function loadAgentConfig(filePath: string): Promise<AgentConfig> {
  const resolvedPath = path.resolve(filePath);
  const raw = asRecord(await readYamlFile(resolvedPath), resolvedPath);
  return normalizeAgentConfig(raw, resolvedPath);
}

export async function loadSkills(directory: string): Promise<SkillMeta[]> {
  const resolvedDirectory = path.resolve(directory);
  const fileNames = await fs.readdir(resolvedDirectory);

  const skills = await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith(".yaml") || fileName.endsWith(".yml"))
      .sort()
      .map(async (fileName) => {
        const fullPath = path.join(resolvedDirectory, fileName);
        const raw = asRecord(await readYamlFile(fullPath), fullPath);
        return normalizeSkill(raw, fullPath);
      })
  );

  return skills;
}
