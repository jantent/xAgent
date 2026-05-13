import type { INotifier } from "../domain/contracts.js";
import type { AlertLevel, CycleResult } from "../domain/models.js";
import type { Logger } from "../utils/logger.js";

/**
 * 通知层当前先输出到控制台。
 * 这样可以把告警和汇总格式先稳定下来，后续再对接 Telegram / Discord。
 */
export class ConsoleNotifier implements INotifier {
  constructor(private readonly logger: Logger) {}

  async sendCycleSummary(result: CycleResult): Promise<void> {
    this.logger.info("主循环摘要", {
      cycleId: result.cycleId,
      mode: result.mode,
      scanned: result.scanned,
      plans: result.plans,
      approved: result.approved,
      executed: result.executed,
      failed: result.failed
    });
  }

  async sendAlert(level: AlertLevel, title: string, body: string, metadata: Record<string, unknown> = {}): Promise<void> {
    this.logger.warn("发送告警", {
      level,
      title,
      body,
      metadata
    });
  }
}
