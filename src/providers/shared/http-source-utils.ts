export type JsonRecord = Record<string, unknown>;
const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_TIMESTAMP_MS = Date.UTC(2100, 0, 1);

export function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as JsonRecord;
}

export function unwrapEnvelope(value: unknown): unknown {
  let current = value;

  for (let depth = 0; depth < 4; depth += 1) {
    const record = asRecord(current);
    if (!record) {
      return current;
    }

    const nested =
      record.data ??
      record.result ??
      record.payload ??
      record.response ??
      record.item ??
      record.attributes;

    if (!nested) {
      return current;
    }

    current = nested;
  }

  return current;
}

export function readString(record: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

export function readNumber(record: JsonRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

export function readBoolean(record: JsonRecord, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "string") {
      if (value === "true") {
        return true;
      }

      if (value === "false") {
        return false;
      }
    }
  }

  return undefined;
}

export function readArray(record: JsonRecord, ...keys: string[]): unknown[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  return undefined;
}

export function readObject(record: JsonRecord, ...keys: string[]): JsonRecord | undefined {
  for (const key of keys) {
    const nested = asRecord(record[key]);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

export function selectEntity(value: unknown, preferredId?: string): JsonRecord | undefined {
  const unwrapped = unwrapEnvelope(value);

  if (Array.isArray(unwrapped)) {
    const objects = unwrapped.map(asRecord).filter((item): item is JsonRecord => Boolean(item));
    if (preferredId) {
      const matched = objects.find((item) => {
        const candidates = [
          readString(item, "mint", "tokenMint", "address", "tokenAddress", "id", "poolAddress")
        ];
        return candidates.includes(preferredId);
      });

      if (matched) {
        return matched;
      }
    }

    return objects[0];
  }

  const record = asRecord(unwrapped);
  if (!record) {
    return undefined;
  }

  const directId = readString(record, "mint", "tokenMint", "address", "tokenAddress", "id", "poolAddress");
  if (directId) {
    if (!preferredId || directId === preferredId) {
      return record;
    }
  }

  return readObject(record, "token", "pool", "item", "attributes", "payload", "data", "result") ?? record;
}

export function selectEntityList(value: unknown): JsonRecord[] {
  const unwrapped = unwrapEnvelope(value);
  if (Array.isArray(unwrapped)) {
    return unwrapped.map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  }

  const record = asRecord(unwrapped);
  if (!record) {
    return [];
  }

  const list =
    readArray(record, "items", "list", "tokens", "rows", "rank", "pools", "candles", "signals") ??
    readArray(record, "data", "result");

  if (list) {
    return list.map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  }

  return [record];
}

export function buildUrl(baseUrl: string, path: string, query?: Record<string, string | number | Array<string | number> | undefined>): string {
  const url = new URL(path, ensureTrailingSlash(baseUrl));
  if (query) {
    for (const [key, rawValue] of Object.entries(query)) {
      if (rawValue === undefined) {
        continue;
      }

      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const value of values) {
        url.searchParams.append(key, String(value));
      }
    }
  }

  return url.toString();
}

export function normalizeFraction(value?: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }

  if (value > 1 && value <= 100) {
    return value / 100;
  }

  return value;
}

export function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = value > 1_000_000_000_000 ? value : value * 1000;
    return normalized >= MIN_TIMESTAMP_MS && normalized <= MAX_TIMESTAMP_MS ? normalized : undefined;
  }

  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      const normalized = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
      return normalized >= MIN_TIMESTAMP_MS && normalized <= MAX_TIMESTAMP_MS ? normalized : undefined;
    }

    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= MIN_TIMESTAMP_MS && parsed <= MAX_TIMESTAMP_MS) {
      return parsed;
    }
  }

  return undefined;
}

function ensureTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}
