import type { SharedStateSnapshot } from "../../src/core/shared-state.js";
import type { AgentConfig } from "../../src/config/types.js";
import { SkillStatus, SystemMode, type PlannedAction, type PoolCandidate, type PositionPlan, type PositionRecord, type ReviewedPlan, type SkillMeta } from "../../src/domain/models.js";

type SkillOverrides = Omit<Partial<SkillMeta>, "params" | "riskLimits" | "applicability"> & {
  params?: Partial<SkillMeta["params"]>;
  riskLimits?: Partial<SkillMeta["riskLimits"]>;
  applicability?: Partial<SkillMeta["applicability"]>;
};

type PoolOverrides = Omit<Partial<PoolCandidate>, "meta"> & {
  meta?: Record<string, unknown>;
};

type PositionOverrides = Partial<PositionRecord>;

type PlanOverrides = Omit<Partial<PositionPlan>, "pool" | "skill"> & {
  pool?: PoolOverrides;
  skill?: SkillOverrides;
};

export function createAgentConfig(): AgentConfig {
  return {
    system: {
      mode: "normal",
      main_loop_interval_ms: 1_800_000,
      high_freq_interval_ms: 5_000,
      max_concurrent_positions: 40
    },
    api: {
      enabled: true,
      host: "127.0.0.1",
      port: 8787,
      auth: {
        bearer_token_env: "XAGENT_API_TOKEN"
      }
    },
    wallet: {
      active_address: "9xBvDemoWallet111111111111111111111111111111",
      mode: "injected",
      secret: {
        plaintext_env: "WALLET_PRIVATE_KEY",
        encrypted_file_path: "./config/wallet.enc.json",
        encryption_key_env: "XAGENT_WALLET_KEY",
        key_version: "v1",
        allow_secret_forwarding: false
      },
      limits: {
        per_transaction_max_sol: 5,
        daily_cumulative_max_sol: 50
      }
    },
    rpc: {
      primary: {
        url_env: "PRIMARY_RPC_URL",
        timeout_ms: 10_000
      },
      backup: {
        url_env: "HELIUS_RPC_URL",
        timeout_ms: 10_000
      },
      grpc: {
        url_env: "GRPC_URL"
      },
      jito: {
        endpoint: "https://mainnet.block-engine.jito.wtf",
        auth_key_env: "JITO_AUTH_KEY",
        tip_lamports: 10_000,
        max_retries: 3
      }
    },
    execution: {
      mode: "dry_run",
      live: {
        executor: "sdk",
        supported_actions: ["open", "close", "rebalance", "claim", "emergency_exit"],
        submission_strategy: "jito_then_rpc",
        gateway: {
          base_url_env: "EXECUTION_GATEWAY_URL",
          api_key_env: "EXECUTION_GATEWAY_API_KEY",
          timeout_ms: 15_000,
          health_path: "/health",
          execute_path: "/v1/actions/execute",
          positions_path: "/v1/positions"
        },
        jupiter: {
          quote_base_url: "https://api.jup.ag/swap/v1",
          swap_base_url: "https://api.jup.ag/swap/v1",
          slippage_bps: 100,
          api_key_env: "JUPITER_API_KEY",
          wrap_and_unwrap_sol: true,
          prioritization_fee_lamports: 100_000
        },
        meteora: {
          dlmm_api_base_url: "https://dlmm.datapi.meteora.ag"
        }
      }
    },
    paper_trading: {
      enabled: true,
      valuation_interval_ms: 300_000,
      fee_capture_rate: 0.35,
      max_fee_tvl_ratio_24h: 250,
      price_exposure: 0.5,
      out_of_range_penalty_pct_per_bin_width: 2,
      max_out_of_range_penalty_pct: 35,
      snapshot_retention: 5_000
    },
    cost_model: {
      enabled: false,
      network_fee_lamports: 5_000,
      priority_fee_lamports: 100_000,
      jito_tip_lamports: 10_000,
      rent_per_position_sol: 0.0025,
      slippage_bps: 80,
      rebalance_slippage_bps: 120,
      failed_tx_fee_lamports: 5_000
    },
    skill_optimizer: {
      enabled: true,
      min_closed_positions: 5,
      min_snapshots: 20,
      evaluation_interval_ms: 1_800_000,
      max_patch_pct: 20,
      auto_apply: false,
      min_auto_apply_confidence: 0.75,
      min_auto_apply_closed_positions: 10,
      auto_apply_actions: ["tighten", "widen", "reduce_risk"]
    },
    canary: {
      enabled: false,
      max_concurrent_positions: 1,
      max_position_sol: 0.2,
      kill_switch: {
        enabled: true,
        max_daily_loss_sol: 0.2,
        max_daily_loss_pct: 1,
        max_position_loss_pct: 12,
        max_consecutive_failures: 3,
        max_pending_action_age_ms: 120_000,
        max_stale_position_count: 1
      }
    },
    guardrails: {
      allow_mock_data: true,
      allow_mock_llm: true,
      require_live_preflight: false,
      active_position_reconcile: "fail",
      persist_failure_strategy: "close_only_then_pause"
    },
    storage: {
      backend: "file",
      state_snapshot_path: "./runtime/state.json",
      audit_dir: "./runtime/audit",
      audit_query_limit: 30,
      audit_retention: {
        enabled: true,
        retention_days: 30,
        max_events_per_source: 500_000,
        cleanup_interval_ms: 21_600_000
      },
      mirror_to_file: true,
      runtime_lock: {
        enabled: true,
        key: "xagent:test",
        file_path: "./runtime/runtime.lock",
        stale_timeout_ms: 120_000
      },
      sqlite: {
        db_path: "./runtime/xagent.db"
      }
    },
    data_providers: {
      gmgn: {
        kind: "gmgn_cli",
        priority: 1,
        command: "gmgn-cli",
        chain: "sol",
        api_key_env: "GMGN_API_KEY",
        timeout_ms: 10_000,
        circuit_breaker: {
          failure_threshold: 5,
          recovery_time_ms: 60_000
        }
      },
      provider_a: {
        priority: 2,
        circuit_breaker: {
          failure_threshold: 5,
          recovery_time_ms: 60_000
        }
      },
      provider_b: {
        priority: 3,
        circuit_breaker: {
          failure_threshold: 10,
          recovery_time_ms: 120_000
        }
      },
      cache: {
        stale_tolerance_ms: 300_000,
        full_degradation_ms: 600_000,
        auto_exit_ms: 1_800_000
      }
    },
    llm: {
      default: {
        provider: "mock",
        model: "mock-default"
      },
      classification: {
        provider: "mock",
        model: "mock-classification"
      },
      fallback: {
        provider: "mock",
        model: "mock-fallback"
      }
    },
    risk: {
      max_position_pct: 2,
      max_total_lp_pct: 20,
      max_token_exposure_pct: 5,
      max_narrative_pools: 5,
      stop_loss_pct: 30,
      max_alive_hours: 168,
      daily_max_loss_pct: 5,
      fee_claim_interval_hours: 8,
      lincoln_exit_threshold: 1,
      filters: {
        enabled: false
      }
    },
    notifications: {
      telegram: {
        bot_token_env: "TG_BOT_TOKEN",
        chat_id_env: "TG_CHAT_ID",
        levels: ["critical", "high", "medium"],
        bot: {
          enabled: true,
          allowed_chat_ids_env: "TG_CHAT_ID",
          dashboard_url_env: "XAGENT_DASHBOARD_URL",
          poll_interval_ms: 2_000,
          poll_timeout_seconds: 25,
          request_timeout_ms: 10_000,
          max_positions: 8,
          max_events: 8
        }
      },
      discord: {
        webhook_env: "DISCORD_WEBHOOK",
        levels: ["critical", "high", "low"]
      }
    },
    meteora: {
      sample_pool_path: "./config/sample-pools.json",
      base_url: "https://dlmm.datapi.meteora.ag",
      base_url_env: "METEORA_API_URL",
      timeout_ms: 6_000,
      health_path: "/health",
      discovery_path: "/pools",
      discovery_limit: 10,
      discovery_sort_by: "fee_tvl_ratio_24h:desc",
      discovery_min_volume_24h: 10_000,
      discovery_min_tvl: 5_000,
      quote_mint: "So11111111111111111111111111111111111111112"
    }
  };
}

