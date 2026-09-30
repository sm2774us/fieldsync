/** Minimal Prometheus text parser: returns totals per metric name (labels summed). */
export function parseMetrics(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+(-?[\d.eE+-]+|NaN)$/.exec(line.trim());
    if (!m) continue;
    const v = Number(m[3]);
    if (Number.isNaN(v)) continue;
    out[m[1]!] = (out[m[1]!] ?? 0) + v;
  }
  return out;
}
