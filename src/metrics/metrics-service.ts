import type { DataProviderManager } from "../managers/data-provider-manager.js";
import type { RPCManager } from "../managers/rpc-manager.js";
import type { SkillManager } from "../managers/skill-manager.js";
import type { SharedState } from "../core/shared-state.js";
import type { ActionExecutionResult, CycleResult, ExecutionBackendStatus } from "../domain/models.js";
import { MetricsRegistry } from "./metrics-registry.js";

interface ExecutionStatusProvider {
  getStatus(): ExecutionBackendStatus;
}

interface RuntimeMetadataProvider {
  getStorageStatus(): {
    stateStoreKind: string;
    auditStoreKind: string;
    cacheStoreKind: string;
    sqliteConfigured: boolean;
  };
  getWalletStatus(): {
    secretLoaded: boolean;
    allowSecretForwarding: boolean;
  };
}

/**
 * MetricsService 负责把“代码里的对象状态”翻译成 Prometheus 可消费的指标。
 * 这样业务模块只需要上报事件，不需要关心文本格式。
 */
export class MetricsService {
  private readonly registry = new MetricsRegistry();
  private executionStatusProvider?: ExecutionStatusProvider;
  private runtimeMetadataProvider?: RuntimeMetadataProvider;

  constructor(
    private readonly state: SharedState,
    private readonly skillManager: SkillManager,
    private readonly dataProviderManager: DataProviderManager,
    private readonly rpcManager: RPCManager
  ) {
    this.registry.setGauge(
      "xagent_start_timestamp_seconds",
      "Agent 启动时间戳（秒）",
      Math.floor(this.state.getStartedAt().getTime() / 1000)
    );
  }

  bindExecutionStatusProvider(provider: ExecutionStatusProvider): void {
    this.executionStatusProvider = provider;
  }

  bindRuntimeMetadataProvider(provider: RuntimeMetadataProvider): void {
    this.runtimeMetadataProvider = provider;
  }

  recordCycle(kind: "main" | "high_freq", result: CycleResult): void {
    this.registry.increment(
      "xagent_cycles_total",
      "按类型和结果统计的循环次数",
      {
        kind,
        status: result.failed > 0 ? "failed" : "success",
        mode: result.mode
      }
    );

    this.registry.setGauge("xagent_last_cycle_scanned", "最近一次主循环扫描的池子数量", result.scanned, {
      kind
    });
    this.registry.setGauge("xagent_last_cycle_actions", "最近一次循环生成的动作数量", result.actions.length, {
      kind
    });
    this.registry.setGauge("xagent_last_cycle_executed", "最近一次循环成功执行的动作数量", result.executed, {
      kind
    });
    this.registry.setGauge("xagent_last_cycle_failed", "最近一次循环失败动作数量", result.failed, {
      kind
    });
  }

  recordAction(result: ActionExecutionResult): void {
    this.registry.increment("xagent_actions_total", "按动作类型和状态统计的执行次数", {
      type: result.type,
      status: result.status
    });
  }

