/**
 * 统一 sleep 工具，便于编排器的双循环和重试逻辑复用。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 给任意 Promise 增加超时保护，避免单个依赖把整个主循环卡死。
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label = "operation"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * 简单的 ID 生成器，满足日志、计划和模拟仓位的唯一标识需求。
 */
export function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 灰度策略需要稳定的概率判定，这里统一抽成工具函数，方便后续接入可控随机源。
 */
export function percentRoll(percent: number, rng: () => number = Math.random): boolean {
  return rng() * 100 <= percent;
}
