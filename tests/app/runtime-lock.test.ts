import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireRuntimeLock } from "../../src/app/runtime-lock.js";
import { createAgentConfig } from "../helpers/factories.js";
import { createTestLogger } from "../helpers/logger.js";

test("acquireRuntimeLock 会在 file backend 下创建并释放本地锁文件", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xagent-runtime-lock-"));
  const stateSnapshotPath = path.join(tempDir, "state.json");
  const config = createAgentConfig();
  config.storage = {
    ...config.storage,
    backend: "file",
    runtime_lock: {
      enabled: true,
      file_path: "./runtime.lock"
    }
  };

  const first = await acquireRuntimeLock(config, {
    cwd: tempDir,
    stateSnapshotPath,
    logger: createTestLogger()
  });
  assert.ok(first);
  await assert.rejects(
    acquireRuntimeLock(config, {
      cwd: tempDir,
      stateSnapshotPath,
      logger: createTestLogger()
    }),
    /已有运行时实例/
  );

  await first?.release();

  const second = await acquireRuntimeLock(config, {
    cwd: tempDir,
    stateSnapshotPath,
    logger: createTestLogger()
  });
  assert.ok(second);
  await second?.release();
});

test("acquireRuntimeLock 会回收陈旧的 file lock", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "xagent-runtime-lock-stale-"));
  const stateSnapshotPath = path.join(tempDir, "state.json");
  const config = createAgentConfig();
  config.storage = {
    ...config.storage,
    backend: "file",
    runtime_lock: {
      enabled: true,
      file_path: "./runtime.lock",
      stale_timeout_ms: 1
    }
  };

  await writeFile(
    path.join(tempDir, "runtime.lock"),
    JSON.stringify({
      ownerToken: "stale",
      pid: 999999,
      hostname: os.hostname(),
      key: "stale-key",
      acquiredAt: new Date(Date.now() - 60_000).toISOString()
    }),
    "utf8"
  );

  const lease = await acquireRuntimeLock(config, {
    cwd: tempDir,
    stateSnapshotPath,
    logger: createTestLogger()
  });
  assert.ok(lease);
  await lease?.release();
});

