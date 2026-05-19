import path from "node:path";

import { Connection, PublicKey } from "@solana/web3.js";

import type { IAuditReader } from "../audit/contracts.js";
import { AuditRetentionService } from "../audit/audit-retention-service.js";
import { CompositeAuditLogger } from "../audit/composite-audit-logger.js";
import { FileAuditReader } from "../audit/file-audit-reader.js";
import { FileAuditLogger } from "../audit/file-audit-logger.js";
import { SqliteAuditLogger } from "../audit/sqlite-audit-logger.js";
import { SqliteAuditReader } from "../audit/sqlite-audit-reader.js";
import { loadAgentConfig, loadSkills } from "../config/loader.js";
import type { AgentConfig, DataProviderConfig } from "../config/types.js";
import { SharedState } from "../core/shared-state.js";
import type { IAuditLogger, IDataProvider, INotifier, IPoolSource } from "../domain/contracts.js";
import type { PositionRecord } from "../domain/models.js";
import { DryRunExecutionBackend } from "../execution/backends/dry-run-execution-backend.js";
import { LiveGatewayExecutionBackend } from "../execution/backends/live-gateway-execution-backend.js";
import { ExecutionGatewayClient } from "../execution/clients/execution-gateway-client.js";
import { JitoBlockEngineClient } from "../execution/clients/jito-block-engine-client.js";
import { JupiterMetisClient } from "../execution/clients/jupiter-metis-client.js";
import { ExecutionLayer } from "../execution/execution-layer.js";
import { SharedStateExecutionJournal } from "../execution/execution-journal.js";
import { LiveSdkExecutionBackend } from "../execution/backends/live-sdk-execution-backend.js";
import { DataProviderManager } from "../managers/data-provider-manager.js";
import { LLMManager } from "../managers/llm-manager.js";
import { RPCManager } from "../managers/rpc-manager.js";
import { SkillManager } from "../managers/skill-manager.js";
import { SystemModeManager } from "../managers/system-mode-manager.js";
import { MetricsService } from "../metrics/metrics-service.js";
import { PoolScout } from "../modules/pool-scout.js";
import { PortfolioManager } from "../modules/portfolio-manager.js";
import { RiskSentinel } from "../modules/risk-sentinel.js";
import { StrategySelector } from "../modules/strategy-selector.js";
import { CompositeNotifier } from "../notifications/composite-notifier.js";
import { ConsoleNotifier } from "../notifications/console-notifier.js";
import { DiscordNotifier } from "../notifications/discord-notifier.js";
import { TelegramNotifier } from "../notifications/telegram-notifier.js";
import { Orchestrator } from "../orchestration/orchestrator.js";
import type { ICacheStore, IStateStore } from "../persistence/contracts.js";
import { FileStateStore } from "../persistence/file-state-store.js";
import { MemoryCacheStore } from "../persistence/memory-cache-store.js";
import { MirroredStateStore } from "../persistence/mirrored-state-store.js";
import { openSqliteDatabase, type SqliteHandle } from "../persistence/sqlite-database.js";
import { SqliteStateStore } from "../persistence/sqlite-state-store.js";
import { GmgnCliDataProvider } from "../providers/data/gmgn-cli-data-provider.js";
import { HttpMarketDataProvider } from "../providers/data/http-market-data-provider.js";
import { MockMarketDataProvider } from "../providers/data/mock-market-data-provider.js";
import { FallbackPoolSource } from "../providers/pools/fallback-pool-source.js";
import { HttpMeteoraPoolSource } from "../providers/pools/http-meteora-pool-source.js";
import { MockMeteoraPoolSource } from "../providers/pools/mock-meteora-pool-source.js";
import { SkillStatsService } from "../services/skill-stats-service.js";
import { SkillOptimizerService } from "../services/skill-optimizer-service.js";
import { PaperTradingService } from "../services/paper-trading-service.js";
import { TelegramBotService } from "../services/telegram-bot-service.js";
import { rootLogger } from "../utils/logger.js";
import type { LoadedWalletSecret } from "../wallet/wallet-secret-manager.js";
import { WalletSecretManager } from "../wallet/wallet-secret-manager.js";
import {
  enforceRuntimeGuardrails,
  resolveRuntimeGuardrails,
  validateMirroredActivePositions
} from "./runtime-guardrails.js";
import { acquireRuntimeLock, type RuntimeLockLease } from "./runtime-lock.js";
import { reconcileStartupState } from "./startup-reconciliation.js";

