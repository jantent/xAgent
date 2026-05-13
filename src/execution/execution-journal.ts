import type { SharedState } from "../core/shared-state.js";
import type { PlannedAction, PositionRecord } from "../domain/models.js";
import type { Logger } from "../utils/logger.js";

export interface ExecutionJournal {
  startAction(action: PlannedAction, options: { availableCapitalSol: number; position?: PositionRecord }): Promise<void>;
  recordTxSignatures(actionId: string, txSignatures: string[]): Promise<void>;
  recordMetadata(actionId: string, metadata: Record<string, unknown>): Promise<void>;
}

export class SharedStateExecutionJournal implements ExecutionJournal {
  constructor(
    private readonly state: SharedState,
    private readonly logger: Logger
  ) {}

  async startAction(action: PlannedAction, options: { availableCapitalSol: number; position?: PositionRecord }): Promise<void> {
    this.state.beginPendingAction({
      action,
      startedAt: new Date(),
      availableCapitalSol: options.availableCapitalSol,
      positionSnapshot: options.position
    });
    await this.state.flush();
  }

  async recordTxSignatures(actionId: string, txSignatures: string[]): Promise<void> {
    if (txSignatures.length === 0) {
      return;
    }

    this.state.updatePendingAction(actionId, { txSignatures });
    await this.state.flush();
  }

  async recordMetadata(actionId: string, metadata: Record<string, unknown>): Promise<void> {
    if (Object.keys(metadata).length === 0) {
      return;
    }

    this.state.updatePendingAction(actionId, { metadata });
    await this.state.flush();
  }

  async safeRecordMetadata(actionId: string, metadata: Record<string, unknown>): Promise<void> {
    try {
      await this.recordMetadata(actionId, metadata);
    } catch (error) {
      this.logger.warn("记录执行元数据失败", {
        actionId,
        error
      });
      throw error;
    }
  }
}
