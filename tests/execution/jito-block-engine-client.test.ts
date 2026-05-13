import assert from "node:assert/strict";
import test from "node:test";

import { JitoBlockEngineClient } from "../../src/execution/clients/jito-block-engine-client.js";
import { createTestLogger } from "../helpers/logger.js";

const originalFetch = globalThis.fetch;

function mockFetch(handler: typeof fetch): void {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: handler
  });
}

test.afterEach(() => {
  mockFetch(originalFetch);
});

test("JitoBlockEngineClient.healthCheck 会通过 getTipAccounts 校验 block engine 可用性", async () => {
  let requestedUrl = "";
  let requestedHeaders: HeadersInit | undefined;
  let requestedBody = "";

  mockFetch(async (input, init) => {
    requestedUrl = String(input);
    requestedHeaders = init?.headers;
    requestedBody = String(init?.body ?? "");

    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: ["Tip111111111111111111111111111111111111111"]
    }), { status: 200 });
  });

  const client = new JitoBlockEngineClient(createTestLogger());
  const result = await client.healthCheck({
    endpoint: "https://mainnet.block-engine.jito.wtf/api/v1/transactions",
    apiKey: "secret"
  });

  assert.equal(result.healthy, true);
  assert.equal(requestedUrl, "https://mainnet.block-engine.jito.wtf/api/v1/getTipAccounts");
  assert.match(requestedBody, /getTipAccounts/);
  assert.equal(new Headers(requestedHeaders).get("x-jito-auth"), "secret");
});

test("JitoBlockEngineClient.healthCheck 在空 tip accounts 响应时返回 unhealthy", async () => {
  mockFetch(async () => new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: []
  }), { status: 200 }));

  const client = new JitoBlockEngineClient(createTestLogger());
  const result = await client.healthCheck({
    endpoint: "https://mainnet.block-engine.jito.wtf"
  });

  assert.equal(result.healthy, false);
  assert.match(result.error ?? "", /空结果/);
});