export interface RuntimeBootstrapOptions {
  cwd: string;
  configPath: string;
  skillsPath: string;
}

export interface AppRuntime {
  config: AgentConfig;
  configPath: string;
  skillsPath: string;
  samplePoolPath: string;
  auditDir: string;
  stateSnapshotPath: string;
  poolSourceName: string;
  storage: {
    stateStoreKind: string;
    auditStoreKind: string;
    cacheStoreKind: string;
    sqliteConfigured: boolean;
  };
  wallet: {
    activeAddress: string;
    secretLoaded: boolean;
    secretSource?: string;
    keyVersion?: string;
    allowSecretForwarding: boolean;
  };
  lock: RuntimeLockLease | null;
  state: SharedState;
  skillManager: SkillManager;
  skillStatsService: SkillStatsService;
  skillOptimizerService: SkillOptimizerService;
  dataProviderManager: DataProviderManager;
  rpcManager: RPCManager;
  metricsService: MetricsService;
  executionLayer: ExecutionLayer;
  paperTradingService: PaperTradingService;
  telegramBot: TelegramBotService | null;
  auditReader: IAuditReader;
  orchestrator: Orchestrator;
  shutdown(): Promise<void>;
}

function createNotifier(config: AgentConfig): CompositeNotifier {
  const logger = rootLogger.child("notifier");
  const notifiers: INotifier[] = [new ConsoleNotifier(logger.child("console"))];

  const telegramConfig = config.notifications.telegram;
  if (telegramConfig?.bot_token_env && telegramConfig.chat_id_env) {
    const botToken = process.env[telegramConfig.bot_token_env];
    const chatId = process.env[telegramConfig.chat_id_env];
    const chatIds = parseTelegramChatIds(chatId);
    if (botToken && chatIds.length > 0) {
      notifiers.push(new TelegramNotifier(botToken, chatIds, telegramConfig, logger.child("telegram")));
    } else {
      logger.warn("Telegram notifier 未启用，缺少环境变量", {
        botTokenEnv: telegramConfig.bot_token_env,
        chatIdEnv: telegramConfig.chat_id_env
      });
    }
  }

  const discordConfig = config.notifications.discord;
  if (discordConfig?.webhook_env) {
    const webhookUrl = process.env[discordConfig.webhook_env];
    if (webhookUrl) {
      notifiers.push(new DiscordNotifier(webhookUrl, discordConfig, logger.child("discord")));
    } else {
      logger.warn("Discord notifier 未启用，缺少环境变量", {
        webhookEnv: discordConfig.webhook_env
      });
    }
  }

  return new CompositeNotifier(notifiers, logger.child("fanout"));
}

function parseTelegramChatIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function createTelegramBotService(config: AgentConfig, runtime: AppRuntime): TelegramBotService | null {
  const telegramConfig = config.notifications.telegram;
  const botConfig = telegramConfig?.bot;
  if (!telegramConfig || botConfig?.enabled !== true) {
    return null;
  }

  const logger = rootLogger.child("telegram_bot");
  const botToken = telegramConfig.bot_token_env ? process.env[telegramConfig.bot_token_env] : undefined;
  if (!botToken) {
    logger.warn("Telegram bot 未启用，缺少 bot token 环境变量", {
      botTokenEnv: telegramConfig.bot_token_env
    });
    return null;
  }

  const allowedChatIdsEnv = botConfig.allowed_chat_ids_env ?? telegramConfig.chat_id_env;
  const allowedChatIds = parseTelegramChatIds(allowedChatIdsEnv ? process.env[allowedChatIdsEnv] : undefined);
  if (allowedChatIds.length === 0) {
    logger.warn("Telegram bot 未启用，缺少授权 chat_id 环境变量", {
      allowedChatIdsEnv
    });
    return null;
  }

  return new TelegramBotService(runtime, {
    botToken,
    allowedChatIds,
    dashboardUrl: resolveConfiguredUrl(botConfig.dashboard_url, botConfig.dashboard_url_env),
    apiAuthEnabled: Boolean(config.api?.auth?.bearer_token_env && process.env[config.api.auth.bearer_token_env]),
    pollIntervalMs: botConfig.poll_interval_ms ?? 2_000,
    pollTimeoutSeconds: botConfig.poll_timeout_seconds ?? 25,
    requestTimeoutMs: botConfig.request_timeout_ms ?? 10_000,
    maxPositions: botConfig.max_positions ?? 8,
    maxEvents: botConfig.max_events ?? 8,
    logger
  });
}

function createExecutionLayer(
  config: AgentConfig,
  state: SharedState,
  rpcManager: RPCManager,
  metricsService: MetricsService,
  walletSecret: LoadedWalletSecret | null
): ExecutionLayer {
  const executionLogger = rootLogger.child("execution");
  const mode = config.execution?.mode ?? "dry_run";
  const executionJournal = new SharedStateExecutionJournal(state, executionLogger.child("journal"));
  const backend =
    mode === "live_gateway"
      ? new LiveGatewayExecutionBackend(
          config,
          rpcManager,
          walletSecret,
          new ExecutionGatewayClient(executionLogger.child("gateway_client")),
          executionLogger.child("backend.live_gateway")
        )
      : mode === "live_sdk"
        ? new LiveSdkExecutionBackend(
            config,
            rpcManager,
            walletSecret,
            new JupiterMetisClient(executionLogger.child("jupiter_client")),
            new JitoBlockEngineClient(executionLogger.child("jito_client")),
            executionLogger.child("backend.live_sdk"),
            executionJournal
          )
        : new DryRunExecutionBackend(config, rpcManager, executionLogger.child("backend.dry_run"));

  return new ExecutionLayer(state, metricsService, backend, executionLogger, executionJournal);
}

function createCacheStore(): ICacheStore {
  return new MemoryCacheStore();
}

function createStateStore(config: AgentConfig, options: {
  stateSnapshotPath: string;
  sqliteHandle?: SqliteHandle;
}): IStateStore {
  const fileStore = new FileStateStore(options.stateSnapshotPath);
  if (config.storage?.backend !== "sqlite" || !options.sqliteHandle) {
    return fileStore;
  }

  const primary = new SqliteStateStore(options.sqliteHandle);
  const mirrors = config.storage?.mirror_to_file === false ? [] : [fileStore];
  return new MirroredStateStore(primary, mirrors, rootLogger.child("state_store.mirror"));
}

async function checkPositionAccountExists(rpcManager: RPCManager, positionPubkey: string): Promise<boolean> {
  const endpoint = rpcManager.getActiveEndpoint();
  if (!endpoint.url || endpoint.url.startsWith("simulated://")) {
    throw new Error("live preflight 缺少真实 RPC 连接，无法校验链上仓位账户");
  }

  try {
    const connection = new Connection(endpoint.url, "confirmed");
    const account = await connection.getAccountInfo(new PublicKey(positionPubkey), "confirmed");
    return Boolean(account);
  } catch {
    return false;
  }
}

