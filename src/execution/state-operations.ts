import type { SharedState } from "../core/shared-state.js";
import type { ExecutionStateOperation } from "../domain/models.js";

/**
 * 执行 backend 只负责产生状态变更描述，
 * 真正的状态写入统一收口到这里，避免 dry-run / live backend 各自绕开共享状态。
 */
export function applyStateOperations(state: SharedState, operations: ExecutionStateOperation[]): void {
  for (const operation of operations) {
    switch (operation.kind) {
      case "adjust_capital":
        state.adjustAvailableCapitalSol(operation.deltaSol);
        break;
      case "upsert_position":
        state.upsertPosition(operation.position);
        break;
      default: {
        const exhaustiveCheck: never = operation;
        throw new Error(`未知状态操作: ${String(exhaustiveCheck)}`);
      }
    }
  }
}
