import type { CacheEntryRecord, ICacheStore } from "./contracts.js";

export class MemoryCacheStore implements ICacheStore {
  readonly kind = "memory";
  private readonly cache = new Map<string, CacheEntryRecord>();

  async get(key: string): Promise<CacheEntryRecord | null> {
    return this.cache.get(key) ?? null;
  }

  async set(key: string, entry: CacheEntryRecord): Promise<void> {
    this.cache.set(key, entry);
  }

  async ping(): Promise<boolean> {
    return true;
  }
}
