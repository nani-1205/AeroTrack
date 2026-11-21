// Dead reckoning: between live updates, move each aircraft along its heading at its ground speed
// so the map animates smoothly even when the feed updates every few seconds (or 90 s on OpenSky).

const EARTH_RADIUS_M = 6_371_000;
/** Never extrapolate further than this — a silent aircraft should visibly stop, not fly on forever. */
export const MAX_EXTRAPOLATION_S = 120;

export interface Kinematics {
  lat: number;
  lon: number;
  headingDeg: number | null;
  groundSpeedMs: number | null;
  /** unix seconds of the reported position */
  lastContact: number;
}

/** Destination point after travelling `distanceM` on `bearingDeg` from (lat, lon). */
export function destination(lat: number, lon: number, bearingDeg: number, distanceM: number): { lat: number; lon: number } {
  const d = distanceM / EARTH_RADIUS_M;
  const b = (bearingDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: (p2 * 180) / Math.PI, lon: ((((l2 * 180) / Math.PI + 540) % 360) - 180) };
}

/** Predicted position at `nowSeconds`. */
export function predict(k: Kinematics, nowSeconds: number): { lat: number; lon: number } {
  const dt = Math.min(Math.max(nowSeconds - k.lastContact, 0), MAX_EXTRAPOLATION_S);
  if (!dt || k.headingDeg == null || !k.groundSpeedMs) return { lat: k.lat, lon: k.lon };
  return destination(k.lat, k.lon, k.headingDeg, k.groundSpeedMs * dt);
}

/** Shifts `lon` by ±360° so it is within 180° of `reference` (no jump across the antimeridian). */
export function nearLon(lon: number, reference: number): number {
  let l = lon;
  while (l - reference > 180) l -= 360;
  while (l - reference < -180) l += 360;
  return l;
}

/**
 * Makes a [lon, lat] path continuous across the antimeridian (e.g. 179.9 → 180.1 instead of
 * 179.9 → -179.9), so MapLibre draws the short way instead of a line around the whole world.
 */
export function unwrapPath(points: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [lon, lat] of points) out.push([out.length ? nearLon(lon, out[out.length - 1]![0]) : lon, lat]);
  return out;
}
