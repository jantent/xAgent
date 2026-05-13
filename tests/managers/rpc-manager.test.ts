import assert from "node:assert/strict";
import test from "node:test";

import { RPCManager } from "../../src/managers/rpc-manager.js";
import { createAgentConfig } from "../helpers/factories.js";
import { createTestLogger } from "../helpers/logger.js";

test("RPCManager 在 live 模式关闭 simulated fallback 时会把未配置 RPC 标记为不可写", async () => {
  const config = createAgentConfig();
  delete process.env[config.rpc.primary.url_env];
  delete process.env[config.rpc.backup.url_env];

  const manager = new RPCManager(config.rpc, createTestLogger(), {
    allowSimulated: false
  });

  await manager.healthCheck();

  const health = manager.getHealth();
  assert.equal(health.canWrite, false);
  assert.equal(health.statuses[0]?.ok, false);
  assert.equal(health.statuses[0]?.simulated, false);
});
