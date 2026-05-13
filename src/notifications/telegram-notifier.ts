import type { INotifier } from "../domain/contracts.js";
import type { AlertLevel, CycleResult } from "../domain/models.js";
import type { NotificationRouteConfig } from "../config/types.js";
import type { Logger } from "../utils/logger.js";

export class TelegramNotifier implements INotifier {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly config: NotificationRouteConfig,
    private readonly logger: Logger
  ) {}

  async sendCycleSummary(result: CycleResult): Promise<void> {
    if (!this.shouldSend("low")) {
      return;
    }

    await this.sendMessage(
      [
        "[xAgent] 主循环摘要",
        `cycle=${result.cycleId}`,
        `mode=${result.mode}`,
        `scanned=${result.scanned}`,
        `plans=${result.plans}`,
        `approved=${result.approved}`,
        `executed=${result.executed}`,
        `failed=${result.failed}`
      ].join("\n")
    );
  }

  async sendAlert(level: AlertLevel, title: string, body: string, metadata: Record<string, unknown> = {}): Promise<void> {
    if (!this.shouldSend(level)) {
      return;
    }

    await this.sendMessage(
      [`[xAgent][${level.toUpperCase()}] ${title}`, body, this.renderMetadata(metadata)].filter(Boolean).join("\n\n")
    );
  }

  private shouldSend(level: AlertLevel): boolean {
    return this.config.levels.includes(level);
  }

  private renderMetadata(metadata: Record<string, unknown>): string {
    const entries = Object.entries(metadata);
    if (entries.length === 0) {
      return "";
    }

    return entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n");
  }

  private async sendMessage(text: string): Promise<void> {
    const endpoint = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        disable_web_page_preview: true
      })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const error = new Error(`Telegram 通知发送失败: ${response.status} ${errorBody}`);
      this.logger.warn("Telegram 通知发送失败", {
        status: response.status,
        errorBody
      });
      throw error;
    }
  }
}
