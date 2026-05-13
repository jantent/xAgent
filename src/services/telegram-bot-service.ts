import type { AppRuntime } from "../app/runtime.js";
import type { AuditEventRecord } from "../audit/contracts.js";
import type { PositionRecord, PositionStatus } from "../domain/models.js";
import type { Logger } from "../utils/logger.js";

const POSITION_STATUSES = new Set<PositionStatus>(["active", "closed", "closing", "error"]);
const AUDIT_SOURCES = new Set(["actions", "errors", "phases", "cycles", "llm"]);
const TELEGRAM_MESSAGE_LIMIT = 4096;

export interface TelegramBotServiceOptions {
  botToken: string;
  allowedChatIds: string[];
  dashboardUrl?: string;
  apiAuthEnabled: boolean;
  pollIntervalMs: number;
  pollTimeoutSeconds: number;
  requestTimeoutMs: number;
  maxPositions: number;
  maxEvents: number;
  logger: Logger;
}

interface TelegramChat {
  id: number | string;
  type?: string;
  username?: string;
  title?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramReplyMarkup {
  inline_keyboard: Array<Array<{
    text: string;
    callback_data?: string;
    url?: string;
  }>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compactLines(lines: Array<string | undefined | null | false>): string {
  return lines.filter((line): line is string => typeof line === "string" && line.length > 0).join("\n");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 16))}\n...已截断`;
}

function formatNumber(value: number | undefined, digits = 2): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }

  return value.toLocaleString("en-US", {
    maximumFractionDigits: digits
  });
}

function formatSignedPercent(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }

  const sign = value > 0 ? "+" : "";
  return `${sign}${formatNumber(value, 2)}%`;
}

function formatDate(value: Date | string | undefined): string {
  if (!value) {
    return "n/a";
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "n/a" : date.toISOString();
}

function positionAgeHours(position: PositionRecord, now = Date.now()): number {
  return Math.max(0, (now - position.openedAt.getTime()) / 3_600_000);
}

function matchesPosition(position: PositionRecord, query: string): boolean {
  const normalized = query.toLowerCase();
  return [
    position.id,
    position.positionPubkey,
    position.poolAddress,
    position.tokenMint,
    position.tokenSymbol,
    position.skillId,
    position.skillVersion,
    position.status,
    position.narrative ?? ""
  ].some((value) => value.toLowerCase().includes(normalized));
}

function summarizeEvent(event: AuditEventRecord): string {
  const payload = event.payload;
  const cycleId = typeof payload.cycleId === "string" ? payload.cycleId : undefined;
  const action = isRecord(payload.action) ? payload.action : undefined;
  const result = isRecord(payload.result) ? payload.result : undefined;
  const error = isRecord(payload.error) ? payload.error : undefined;
  const phase = typeof payload.phase === "string" ? payload.phase : undefined;

  if (action) {
    const actionType = typeof action.type === "string" ? action.type : "action";
    const trigger = typeof action.trigger === "string" ? action.trigger : undefined;
    const status = typeof result?.status === "string" ? result.status : undefined;
    const message = typeof result?.message === "string" ? result.message : undefined;
    return [actionType, trigger ? `trigger=${trigger}` : undefined, status, message].filter(Boolean).join(" · ");
  }

  if (error) {
    const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
    return `error${phase ? `@${phase}` : ""} · ${message}`;
  }

  if (phase) {
    return `phase=${phase}`;
  }

  if (cycleId) {
    return `cycle=${cycleId}`;
  }

  return truncate(JSON.stringify(payload), 160);
}

function buildHelpText(): string {
  return [
    "[xAgent] Telegram 控制面",
    "",
    "/status - 查看运行状态",
    "/dashboard - 打开 Dashboard 页面",
    "/positions [active|closed|all|closing|error] [关键词] - 查询仓位",
    "/position <id|symbol|mint|pool> - 查看单仓详情",
    "/events [actions|errors|phases|cycles|llm] [关键词] - 查询最近审计事件",
    "/id - 查看当前 Telegram chat_id"
  ].join("\n");
}

export class TelegramBotService {
  private readonly allowedChatIds: Set<string>;
  private running = false;
  private loopPromise?: Promise<void>;
  private nextUpdateOffset?: number;
  private activeController?: AbortController;
  private runtimeDashboardUrl?: string;

  constructor(
    private readonly runtime: AppRuntime,
    private readonly options: TelegramBotServiceOptions
  ) {
    this.allowedChatIds = new Set(options.allowedChatIds.map((chatId) => chatId.trim()).filter(Boolean));
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.loopPromise = this.runLoop();
    this.options.logger.info("Telegram bot 已启动", {
      allowedChats: this.allowedChatIds.size,
      dashboardUrlConfigured: Boolean(this.options.dashboardUrl)
    });
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.activeController?.abort();
    await this.loopPromise?.catch((error) => {
      this.options.logger.warn("Telegram bot 停止时轮询异常", { error });
    });
    this.options.logger.info("Telegram bot 已停止");
  }

  isRunning(): boolean {
    return this.running;
  }

  setRuntimeDashboardUrl(url: string | undefined): void {
    this.runtimeDashboardUrl = url;
  }

  async handleTextForTest(chatId: string, text: string): Promise<string> {
    return await this.renderCommand(chatId, text);
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.getUpdates();
        for (const update of updates) {
          try {
            await this.handleUpdate(update);
          } catch (error) {
            this.options.logger.warn("Telegram update 处理失败", {
              updateId: update.update_id,
              error
            });
          } finally {
            this.nextUpdateOffset = update.update_id + 1;
          }
        }
      } catch (error) {
        if (this.running) {
          this.options.logger.warn("Telegram bot 轮询失败", { error });
          await this.sleep(this.options.pollIntervalMs);
        }
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const pollRequestTimeoutMs = Math.max(
      this.options.requestTimeoutMs,
      this.options.pollTimeoutSeconds * 1000 + 5_000
    );
    return await this.telegramRequest<TelegramUpdate[]>(
      "getUpdates",
      {
        offset: this.nextUpdateOffset,
        timeout: this.options.pollTimeoutSeconds,
        allowed_updates: ["message", "callback_query"]
      },
      pollRequestTimeoutMs
    );
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message?.text) {
      const chatId = String(update.message.chat.id);
      const response = await this.renderCommand(chatId, update.message.text);
      if (response) {
        await this.sendMessage(chatId, response, this.defaultReplyMarkup());
      }
      return;
    }

    const callback = update.callback_query;
    if (!callback?.message || !callback.data) {
      return;
    }

    const chatId = String(callback.message.chat.id);
    if (!this.isAuthorized(chatId)) {
      await this.answerCallbackQuery(callback.id, "未授权");
      return;
    }

    const command = callback.data === "positions_active"
      ? "/positions active"
      : callback.data === "events_recent"
        ? "/events"
        : `/${callback.data}`;
    const response = await this.renderCommand(chatId, command);
    await this.answerCallbackQuery(callback.id, "已刷新");
    if (response) {
      await this.sendMessage(chatId, response, this.defaultReplyMarkup());
    }
  }

  private async renderCommand(chatId: string, text: string): Promise<string> {
    const parsed = this.parseCommand(text);
    if (!parsed) {
      return "";
    }

    if (parsed.command === "id") {
      return `chat_id=${chatId}`;
    }

    if (!this.isAuthorized(chatId)) {
      return `未授权的 Telegram chat_id: ${chatId}\n请把它加入 ${this.runtime.config.notifications.telegram?.bot?.allowed_chat_ids_env ?? this.runtime.config.notifications.telegram?.chat_id_env ?? "TG_CHAT_ID"}`;
    }

    switch (parsed.command) {
      case "start":
      case "help":
        return buildHelpText();
      case "status":
        return this.renderStatus();
      case "dashboard":
      case "page":
        return this.renderDashboard();
      case "positions":
        return this.renderPositions(parsed.args);
      case "position":
        return this.renderPosition(parsed.args);
      case "events":
        return await this.renderEvents(parsed.args);
      default:
        return `未知命令: /${parsed.command}\n\n${buildHelpText()}`;
    }
  }

  private parseCommand(text: string): { command: string; args: string[] } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
      return null;
    }

    const [rawCommand = "", ...args] = trimmed.slice(1).split(/\s+/);
    const command = rawCommand.split("@")[0]?.toLowerCase();
    return command ? { command, args } : null;
  }

  private isAuthorized(chatId: string): boolean {
    return this.allowedChatIds.has(chatId);
  }

  private defaultReplyMarkup(): TelegramReplyMarkup | undefined {
    const dashboardUrl = this.resolveDashboardUrl();
    const keyboard: TelegramReplyMarkup["inline_keyboard"] = [
      [
        { text: "状态", callback_data: "status" },
        { text: "活跃仓位", callback_data: "positions_active" },
        { text: "最近事件", callback_data: "events_recent" }
      ]
    ];

    if (dashboardUrl) {
      keyboard.push([{ text: "打开 Dashboard", url: dashboardUrl }]);
    }

    return {
      inline_keyboard: keyboard
    };
  }

  private renderStatus(): string {
    const snapshot = this.runtime.state.getSnapshot();
    const execution = this.runtime.executionLayer.getStatus();
    const rpc = this.runtime.rpcManager.getHealth();
    const dataProviders = this.runtime.dataProviderManager.getHealthSnapshot();
    const paperTrading = this.runtime.paperTradingService.getSummary();
    const activePositions = this.runtime.state.getActivePositions();
    const averagePnl =
      activePositions.length > 0
        ? activePositions.reduce((sum, position) => sum + position.pnlPercent, 0) / activePositions.length
        : undefined;

    return compactLines([
      "[xAgent] 状态",
      `mode=${snapshot.mode}${snapshot.manualPause ? " manual_paused" : ""}`,
      `execution=${execution.mode}/${execution.backend} healthy=${execution.healthy ? "yes" : "no"}`,
      `capital=${formatNumber(snapshot.availableCapitalSol, 4)} SOL`,
      `positions=${snapshot.activePositions.length}/${snapshot.allPositions.length} active/total avg_pnl=${formatSignedPercent(averagePnl)}`,
      `rpc=${rpc.activeName} write=${rpc.canWrite ? "yes" : "no"}`,
      `data_providers=${dataProviders.hasAnyProvider ? "online" : "offline"} primary=${dataProviders.hasPrimaryProvider ? "yes" : "no"}`,
      `paper=${paperTrading.enabled ? "on" : "off"} snapshots=${paperTrading.snapshotCount} stale=${paperTrading.stalePositions}`,
      `last_main=${formatDate(snapshot.lastMainCycleAt)}`,
      `last_tick=${formatDate(snapshot.lastHighFreqTickAt)}`,
      snapshot.lastPauseReason ? `pause_reason=${snapshot.lastPauseReason}` : undefined,
      this.runtime.state.getLastPersistError() ? `persist_error=${this.runtime.state.getLastPersistError()}` : undefined
    ]);
  }

  private renderDashboard(): string {
    const dashboardUrl = this.resolveDashboardUrl();
    if (!dashboardUrl) {
      return [
        "[xAgent] Dashboard",
        "当前没有可发送的页面地址。",
        "线上部署建议设置 XAGENT_DASHBOARD_URL=https://你的域名/dashboard，然后在 notifications.telegram.bot.dashboard_url_env 中引用它。"
      ].join("\n");
    }

    return compactLines([
      "[xAgent] Dashboard",
      dashboardUrl,
      this.options.apiAuthEnabled ? "控制面启用了 Bearer Token，浏览器打开后会提示输入 XAGENT_API_TOKEN。" : undefined
    ]);
  }

  private renderPositions(args: string[]): string {
    const first = args[0]?.toLowerCase();
    const status = first && POSITION_STATUSES.has(first as PositionStatus) ? (first as PositionStatus) : undefined;
    const showAll = first === "all";
    const query = (status || showAll ? args.slice(1) : args).join(" ").trim();
    const allPositions = this.runtime.state.getAllPositions();
    const filtered = allPositions
      .filter((position) => showAll || position.status === (status ?? "active"))
      .filter((position) => (query ? matchesPosition(position, query) : true))
      .sort((left, right) => right.openedAt.getTime() - left.openedAt.getTime());

    const limit = Math.max(1, this.options.maxPositions);
    const lines = filtered.slice(0, limit).map((position, index) => {
      return [
        `${index + 1}. ${position.tokenSymbol} ${formatSignedPercent(position.pnlPercent)} ${formatNumber(position.depositedSol, 4)} SOL`,
        `   id=${position.id} status=${position.status} skill=${position.skillId}`,
        `   range=${position.fromBinId}-${position.toBinId} in_range=${position.isInRange ? "yes" : "no"} age=${formatNumber(positionAgeHours(position), 1)}h`
      ].join("\n");
    });

    return compactLines([
      `[xAgent] 仓位 ${status ?? (showAll ? "all" : "active")}${query ? ` q=${query}` : ""}`,
      `matched=${filtered.length} showing=${Math.min(filtered.length, limit)} total=${allPositions.length}`,
      lines.length > 0 ? lines.join("\n") : "没有匹配仓位。"
    ]);
  }

  private renderPosition(args: string[]): string {
    const query = args.join(" ").trim();
    if (!query) {
      return "用法: /position <id|symbol|mint|pool>";
    }

    const positions = this.runtime.state
      .getAllPositions()
      .filter((position) => matchesPosition(position, query))
      .sort((left, right) => right.openedAt.getTime() - left.openedAt.getTime());
    const position = positions[0];
    if (!position) {
      return `没有找到匹配仓位: ${query}`;
    }

    return compactLines([
      `[xAgent] 仓位详情 ${position.tokenSymbol}`,
      `id=${position.id}`,
      `status=${position.status} in_range=${position.isInRange ? "yes" : "no"}`,
      `pnl=${formatSignedPercent(position.pnlPercent)} value_usd=${formatNumber(position.currentValueUsd, 2)} deposit=${formatNumber(position.depositedSol, 4)} SOL`,
      `fees_claimed=${formatNumber(position.totalFeesClaimedSol, 4)} SOL rebalance=${position.rebalanceCount}`,
      `skill=${position.skillId}@${position.skillVersion} direction=${position.direction}`,
      `range=${position.fromBinId}-${position.toBinId}`,
      `pool=${position.poolAddress}`,
      `mint=${position.tokenMint}`,
      `position_pubkey=${position.positionPubkey}`,
      `opened=${formatDate(position.openedAt)}`,
      `max_alive_until=${formatDate(position.maxAliveUntil)}`,
      position.closedAt ? `closed=${formatDate(position.closedAt)}` : undefined,
      position.outOfRangeSince ? `out_of_range_since=${formatDate(position.outOfRangeSince)}` : undefined,
      position.paper
        ? `paper_value=${formatNumber(position.paper.currentValueSol, 4)} SOL unclaimed=${formatNumber(position.paper.unclaimedFeesSol, 4)} SOL source=${position.paper.lastSource ?? "n/a"}`
        : undefined,
      position.narrative ? `narrative=${position.narrative}` : undefined
    ]);
  }

  private async renderEvents(args: string[]): Promise<string> {
    const first = args[0]?.toLowerCase();
    const source = first && AUDIT_SOURCES.has(first) ? first : undefined;
    const query = (source ? args.slice(1) : args).join(" ").trim();
    const limit = Math.max(1, this.options.maxEvents);
    const events = this.runtime.auditReader.queryEvents
      ? await this.runtime.auditReader.queryEvents({
          source,
          q: query || undefined,
          limit
        })
      : (await this.runtime.auditReader.readRecent(limit)).filter((event) => {
          if (source && event.source !== source) {
            return false;
          }
          return query ? `${event.source} ${JSON.stringify(event.payload)}`.toLowerCase().includes(query.toLowerCase()) : true;
        });

    const lines = events.slice(0, limit).map((event, index) => {
      const cycleId = typeof event.payload.cycleId === "string" ? ` cycle=${event.payload.cycleId}` : "";
      return `${index + 1}. ${event.source}${cycleId} ${formatDate(event.timestamp)}\n   ${summarizeEvent(event)}`;
    });

    return compactLines([
      `[xAgent] 最近事件${source ? ` source=${source}` : ""}${query ? ` q=${query}` : ""}`,
      lines.length > 0 ? lines.join("\n") : "没有匹配事件。"
    ]);
  }

  private resolveDashboardUrl(): string | undefined {
    return this.options.dashboardUrl || this.runtimeDashboardUrl;
  }

  private async sendMessage(chatId: string, text: string, replyMarkup?: TelegramReplyMarkup): Promise<void> {
    await this.telegramRequest("sendMessage", {
      chat_id: chatId,
      text: truncate(text, TELEGRAM_MESSAGE_LIMIT - 128),
      disable_web_page_preview: true,
      reply_markup: replyMarkup
    });
  }

  private async answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
    await this.telegramRequest("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text
    });
  }

  private async telegramRequest<T = unknown>(
    method: string,
    payload: Record<string, unknown>,
    timeoutMs = this.options.requestTimeoutMs
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    this.activeController = controller;

    try {
      const response = await fetch(`https://api.telegram.org/bot${this.options.botToken}/${method}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const body = (await response.json()) as TelegramApiResponse<T>;
      if (!response.ok || !body.ok) {
        throw new Error(`Telegram API ${method} 失败: ${response.status} ${body.description ?? "unknown error"}`);
      }

      return body.result as T;
    } finally {
      clearTimeout(timer);
      if (this.activeController === controller) {
        this.activeController = undefined;
      }
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
