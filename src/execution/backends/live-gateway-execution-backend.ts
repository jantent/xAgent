import type { IExecutionBackend } from "../../domain/contracts.js";
import type {
  ActionExecutionResult,
  ActionType,
  ExecutionBackendStatus,
  ExecutionContext,
  PlannedAction
} from "../../domain/models.js";
import type { AgentConfig, LiveExecutionConfig } from "../../config/types.js";
import type { RPCManager } from "../../managers/rpc-manager.js";
import type { LoadedWalletSecret } from "../../wallet/wallet-secret-manager.js";
import { ExecutionGatewayClient } from "../clients/execution-gateway-client.js";
import type { Logger } from "../../utils/logger.js";

const MUTATING_ACTIONS: ActionType[] = ["open", "close", "rebalance", "claim", "emergency_exit"];

interface GatewayRuntimeConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  healthPath?: string;
  executePath?: string;
}

function isSecretForwardingSafe(baseUrl: string): boolean {
  const parsed = new URL(baseUrl);
  return parsed.protocol === "https:" || parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
}

/**
 * live gateway backend 负责把策略动作转换成稳定的 HTTP 契约，
 * 允许真正的 Meteora/Jupiter/Jito 执行器在独立进程或独立仓库里演进。
 */
export class LiveGatewayExecutionBackend implements IExecutionBackend {
  private status: ExecutionBackendStatus;

  constructor(
    private readonly config: AgentConfig,
    private readonly rpcManager: RPCManager,
    private readonly walletSecret: LoadedWalletSecret | null,
    private readonly gatewayClient: ExecutionGatewayClient,
    private readonly logger: Logger
  ) {
    const liveConfig = this.requireLiveConfig();
    const target = this.tryResolveGatewayBaseUrl(liveConfig);
    this.status = {
      mode: "live_gateway",
      backend: "gateway",
      dryRun: false,
      healthy: Boolean(target),
      supportedActions: liveConfig.supported_actions,
      submissionStrategy: liveConfig.submission_strategy,
      target,
      ...(target
        ? {}
        : {
            lastErrorAt: new Date(),
            lastError: `缺少执行 gateway 地址环境变量 ${liveConfig.gateway.base_url_env}`
          })
    };
  }

  getStatus(): ExecutionBackendStatus {
    return this.status;
  }

  async execute(action: PlannedAction, context: ExecutionContext): Promise<ActionExecutionResult> {
    const liveConfig = this.requireLiveConfig();
    if (!liveConfig.supported_actions.includes(action.type)) {
      return {
        actionId: action.id,
        type: action.type,
        status: "skipped",
        message: `live gateway 未启用 ${action.type} 动作，已跳过。`,
        txSignatures: [],
        latencyMs: 0,
        metadata: {
          backend: "live_gateway",
          submissionStrategy: liveConfig.submission_strategy
        }
      };
    }

    const runtimeConfig = this.resolveGatewayRuntimeConfig(liveConfig);
    const health = await this.gatewayClient.healthCheck(runtimeConfig);
    if (!health.healthy) {
      const message = `execution gateway 健康检查失败: ${health.error ?? "unknown error"}`;
      this.markFailure(message, runtimeConfig.baseUrl);
      throw new Error(message);
    }

    const activeEndpoint = this.rpcManager.getActiveEndpoint();
    const result = await this.gatewayClient.execute({
      action,
      ...runtimeConfig,
      payload: {
        action,
        context: {
          availableCapitalSol: context.availableCapitalSol,
          position: context.position ?? null
        },
        execution: {
          wallet: {
            activeAddress: this.config.wallet.active_address,
            mode: this.config.wallet.mode,
            limits: this.config.wallet.limits,
            secret:
              this.walletSecret?.allowSecretForwarding === true
                ? {
                    value: this.walletSecret.secret,
                    keyVersion: this.walletSecret.keyVersion,
                    source: this.walletSecret.source
                  }
                : undefined
          },
          submissionStrategy: liveConfig.submission_strategy,
          supportedActions: liveConfig.supported_actions,
          jupiter: liveConfig.jupiter,
          meteora: liveConfig.meteora,
          jito: this.config.rpc.jito,
          rpc: {
            activeName: activeEndpoint.name,
            primary: {
              url: process.env[this.config.rpc.primary.url_env],
              timeoutMs: this.config.rpc.primary.timeout_ms
            },
            backup: {
              url: process.env[this.config.rpc.backup.url_env],
              timeoutMs: this.config.rpc.backup.timeout_ms
            },
            grpc: this.config.rpc.grpc
              ? {
                  url: process.env[this.config.rpc.grpc.url_env]
                }
              : undefined
          }
        }
      }
    });

    if (result.status === "success" && MUTATING_ACTIONS.includes(action.type) && !result.stateOperations?.length) {
      this.logger.warn("live gateway 成功返回，但没有附带状态回写操作", {
        actionId: action.id,
        actionType: action.type,
        gatewayTarget: runtimeConfig.baseUrl
      });
    }

    if (result.status === "failed") {
      this.markFailure(`execution gateway 动作失败: ${result.message}`, runtimeConfig.baseUrl);
    } else if (result.status === "success") {
      this.status = {
        ...this.status,
        healthy: true,
        target: runtimeConfig.baseUrl,
        lastSuccessAt: new Date(),
        lastError: undefined,
        lastErrorAt: undefined
      };
    }

    return {
      ...result,
      metadata: {
        ...(result.metadata ?? {}),
        backend: "live_gateway",
        gatewayTarget: runtimeConfig.baseUrl,
        submissionStrategy: liveConfig.submission_strategy,
        rpcProvider: activeEndpoint.name
      }
    };
  }

  private requireLiveConfig(): LiveExecutionConfig {
    if (!this.config.execution?.live) {
      throw new Error("execution.mode=live_gateway 但 execution.live 未配置");
    }

    return this.config.execution.live;
  }

  private tryResolveGatewayBaseUrl(liveConfig: LiveExecutionConfig): string | undefined {
    const value = process.env[liveConfig.gateway.base_url_env];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private resolveGatewayRuntimeConfig(liveConfig: LiveExecutionConfig): GatewayRuntimeConfig {
    const baseUrl = this.tryResolveGatewayBaseUrl(liveConfig);
    if (!baseUrl) {
      const message = `缺少执行 gateway 地址环境变量 ${liveConfig.gateway.base_url_env}`;
      this.markFailure(message);
      throw new Error(message);
    }

    if (this.walletSecret?.allowSecretForwarding === true && !isSecretForwardingSafe(baseUrl)) {
      const message = `gateway ${baseUrl} 不是受信任的 HTTPS/loopback 地址，拒绝透传钱包密钥`;
      this.markFailure(message, baseUrl);
      throw new Error(message);
    }

    const apiKey =
      liveConfig.gateway.api_key_env && process.env[liveConfig.gateway.api_key_env]
        ? process.env[liveConfig.gateway.api_key_env]
        : undefined;

    return {
      baseUrl,
      apiKey,
      timeoutMs: liveConfig.gateway.timeout_ms,
      healthPath: liveConfig.gateway.health_path,
      executePath: liveConfig.gateway.execute_path
    };
  }

  private markFailure(message: string, target?: string): void {
    this.status = {
      ...this.status,
      healthy: false,
      target: target ?? this.status.target,
      lastError: message,
      lastErrorAt: new Date()
    };
  }
}
