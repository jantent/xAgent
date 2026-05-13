import type { Logger } from "../../src/utils/logger.js";

export function createTestLogger(module = "test"): Logger {
  const logger = {
    child(suffix: string) {
      return createTestLogger(`${module}.${suffix}`);
    },
    debug() {},
    info() {},
    warn() {},
    error() {}
  };

  return logger as unknown as Logger;
}
