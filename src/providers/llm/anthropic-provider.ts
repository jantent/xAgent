import type { ILLMProvider } from "../../domain/contracts.js";
import type { ChatMessage, LLMChatRequest, LLMChatResponse, LLMToolRequest, LLMToolResponse } from "../../domain/models.js";

interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapMessages(messages: ChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter(
      (message): message is ChatMessage & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant"
    )
    .map((message) => ({
      role: message.role,
      content: message.content
    }));
}

function parseResponse(payload: any, provider: string, model: string, startedAt: number): LLMToolResponse {
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  return {
    content: blocks
      .filter((item: any) => item.type === "text")
      .map((item: any) => item.text)
      .join("\n"),
    usage: {
      inputTokens: payload.usage?.input_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0
    },
    latencyMs: Date.now() - startedAt,
    model,
    provider,
    toolCalls: blocks
      .filter((item: any) => item.type === "tool_use")
      .map((item: any) => ({
        name: typeof item.name === "string" ? item.name : "unknown",
        arguments: isRecord(item.input) ? item.input : {}
      }))
  };
}

export class AnthropicProvider implements ILLMProvider {
  readonly name = "anthropic";
  private readonly baseUrl: string;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com/v1";
  }

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const start = Date.now();
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.options.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: this.options.model,
        system: request.systemPrompt,
        messages: mapMessages(request.messages),
        max_tokens: request.maxTokens ?? 2048,
        temperature: request.temperature ?? 0.3
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic chat failed: ${response.status} ${await response.text()}`);
    }

    const payload = (await response.json()) as any;
    return parseResponse(payload, this.name, this.options.model, start);
  }

  async chatWithTools(request: LLMToolRequest): Promise<LLMToolResponse> {
    const start = Date.now();
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.options.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: this.options.model,
        system: request.systemPrompt,
        messages: mapMessages(request.messages),
        max_tokens: request.maxTokens ?? 2048,
        temperature: request.temperature ?? 0.3,
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema
        }))
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic tool chat failed: ${response.status} ${await response.text()}`);
    }

    const payload = (await response.json()) as any;
    return parseResponse(payload, this.name, this.options.model, start);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
