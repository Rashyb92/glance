/**
 * Minimal in-process metrics in Prometheus text format. Zero dependencies; a real
 * deployment can scrape `/metrics` or swap this for prom-client behind the same
 * `metrics.inc/gauge` surface.
 */
const counters = new Map<string, number>();
const gauges = new Map<string, () => number>();

export const metrics = {
  inc(name: string, by = 1): void {
    counters.set(name, (counters.get(name) ?? 0) + by);
  },
  gauge(name: string, read: () => number): void {
    gauges.set(name, read);
  },
  render(): string {
    const lines: string[] = [];
    for (const [name, value] of counters) {
      lines.push(`# TYPE ${name} counter`, `${name} ${value}`);
    }
    for (const [name, read] of gauges) {
      let v = 0;
      try {
        v = read();
      } catch {
        v = 0;
      }
      lines.push(`# TYPE ${name} gauge`, `${name} ${v}`);
    }
    return `${lines.join('\n')}\n`;
  },
};
