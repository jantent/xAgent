import type { SharedStateSnapshot } from "../core/shared-state.js";

export interface CacheEntryRecord {
  valueJson: string;
  expiresAt: number;
}

export interface IStateStore {
  readonly kind: string;
  load(): Promise<SharedStateSnapshot | null>;
  save(snapshot: SharedStateSnapshot): Promise<void>;
  ping?(): Promise<boolean>;
  close?(): Promise<void>;
}

export interface ICacheStore {
  readonly kind: string;
  get(key: string): Promise<CacheEntryRecord | null>;
  set(key: string, entry: CacheEntryRecord): Promise<void>;
  ping?(): Promise<boolean>;
  close?(): Promise<void>;
}
