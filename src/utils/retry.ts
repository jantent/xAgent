import { sleep } from "./async.js";
import type { Logger } from "./logger.js";

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors: string[];
}

export const RETRY_POLICIES: Record<string, RetryPolicy> = {
  solana_tx: {
    maxRetries: 3,
    baseDelayMs: 2000,
    maxDelayMs: 16000,
    backoffMultiplier: 2,
    retryableErrors: ["BlockhashNotFound", "TransactionExpired", "InsufficientFundsForFee"]
  },
  data_api: {
    maxRetries: 2,
    baseDelayMs: 1000,
    maxDelayMs: 5000,
    backoffMultiplier: 2,
    retryableErrors: ["TIMEOUT", "503", "429", "ECONNRESET", "timeout"]
  },
  llm: {
    maxRetries: 1,
    baseDelayMs: 3000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
    retryableErrors: ["TIMEOUT", "503", "429", "overloaded", "timeout"]
  }
};

function isRetryable(error: unknown, policy: RetryPolicy): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return policy.retryableErrors.some((token) => text.includes(token));
}

/**
 * 重试逻辑集中在这里，避免各模块自己写一套 backoff，导致行为不一致。
 */
export async function retryWithPolicy<T>(
  policy: RetryPolicy,
  task: () => Promise<T>,
  logger: Logger,
  label: string
): Promise<T> {
  let currentAttempt = 0;
  let delayMs = policy.baseDelayMs;
  let lastError: unknown;

  while (currentAttempt <= policy.maxRetries) {
    try {
      return await task();
    } catch (error) {
      lastError = error;

      const reachedLimit = currentAttempt >= policy.maxRetries;
      const retryable = isRetryable(error, policy);

      if (reachedLimit || !retryable) {
        throw error;
      }

      logger.warn("操作失败，准备按策略重试", {
        label,
        currentAttempt,
        nextDelayMs: delayMs,
        error
      });

      await sleep(delayMs);
      delayMs = Math.min(policy.maxDelayMs, Math.round(delayMs * policy.backoffMultiplier));
      currentAttempt += 1;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${label} retry failed`);
}
