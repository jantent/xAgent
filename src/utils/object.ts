/**
 * 这里不做通用的深层 schema 合并，只做“对象层级的递归覆盖”。
 * 这样可以满足 Skill 参数热更新，又不会引入额外依赖。
 */
export function deepMerge<T>(target: T, patch: Partial<T>): T {
  if (typeof target !== "object" || target === null) {
    return patch as T;
  }

  if (typeof patch !== "object" || patch === null) {
    return target;
  }

  const base = Array.isArray(target) ? [...target] : { ...target };

  for (const [key, value] of Object.entries(patch)) {
    const typedKey = key as keyof T;
    const currentValue = target[typedKey];

    if (Array.isArray(value)) {
      (base as T)[typedKey] = value as T[keyof T];
      continue;
    }

    if (typeof value === "object" && value !== null && typeof currentValue === "object" && currentValue !== null) {
      (base as T)[typedKey] = deepMerge(currentValue, value) as T[keyof T];
      continue;
    }

    (base as T)[typedKey] = value as T[keyof T];
  }

  return base as T;
}
