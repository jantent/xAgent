import type { ILLMProvider } from "../../domain/contracts.js";
import type { ChatMessage, LLMChatRequest, LLMChatResponse, LLMToolRequest, LLMToolResponse } from "../../domain/models.js";

interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

function mapMessages(messages: ChatMessage[]): Array<{ role: string; content: string }> {
  return messages.map((message) => ({
    role: message.role === "tool" ? "assistant" : message.role,
    content: message.content
  }));
}

export class OpenAIProvider implements ILLMProvider {
  readonly name = "openai";
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
  }

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const start = Date.now();
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.apiKey}`
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: mapMessages(request.messages),
        temperature: request.temperature ?? 0.3,
        max_tokens: request.maxTokens ?? 2048,
        response_format: request.jsonMode ? { type: "json_object" } : undefined
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI chat failed: ${response.status} ${await response.text()}`);
    }

    const payload = (await response.json()) as any;
    const content = payload.choices?.[0]?.message?.content ?? "";

    return {
      content,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0
      },
      latencyMs: Date.now() - start,
      model: this.options.model,
      provider: this.name
    };
  }

  async chatWithTools(request: LLMToolRequest): Promise<LLMToolResponse> {
    const start = Date.now();
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.apiKey}`
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: mapMessages(request.messages),
        temperature: request.temperature ?? 0.3,
        max_tokens: request.maxTokens ?? 2048,
        tools: request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          }
        }))
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI tool chat failed: ${response.status} ${await response.text()}`);
    }

    const payload = (await response.json()) as any;
    const choice = payload.choices?.[0];

    return {
      content: choice?.message?.content ?? "",
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0
      },
      latencyMs: Date.now() - start,
      model: this.options.model,
      provider: this.name,
      toolCalls: Array.isArray(choice?.message?.tool_calls)
        ? choice.message.tool_calls.map((call: any) => ({
            name: call.function?.name ?? "unknown",
            arguments: call.function?.arguments ? JSON.parse(call.function.arguments) : {}
          }))
        : []
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