  refreshRuntimeGauges(): void {
    const snapshot = this.state.getSnapshot();
    const rpcHealth = this.rpcManager.getHealth();
    const dataHealth = this.dataProviderManager.getHealthSnapshot();
    const skills = this.skillManager.listAll();
    const executionStatus = this.executionStatusProvider?.getStatus();
    const storageStatus = this.runtimeMetadataProvider?.getStorageStatus();
    const walletStatus = this.runtimeMetadataProvider?.getWalletStatus();

    this.registry.setGauge("xagent_manual_pause", "是否处于人工暂停状态", snapshot.manualPause ? 1 : 0);
    this.registry.setGauge("xagent_active_positions", "当前活跃仓位数量", snapshot.activePositions.length);
    this.registry.setGauge("xagent_total_positions", "当前总仓位数量（含已关闭）", snapshot.allPositions.length);
    this.registry.setGauge("xagent_available_capital_sol", "当前可用 SOL 资金", snapshot.availableCapitalSol);
    this.registry.setGauge(
      "xagent_active_costs_paid_sol",
      "当前活跃仓位累计成本（SOL）",
      snapshot.activePositions.reduce((sum, position) => sum + (position.costsPaidSol ?? 0), 0)
    );
    this.registry.setGauge(
      "xagent_stale_active_positions",
      "当前 stale paper mark 的活跃仓位数量",
      snapshot.activePositions.filter((position) => position.paper?.staleReason).length
    );
    this.registry.setGauge(
      "xagent_worst_active_pnl_percent",
      "当前活跃仓位最差 PnL 百分比",
      snapshot.activePositions.reduce((worst, position) => Math.min(worst, position.pnlPercent), 0)
    );
    this.registry.setGauge("xagent_system_mode_info", "当前系统模式信息", 1, {
      mode: snapshot.mode
    });
    this.registry.setGauge("xagent_rpc_active_info", "当前生效中的 RPC 信息", 1, {
      provider: rpcHealth.activeName
    });

    if (storageStatus) {
      this.registry.setGauge("xagent_storage_backend_info", "当前持久化后端信息", 1, {
        state_store: storageStatus.stateStoreKind,
        audit_store: storageStatus.auditStoreKind,
        cache_store: storageStatus.cacheStoreKind
      });
      this.registry.setGauge("xagent_storage_sqlite_configured", "是否已配置 SQLite backend", storageStatus.sqliteConfigured ? 1 : 0);
    }

    if (walletStatus) {
      this.registry.setGauge("xagent_wallet_secret_loaded", "是否已加载钱包 secret", walletStatus.secretLoaded ? 1 : 0);
      this.registry.setGauge(
        "xagent_wallet_secret_forwarding_enabled",
        "是否允许把钱包 secret 转发到 execution gateway",
        walletStatus.allowSecretForwarding ? 1 : 0
      );
    }

    if (executionStatus) {
      this.registry.setGauge("xagent_execution_backend_info", "当前执行后端信息", 1, {
        mode: executionStatus.mode,
        backend: executionStatus.backend,
        submission_strategy: executionStatus.submissionStrategy
      });
      this.registry.setGauge("xagent_execution_backend_up", "当前执行后端健康状态", executionStatus.healthy ? 1 : 0, {
        backend: executionStatus.backend
      });

      if (executionStatus.lastSuccessAt) {
        this.registry.setGauge(
          "xagent_execution_last_success_timestamp_seconds",
          "最近一次成功执行的时间戳",
          Math.floor(executionStatus.lastSuccessAt.getTime() / 1000)
        );
      }

      if (executionStatus.lastErrorAt) {
        this.registry.setGauge(
          "xagent_execution_last_error_timestamp_seconds",
          "最近一次执行后端报错时间戳",
          Math.floor(executionStatus.lastErrorAt.getTime() / 1000)
        );
      }
    }

    for (const status of rpcHealth.statuses) {
      this.registry.setGauge("xagent_rpc_up", "RPC 节点可用状态", status.ok ? 1 : 0, {
        provider: status.provider
      });
      this.registry.setGauge("xagent_rpc_latency_ms", "RPC 节点最近探活延迟", status.latencyMs ?? 0, {
        provider: status.provider
      });
    }

    for (const status of dataHealth.providerStatuses) {
      this.registry.setGauge("xagent_data_provider_up", "数据源可用状态", status.ok ? 1 : 0, {
        provider: status.provider
      });
      this.registry.setGauge("xagent_data_provider_failures", "数据源连续失败次数", status.consecutiveFailures, {
        provider: status.provider
      });
    }

    const skillCounts = new Map<string, number>();
    for (const skill of skills) {
      skillCounts.set(skill.status, (skillCounts.get(skill.status) ?? 0) + 1);
    }

    for (const [status, count] of skillCounts.entries()) {
      this.registry.setGauge("xagent_skills_total", "各生命周期状态下的 Skill 数量", count, {
        status
      });
    }
  }

  renderPrometheus(): string {
    this.refreshRuntimeGauges();
    return this.registry.renderPrometheus();
  }
}
