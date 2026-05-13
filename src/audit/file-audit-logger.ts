import { promises as fs } from "node:fs";
import path from "node:path";

import type { IAuditLogger } from "../domain/contracts.js";
import type { ActionExecutionResult, CycleResult, LLMChatResponse, PlannedAction } from "../domain/models.js";
import type { Logger } from "../utils/logger.js";

/**
 * 当前先落地成 JSONL 文件，优点是：
 * 1. 不依赖数据库即可运行；
 * 2. 每一类审计记录都可以直接 grep / 导入分析；
 * 3. 后续迁移到 PostgreSQL 时，接口层保持不变。
 */
export class FileAuditLogger implements IAuditLogger {
  constructor(
    private readonly rootDir: string,
    private readonly logger: Logger
  ) {}

  async startCycle(cycleId: string, metadata: Record<string, unknown> = {}): Promise<void> {
    await this.append("cycles.jsonl", {
      type: "start",
      cycleId,
      timestamp: new Date().toISOString(),
      metadata
    });
  }

  async recordPhase(cycleId: string, phase: string, metadata: Record<string, unknown>): Promise<void> {
    await this.append("phases.jsonl", {
      cycleId,
      phase,
      timestamp: new Date().toISOString(),
      metadata
    });
  }

  async recordAction(cycleId: string, action: PlannedAction, result: ActionExecutionResult): Promise<void> {
    await this.append("actions.jsonl", {
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
    await this.append("llm.jsonl", {
      cycleId,
      role,
      timestamp: new Date().toISOString(),
      response,
      metadata
    });
  }

  async recordError(cycleId: string, error: unknown, metadata: Record<string, unknown> = {}): Promise<void> {
    await this.append("errors.jsonl", {
      cycleId,
      timestamp: new Date().toISOString(),
      metadata,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
    });
  }

  async finishCycle(cycleId: string, result: CycleResult): Promise<void> {
    await this.append("cycles.jsonl", {
      type: "finish",
      cycleId,
      timestamp: new Date().toISOString(),
      result
    });
  }

  private async append(fileName: string, payload: Record<string, unknown>): Promise<void> {
    const directory = path.resolve(this.rootDir);
    await fs.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, fileName);
    await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
    this.logger.debug("写入审计日志", { filePath, fileName });
  }
}
