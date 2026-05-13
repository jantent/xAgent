import type { ILLMProvider } from "../../domain/contracts.js";
import type { LLMChatRequest, LLMChatResponse, LLMToolRequest, LLMToolResponse } from "../../domain/models.js";

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * 本地 mock LLM 主要承担两个任务：
 * 1. 让主流程在无 API Key 时也能完整跑通；
 * 2. 把 LLM 仅作为“建议层”的原则固定下来，避免业务逻辑偷偷依赖幻觉输出。
 */
export class MockLLMProvider implements ILLMProvider {
  readonly name = "mock";

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const start = Date.now();
    const lastMessage = request.messages.at(-1)?.content ?? "";
    const content = request.jsonMode
      ? JSON.stringify({
          summary: "mock 模型建议以规则引擎结果为准。",
          confidence: 0.66,
          decision: "follow_rules",
          hint: lastMessage.slice(0, 120),
          scoreDelta: 0,
          amountMultiplier: 1
        })
      : `mock 模型已收到请求，建议继续沿用规则引擎决策。摘要：${lastMessage.slice(0, 120)}`;

    return {
      content,
      usage: {
        inputTokens: estimateTokens(lastMessage),
        outputTokens: estimateTokens(content)
      },
      latencyMs: Date.now() - start,
      model: "mock-default",
      provider: this.name
    };
  }

  async chatWithTools(request: LLMToolRequest): Promise<LLMToolResponse> {
    const response = await this.chat(request);
    return {
      ...response,
      toolCalls: []
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
