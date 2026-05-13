import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicProvider } from "../../../src/providers/llm/anthropic-provider.js";

test("AnthropicProvider.chatWithTools 会解析 tool_use block", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: "需要调用工具"
          },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "lookup_pool",
            input: {
              pool: "BONK"
            }
          }
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5
        }
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

  try {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "claude-test",
      baseUrl: "https://anthropic.example"
    });
    const response = await provider.chatWithTools({
      messages: [
        {
          role: "user",
          content: "帮我查池子"
        }
      ],
      tools: [
        {
          name: "lookup_pool",
          description: "查询池子",
          inputSchema: {
            type: "object"
          }
        }
      ]
    });

    assert.equal(response.content, "需要调用工具");
    assert.deepEqual(response.toolCalls, [
      {
        name: "lookup_pool",
        arguments: {
          pool: "BONK"
        }
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
