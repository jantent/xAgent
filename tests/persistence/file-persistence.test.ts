import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SharedStateSnapshot } from "../../src/core/shared-state.js";
import { FileAuditReader } from "../../src/audit/file-audit-reader.js";
import type { IStateStore } from "../../src/persistence/contracts.js";
import { FileStateStore } from "../../src/persistence/file-state-store.js";
import { MirroredStateStore } from "../../src/persistence/mirrored-state-store.js";
import { createPositionRecord, createStateSnapshot } from "../helpers/factories.js";
import { createTestLogger } from "../helpers/logger.js";

test("FileStateStore 会完成 save/load round-trip 并保留日期字段", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "xagent-file-store-"));
  try {
    const store = new FileStateStore(path.join(tmpDir, "nested", "state.json"));
    const snapshot = createStateSnapshot({
      activePositions: [createPositionRecord()],
      allPositions: [createPositionRecord()]
    });

    assert.equal(await store.load(), null);
    await store.save(snapshot);
    const loaded = await store.load();

    assert.deepEqual(loaded, snapshot);
    assert.equal(loaded?.activePositions[0]?.openedAt instanceof Date, true);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("MirroredStateStore 主存储读取失败时会回退到镜像", async () => {
  const snapshot = createStateSnapshot({
    availableCapitalSol: 6.5
  });
  const primary: IStateStore = {
    kind: "primary",
    async load() {
      throw new Error("primary down");
    },
    async save() {}
  };
  const mirror: IStateStore = {
    kind: "mirror",
    async load() {
      return snapshot;
    },
    async save() {}
  };

  const store = new MirroredStateStore(primary, [mirror], createTestLogger());
  assert.deepEqual(await store.load(), snapshot);
});

test("MirroredStateStore 保存时主存储成功即可成功，镜像失败只记录日志", async () => {
  const saved: SharedStateSnapshot[] = [];
  const primary: IStateStore = {
    kind: "primary",
    async load() {
      return null;
    },
    async save(snapshot) {
      saved.push(snapshot);
    }
  };
  const failingMirror: IStateStore = {
    kind: "mirror",
    async load() {
      return null;
    },
    async save() {
      throw new Error("mirror down");
    }
  };
  const snapshot = createStateSnapshot({
    availableCapitalSol: 9
  });

  const store = new MirroredStateStore(primary, [failingMirror], createTestLogger());
  await store.save(snapshot);

  assert.deepEqual(saved, [snapshot]);
});

test("FileAuditReader queryEvents 支持筛选、搜索和分页", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "xagent-file-audit-"));
  try {
    await writeFile(
      path.join(tmpDir, "actions.jsonl"),
      [
        JSON.stringify({ cycleId: "cycle-2", timestamp: "2026-01-03T00:00:00.000Z", action: { type: "close" }, result: { message: "closed RKC" } }),
        JSON.stringify({ cycleId: "cycle-1", timestamp: "2026-01-01T00:00:00.000Z", action: { type: "open" }, result: { message: "opened BONK" } })
      ].join("\n") + "\n",
      "utf8"
    );
    await writeFile(
      path.join(tmpDir, "errors.jsonl"),
      JSON.stringify({ cycleId: "cycle-1", timestamp: "2026-01-02T00:00:00.000Z", error: { message: "provider timeout" } }) + "\n",
      "utf8"
    );

    const reader = new FileAuditReader(tmpDir);
    const events = await reader.queryEvents({
      source: "actions",
      cycleId: "cycle-1",
      q: "bonk",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-01-02T00:00:00.000Z",
      limit: 10
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.source, "actions");
    assert.equal(events[0]?.payload.cycleId, "cycle-1");

    const paged = await reader.queryEvents({ limit: 1, offset: 1 });
    assert.equal(paged.length, 1);
    assert.equal(paged[0]?.source, "errors");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
