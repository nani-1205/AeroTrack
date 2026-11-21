/** Validated categorical slots (dataviz validator: light mode on #ffffff — all checks pass;
 *  slots 3–4 sit below 3:1 contrast, so every chart ships a legend + table view as relief). */
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'] as const;

/** Round "nice" axis ticks from 0 to ≥ max: steps of 1, 2, 2.5 or 5 × 10ⁿ. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks.length > 1 ? ticks : [0, step];
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** Axis label: in full under 10,000, compact above (one style per axis). */
export function axisLabel(v: number, maxTick: number): string {
  return maxTick >= 10_000 ? compact.format(v) : full.format(v);
}

/** Evenly spaced indices for x-axis ticks (always includes first and last). */
export function tickIndices(n: number, max = 6): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => Math.round(i * step));
}
