import { CircuitBreaker } from "../core/circuit-breaker.js";
import type { ProviderHealthStatus } from "../domain/models.js";
import type { AgentConfig } from "../config/types.js";
import { withTimeout } from "../utils/async.js";
import type { Logger } from "../utils/logger.js";

interface RpcHealthState {
  activeName: "primary" | "backup";
  canWrite: boolean;
  statuses: ProviderHealthStatus[];
}

interface RPCManagerOptions {
  allowSimulated?: boolean;
}

/**
 * 真实项目里这里会直接持有 Solana Connection。
 * 当前骨架先把主备切换和探活逻辑写清楚，后续接入 @solana/web3.js 即可替换底层实现。
 */
export class RPCManager {
  private readonly primaryBreaker = new CircuitBreaker("rpc_primary", 3, 60_000);
  private readonly backupBreaker = new CircuitBreaker("rpc_backup", 3, 60_000);
  private activeName: "primary" | "backup" = "primary";
  private primaryStatus: ProviderHealthStatus = {
    provider: "rpc_primary",
    ok: true,
    canRead: true,
    canWrite: true,
    lastCheckedAt: new Date(),
    consecutiveFailures: 0,
    simulated: true
  };
  private backupStatus: ProviderHealthStatus = {
    provider: "rpc_backup",
    ok: true,
    canRead: true,
    canWrite: true,
    lastCheckedAt: new Date(),
    consecutiveFailures: 0,
    simulated: true
  };

  constructor(
    private readonly config: AgentConfig["rpc"],
    private readonly logger: Logger,
    private readonly options: RPCManagerOptions = {}
  ) {}

  async healthCheck(): Promise<void> {
    const primaryUrl = process.env[this.config.primary.url_env];
    const backupUrl = process.env[this.config.backup.url_env];
    const allowSimulated = this.options.allowSimulated !== false;

    if (!primaryUrl && !backupUrl) {
      this.primaryStatus = {
        provider: "rpc_primary",
        ok: allowSimulated,
        canRead: allowSimulated,
        canWrite: allowSimulated,
        lastCheckedAt: new Date(),
        consecutiveFailures: 0,
        simulated: allowSimulated,
        ...(allowSimulated ? {} : { lastError: "rpc_primary 未配置 URL" })
      };
      this.backupStatus = {
        provider: "rpc_backup",
        ok: allowSimulated,
        canRead: allowSimulated,
        canWrite: allowSimulated,
        lastCheckedAt: new Date(),
        consecutiveFailures: 0,
        simulated: allowSimulated,
        ...(allowSimulated ? {} : { lastError: "rpc_backup 未配置 URL" })
      };
      this.activeName = "primary";
      return;
    }

    this.primaryStatus = await this.probeEndpoint(
      "rpc_primary",
      primaryUrl,
      this.config.primary.timeout_ms,
      this.primaryBreaker
    );

    this.backupStatus = await this.probeEndpoint(
      "rpc_backup",
      backupUrl,
      this.config.backup.timeout_ms,
      this.backupBreaker
    );

    if (this.primaryStatus.ok) {
      this.activeName = "primary";
    } else if (this.backupStatus.ok) {
      this.activeName = "backup";
    }
  }

  getHealth(): RpcHealthState {
    const activeStatus = this.activeName === "primary" ? this.primaryStatus : this.backupStatus;
    return {
      activeName: this.activeName,
      canWrite: activeStatus.ok && activeStatus.canWrite,
      statuses: [this.primaryStatus, this.backupStatus]
    };
  }

  getActiveEndpoint(): { name: "primary" | "backup"; url: string } {
    const envKey = this.activeName === "primary" ? this.config.primary.url_env : this.config.backup.url_env;
    return {
      name: this.activeName,
      url: process.env[envKey] ?? `simulated://${this.activeName}`
    };
  }

  private async probeEndpoint(
    providerName: string,
    url: string | undefined,
    timeoutMs: number,
    breaker: CircuitBreaker
  ): Promise<ProviderHealthStatus> {
    if (!url) {
      return {
        provider: providerName,
        ok: false,
        canRead: false,
        canWrite: false,
        lastCheckedAt: new Date(),
        lastError: `${providerName} 未配置 URL`,
        consecutiveFailures: breaker.getConsecutiveFailures()
      };
    }

    const startedAt = Date.now();

    try {
      const response = await withTimeout(
        fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getLatestBlockhash",
            params: []
          })
        }),
        timeoutMs,
        providerName
      );

      if (!response.ok) {
        throw new Error(`${providerName} returned ${response.status}`);
      }

      breaker.recordSuccess();
      return {
        provider: providerName,
        ok: true,
        canRead: true,
        canWrite: true,
        latencyMs: Date.now() - startedAt,
        lastCheckedAt: new Date(),
        consecutiveFailures: breaker.getConsecutiveFailures()
      };
    } catch (error) {
      breaker.recordFailure(error);
      this.logger.warn("RPC 探活失败", { providerName, error });
      return {
        provider: providerName,
        ok: false,
        canRead: false,
        canWrite: false,
        latencyMs: Date.now() - startedAt,
        lastCheckedAt: new Date(),
        lastError: error instanceof Error ? error.message : String(error),
        consecutiveFailures: breaker.getConsecutiveFailures()
      };
    }
  }
}
