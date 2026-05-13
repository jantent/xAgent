import type { INotifier } from "../domain/contracts.js";
import type { AlertLevel, CycleResult } from "../domain/models.js";
import type { Logger } from "../utils/logger.js";

export class CompositeNotifier implements INotifier {
  constructor(
    private readonly notifiers: INotifier[],
    private readonly logger: Logger
  ) {}

  async sendCycleSummary(result: CycleResult): Promise<void> {
    await this.fanOut((notifier) => notifier.sendCycleSummary(result), "cycle_summary");
  }

  async sendAlert(level: AlertLevel, title: string, body: string, metadata: Record<string, unknown> = {}): Promise<void> {
    await this.fanOut((notifier) => notifier.sendAlert(level, title, body, metadata), `alert:${level}:${title}`);
  }

  private async fanOut(task: (notifier: INotifier) => Promise<void>, label: string): Promise<void> {
    const results = await Promise.allSettled(this.notifiers.map((notifier) => task(notifier)));
    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.warn("Notifier fan-out 失败", {
          label,
          error: result.reason
        });
      }
    }
  }
}