export function createSkill(overrides: SkillOverrides = {}): SkillMeta {
  const base: SkillMeta = {
    id: "bread_n_butter",
    version: "1.0.0",
    name: "Bread n Butter",
    description: "默认测试策略",
    status: SkillStatus.ACTIVE,
    params: {
      direction: "both",
      distributionType: "Spot",
      binCount: 12,
      binStepPreference: [5, 10],
      feeRatePreference: [40, 80],
      entryConditions: [],
      exitConditions: [],
      rebalanceRules: []
    },
    riskLimits: {
      maxPositionSizePercent: 2,
      maxTotalExposurePercent: 20,
      maxConcurrentPositions: 2,
      stopLossPercent: 20,
      maxAliveHours: 72,
      maxDailyRebalances: 3
    },
    applicability: {
      minLincolnScore: 7,
      minSafetyScore: 70,
      lifecycleStages: ["birth", "hype"]
    },
    changelog: "initial",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z")
  };

  return {
    ...base,
    ...overrides,
    params: {
      ...base.params,
      ...overrides.params
    },
    riskLimits: {
      ...base.riskLimits,
      ...overrides.riskLimits
    },
    applicability: {
      ...base.applicability,
      ...overrides.applicability
    }
  };
}

export function createPoolCandidate(overrides: PoolOverrides = {}): PoolCandidate {
  const base: PoolCandidate = {
    address: "DLMM111111111111111111111111111111111111111",
    tokenMint: "MINT111111111111111111111111111111111111111",
    tokenSymbol: "BONK",
    quoteMint: "So11111111111111111111111111111111111111112",
    binStep: 10,
    feeRatePct: 0.8,
    lincolnScore: 8.5,
    safetyScore: 82,
    organicScore: 75,
    grade: "A",
    lifecycleStage: "hype",
    tvl: 150_000,
    vol24h: 250_000,
    feeTvlRatio24h: 5.2,
    mcap: 5_000_000,
    smartMoneyNet: 35_000,
    dataSource: "mock",
    narrative: "pet meme",
    reasons: ["fee_tvl_ratio high"],
    meta: {
      activeBinId: 8_000
    }
  };

  return {
    ...base,
    ...overrides,
    meta: {
      ...base.meta,
      ...overrides.meta
    }
  };
}

