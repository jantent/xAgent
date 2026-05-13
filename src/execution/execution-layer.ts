import type { IExecutionBackend } from "../domain/contracts.js";
import { SystemMode, type ActionExecutionResult, type ExecutionBackendStatus, type PlannedAction } from "../domain/models.js";
import type { SharedState } from "../core/shared-state.js";
import type { MetricsService } from "../metrics/metrics-service.js";
import { applyStateOperations } from "./state-operations.js";
import type { ExecutionJournal } from "./execution-journal.js";
import type { Logger } from "../utils/logger.js";

const MUTATING_ACTION_TYPES = new Set(["open", "close", "rebalance", "claim", "emergency_exit"]);
const CLOSE_ONLY_ALLOWED_ACTION_TYPES = new Set(["close", "emergency_exit"]);

/**
 * ExecutionLayer 现在只保留三件事：
 * 1. 从共享状态提取执行上下文；
 * 2. 调用具体 backend；
 * 3. 统一应用状态回写并记录 metrics。
 */
export class ExecutionLayer {
  constructor(
    private readonly state: SharedState,
    private readonly metricsService: MetricsService,
    private readonly backend: IExecutionBackend,
    private readonly logger: Logger,
    private readonly executionJournal?: ExecutionJournal
  ) {}

  getStatus(): ExecutionBackendStatus {
    return this.backend.getStatus();
  }

  async execute(action: PlannedAction): Promise<ActionExecutionResult> {
    const startedAt = Date.now();
    const backendStatus = this.backend.getStatus();
    const shouldTrackAction = MUTATING_ACTION_TYPES.has(action.type);

    if (this.state.isManualPause()) {
      return {
        actionId: action.id,
        type: action.type,
        status: "skipped",
        message: `系统处于暂停状态，已跳过动作 ${action.id}。`,
        txSignatures: [],
        latencyMs: Date.now() - startedAt,
        metadata: {
          backend: backendStatus.backend,
          paused: true,
          pauseReason: this.state.getSnapshot().lastPauseReason
        }
      };
    }

    if (this.state.getMode() === SystemMode.CLOSE_ONLY && !CLOSE_ONLY_ALLOWED_ACTION_TYPES.has(action.type)) {
      return {
        actionId: action.id,
        type: action.type,
        status: "skipped",
        message: `系统处于 close_only，动作 ${action.type} 已跳过。`,
        txSignatures: [],
        latencyMs: Date.now() - startedAt,
        metadata: {
          backend: backendStatus.backend,
          mode: SystemMode.CLOSE_ONLY
        }
      };
    }

    if (this.state.hasAppliedAction(action.id)) {
      this.logger.warn("检测到重复动作，跳过执行", {
        actionId: action.id,
        actionType: action.type,
        backend: backendStatus.backend
      });
      return {
        actionId: action.id,
        type: action.type,
        status: "skipped",
        message: `动作 ${action.id} 已处理，已跳过重复执行。`,
        txSignatures: [],
        latencyMs: Date.now() - startedAt,
        metadata: {
          backend: backendStatus.backend,
          deduplicated: true
        }
      };
    }

    const executionContext = {
      availableCapitalSol: this.state.getAvailableCapitalSol(),
      position: action.positionId ? this.state.getPosition(action.positionId) : undefined
    };

    if (shouldTrackAction) {
      try {
        if (this.executionJournal) {
          await this.executionJournal.startAction(action, executionContext);
        } else {
          this.state.beginPendingAction({
            action,
            startedAt: new Date(),
            availableCapitalSol: executionContext.availableCapitalSol,
            positionSnapshot: executionContext.position
          });
          await this.state.flush();
        }
      } catch (error) {
        this.state.discardPendingAction(action.id);
        const failedBeforeExecution: ActionExecutionResult = {
          actionId: action.id,
          type: action.type,
          status: "failed",
          message: `执行前无法持久化处理中动作: ${error instanceof Error ? error.message : String(error)}`,
          txSignatures: [],
          latencyMs: Date.now() - startedAt,
          metadata: {
            backend: backendStatus.backend,
            phase: "pre_execute_persist"
          }
        };
        this.metricsService.recordAction(failedBeforeExecution);
        return failedBeforeExecution;
      }
    }

    try {
      const result = await this.backend.execute(action, executionContext);

      if (result.status === "success" && MUTATING_ACTION_TYPES.has(action.type) && !result.stateOperations?.length) {
        throw new Error(`动作 ${action.type} 执行成功，但缺少状态回写操作`);
      }

      if (result.stateOperations?.length) {
        applyStateOperations(this.state, result.stateOperations);
      }

      if ((MUTATING_ACTION_TYPES.has(action.type) && result.status === "success") || result.stateOperations?.length) {
        this.state.markActionApplied(action.id);
      }

      if (shouldTrackAction) {
        this.state.clearPendingAction(action.id);
      }

      let finalResult = result;
      if (shouldTrackAction || result.stateOperations?.length) {
        try {
          await this.state.flush();
        } catch (error) {
          this.logger.error("执行后状态持久化失败，保留启动恢复线索", {
            actionId: action.id,
            actionType: action.type,
            error
          });
          finalResult = {
            ...result,
            metadata: {
              ...(result.metadata ?? {}),
              statePersistence: "failed"
            }
          };
        }
      }

      this.metricsService.recordAction(finalResult);
      return finalResult;
    } catch (error) {
      this.logger.error("执行层处理动作失败", {
        actionId: action.id,
        actionType: action.type,
        backend: backendStatus.backend,
        error
      });

      const failedResult: ActionExecutionResult = {
        actionId: action.id,
        type: action.type,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        txSignatures: [],
        latencyMs: Date.now() - startedAt,
        metadata: {
          backend: backendStatus.backend
        }
      };
      this.metricsService.recordAction(failedResult);
      return failedResult;
    }
  }
}
