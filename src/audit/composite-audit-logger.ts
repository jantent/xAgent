import type { IAuditLogger } from "../domain/contracts.js";
import type { ActionExecutionResult, CycleResult, LLMChatResponse, PlannedAction } from "../domain/models.js";
import type { Logger } from "../utils/logger.js";

export class CompositeAuditLogger implements IAuditLogger {
  constructor(
    private readonly loggers: IAuditLogger[],
    private readonly logger: Logger
  ) {}

  async startCycle(cycleId: string, metadata: Record<string, unknown> = {}): Promise<void> {
    await this.fanout((target) => target.startCycle(cycleId, metadata), "startCycle");
  }

  async recordPhase(cycleId: string, phase: string, metadata: Record<string, unknown>): Promise<void> {
    await this.fanout((target) => target.recordPhase(cycleId, phase, metadata), "recordPhase");
  }

  async recordAction(cycleId: string, action: PlannedAction, result: ActionExecutionResult): Promise<void> {
    await this.fanout((target) => target.recordAction(cycleId, action, result), "recordAction");
  }

  async recordLLMCall(
    cycleId: string,
    role: string,
    response: LLMChatResponse,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    await this.fanout((target) => target.recordLLMCall(cycleId, role, response, metadata), "recordLLMCall");
  }

  async recordError(cycleId: string, error: unknown, metadata: Record<string, unknown> = {}): Promise<void> {
    await this.fanout((target) => target.recordError(cycleId, error, metadata), "recordError");
  }

  async finishCycle(cycleId: string, result: CycleResult): Promise<void> {
    await this.fanout((target) => target.finishCycle(cycleId, result), "finishCycle");
  }

  private async fanout(
    runner: (target: IAuditLogger) => Promise<void>,
    operation: string
  ): Promise<void> {
    await Promise.all(
      this.loggers.map(async (target) => {
        try {
          await runner(target);
        } catch (error) {
          this.logger.warn("审计镜像写入失败", { operation, error });
        }
      })
    );
  }
}
