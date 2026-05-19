import type { AppRuntime } from "../app/runtime.js";
import type { AuditEventRecord } from "../audit/contracts.js";
import type { ActionType, PositionRecord, PositionStatus } from "../domain/models.js";
import { ControlService } from "./control-service.js";
import type { Logger } from "../utils/logger.js";

const POSITION_STATUSES = new Set<PositionStatus>(["active", "closed", "closing", "error"]);
const AUDIT_SOURCES = new Set(["actions", "errors", "phases", "cycles", "llm"]);
const TRADE_ACTION_TYPES = new Set<ActionType>(["open", "close", "rebalance", "claim", "noop", "emergency_exit"]);
const TRADE_STATUSES = new Set(["success", "failed", "skipped"]);
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

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readDateLike(value: unknown): Date | string | undefined {
  return value instanceof Date || typeof value === "string" ? value : undefined;
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

function formatPositionRef(position: PositionRecord): string {
  const segments = position.id.split("-");
  const suffix = segments[segments.length - 1];
  return suffix && suffix.length >= 4 ? suffix : position.id.slice(-8);
}

function formatSkillLabel(skillId: string): string {
  return skillId.replaceAll("_", " ");
}

function formatRange(position: PositionRecord): string {
  return `bin ${position.fromBinId}..${position.toBinId}`;
}

function formatRangeStatus(position: PositionRecord): string {
  return position.isInRange ? "区间内" : "区间外";
}

function matchesPosition(position: PositionRecord, query: string): boolean {
  const normalized = query.toLowerCase();
  return [
    position.id,
    formatPositionRef(position),
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
    "/status - 查看运行状态与 KPI",
    "/infra - 查看执行/RPC/数据源/存储/钱包",
    "/dashboard - 打开 Dashboard 页面",
    "/positions [active|closed|all|closing|error] [关键词] - 查询仓位",
    "/position <id|symbol|mint|pool> - 查看单仓详情",
    "/trades [open|close|rebalance|claim|emergency_exit|noop] [success|failed|skipped] [关键词] - 查询交易历史",
    "/report [7|30|90] - 查看资产报告",
    "/skills [关键词] - 查看 Skill/实验/Optimizer 摘要",
    "/optimizer - 查看参数优化建议",
    "/events [actions|errors|phases|cycles|llm] [关键词] - 查询最近审计事件",
    "/id - 查看当前 Telegram chat_id"
  ].join("\n");
}

export class TelegramBotService {
  private readonly allowedChatIds: Set<string>;
  private readonly controlService: ControlService;
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
    this.controlService = new ControlService(runtime);
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
        : callback.data === "trades_recent"
          ? "/trades"
          : callback.data === "skills_summary"
            ? "/skills"
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
        return await this.renderStatus();
      case "infra":
        return await this.renderInfra();
      case "dashboard":
      case "page":
        return this.renderDashboard();
      case "positions":
        return this.renderPositions(parsed.args);
      case "position":
        return this.renderPosition(parsed.args);
      case "trades":
      case "trade":
        return await this.renderTrades(parsed.args);
      case "report":
      case "portfolio":
        return await this.renderReport(parsed.args);
      case "skills":
      case "skill":
        return await this.renderSkills(parsed.args);
      case "optimizer":
        return this.renderOptimizer();
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
        { text: "交易", callback_data: "trades_recent" }
      ],
      [
        { text: "Skill", callback_data: "skills_summary" },
        { text: "基础设施", callback_data: "infra" },
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

  private async renderStatus(): Promise<string> {
    const status = await this.controlService.getStatus();
    const portfolio = readRecord(status.portfolio);
    const pnlLedger = readRecord(status.pnlLedger);
    const execution = readRecord(status.execution);
    const canary = readRecord(status.canary);
    const paperTrading = readRecord(status.paperTrading);
    const activePositions = this.runtime.state.getActivePositions();
    const averagePnl =
      activePositions.length > 0
        ? activePositions.reduce((sum, position) => sum + position.pnlPercent, 0) / activePositions.length
        : undefined;

    return compactLines([
      "[xAgent] 状态",
      `mode=${readString(status.mode) ?? "n/a"}${readBoolean(status.manualPause) ? " manual_paused" : ""}`,
      `execution=${readString(execution.mode) ?? "n/a"}/${readString(execution.backend) ?? "n/a"} healthy=${readBoolean(execution.healthy) ? "yes" : "no"}`,
      `capital=${formatNumber(readNumber(status.availableCapitalSol), 4)} SOL`,
      `positions=${formatNumber(readNumber(status.activePositions), 0)}/${formatNumber(readNumber(status.totalPositions), 0)} active/total avg_pnl=${formatSignedPercent(averagePnl)}`,
      `portfolio value=${formatNumber(readNumber(portfolio.totalCurrentValueSol), 4)} SOL exposure=${formatNumber(readNumber(portfolio.exposurePercent), 2)}%`,
      `pnl=${formatNumber(readNumber(pnlLedger.totalPnlSol), 4)} SOL ${formatSignedPercent(readNumber(pnlLedger.totalPnlPercent))}`,
      `canary=${readBoolean(canary.enabled) ? "on" : "off"} stale_active=${formatNumber(readNumber(canary.staleActivePositions), 0)}`,
      `paper=${readBoolean(paperTrading.enabled) ? "on" : "off"} snapshots=${formatNumber(readNumber(paperTrading.snapshotCount), 0)} stale=${formatNumber(readNumber(paperTrading.stalePositions), 0)}`,
      `last_main=${formatDate(readDateLike(status.lastMainCycleAt))}`,
      `last_tick=${formatDate(readDateLike(status.lastHighFreqTickAt))}`,
      readString(status.lastPauseReason) ? `pause_reason=${readString(status.lastPauseReason)}` : undefined,
      this.runtime.state.getLastPersistError() ? `persist_error=${this.runtime.state.getLastPersistError()}` : undefined
    ]);
  }

  private async renderInfra(): Promise<string> {
    const status = await this.controlService.getStatus();
    const execution = readRecord(status.execution);
    const rpc = readRecord(status.rpc);
    const dataProviders = readRecord(status.dataProviders);
    const storage = readRecord(status.storage);
    const runtimeLock = readRecord(status.runtimeLock);
    const wallet = readRecord(status.wallet);

    return compactLines([
      "[xAgent] 基础设施",
      `execution=${readString(execution.mode) ?? "n/a"}/${readString(execution.backend) ?? "n/a"} healthy=${readBoolean(execution.healthy) ? "yes" : "no"}`,
      `rpc=${readString(rpc.activeName) ?? "n/a"} write=${readBoolean(rpc.canWrite) ? "yes" : "no"}`,
      `data_providers=${readBoolean(dataProviders.hasAnyProvider) ? "online" : "offline"} primary=${readBoolean(dataProviders.hasPrimaryProvider) ? "yes" : "no"}`,
      `storage state=${readString(storage.stateStoreKind) ?? "n/a"} audit=${readString(storage.auditStoreKind) ?? "n/a"} cache=${readString(storage.cacheStoreKind) ?? "n/a"}`,
      `sqlite=${readBoolean(storage.sqliteConfigured) ? "configured" : "off"} pool_source=${readString(status.poolSource) ?? "n/a"}`,
      `lock=${readString(runtimeLock.kind) ?? "off"} pid=${formatNumber(readNumber(runtimeLock.pid), 0)} host=${readString(runtimeLock.hostname) ?? "n/a"}`,
      `wallet=${readBoolean(wallet.secretLoaded) ? "SECRET_LOADED" : "ADDRESS_ONLY"} address=${readString(wallet.activeAddress) ?? "n/a"}`,
      readString(status.statePersistenceError) ? `persist_error=${readString(status.statePersistenceError)}` : undefined
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
        `${index + 1}. ${position.tokenSymbol} | PnL ${formatSignedPercent(position.pnlPercent)} | ${formatNumber(position.depositedSol, 4)} SOL | ${formatNumber(positionAgeHours(position), 1)}h`,
        `   ${formatRangeStatus(position)} | ${formatRange(position)} | ${formatSkillLabel(position.skillId)} | ref ${formatPositionRef(position)}`
      ].join("\n");
    });
    const statusLabel = status === "active" || (!status && !showAll) ? "活跃仓位" : showAll ? "全部仓位" : `${status} 仓位`;
    const summary = [
      `${filtered.length} matched`,
      `${Math.min(filtered.length, limit)} showing`,
      `${allPositions.filter((position) => position.status === "active").length} active`,
      `${allPositions.length} total`
    ].join(" / ");

    return compactLines([
      `[xAgent] ${statusLabel}${query ? ` · ${query}` : ""}`,
      summary,
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
      `状态 ${position.status} | ${formatRangeStatus(position)} | PnL ${formatSignedPercent(position.pnlPercent)}`,
      `资金 ${formatNumber(position.depositedSol, 4)} SOL | 估值 $${formatNumber(position.currentValueUsd, 2)} | 手续费 ${formatNumber(position.totalFeesClaimedSol, 4)} SOL`,
      `策略 ${formatSkillLabel(position.skillId)}@${position.skillVersion} | ${position.direction}`,
      `${formatRange(position)} | 已重平衡 ${position.rebalanceCount} 次`,
      `开仓 ${formatDate(position.openedAt)}`,
      `最长持有到 ${formatDate(position.maxAliveUntil)}`,
      position.closedAt ? `平仓 ${formatDate(position.closedAt)}` : undefined,
      position.outOfRangeSince ? `出界开始 ${formatDate(position.outOfRangeSince)}` : undefined,
      position.paper
        ? `Paper ${formatNumber(position.paper.currentValueSol, 4)} SOL | 未领 ${formatNumber(position.paper.unclaimedFeesSol, 4)} SOL | ${position.paper.lastSource ?? "n/a"}`
        : undefined,
      position.narrative ? `叙事 ${position.narrative}` : undefined,
      `短码 ${formatPositionRef(position)}`,
      `内部ID ${position.id}`,
      `Pool ${position.poolAddress}`,
      `Mint ${position.tokenMint}`,
      `Position ${position.positionPubkey}`
    ]);
  }

  private async renderTrades(args: string[]): Promise<string> {
    const first = args[0]?.toLowerCase();
    const actionType = first && TRADE_ACTION_TYPES.has(first as ActionType) ? (first as ActionType) : undefined;
    const second = args[actionType ? 1 : 0]?.toLowerCase();
    const status = second && TRADE_STATUSES.has(second) ? second : undefined;
    const queryStart = (actionType ? 1 : 0) + (status ? 1 : 0);
    const query = args.slice(queryStart).join(" ").trim();
    const payload = await this.controlService.getTradeHistory({
      limit: Math.max(1, this.options.maxEvents),
      offset: 0,
      actionType,
      status: status as "success" | "failed" | "skipped" | undefined,
      token: query || undefined
    });
    const summary = readRecord(payload.summary);
    const trades = Array.isArray(payload.trades) ? payload.trades.filter(isRecord) : [];
    const lines = trades.map((trade, index) => {
      const pnl = readNumber(trade.realizedPnlPercent);
      const capital = readNumber(trade.recoveredSol) ?? readNumber(trade.depositedSol) ?? readNumber(trade.capitalDeltaSol);
      return [
        `${index + 1}. ${readString(trade.actionType) ?? "action"} ${readString(trade.status) ?? "n/a"} | ${readString(trade.tokenSymbol) ?? "n/a"} | PnL ${formatSignedPercent(pnl)}`,
        `   ${formatNumber(capital, 4)} SOL | ${readString(trade.skillId) ?? "n/a"} | ${formatDate(readDateLike(trade.timestamp))}`,
        readString(trade.message) ? `   ${readString(trade.message)}` : undefined
      ].filter(Boolean).join("\n");
    });

    return compactLines([
      `[xAgent] 交易历史${actionType ? ` action=${actionType}` : ""}${status ? ` status=${status}` : ""}${query ? ` q=${query}` : ""}`,
      `total=${formatNumber(readNumber(summary.total), 0)} success=${formatNumber(readNumber(summary.success), 0)} failed=${formatNumber(readNumber(summary.failed), 0)} skipped=${formatNumber(readNumber(summary.skipped), 0)}`,
      `realized=${formatNumber(readNumber(summary.totalRealizedPnlSol), 4)} SOL avg=${formatSignedPercent(readNumber(summary.averageRealizedPnlPercent))} fees=${formatNumber(readNumber(summary.totalFeesClaimedSol), 4)} SOL`,
      lines.length > 0 ? lines.join("\n") : "没有匹配交易。"
    ]);
  }

  private async renderReport(args: string[]): Promise<string> {
    const requestedDays = Number(args[0]);
    const days = requestedDays === 30 || requestedDays === 90 ? requestedDays : 7;
    const payload = await this.controlService.getPortfolioReport({
      days,
      timezoneOffsetMinutes: new Date().getTimezoneOffset()
    });
    const range = readRecord(payload.range);
    const summary = readRecord(payload.summary);
    const dataQuality = readRecord(summary.dataQuality);
    const bestDay = readRecord(summary.bestDay);
    const worstDay = readRecord(summary.worstDay);
    const current = readRecord(summary.current);

    return compactLines([
      `[xAgent] 资产报告 ${formatNumber(readNumber(range.days), 0)}天`,
      `${readString(range.startDate) ?? "n/a"} .. ${readString(range.endDate) ?? "n/a"}`,
      `pnl=${formatNumber(readNumber(summary.totalPnlSol), 4)} SOL ${formatSignedPercent(readNumber(summary.totalPnlPercent))} / $${formatNumber(readNumber(summary.totalPnlUsd), 2)}`,
      `trades=${formatNumber(readNumber(summary.tradeCount), 0)} data_days=${formatNumber(readNumber(summary.dataDays), 0)} +days=${formatNumber(readNumber(summary.positiveDays), 0)} -days=${formatNumber(readNumber(summary.negativeDays), 0)}`,
      `current value=${formatNumber(readNumber(current.totalCurrentValueSol), 4)} SOL exposure=${formatNumber(readNumber(current.exposurePercent), 2)}%`,
      readString(bestDay.date) ? `best=${readString(bestDay.date)} ${formatNumber(readNumber(bestDay.pnlSol), 4)} SOL` : undefined,
      readString(worstDay.date) ? `worst=${readString(worstDay.date)} ${formatNumber(readNumber(worstDay.pnlSol), 4)} SOL` : undefined,
      `snapshots=${formatNumber(readNumber(dataQuality.snapshotCount), 0)} stale=${formatNumber(readNumber(dataQuality.staleSnapshotCount), 0)} rejected=${formatNumber(readNumber(dataQuality.rejectedSnapshotCount), 0)}`
    ]);
  }

  private async renderSkills(args: string[]): Promise<string> {
    const query = args.join(" ").trim().toLowerCase();
    const skills = this.runtime.skillStatsService
      .enrichSkills(this.runtime.skillManager.listAll())
      .filter((skill) => {
        if (!query) {
          return true;
        }
        return `${skill.id} ${skill.name} ${skill.version} ${skill.status} ${skill.description ?? ""}`.toLowerCase().includes(query);
      });
    const recommendations = readRecord(this.controlService.getSkillOptimizationRecommendations());
    const recommendationItems = Array.isArray(recommendations.recommendations)
      ? recommendations.recommendations.filter(isRecord)
      : [];
    const experiments = readRecord(this.controlService.getStrategyExperiments());
    const experimentItems = Array.isArray(experiments.experiments) ? experiments.experiments.filter(isRecord) : [];
    const limit = Math.max(1, this.options.maxPositions);
    const lines = skills.slice(0, limit).map((skill, index) => {
      const stats = readRecord(skill.stats);
      const recommendation = recommendationItems.find((item) => item.skillId === skill.id && item.skillVersion === skill.version);
      const experiment = experimentItems.find((item) => item.skillId === skill.id && item.skillVersion === skill.version);
      return [
        `${index + 1}. ${skill.id}@${skill.version} | ${skill.status} | canary=${formatNumber(skill.canaryPercent, 0)}%`,
        `   positions=${formatNumber(readNumber(stats.totalPositions), 0)} win=${formatNumber(readNumber(stats.winRate), 1)}% pnl=$${formatNumber(readNumber(stats.estimatedPnlUsd), 2)} experiment=${readString(experiment?.status) ?? "n/a"}`,
        recommendation ? `   optimizer=${readString(recommendation.suggestedAction) ?? "hold"}${readString(recommendation.disabledReason) ? ` disabled=${readString(recommendation.disabledReason)}` : ""}` : undefined
      ].filter(Boolean).join("\n");
    });

    return compactLines([
      `[xAgent] Skill 摘要${query ? ` · ${query}` : ""}`,
      `${skills.length} matched / ${Math.min(skills.length, limit)} showing`,
      lines.length > 0 ? lines.join("\n") : "没有匹配 Skill。"
    ]);
  }

  private renderOptimizer(): string {
    const payload = readRecord(this.controlService.getSkillOptimizationRecommendations());
    const summary = readRecord(payload.summary);
    const recommendations = Array.isArray(payload.recommendations) ? payload.recommendations.filter(isRecord) : [];
    const limit = Math.max(1, this.options.maxEvents);
    const lines = recommendations.slice(0, limit).map((recommendation, index) => {
      const paramsPatch = readRecord(recommendation.paramsPatch);
      const riskLimitsPatch = readRecord(recommendation.riskLimitsPatch);
      const patchKeys = [...Object.keys(paramsPatch), ...Object.keys(riskLimitsPatch)];
      return [
        `${index + 1}. ${readString(recommendation.skillId) ?? "n/a"}@${readString(recommendation.skillVersion) ?? "n/a"} | ${readString(recommendation.suggestedAction) ?? "hold"}`,
        `   confidence=${formatNumber(readNumber(recommendation.confidence), 2)} patch=${patchKeys.join(", ") || "none"}${readString(recommendation.disabledReason) ? ` disabled=${readString(recommendation.disabledReason)}` : ""}`
      ].join("\n");
    });

    return compactLines([
      "[xAgent] Optimizer 建议",
      `summary enabled=${readBoolean(summary.enabled) ? "yes" : "no"} total=${formatNumber(readNumber(summary.recommendationCount), 0)} auto_apply=${readBoolean(summary.autoApply) ? "yes" : "no"}`,
      readString(summary.disabledReason) ? `disabled_reason=${readString(summary.disabledReason)}` : undefined,
      lines.length > 0 ? lines.join("\n") : "当前没有优化建议。"
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
