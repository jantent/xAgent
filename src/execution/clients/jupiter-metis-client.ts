import type { ExecutionJupiterConfig } from "../../config/types.js";
import type { Logger } from "../../utils/logger.js";

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold?: string;
  routePlan?: unknown[];
  [key: string]: unknown;
}

export interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
  dynamicSlippageReport?: Record<string, unknown>;
  simulationError?: unknown;
  [key: string]: unknown;
}

function withPath(baseUrl: string, path: "quote" | "swap"): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return normalized.endsWith(`/${path}`) ? normalized : `${normalized}/${path}`;
}

export class JupiterMetisClient {
  constructor(private readonly logger: Logger) {}

  async quoteExactIn(
    config: ExecutionJupiterConfig,
    params: {
      inputMint: string;
      outputMint: string;
      amount: bigint;
    }
  ): Promise<JupiterQuoteResponse> {
    const url = new URL(withPath(config.quote_base_url, "quote"));
    url.searchParams.set("inputMint", params.inputMint);
    url.searchParams.set("outputMint", params.outputMint);
    url.searchParams.set("amount", params.amount.toString());
    url.searchParams.set("slippageBps", String(config.slippage_bps));
    url.searchParams.set("restrictIntermediateTokens", "true");

    const response = await fetch(url, {
      headers: this.buildHeaders(config)
    });
    const payload = (await response.json()) as JupiterQuoteResponse;
    if (!response.ok) {
      throw new Error(`Jupiter quote failed: ${response.status} ${JSON.stringify(payload)}`);
    }

    this.logger.info("Jupiter Quote 成功", {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount.toString(),
      routeCount: Array.isArray(payload.routePlan) ? payload.routePlan.length : 0
    });
    return payload;
  }

  async buildSwapTransaction(
    config: ExecutionJupiterConfig,
    params: {
      quoteResponse: JupiterQuoteResponse;
      userPublicKey: string;
    }
  ): Promise<JupiterSwapResponse> {
    const response = await fetch(withPath(config.swap_base_url, "swap"), {
      method: "POST",
      headers: this.buildHeaders(config),
      body: JSON.stringify({
        quoteResponse: params.quoteResponse,
        userPublicKey: params.userPublicKey,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: true,
        wrapAndUnwrapSol: config.wrap_and_unwrap_sol ?? true,
        ...(config.prioritization_fee_lamports
          ? {
              prioritizationFeeLamports: config.prioritization_fee_lamports
            }
          : {})
      })
    });

    const payload = (await response.json()) as JupiterSwapResponse;
    if (!response.ok) {
      throw new Error(`Jupiter swap build failed: ${response.status} ${JSON.stringify(payload)}`);
    }

    if (payload.simulationError) {
      throw new Error(`Jupiter swap simulation failed: ${JSON.stringify(payload.simulationError)}`);
    }

    this.logger.info("Jupiter Swap 交易构建成功", {
      userPublicKey: params.userPublicKey,
      lastValidBlockHeight: payload.lastValidBlockHeight
    });
    return payload;
  }

  private buildHeaders(config: ExecutionJupiterConfig): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };

    const apiKey = config.api_key_env ? process.env[config.api_key_env] : undefined;
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }

    return headers;
  }
}
