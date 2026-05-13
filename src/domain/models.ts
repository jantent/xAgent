export type LifecycleStage = "birth" | "hype" | "plateau" | "decline";
export type PositionDirection = "below" | "above" | "both";
export type DistributionType = "Spot" | "Curve" | "BidAsk";
export type RuleOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
export type PositionStatus = "active" | "closed" | "closing" | "error";
export type ActionType = "open" | "close" | "rebalance" | "claim" | "noop" | "emergency_exit";
export type AlertLevel = "critical" | "high" | "medium" | "low";
export type ExecutionMode = "dry_run" | "live_gateway" | "live_sdk";
export type ExecutionSubmissionStrategy = "gateway_managed" | "rpc" | "jito" | "jito_then_rpc";

export enum SkillStatus {
  DRAFT = "draft",
  CANARY = "canary",
  ACTIVE = "active",
  DISABLED = "disabled",
  DEPRECATED = "deprecated"
}

export enum SystemMode {
  NORMAL = "normal",
  DEGRADED_NO_SIGNALS = "degraded_no_signals",
  DEGRADED_READ_ONLY = "degraded_read_only",
  CLOSE_ONLY = "close_only",
  EMERGENCY_PAUSED = "emergency_paused"
}

export interface ConditionRule {
  description: string;
  key: string;
  operator: RuleOperator;
  value: string | number | boolean;
}

export interface RebalanceRule {
  description: string;
  trigger: string;
  action: "rebalance" | "close";
  threshold: number;
}

export interface SkillParams {
  direction: PositionDirection;
  distributionType: DistributionType;
  binCount: number;
  binStepPreference: number[];
  feeRatePreference: number[];
  entryConditions: ConditionRule[];
  exitConditions: ConditionRule[];
  rebalanceRules: RebalanceRule[];
}

export interface SkillRiskLimits {
  maxPositionSizePercent: number;
  maxTotalExposurePercent: number;
  maxConcurrentPositions: number;
  stopLossPercent: number;
  maxAliveHours: number;
  maxDailyRebalances: number;
}

export interface SkillApplicability {
  minLincolnScore: number;
  minSafetyScore: number;
  minMcap?: number;
  maxMcap?: number;
  lifecycleStages: LifecycleStage[];
}

