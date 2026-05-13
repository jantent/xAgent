import { SystemMode } from "../domain/models.js";
import type { PortfolioHealth, ProviderHealthSnapshot } from "../domain/models.js";
import type { Logger } from "../utils/logger.js";

interface RpcHealthInput {
  canWrite: boolean;
}

/**
 * 系统模式是所有动作的总闸门。
 * 任何模块都不应该绕过它直接开仓，否则降级策略就会失效。
 */
export class SystemModeManager {
  private currentMode = SystemMode.NORMAL;

  constructor(
    private readonly maxDailyLossPct: number,
    private readonly fullDegradationMs: number,
    private readonly logger: Logger
  ) {}

  evaluateMode(input: {
    manualPaused: boolean;
    rpcHealth: RpcHealthInput;
    dataHealth: ProviderHealthSnapshot;
    portfolioHealth: PortfolioHealth;
  }): SystemMode {
    if (input.manualPaused) {
      this.currentMode = SystemMode.EMERGENCY_PAUSED;
    } else if (!input.rpcHealth.canWrite) {
      this.currentMode = SystemMode.DEGRADED_READ_ONLY;
    } else if (!input.dataHealth.hasAnyProvider && (input.dataHealth.allProvidersDownForMs ?? 0) >= this.fullDegradationMs) {
      this.currentMode = SystemMode.CLOSE_ONLY;
    } else if (!input.dataHealth.hasAnyProvider) {
      this.currentMode = SystemMode.DEGRADED_NO_SIGNALS;
    } else if (input.portfolioHealth.dailyLossPct > this.maxDailyLossPct) {
      this.currentMode = SystemMode.CLOSE_ONLY;
    } else {
      this.currentMode = SystemMode.NORMAL;
    }

    this.logger.info("系统模式评估完成", {
      mode: this.currentMode,
      manualPaused: input.manualPaused,
      rpcWritable: input.rpcHealth.canWrite,
      hasAnyProvider: input.dataHealth.hasAnyProvider,
      hasPrimaryProvider: input.dataHealth.hasPrimaryProvider,
      allProvidersDownForMs: input.dataHealth.allProvidersDownForMs ?? 0,
      dailyLossPct: input.portfolioHealth.dailyLossPct
    });

    return this.currentMode;
  }

  getCurrentMode(): SystemMode {
    return this.currentMode;
  }
}