async function inspectTransactions(
  rpcManager: RPCManager,
  signerAddress: string,
  signatures: string[]
): Promise<Array<{
  signature: string;
  confirmed: boolean;
  confirmedAt?: Date;
  walletDeltaSol?: number;
}>> {
  const endpoint = rpcManager.getActiveEndpoint();
  if (!endpoint.url || endpoint.url.startsWith("simulated://")) {
    throw new Error("startup reconcile 缺少真实 RPC 连接，无法检查交易状态");
  }

  const connection = new Connection(endpoint.url, "confirmed");
  return Promise.all(
    signatures.map(async (signature) => {
      const transaction = await connection.getParsedTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });
      if (!transaction || transaction.meta?.err) {
        return {
          signature,
          confirmed: false
        };
      }

      const walletIndex = transaction.transaction.message.accountKeys.findIndex((accountKey) => {
        if (typeof accountKey === "string") {
          return accountKey === signerAddress;
        }
        if ("pubkey" in accountKey && accountKey.pubkey instanceof PublicKey) {
          return accountKey.pubkey.toBase58() === signerAddress;
        }
        return false;
      });

      const walletDeltaLamports =
        walletIndex >= 0 && transaction.meta
          ? (transaction.meta.postBalances[walletIndex] ?? 0) - (transaction.meta.preBalances[walletIndex] ?? 0)
          : undefined;

      return {
        signature,
        confirmed: true,
        confirmedAt: typeof transaction.blockTime === "number" ? new Date(transaction.blockTime * 1000) : undefined,
        walletDeltaSol:
          typeof walletDeltaLamports === "number" ? walletDeltaLamports / 1_000_000_000 : undefined
      };
    })
  );
}

function createAuditInfrastructure(
  config: AgentConfig,
  options: {
    auditDir: string;
    sqliteHandle?: SqliteHandle;
  }
): {
  auditLogger: IAuditLogger;
  auditReader: IAuditReader;
  auditStoreKind: string;
  close: () => Promise<void>;
} {
  const fileAuditLogger = new FileAuditLogger(options.auditDir, rootLogger.child("audit.file"));
  const fileAuditReader = new FileAuditReader(options.auditDir);

  if (config.storage?.backend !== "sqlite" || !options.sqliteHandle) {
    return {
      auditLogger: fileAuditLogger,
      auditReader: fileAuditReader,
      auditStoreKind: "file",
      close: async () => undefined
    };
  }

  const sqliteAuditLogger = new SqliteAuditLogger(options.sqliteHandle);
  const sqliteAuditReader = new SqliteAuditReader(options.sqliteHandle);
  const mirrorToFile = config.storage?.mirror_to_file !== false;

  return {
    auditLogger: mirrorToFile
      ? new CompositeAuditLogger([sqliteAuditLogger, fileAuditLogger], rootLogger.child("audit.composite"))
      : sqliteAuditLogger,
    auditReader: sqliteAuditReader,
    auditStoreKind: mirrorToFile ? "sqlite+file" : "sqlite",
    close: async () => undefined
  };
}

async function loadWalletSecret(cwd: string, config: AgentConfig): Promise<LoadedWalletSecret | null> {
  const manager = new WalletSecretManager(cwd, config.wallet.secret, rootLogger.child("wallet_secret"));
  return manager.load();
}

function resolveConfiguredUrl(baseUrl?: string, envKey?: string): string | undefined {
  const envValue = envKey ? process.env[envKey]?.trim() : undefined;
  if (envValue) {
    return envValue;
  }

  return baseUrl?.trim() || undefined;
}

function createDataProvider(
  name: string,
  providerConfig: DataProviderConfig | undefined,
  loggerSuffix: string
): IDataProvider | undefined {
  if (!providerConfig || providerConfig.enabled === false) {
    return undefined;
  }

  if (providerConfig.kind === "gmgn_cli") {
    const apiKey = providerConfig.api_key_env ? process.env[providerConfig.api_key_env] : undefined;
    return new GmgnCliDataProvider({
      name,
      priority: providerConfig.priority,
      command: providerConfig.command,
      chain: providerConfig.chain,
      apiKeyEnv: providerConfig.api_key_env,
      apiKey,
      timeoutMs: providerConfig.timeout_ms,
      logger: rootLogger.child(loggerSuffix)
    });
  }

  const baseUrl = resolveConfiguredUrl(providerConfig.base_url, providerConfig.base_url_env);
  if (!baseUrl) {
    return undefined;
  }

  const apiKey = providerConfig.api_key_env ? process.env[providerConfig.api_key_env] : undefined;
  return new HttpMarketDataProvider({
    name,
    priority: providerConfig.priority,
    baseUrl,
    apiKey,
    apiKeyHeader: providerConfig.api_key_header,
    timeoutMs: providerConfig.timeout_ms,
    config: providerConfig,
    logger: rootLogger.child(loggerSuffix)
  });
}

