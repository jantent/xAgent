import type { IAuditLogger } from "../domain/contracts.js";
import type { ActionExecutionResult, CycleResult, LLMChatResponse, PlannedAction } from "../domain/models.js";
import type { SqliteHandle } from "../persistence/sqlite-database.js";

export class SqliteAuditLogger implements IAuditLogger {
  constructor(private readonly handle: SqliteHandle) {}

  async startCycle(cycleId: string, metadata: Record<string, unknown> = {}): Promise<void> {
    this.insert("cycles", cycleId, {
      type: "start",
      cycleId,
      timestamp: new Date().toISOString(),
      metadata
    });
  }

  async recordPhase(cycleId: string, phase: string, metadata: Record<string, unknown>): Promise<void> {
    this.insert("phases", cycleId, {
      cycleId,
      phase,
      timestamp: new Date().toISOString(),
      metadata
    });
  }

  async recordAction(cycleId: string, action: PlannedAction, result: ActionExecutionResult): Promise<void> {
    this.insert("actions", cycleId, {
      cycleId,
      timestamp: new Date().toISOString(),
      action,
      result
    });
  }

  async recordLLMCall(
    cycleId: string,
    role: string,
    response: LLMChatResponse,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    this.insert("llm", cycleId, {
      cycleId,
      role,
      timestamp: new Date().toISOString(),
      response,
      metadata
    });
  }

  async recordError(cycleId: string, error: unknown, metadata: Record<string, unknown> = {}): Promise<void> {
    this.insert("errors", cycleId, {
      cycleId,
      timestamp: new Date().toISOString(),
      metadata,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
    });
  }

  async finishCycle(cycleId: string, result: CycleResult): Promise<void> {
    this.insert("cycles", cycleId, {
      type: "finish",
      cycleId,
      timestamp: new Date().toISOString(),
      result
    });
  }

  private insert(source: string, cycleId: string | null, payload: Record<string, unknown>): void {
    const timestamp = typeof payload.timestamp === "string" ? payload.timestamp : new Date().toISOString();
    this.handle.db.run(
      "INSERT INTO audit_events (source, cycle_id, occurred_at, payload) VALUES (?, ?, ?, ?)",
      [source, cycleId, timestamp, JSON.stringify(payload)]
    );
    this.handle.flush();
  }
}
