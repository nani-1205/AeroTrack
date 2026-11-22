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

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in kilometres. */
export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLon - aLon) / 2) ** 2;
  return (2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))) / 1000;
}

/**
 * Points along the shortest (great-circle) path between two airports, as a continuous
 * [lon, lat] line. Long routes curve towards the poles: Kolkata → Atlanta flies over the Arctic.
 */
export function greatCircle(from: [number, number], to: [number, number], segments = 96): [number, number][] {
  const [p1, l1, p2, l2] = [rad(from[0]), rad(from[1]), rad(to[0]), rad(to[1])];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (d < 1e-9) return [[from[1], from[0]]];
  const pts: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
    const y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
    const z = a * Math.sin(p1) + b * Math.sin(p2);
    pts.push([deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
  }
  return unwrapPath(pts);
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