export interface SkillMeta {
  id: string;
  version: string;
  name: string;
  description: string;
  status: SkillStatus;
  canaryPercent?: number;
  enabledAt?: Date;
  disabledAt?: Date;
  params: SkillParams;
  riskLimits: SkillRiskLimits;
  applicability: SkillApplicability;
  changelog: string;
  previousVersion?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillRuntimeStats {
  skillId: string;
  skillVersion: string;
  totalPositions: number;
  activePositions: number;
  closedPositions: number;
  estimatedPnlUsd: number;
  totalFeesClaimedSol: number;
  paperFeesAccruedSol: number;
  activeMarkPnlUsd: number;
  averagePositionHours: number;
  winRate: number;
  worstPnlPercent: number;
  maxDrawdownPercent: number;
  updatedAt: Date;
}

export type SkillOptimizationSuggestedAction = "hold" | "tighten" | "widen" | "reduce_risk" | "increase_canary";

export interface SkillOptimizationRecommendation {
  skillId: string;
  skillVersion: string;
  evaluatedAt: Date;
  suggestedAction: SkillOptimizationSuggestedAction;
  confidence: number;
  reason: string;
  paramsPatch?: Partial<SkillParams>;
  riskLimitsPatch?: Partial<SkillRiskLimits>;
  disabledReason?: string;
}

export interface BinRange {
  minBinId: number;
  maxBinId: number;
}

export interface PoolCandidate {
  address: string;
  tokenMint: string;
  tokenSymbol: string;
  quoteMint: string;
  binStep: number;
  feeRatePct: number;
  lincolnScore: number;
  safetyScore: number;
  organicScore: number;
  grade?: string;
  lifecycleStage: LifecycleStage;
  tvl: number;
  vol24h: number;
  feeTvlRatio24h: number;
  mcap: number;
  smartMoneyNet: number;
  dataSource: string;
  narrative?: string;
  reasons: string[];
  meta?: Record<string, unknown>;
}

export interface PositionPlan {
  id: string;
  pool: PoolCandidate;
  skill: SkillMeta;
  score: number;
  reason: string;
  range: BinRange;
  suggestedAmountSol: number;
  llmSummary?: string;
}

export interface ReviewedPlan extends PositionPlan {
  approved: boolean;
  rejectionReason?: string;
}

export interface PositionRecord {
  id: string;
  positionPubkey: string;
  poolAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  walletAddress: string;
  skillId: string;
  skillVersion: string;
  direction: PositionDirection;
  fromBinId: number;
  toBinId: number;
  depositedSol: number;
  currentValueUsd: number;
  pnlPercent: number;
  isInRange: boolean;
  totalFeesClaimedSol: number;
  rebalanceCount: number;
  status: PositionStatus;
  entryLincolnScore: number;
  openedAt: Date;
  maxAliveUntil: Date;
  closedAt?: Date;
  narrative?: string;
  outOfRangeSince?: Date;
  lastClaimedAt?: Date;
  lastFeeCheckAt?: Date;
  paper?: PaperPositionState;
}

export interface PaperPositionState {
  entryActiveBinId?: number;
  entryPrice?: number;
  currentValueSol?: number;
  unclaimedFeesSol: number;
  lastValuationAt?: Date;
  lastActiveBinId?: number;
  lastSource?: string;
  staleReason?: string;
}

export interface PaperPositionSnapshot {
  id: string;
  positionId: string;
  skillId: string;
  skillVersion: string;
  poolAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  timestamp: Date;
  activeBinId?: number;
  valueSol: number;
  valueUsd: number;
  pnlPercent: number;
  feeAccruedSol: number;
  unclaimedFeesSol: number;
  inRange: boolean;
  source: string;
  stale: boolean;
  staleReason?: string;
}

export interface PlannedAction {
  id: string;
  type: ActionType;
  trigger: string;
  reason: string;
  pool?: PoolCandidate;
  skill?: SkillMeta;
  positionId?: string;
  amountSol?: number;
  newRange?: BinRange;
  metadata?: Record<string, unknown>;
}

export interface ExecutionContext {
  availableCapitalSol: number;
  position?: PositionRecord;
}

export type ExecutionStateOperation =
  | {
      kind: "adjust_capital";
      deltaSol: number;
    }
  | {
      kind: "upsert_position";
      position: PositionRecord;
    };

export interface ExecutionBackendStatus {
  mode: ExecutionMode;
  backend: string;
  dryRun: boolean;
  healthy: boolean;
  supportedActions: ActionType[];
  submissionStrategy: ExecutionSubmissionStrategy;
  target?: string;
  lastSuccessAt?: Date;
  lastErrorAt?: Date;
  lastError?: string;
}

export interface ActionExecutionResult {
  actionId: string;
  type: ActionType;
  status: "success" | "failed" | "skipped";
  message: string;
  txSignatures: string[];
  latencyMs: number;
  metadata?: Record<string, unknown>;
  stateOperations?: ExecutionStateOperation[];
}

export interface CycleResult {
  cycleId: string;
  mode: SystemMode;
  scanned: number;
  plans: number;
  approved: number;
  executed: number;
  failed: number;
  actions: PlannedAction[];
  results: ActionExecutionResult[];
  startedAt: Date;
  finishedAt: Date;
}

export interface PortfolioHealth {
  dailyLossPct: number;
  activePositions: number;
  totalExposureSol: number;
  totalExposurePct: number;
}

export interface TokenSafetyData {
  mint: string;
  safetyScore: number;
  verdict: "SAFE" | "WARNING" | "DANGER" | "UNKNOWN";
  source: string;
  topHolderPct?: number;
  rugProbability?: number;
  isStale?: boolean;
}

export interface SmartMoneyData {
  mint: string;
  buy24h: number;
  sell24h: number;
  net24h: number;
  source: string;
  isStale?: boolean;
}

export interface TrendingToken {
  mint: string;
  symbol: string;
  rank: number;
  volume24h: number;
  source: string;
}

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface UrgentSignal {
  provider: string;
  signalType: "dev_sell" | "rug" | string;
  tokenMint: string;
  severity: AlertLevel;
  message: string;
}

export interface UrgentSignalSummary {
  hasDevSell: boolean;
  hasRug: boolean;
  signals: UrgentSignal[];
}

export interface ProviderHealthStatus {
  provider: string;
  ok: boolean;
  canRead: boolean;
  canWrite: boolean;
  latencyMs?: number;
  lastCheckedAt: Date;
  lastError?: string;
  consecutiveFailures: number;
  simulated?: boolean;
}

export interface ProviderHealthSnapshot {
  hasAnyProvider: boolean;
  hasPrimaryProvider: boolean;
  providerStatuses: ProviderHealthStatus[];
  lastAnyProviderOkAt?: Date;
  allProvidersDownForMs?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMChatRequest {
  messages: ChatMessage[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

export interface LLMChatResponse {
  content: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  latencyMs: number;
  model: string;
  provider: string;
}

export interface LLMToolRequest extends LLMChatRequest {
  tools: ToolDefinition[];
}

export interface LLMToolResponse extends LLMChatResponse {
  toolCalls?: ToolCall[];
}
