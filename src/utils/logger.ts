type LogLevel = "debug" | "info" | "warn" | "error";

function normalizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return {
    message: String(error)
  };
}

function normalizeFields(fields?: Record<string, unknown>): Record<string, unknown> {
  if (!fields) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (value instanceof Error) {
        return [key, normalizeError(value)];
      }

      return [key, value];
    })
  );
}

/**
 * 这里不引入额外日志库，原因是当前仓库还处于核心骨架阶段。
 * 先统一成结构化 JSON 输出，后续接入 pino / Winston 时可以平滑替换。
 */
export class Logger {
  constructor(
    private readonly module: string,
    private readonly baseFields: Record<string, unknown> = {}
  ) {}

  child(moduleSuffix: string, extraFields: Record<string, unknown> = {}): Logger {
    return new Logger(`${this.module}.${moduleSuffix}`, {
      ...this.baseFields,
      ...extraFields
    });
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      module: this.module,
      message,
      ...this.baseFields,
      ...normalizeFields(fields)
    };

    console.log(JSON.stringify(payload));
  }
}

export const rootLogger = new Logger("xagent");
export const serializeError = normalizeError;