function createDataProviders(
  config: AgentConfig,
  samplePoolPath: string,
  options: { allowMockData: boolean }
): IDataProvider[] {
  const providers: IDataProvider[] = [];

  const gmgn = createDataProvider("gmgn", config.data_providers.gmgn, "provider.gmgn");
  if (gmgn) {
    providers.push(gmgn);
  }

  const providerA = createDataProvider("provider_a", config.data_providers.provider_a, "provider.provider_a");
  if (providerA) {
    providers.push(providerA);
  }

  const providerB = createDataProvider("provider_b", config.data_providers.provider_b, "provider.provider_b");
  if (providerB) {
    providers.push(providerB);
  }

  if (options.allowMockData) {
    providers.push(new MockMarketDataProvider("mock_gmgn", 999, samplePoolPath, rootLogger.child("provider.mock_gmgn")));
  }

  if (providers.length === 0) {
    throw new Error("当前 guardrails 已禁用 mock data provider，但未配置任何真实数据源");
  }

  providers.sort((left, right) => left.priority - right.priority);

  rootLogger.info("数据源装配完成", {
    providers: providers.map((provider) => provider.name)
  });

  return providers;
}

function createPoolSource(
  config: AgentConfig,
  samplePoolPath: string,
  options: { allowMockData: boolean }
): IPoolSource {
  const meteoraConfig = config.meteora;
  const sources: IPoolSource[] = [];
  const meteoraBaseUrl = resolveConfiguredUrl(meteoraConfig?.base_url, meteoraConfig?.base_url_env);

  if (meteoraConfig && meteoraBaseUrl) {
    sources.push(
      new HttpMeteoraPoolSource({
        baseUrl: meteoraBaseUrl,
        timeoutMs: meteoraConfig.timeout_ms,
        config: meteoraConfig,
        logger: rootLogger.child("pool_source.meteora_http")
      })
    );
  }

  if (options.allowMockData) {
    sources.push(new MockMeteoraPoolSource(samplePoolPath, rootLogger.child("pool_source.mock_meteora")));
  }

  if (sources.length === 0) {
    throw new Error("当前 guardrails 已禁用 mock pool source，但未配置任何真实 Meteora 池子发现源");
  }

  if (sources.length === 1) {
    return sources[0]!;
  }

  return new FallbackPoolSource(sources, rootLogger.child("pool_source.fallback"));
}

/**
 * buildRuntime 负责把“散落的模块实例化逻辑”收敛成一个统一入口。
 * 这样 CLI、API Server、测试都可以复用同一套装配流程。
 */
