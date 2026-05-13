import type { Logger } from "../../utils/logger.js";

interface JsonRpcSuccess<TResult> {
  jsonrpc: string;
  id?: number | string | null;
  result: TResult;
}

interface JsonRpcFailure {
  jsonrpc: string;
  id?: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcResponse<TResult> = JsonRpcSuccess<TResult> | JsonRpcFailure;

export interface JitoSendTransactionOptions {
  endpoint: string;
  apiKey?: string;
  bundleOnly?: boolean;
}

export interface JitoSendTransactionResult {
  signature: string;
  bundleId?: string;
}

export interface JitoHealthCheckOptions {
  endpoint: string;
  apiKey?: string;
}

export interface JitoHealthCheckResult {
  healthy: boolean;
  error?: string;
  tipAccounts?: string[];
}

function normalizeTransactionsEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");

  if (trimmed.endsWith("/api/v1/transactions")) {
    return trimmed;
  }

  if (trimmed.endsWith("/api/v1/bundles")) {
    return `${trimmed.slice(0, -"/api/v1/bundles".length)}/api/v1/transactions`;
  }

  if (trimmed.endsWith("/api/v1")) {
    return `${trimmed}/transactions`;
  }

  return `${trimmed}/api/v1/transactions`;
}

function normalizeTipAccountsEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");

  if (trimmed.endsWith("/api/v1/getTipAccounts")) {
    return trimmed;
  }

  if (trimmed.endsWith("/api/v1/transactions")) {
    return `${trimmed.slice(0, -"/transactions".length)}/getTipAccounts`;
  }

  if (trimmed.endsWith("/api/v1/bundles")) {
    return `${trimmed.slice(0, -"/bundles".length)}/getTipAccounts`;
  }

  if (trimmed.endsWith("/api/v1")) {
    return `${trimmed}/getTipAccounts`;
  }

  return `${trimmed}/api/v1/getTipAccounts`;
}

export class JitoBlockEngineClient {
  constructor(private readonly logger: Logger) {}

  async healthCheck(options: JitoHealthCheckOptions): Promise<JitoHealthCheckResult> {
    const url = normalizeTipAccountsEndpoint(options.endpoint);
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };

    if (options.apiKey) {
      headers["x-jito-auth"] = options.apiKey;
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTipAccounts",
          params: []
        })
      });

      const payload = (await response.json()) as JsonRpcResponse<string[]>;
      if (!response.ok) {
        return {
          healthy: false,
          error: `Jito block engine returned ${response.status}: ${JSON.stringify(payload)}`
        };
      }

      if ("error" in payload) {
        return {
          healthy: false,
          error: payload.error.message
        };
      }

      const tipAccounts = Array.isArray(payload.result)
        ? payload.result.filter((item): item is string => typeof item === "string" && item.length > 0)
        : [];

      if (tipAccounts.length === 0) {
        return {
          healthy: false,
          error: "Jito getTipAccounts 返回空结果"
        };
      }

      return {
        healthy: true,
        tipAccounts
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async sendTransaction(
    serializedTransactionBase64: string,
    options: JitoSendTransactionOptions
  ): Promise<JitoSendTransactionResult> {
    const url = new URL(normalizeTransactionsEndpoint(options.endpoint));
    if (options.bundleOnly) {
      url.searchParams.set("bundleOnly", "true");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };

    if (options.apiKey) {
      headers["x-jito-auth"] = options.apiKey;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [serializedTransactionBase64, { encoding: "base64" }]
      })
    });

    const payload = (await response.json()) as JsonRpcResponse<string>;
    if (!response.ok) {
      throw new Error(`Jito block engine returned ${response.status}: ${JSON.stringify(payload)}`);
    }

    if ("error" in payload) {
      throw new Error(`Jito sendTransaction failed: ${payload.error.message}`);
    }

    const bundleId = response.headers.get("x-bundle-id") ?? undefined;
    this.logger.info("Jito 交易发送成功", {
      endpoint: url.toString(),
      signature: payload.result,
      bundleId
    });

    return {
      signature: payload.result,
      bundleId
    };
  }
}
