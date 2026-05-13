type MetricType = "counter" | "gauge";
type MetricLabels = Record<string, string | number | boolean>;

interface MetricSeries {
  labels: MetricLabels;
  value: number;
}

interface MetricDefinition {
  name: string;
  help: string;
  type: MetricType;
  series: Map<string, MetricSeries>;
}

function serializeLabels(labels: MetricLabels): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`)
    .join(",");
}

function seriesKey(labels: MetricLabels): string {
  return JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * 当前先实现一个轻量级 Prometheus 文本导出器。
 * 目标是尽快把“可观测性接口”立起来，后续即使替换成 prom-client，
 * 上层调用方式也可以保持一致。
 */
export class MetricsRegistry {
  private readonly metrics = new Map<string, MetricDefinition>();

  define(name: string, help: string, type: MetricType): void {
    if (this.metrics.has(name)) {
      return;
    }

    this.metrics.set(name, {
      name,
      help,
      type,
      series: new Map()
    });
  }

  increment(name: string, help: string, labels: MetricLabels = {}, value = 1): void {
    const metric = this.getOrCreate(name, help, "counter");
    const key = seriesKey(labels);
    const existing = metric.series.get(key);

    metric.series.set(key, {
      labels,
      value: (existing?.value ?? 0) + value
    });
  }

  setGauge(name: string, help: string, value: number, labels: MetricLabels = {}): void {
    const metric = this.getOrCreate(name, help, "gauge");
    metric.series.set(seriesKey(labels), {
      labels,
      value
    });
  }

  renderPrometheus(): string {
    const lines: string[] = [];

    for (const metric of Array.from(this.metrics.values()).sort((left, right) => left.name.localeCompare(right.name))) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);

      for (const series of metric.series.values()) {
        const labels = serializeLabels(series.labels);
        if (labels) {
          lines.push(`${metric.name}{${labels}} ${series.value}`);
        } else {
          lines.push(`${metric.name} ${series.value}`);
        }
      }
    }

    return `${lines.join("\n")}\n`;
  }

  private getOrCreate(name: string, help: string, type: MetricType): MetricDefinition {
    const existing = this.metrics.get(name);
    if (existing) {
      return existing;
    }

    const created: MetricDefinition = {
      name,
      help,
      type,
      series: new Map()
    };
    this.metrics.set(name, created);
    return created;
  }
}