export async function buildRuntime(options: RuntimeBootstrapOptions): Promise<AppRuntime> {
  const configPath = path.resolve(options.cwd, options.configPath);
  const skillsPath = path.resolve(options.cwd, options.skillsPath);
  const config = await loadAgentConfig(configPath);
  const skills = await loadSkills(skillsPath);
  const samplePoolPath = path.resolve(options.cwd, config.meteora?.sample_pool_path ?? "config/sample-pools.json");
  const auditDir = path.resolve(options.cwd, config.storage?.audit_dir ?? "runtime/audit");
  const stateSnapshotPath = path.resolve(options.cwd, config.storage?.state_snapshot_path ?? "runtime/state.json");
  const sqliteDbPath = path.resolve(options.cwd, config.storage?.sqlite?.db_path ?? "runtime/xagent.db");
  const sqliteHandle = config.storage?.backend === "sqlite"
    ? await openSqliteDatabase(sqliteDbPath)
    : undefined;
  const walletSecret = await loadWalletSecret(options.cwd, config);
  const cacheStore = createCacheStore();
  const stateStore = createStateStore(config, {
    stateSnapshotPath,
    sqliteHandle
  });
  const auditInfrastructure = createAuditInfrastructure(config, {
    auditDir,
    sqliteHandle
  });
  const auditRetentionService = new AuditRetentionService({
    policy: {
      enabled: config.storage?.audit_retention?.enabled,
      retentionDays: config.storage?.audit_retention?.retention_days,
      maxEventsPerSource: config.storage?.audit_retention?.max_events_per_source,
      cleanupIntervalMs: config.storage?.audit_retention?.cleanup_interval_ms
    },
    auditDir,
    cleanFileAudit: config.storage?.backend !== "sqlite" || config.storage?.mirror_to_file !== false,
    sqliteHandle,
    logger: rootLogger.child("audit_retention")
  });
  const guardrails = resolveRuntimeGuardrails(config);
  let runtimeLock: RuntimeLockLease | null = null;

  try {
    runtimeLock = await acquireRuntimeLock(config, {
      cwd: options.cwd,
      stateSnapshotPath,
      logger: rootLogger.child("runtime_lock")
    });
    const initialSnapshot = await stateStore.load();
    const state = new SharedState({
      initialSnapshot: initialSnapshot ?? undefined,
      onChange: (snapshot) => stateStore.save(snapshot),
      logger: rootLogger.child("state"),
      persistFailureStrategy: guardrails.persist_failure_strategy
    });
    if (!initialSnapshot) {
      state.setAvailableCapitalSol(25);
    }

    const { auditLogger, auditReader } = auditInfrastructure;
    auditRetentionService.start();
    const llmManager = new LLMManager(config.llm, auditLogger, rootLogger.child("llm"), {
      allowMockProvider: guardrails.allow_mock_llm
    });
    const skillManager = new SkillManager(skills, {
      runtimeSkills: initialSnapshot?.runtimeSkills,
      onChange: (nextSkills) => {
        state.setRuntimeSkills(nextSkills);
      }
    });
    state.setRuntimeSkills(skillManager.listAll());
    const skillStatsService = new SkillStatsService(state);
    const skillOptimizerService = new SkillOptimizerService(config, state, skillStatsService, skillManager);
    const dataProviders = createDataProviders(config, samplePoolPath, {
      allowMockData: guardrails.allow_mock_data
    });
    const dataProviderManager = new DataProviderManager(
      dataProviders,
      config.data_providers,
      cacheStore,
      rootLogger.child("data_provider_manager")
    );
    const rpcManager = new RPCManager(config.rpc, rootLogger.child("rpc"), {
      allowSimulated: (config.execution?.mode ?? "dry_run") !== "live_sdk"
    });
    const systemModeManager = new SystemModeManager(
      config.risk.daily_max_loss_pct,
      config.data_providers.cache.full_degradation_ms,
      rootLogger.child("system_mode")
    );
    const metricsService = new MetricsService(state, skillManager, dataProviderManager, rpcManager);
    const poolSource = createPoolSource(config, samplePoolPath, {
      allowMockData: guardrails.allow_mock_data
    });
    const executionDependencyChecker = async (): Promise<void> => {
    if (!config.execution?.live) {
      return;
    }

    if (config.execution.mode === "live_sdk") {
      const jupiter = config.execution.live.jupiter;
      if (!jupiter) {
        throw new Error("live preflight 失败：缺少 Jupiter 配置");
      }

      const jupiterClient = new JupiterMetisClient(rootLogger.child("preflight.jupiter"));
      await jupiterClient.quoteExactIn(jupiter, {
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: 1_000_000n
      });

      if (config.execution.live.submission_strategy !== "rpc") {
        const jitoApiKey = config.rpc.jito.auth_key_env ? process.env[config.rpc.jito.auth_key_env] : undefined;
        const jitoHealth = await new JitoBlockEngineClient(rootLogger.child("preflight.jito")).healthCheck({
          endpoint: config.rpc.jito.endpoint,
          apiKey: jitoApiKey
        });

        if (!jitoHealth.healthy) {
          throw new Error(`live preflight 失败：Jito block engine 健康检查失败: ${jitoHealth.error ?? "unknown error"}`);
        }
      }
      return;
    }

    if (config.execution.mode === "live_gateway") {
      const gateway = config.execution.live.gateway;
      const baseUrl = process.env[gateway.base_url_env]?.trim();
      if (!baseUrl) {
        throw new Error(`live preflight 失败：缺少执行 gateway 地址环境变量 ${gateway.base_url_env}`);
      }

      const apiKey = gateway.api_key_env ? process.env[gateway.api_key_env] : undefined;
      const gatewayClient = new ExecutionGatewayClient(rootLogger.child("preflight.gateway"));
      const health = await gatewayClient.healthCheck({
        baseUrl,
        apiKey,
        healthPath: gateway.health_path,
        timeoutMs: gateway.timeout_ms
      });

      if (!health.healthy) {
        throw new Error(`live preflight 失败：execution gateway 健康检查失败: ${health.error ?? "unknown error"}`);
      }

      const localActivePositions = state.getActivePositions();
      if (!gateway.positions_path && localActivePositions.length > 0) {
        throw new Error("live preflight 失败：本地存在活跃仓位，但 execution.live.gateway.positions_path 未配置");
      }

      if (gateway.positions_path) {
        const mirroredPositions = await gatewayClient.listPositions({
          baseUrl,
          apiKey,
          positionsPath: gateway.positions_path,
          timeoutMs: gateway.timeout_ms,
          walletAddress: config.wallet.active_address,
          activeOnly: true
        });

        validateMirroredActivePositions(
          "execution gateway",
          config.wallet.active_address,
          localActivePositions,
          mirroredPositions
        );
      }
    }
    };
    const gatewayMirrorReader = async (): Promise<PositionRecord[]> => {
    if (config.execution?.mode !== "live_gateway" || !config.execution.live) {
      return [];
    }

    const gateway = config.execution.live.gateway;
    if (!gateway.positions_path) {
      return [];
    }

    const baseUrl = process.env[gateway.base_url_env]?.trim();
    if (!baseUrl) {
      throw new Error(`startup reconcile 失败：缺少执行 gateway 地址环境变量 ${gateway.base_url_env}`);
    }

    const apiKey = gateway.api_key_env ? process.env[gateway.api_key_env] : undefined;
    return new ExecutionGatewayClient(rootLogger.child("startup_reconcile.gateway")).listPositions({
      baseUrl,
      apiKey,
      positionsPath: gateway.positions_path,
      timeoutMs: gateway.timeout_ms,
      walletAddress: config.wallet.active_address,
      activeOnly: true
    });
    };
    const poolScout = new PoolScout(poolSource, dataProviderManager, llmManager, rootLogger.child("pool_scout"));
    const strategySelector = new StrategySelector(skillManager, llmManager, rootLogger.child("strategy_selector"));
    const riskSentinel = new RiskSentinel(config, skillManager, rootLogger.child("risk_sentinel"));
    const portfolioManager = new PortfolioManager(rootLogger.child("portfolio_manager"));
    const executionLayer = createExecutionLayer(config, state, rpcManager, metricsService, walletSecret);
    const paperTradingService = new PaperTradingService(config, state, rootLogger.child("paper_trading"), poolSource);
    metricsService.bindExecutionStatusProvider(executionLayer);
    metricsService.bindRuntimeMetadataProvider({
    getStorageStatus: () => ({
      stateStoreKind: stateStore.kind,
      auditStoreKind: auditInfrastructure.auditStoreKind,
      cacheStoreKind: cacheStore.kind,
      sqliteConfigured: Boolean(sqliteHandle)
    }),
    getWalletStatus: () => ({
      secretLoaded: Boolean(walletSecret),
      allowSecretForwarding: walletSecret?.allowSecretForwarding ?? false
    })
    });
    const notifier = createNotifier(config);

    const orchestrator = new Orchestrator(
    config,
    state,
    poolScout,
    strategySelector,
    riskSentinel,
    portfolioManager,
    executionLayer,
    paperTradingService,
    dataProviderManager,
    rpcManager,
    systemModeManager,
    metricsService,
    auditLogger,
    notifier,
    rootLogger.child("orchestrator"),
    skillOptimizerService
    );

    const runtime: AppRuntime = {
    config,
    configPath,
    skillsPath,
    samplePoolPath,
    auditDir,
    stateSnapshotPath,
    poolSourceName: poolSource.name,
    storage: {
      stateStoreKind: stateStore.kind,
      auditStoreKind: auditInfrastructure.auditStoreKind,
      cacheStoreKind: cacheStore.kind,
      sqliteConfigured: Boolean(sqliteHandle)
    },
    wallet: {
      activeAddress: config.wallet.active_address,
      secretLoaded: Boolean(walletSecret),
      secretSource: walletSecret?.source,
      keyVersion: walletSecret?.keyVersion,
      allowSecretForwarding: walletSecret?.allowSecretForwarding ?? false
    },
    lock: runtimeLock,
    state,
    skillManager,
    skillStatsService,
    skillOptimizerService,
    dataProviderManager,
    rpcManager,
    metricsService,
    executionLayer,
    paperTradingService,
    telegramBot: null,
    auditReader,
    orchestrator,
    shutdown: async () => {
      await runtime.telegramBot?.stop();
      auditRetentionService.stop();
      await stateStore.close?.();
      await cacheStore.close?.();
      await auditInfrastructure.close();
      sqliteHandle?.close();
      await runtimeLock?.release();
    }
    };

    runtime.telegramBot = createTelegramBotService(config, runtime);

    await reconcileStartupState(config, {
      walletSecret,
      state,
      auditLogger,
      auditReader,
      logger: rootLogger.child("startup_reconcile"),
      checkPositionAccountExists: (positionPubkey) => checkPositionAccountExists(rpcManager, positionPubkey),
      inspectTransactions: (signatures) => inspectTransactions(rpcManager, config.wallet.active_address, signatures),
      listMirroredActivePositions: gatewayMirrorReader
    });

    await enforceRuntimeGuardrails(config, {
      walletSecret,
      rpcManager,
      activePositions: state.getActivePositions(),
      checkDataProviders: async () => {
        const snapshot = await dataProviderManager.healthCheck();
        return {
          hasAnyProvider: snapshot.hasAnyProvider,
          hasPrimaryProvider: snapshot.hasPrimaryProvider,
          providerErrors: snapshot.providerStatuses
            .filter((status) => !status.ok && status.lastError)
            .map((status) => `${status.provider}: ${status.lastError}`)
        };
      },
      checkPoolSource: async () => {
        const health = await poolSource.healthCheck();
        return {
          provider: health.provider,
          ok: health.ok,
          error: health.lastError
        };
      },
      checkExecutionDependencies: executionDependencyChecker,
      checkPositionAccountExists: (positionPubkey) => checkPositionAccountExists(rpcManager, positionPubkey),
      storage: {
        stateStoreKind: runtime.storage.stateStoreKind
      }
    });
    return runtime;
  } catch (error) {
    await runtimeLock?.release().catch(() => undefined);
    await stateStore.close?.().catch(() => undefined);
    await cacheStore.close?.().catch(() => undefined);
    await auditInfrastructure.close().catch(() => undefined);
    auditRetentionService.stop();
    throw error;
  }
}
