import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import type { FileHandle } from "node:fs/promises";

import type { AgentConfig } from "../config/types.js";
import type { Logger } from "../utils/logger.js";

export interface RuntimeLockLease {
  readonly kind: "file";
  readonly key: string;
  readonly acquiredAt: Date;
  describe(): Record<string, unknown>;
  release(): Promise<void>;
}

interface AcquireRuntimeLockOptions {
  cwd: string;
  stateSnapshotPath: string;
  logger: Logger;
}

interface LockFilePayload {
  ownerToken: string;
  pid: number;
  hostname: string;
  key: string;
  acquiredAt: string;
}

export async function acquireRuntimeLock(
  config: AgentConfig,
  options: AcquireRuntimeLockOptions
): Promise<RuntimeLockLease | null> {
  const runtimeLock = config.storage?.runtime_lock;
  if (runtimeLock?.enabled === false) {
    return null;
  }

  const key = runtimeLock?.key?.trim() || buildDefaultLockKey(config);
  const lockFilePath = resolve(
    options.cwd,
    runtimeLock?.file_path?.trim() || `${options.stateSnapshotPath}.lock`
  );
  return acquireFileRuntimeLock(key, lockFilePath, runtimeLock?.stale_timeout_ms ?? 120_000, options.logger);
}

function buildDefaultLockKey(config: AgentConfig): string {
  return `xagent:${config.execution?.mode ?? "dry_run"}:${config.wallet.active_address}`;
}

async function acquireFileRuntimeLock(
  key: string,
  filePath: string,
  staleTimeoutMs: number,
  logger: Logger
): Promise<RuntimeLockLease> {
  const ownerToken = randomUUID();
  const payload: LockFilePayload = {
    ownerToken,
    pid: process.pid,
    hostname: os.hostname(),
    key,
    acquiredAt: new Date().toISOString()
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.mkdir(dirname(filePath), { recursive: true });
      const handle = await fs.open(filePath, "wx");
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      return new FileRuntimeLockLease(filePath, handle, payload, logger);
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== "EEXIST") {
        throw error;
      }

      const existing = await readExistingLockFile(filePath);
      if (!existing || !isStaleFileLock(existing, staleTimeoutMs)) {
        throw new Error(
          `检测到已有运行时实例持有锁 ${key}。file=${filePath}${existing ? ` pid=${existing.pid} host=${existing.hostname}` : ""}`
        );
      }

      logger.warn("检测到陈旧 runtime lock，尝试回收", {
        key,
        filePath,
        existingPid: existing.pid,
        existingHostname: existing.hostname,
        existingAcquiredAt: existing.acquiredAt
      });
      await fs.rm(filePath, { force: true });
    }
  }

  throw new Error(`获取 runtime lock 失败：${filePath}`);
}

async function readExistingLockFile(filePath: string): Promise<LockFilePayload | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockFilePayload>;
    if (
      typeof parsed.ownerToken !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.key !== "string" ||
      typeof parsed.acquiredAt !== "string"
    ) {
      return null;
    }

    return parsed as LockFilePayload;
  } catch {
    return null;
  }
}

function isStaleFileLock(payload: LockFilePayload, staleTimeoutMs: number): boolean {
  const acquiredAt = new Date(payload.acquiredAt);
  if (Number.isNaN(acquiredAt.getTime())) {
    return true;
  }

  if (Date.now() - acquiredAt.getTime() >= staleTimeoutMs) {
    return true;
  }

  if (payload.hostname !== os.hostname()) {
    return false;
  }

  return !isProcessAlive(payload.pid);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    return errno.code === "EPERM";
  }
}

class FileRuntimeLockLease implements RuntimeLockLease {
  readonly kind = "file" as const;
  readonly key: string;
  readonly acquiredAt: Date;

  constructor(
    private readonly filePath: string,
    private readonly handle: FileHandle,
    private readonly payload: LockFilePayload,
    private readonly logger: Logger
  ) {
    this.key = payload.key;
    this.acquiredAt = new Date(payload.acquiredAt);
  }

  describe(): Record<string, unknown> {
    return {
      kind: this.kind,
      key: this.key,
      filePath: this.filePath,
      pid: this.payload.pid,
      hostname: this.payload.hostname,
      acquiredAt: this.acquiredAt
    };
  }

  async release(): Promise<void> {
    await this.handle.close();

    try {
      const existing = await readExistingLockFile(this.filePath);
      if (!existing || existing.ownerToken !== this.payload.ownerToken) {
        return;
      }

      await fs.rm(this.filePath, { force: true });
    } catch (error) {
      this.logger.warn("释放 file runtime lock 失败", {
        filePath: this.filePath,
        error
      });
    }
  }
}

