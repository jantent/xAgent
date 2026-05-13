import type { IAuditLogger, INotifier } from "../../src/domain/contracts.js";
import type { ActionExecutionResult, CycleResult } from "../../src/domain/models.js";

export function createMetricsServiceSpy() {
  const actionResults: ActionExecutionResult[] = [];
  const cycleResults: Array<{ kind: "main" | "high_freq"; result: CycleResult }> = [];

  return {
    actionResults,
    cycleResults,
    recordAction(result: ActionExecutionResult) {
      actionResults.push(result);
    },
    recordCycle(kind: "main" | "high_freq", result: CycleResult) {
      cycleResults.push({ kind, result });
    }
  };
}

export function createAuditLoggerSpy(): IAuditLogger & {
  phases: Array<{ cycleId: string; phase: string; metadata: Record<string, unknown> }>;
  actions: Array<{ cycleId: string; actionId: string; status: string }>;
  errors: Array<{ cycleId: string; phase?: string }>;
  finished: CycleResult[];
} {
  const phases: Array<{ cycleId: string; phase: string; metadata: Record<string, unknown> }> = [];
  const actions: Array<{ cycleId: string; actionId: string; status: string }> = [];
  const errors: Array<{ cycleId: string; phase?: string }> = [];
  const finished: CycleResult[] = [];

  return {
    phases,
    actions,
    errors,
    finished,
    async startCycle() {},
    async recordPhase(cycleId, phase, metadata) {
      phases.push({ cycleId, phase, metadata });
    },
    async recordAction(cycleId, action, result) {
      actions.push({ cycleId, actionId: action.id, status: result.status });
    },
    async recordLLMCall() {},
    async recordError(cycleId, _error, metadata) {
      errors.push({ cycleId, phase: typeof metadata?.phase === "string" ? metadata.phase : undefined });
    },
    async finishCycle(_cycleId, result) {
      finished.push(result);
    }
  };
}

export function createNotifierSpy(): INotifier & {
  summaries: CycleResult[];
  alerts: Array<{ level: string; title: string; body: string }>;
} {
  const summaries: CycleResult[] = [];
  const alerts: Array<{ level: string; title: string; body: string }> = [];

  return {
    summaries,
    alerts,
    async sendCycleSummary(result) {
      summaries.push(result);
    },
    async sendAlert(level, title, body) {
      alerts.push({ level, title, body });
    }
  };
}
