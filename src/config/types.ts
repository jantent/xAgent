import type { ActionType, ExecutionMode, ExecutionSubmissionStrategy } from "../domain/models.js";

export interface CircuitBreakerConfig {
  failure_threshold: number;
  recovery_time_ms: number;
}

export interface RpcEndpointConfig {
  url_env: string;
  timeout_ms: number;
}

export interface WalletSecretConfig {
  plaintext_env?: string;
  encrypted_file_path?: string;
  encryption_key_env?: string;
  key_version?: string;
  allow_secret_forwarding?: boolean;
  previous_encrypted_file_path?: string;
  previous_key_version?: string;
}

export interface DataProviderConfig {
  kind?: "http" | "gmgn_cli";
  priority: number;
  enabled?: boolean;
  command?: string;
  chain?: string;
  base_url?: string;
  base_url_env?: string;
  api_key_env?: string;
  api_key_header?: string;
  timeout_ms?: number;
  health_path?: string;
  token_safety_path?: string;
  smart_money_path?: string;
  trending_path?: string;
  ohlcv_path?: string;
  urgent_signals_path?: string;
  circuit_breaker: CircuitBreakerConfig;
}

export interface CacheConfig {
  stale_tolerance_ms: number;
  full_degradation_ms: number;
  auto_exit_ms: number;
}

export interface LLMRouteConfig {
  provider: string;
  model: string;
  api_key_env?: string;
  base_url?: string;
  max_tokens?: number;
  temperature?: number;
}

export interface NotificationRouteConfig {
  bot_token_env?: string;
  chat_id_env?: string;
  webhook_env?: string;
  levels: string[];
  bot?: {
    enabled?: boolean;
    allowed_chat_ids_env?: string;
    dashboard_url?: string;
    dashboard_url_env?: string;
    poll_interval_ms?: number;
    poll_timeout_seconds?: number;
    request_timeout_ms?: number;
    max_positions?: number;
    max_events?: number;
  };
}

export interface ExecutionGatewayConfig {
  base_url_env: string;
  api_key_env?: string;
  timeout_ms: number;
  health_path?: string;
  execute_path?: string;
  positions_path?: string;
}

export interface ExecutionJupiterConfig {
  quote_base_url: string;
  swap_base_url: string;
  slippage_bps: number;
  api_key_env?: string;
  wrap_and_unwrap_sol?: boolean;
  prioritization_fee_lamports?: number;
}

export interface ExecutionMeteoraConfig {
  dlmm_api_base_url: string;
}

export interface LiveExecutionConfig {
  executor: "gateway" | "sdk";
  supported_actions: ActionType[];
  submission_strategy: ExecutionSubmissionStrategy;
  gateway: ExecutionGatewayConfig;
  jupiter?: ExecutionJupiterConfig;
  meteora?: ExecutionMeteoraConfig;
}

export interface StorageConfig {
  backend?: "file" | "sqlite";
  state_snapshot_path?: string;
  audit_dir?: string;
  audit_query_limit?: number;
  audit_retention?: {
    enabled?: boolean;
    retention_days?: number;
    max_events_per_source?: number;
    cleanup_interval_ms?: number;
  };
  mirror_to_file?: boolean;
  runtime_lock?: {
    enabled?: boolean;
    key?: string;
    file_path?: string;
    stale_timeout_ms?: number;
  };
  sqlite?: {
    db_path?: string;
  };
}

export interface RuntimeGuardrailsConfig {
  allow_mock_data?: boolean;
  allow_mock_llm?: boolean;
  require_live_preflight?: boolean;
  active_position_reconcile?: "fail" | "close_missing" | "repair";
  persist_failure_strategy?: "off" | "close_only" | "close_only_then_pause";
}

export interface PaperTradingConfig {
  enabled?: boolean;
  valuation_interval_ms?: number;
  fee_capture_rate?: number;
  max_fee_tvl_ratio_24h?: number;
  price_exposure?: number;
  out_of_range_penalty_pct_per_bin_width?: number;
  max_out_of_range_penalty_pct?: number;
  snapshot_retention?: number;
}

export interface SkillOptimizerConfig {
  enabled?: boolean;
  min_closed_positions?: number;
  min_snapshots?: number;
  evaluation_interval_ms?: number;
  max_patch_pct?: number;
}

export interface AgentConfig {
  valuation?: {
    sol_price_usd?: number;
    sol_price_usd_env?: string;
  };
  system: {
    mode: string;
    main_loop_interval_ms: number;
    high_freq_interval_ms: number;
    max_concurrent_positions: number;
  };
  api?: {
    enabled?: boolean;
    host?: string;
    port?: number;
    auth?: {
      bearer_token_env?: string;
    };
  };
  wallet: {
    active_address: string;
    mode: "injected" | "phantom_delegate";
    secret?: WalletSecretConfig;
    limits: {
      per_transaction_max_sol: number;
      daily_cumulative_max_sol: number;
    };
  };
  rpc: {
    primary: RpcEndpointConfig;
    backup: RpcEndpointConfig;
    grpc?: {
      url_env: string;
    };
    jito: {
      endpoint: string;
      auth_key_env?: string;
      tip_lamports: number;
      max_retries: number;
    };
  };
  execution?: {
    mode: ExecutionMode;
    live?: LiveExecutionConfig;
  };
  paper_trading?: PaperTradingConfig;
  skill_optimizer?: SkillOptimizerConfig;
  guardrails?: RuntimeGuardrailsConfig;
  storage?: StorageConfig;
  data_providers: {
    gmgn?: DataProviderConfig;
    provider_a?: DataProviderConfig;
    provider_b?: DataProviderConfig;
    cache: CacheConfig;
  };
  llm: {
    default: LLMRouteConfig;
    classification?: LLMRouteConfig;
    fallback?: LLMRouteConfig;
  };
  risk: {
    max_position_pct: number;
    max_total_lp_pct: number;
    max_token_exposure_pct: number;
    max_narrative_pools: number;
    stop_loss_pct: number;
    max_alive_hours: number;
    daily_max_loss_pct: number;
    fee_claim_interval_hours: number;
    lincoln_exit_threshold: number;
  };
  notifications: {
    telegram?: NotificationRouteConfig;
    discord?: NotificationRouteConfig;
  };
  meteora?: {
    sample_pool_path?: string;
    base_url?: string;
    base_url_env?: string;
    timeout_ms?: number;
    health_path?: string;
    discovery_path?: string;
    discovery_limit?: number;
    discovery_sort_by?: string;
    discovery_min_volume_24h?: number;
    discovery_min_tvl?: number;
    quote_mint?: string;
  };
}
