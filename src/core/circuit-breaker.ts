import type { ProviderHealthStatus } from "../domain/models.js";

type CircuitState = "closed" | "open" | "half_open";

/**
 * 熔断器的目的不是“报错更好看”，而是隔离故障依赖，防止主循环被连续拖垮。
 * 这里的实现足够轻量，但保留了 closed / open / half_open 三态，方便后续接入 metrics。
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private consecutiveFailures = 0;
  private lastFailureAt?: Date;
  private lastSuccessAt?: Date;
  private lastError?: string;

  constructor(
    private readonly name: string,
    private readonly failureThreshold: number,
    private readonly recoveryTimeMs: number
  ) {}

  isOpen(): boolean {
    if (this.state !== "open") {
      return false;
    }

    if (!this.lastFailureAt) {
      return true;
    }

    const elapsed = Date.now() - this.lastFailureAt.getTime();
    if (elapsed > this.recoveryTimeMs) {
      this.state = "half_open";
      return false;
    }

    return true;
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.consecutiveFailures = 0;
    this.lastSuccessAt = new Date();
    this.lastError = undefined;
    this.state = "closed";
  }

  recordFailure(error?: unknown): void {
    this.failureCount += 1;
    this.consecutiveFailures += 1;
    this.lastFailureAt = new Date();
    this.lastError = error instanceof Error ? error.message : error ? String(error) : undefined;

    if (this.failureCount >= this.failureThreshold || this.state === "half_open") {
      this.state = "open";
    }
  }

  snapshot(canWrite = false, latencyMs?: number, simulated = false): ProviderHealthStatus {
    return {
      provider: this.name,
      ok: this.state !== "open",
      canRead: this.state !== "open",
      canWrite,
      latencyMs,
      lastCheckedAt: new Date(),
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      simulated
    };
  }

  getState(): CircuitState {
    return this.state;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }
}
