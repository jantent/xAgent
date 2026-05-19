import type {
  ActionExecutionResult,
  AlertLevel,
  CycleResult,
  ExecutionBackendStatus,
  ExecutionContext,
  LLMChatRequest,
  LLMChatResponse,
  LLMToolRequest,
  LLMToolResponse,
  OHLCV,
  PlannedAction,
  PoolCandidate,
  ProviderHealthStatus,
  SmartMoneyData,
  TokenSafetyData,
  TrendingToken,
  UrgentSignal
} from "./models.js";

export interface IDataProvider {
  readonly name: string;
  readonly priority: number;
  getTokenSafety(mint: string): Promise<TokenSafetyData>;
  getSmartMoneyFlow(mint: string): Promise<SmartMoneyData>;
  getTrendingTokens(chain: string, period: string): Promise<TrendingToken[]>;
  getOHLCV(mint: string, interval: string): Promise<OHLCV[]>;
  getUrgentSignals?(tokenMints: string[]): Promise<UrgentSignal[]>;
  healthCheck(): Promise<ProviderHealthStatus>;
}

export interface IPoolSource {
  readonly name: string;
  discoverPools(): Promise<PoolCandidate[]>;
  getPool?(address: string): Promise<PoolCandidate | undefined>;
  healthCheck(): Promise<ProviderHealthStatus>;
}

export interface ILLMProvider {
  readonly name: string;
  chat(request: LLMChatRequest): Promise<LLMChatResponse>;
  chatWithTools(request: LLMToolRequest): Promise<LLMToolResponse>;
  healthCheck(): Promise<boolean>;
}

export interface IAuditLogger {
  startCycle(cycleId: string, metadata?: Record<string, unknown>): Promise<void>;
  recordPhase(cycleId: string, phase: string, metadata: Record<string, unknown>): Promise<void>;
  recordAction(cycleId: string, action: PlannedAction, result: ActionExecutionResult): Promise<void>;
  recordLLMCall(cycleId: string, role: string, response: LLMChatResponse, metadata?: Record<string, unknown>): Promise<void>;
  recordError(cycleId: string, error: unknown, metadata?: Record<string, unknown>): Promise<void>;
  finishCycle(cycleId: string, result: CycleResult): Promise<void>;
}

export interface INotifier {
  sendCycleSummary(result: CycleResult): Promise<void>;
  sendAlert(level: AlertLevel, title: string, body: string, metadata?: Record<string, unknown>): Promise<void>;
}

export interface IExecutionBackend {
  execute(action: PlannedAction, context: ExecutionContext): Promise<ActionExecutionResult>;
  getStatus(): ExecutionBackendStatus;
}
