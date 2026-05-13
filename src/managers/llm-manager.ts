import type { IAuditLogger, ILLMProvider } from "../domain/contracts.js";
import type { LLMChatRequest, LLMChatResponse, LLMToolRequest, LLMToolResponse } from "../domain/models.js";
import type { AgentConfig, LLMRouteConfig } from "../config/types.js";
import { RETRY_POLICIES, retryWithPolicy } from "../utils/retry.js";
import type { Logger } from "../utils/logger.js";
import { AnthropicProvider } from "../providers/llm/anthropic-provider.js";
import { MockLLMProvider } from "../providers/llm/mock-llm-provider.js";
import { OpenAIProvider } from "../providers/llm/openai-provider.js";

type LLMRole = "default" | "classification" | "fallback";

interface LLMManagerOptions {
  allowMockProvider?: boolean;
}

/**
 * LLMManager 只负责路由、降级与审计。
 * 真正的业务判断仍然必须落在规则引擎，避免 LLM 结果直接驱动链上操作。
 */
export class LLMManager {
  private readonly providers = new Map<string, ILLMProvider>();
  private readonly allowMockProvider: boolean;

  constructor(
    private readonly config: AgentConfig["llm"],
    private readonly auditLogger: IAuditLogger,
    private readonly logger: Logger,
    options: LLMManagerOptions = {}
  ) {
    this.allowMockProvider = options.allowMockProvider !== false;
    if (this.allowMockProvider) {
      this.providers.set("mock", new MockLLMProvider());
    }
    this.validateRoutes();
    this.bootstrapConfiguredProviders();
  }

  async chat(role: LLMRole, request: LLMChatRequest, cycleId = "standalone"): Promise<LLMChatResponse> {
    const route = this.getRoute(role);
    const provider = this.resolveProvider(route.provider);
    const retryPolicy = RETRY_POLICIES.llm!;

    try {
      const response = await retryWithPolicy(
        retryPolicy,
        () =>
          provider.chat({
            ...request,
            maxTokens: request.maxTokens ?? route.max_tokens,
            temperature: request.temperature ?? route.temperature
          }),
        this.logger,
        `llm:${role}:${provider.name}`
      );

      await this.auditLogger.recordLLMCall(cycleId, role, response, {
        targetProvider: route.provider,
        resolvedProvider: provider.name
      });

      return response;
    } catch (error) {
      if (role !== "fallback" && this.config.fallback) {
        this.logger.warn("主 LLM 调用失败，转入 fallback provider", {
          role,
          targetProvider: route.provider,
          error
        });

        return this.chat("fallback", request, cycleId);
      }

      throw error;
    }
  }

  async chatWithTools(role: LLMRole, request: LLMToolRequest, cycleId = "standalone"): Promise<LLMToolResponse> {
    const route = this.getRoute(role);
    const provider = this.resolveProvider(route.provider);
    const retryPolicy = RETRY_POLICIES.llm!;

    try {
      const response = await retryWithPolicy(
        retryPolicy,
        () =>
          provider.chatWithTools({
            ...request,
            maxTokens: request.maxTokens ?? route.max_tokens,
            temperature: request.temperature ?? route.temperature
          }),
        this.logger,
        `llm-tools:${role}:${provider.name}`
      );

      await this.auditLogger.recordLLMCall(cycleId, role, response, {
        targetProvider: route.provider,
        resolvedProvider: provider.name,
        toolCount: request.tools.length
      });

      return response;
    } catch (error) {
      if (role !== "fallback" && this.config.fallback) {
        this.logger.warn("主 LLM tool 调用失败，转入 fallback provider", {
          role,
          targetProvider: route.provider,
          error
        });

        return this.chatWithTools("fallback", request, cycleId);
      }

      throw error;
    }
  }

  private bootstrapConfiguredProviders(): void {
    const routes = [this.config.default, this.config.classification, this.config.fallback].filter(
      (route): route is LLMRouteConfig => Boolean(route)
    );

    for (const route of routes) {
      if (this.providers.has(route.provider)) {
        continue;
      }

      if (route.provider === "openai") {
        const apiKey = route.api_key_env ? process.env[route.api_key_env] : undefined;
        if (!apiKey) {
          if (!this.allowMockProvider) {
            throw new Error(`OpenAI API Key 未配置，且当前 guardrails 已禁用 mock LLM fallback: ${route.model}`);
          }

          this.logger.warn("OpenAI API Key 未配置，将自动回退到 mock provider", { model: route.model });
          continue;
        }

        this.providers.set(
          "openai",
          new OpenAIProvider({
            apiKey,
            model: route.model,
            baseUrl: route.base_url
          })
        );
      }

      if (route.provider === "anthropic") {
        const apiKey = route.api_key_env ? process.env[route.api_key_env] : undefined;
        if (!apiKey) {
          if (!this.allowMockProvider) {
            throw new Error(`Anthropic API Key 未配置，且当前 guardrails 已禁用 mock LLM fallback: ${route.model}`);
          }

          this.logger.warn("Anthropic API Key 未配置，将自动回退到 mock provider", { model: route.model });
          continue;
        }

        this.providers.set(
          "anthropic",
          new AnthropicProvider({
            apiKey,
            model: route.model,
            baseUrl: route.base_url
          })
        );
      }
    }
  }

  private validateRoutes(): void {
    if (this.allowMockProvider) {
      return;
    }

    const routeEntries: Array<[LLMRole, LLMRouteConfig | undefined]> = [
      ["default", this.config.default],
      ["classification", this.config.classification],
      ["fallback", this.config.fallback]
    ];

    for (const [role, route] of routeEntries) {
      if (route?.provider === "mock") {
        throw new Error(`llm.${role}.provider=mock，但当前 guardrails 已禁用 mock LLM`);
      }
    }
  }

  private getRoute(role: LLMRole): LLMRouteConfig {
    if (role === "classification" && this.config.classification) {
      return this.config.classification;
    }

    if (role === "fallback" && this.config.fallback) {
      return this.config.fallback;
    }

    return this.config.default;
  }

  private resolveProvider(providerName: string): ILLMProvider {
    const provider = this.providers.get(providerName);
    if (provider) {
      return provider;
    }

    const mockProvider = this.providers.get("mock");
    if (mockProvider) {
      return mockProvider;
    }

    throw new Error(`LLM provider ${providerName} 未初始化，且当前未启用 mock fallback`);
  }
}
