import assert from "node:assert/strict";
import test from "node:test";

import { LLMManager } from "../../src/managers/llm-manager.js";
import { createAuditLoggerSpy } from "../helpers/fakes.js";
import { createAgentConfig } from "../helpers/factories.js";
import { createTestLogger } from "../helpers/logger.js";

test("LLMManager 在禁用 mock 时会拒绝 mock 路由配置", () => {
  const config = createAgentConfig();

  assert.throws(
    () => new LLMManager(config.llm, createAuditLoggerSpy(), createTestLogger(), { allowMockProvider: false }),
    /禁用 mock LLM/
  );
});

test("LLMManager 在禁用 mock 时会要求真实 provider 凭据", () => {
  const config = createAgentConfig();
  const envName = "XAGENT_TEST_MISSING_OPENAI_KEY";
  delete process.env[envName];
  config.llm.default = {
    provider: "openai",
    model: "gpt-4.1-mini",
    api_key_env: envName
  };
  config.llm.classification = undefined;
  config.llm.fallback = undefined;

  assert.throws(
    () => new LLMManager(config.llm, createAuditLoggerSpy(), createTestLogger(), { allowMockProvider: false }),
    /OpenAI API Key 未配置/
  );
});