export function createPositionRecord(overrides: PositionOverrides = {}): PositionRecord {
  const base: PositionRecord = {
    id: "position-1",
    positionPubkey: "pubkey-1",
    poolAddress: "DLMM111111111111111111111111111111111111111",
    tokenMint: "MINT111111111111111111111111111111111111111",
    tokenSymbol: "BONK",
    walletAddress: "wallet-1",
    skillId: "bread_n_butter",
    skillVersion: "1.0.0",
    direction: "both",
    fromBinId: 7_995,
    toBinId: 8_005,
    depositedSol: 1.2,
    currentValueUsd: 180,
    pnlPercent: 0,
    isInRange: true,
    totalFeesClaimedSol: 0,
    rebalanceCount: 0,
    status: "active",
    entryLincolnScore: 8.5,
    openedAt: new Date("2026-01-01T00:00:00.000Z"),
    maxAliveUntil: new Date("2026-01-04T00:00:00.000Z"),
    narrative: "pet meme"
  };

  return {
    ...base,
    ...overrides
  };
}

export function createPlan(overrides: PlanOverrides = {}): PositionPlan {
  const { pool: poolOverrides, skill: skillOverrides, ...rest } = overrides;
  const pool = createPoolCandidate(poolOverrides);
  const skill = createSkill(skillOverrides);

  return {
    id: "plan-1",
    score: 9.2,
    reason: "测试计划",
    range: {
      minBinId: 7_994,
      maxBinId: 8_006
    },
    suggestedAmountSol: 1.4,
    ...rest,
    pool,
    skill
  };
}

export function createReviewedPlan(overrides: PlanOverrides & Pick<ReviewedPlan, "approved"> & { rejectionReason?: string }): ReviewedPlan {
  const plan = createPlan(overrides);
  return {
    ...plan,
    approved: overrides.approved,
    ...(overrides.rejectionReason ? { rejectionReason: overrides.rejectionReason } : {})
  };
}

export function createOpenAction(overrides: Partial<PlannedAction> = {}): PlannedAction {
  const plan = createPlan();
  return {
    id: "action-open-1",
    type: "open",
    trigger: "scheduled",
    reason: plan.reason,
    pool: plan.pool,
    skill: plan.skill,
    amountSol: plan.suggestedAmountSol,
    newRange: plan.range,
    ...overrides
  };
}

export function createStateSnapshot(overrides: Partial<SharedStateSnapshot> = {}): SharedStateSnapshot {
  return {
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    mode: SystemMode.NORMAL,
    manualPause: false,
    availableCapitalSol: 10,
    activePositions: [],
    allPositions: [],
    ...overrides
  };
}
