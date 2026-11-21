// Display formatting. The API speaks SI; aviation displays feet, knots and ft/min.

const M_TO_FT = 3.280_84;
const MS_TO_KT = 1.943_844;
const MS_TO_FPM = 196.850_4;
const nf = new Intl.NumberFormat('en-US');
const DASH = '—';

export function altitude(m: number | null | undefined): string {
  if (m == null) return DASH;
  return `${nf.format(Math.round((m * M_TO_FT) / 100) * 100)} ft`;
}

export function speed(ms: number | null | undefined): string {
  return ms == null ? DASH : `${Math.round(ms * MS_TO_KT)} kt`;
}

export function verticalRate(ms: number | null | undefined): string {
  if (ms == null) return DASH;
  const fpm = Math.round((ms * MS_TO_FPM) / 50) * 50;
  if (Math.abs(fpm) < 100) return 'level';
  return `${fpm > 0 ? '▲ +' : '▼ −'}${nf.format(Math.abs(fpm))} ft/min`;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function heading(deg: number | null | undefined): string {
  if (deg == null) return DASH;
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return `${d}° ${COMPASS[Math.round(d / 22.5) % 16]}`;
}

/** "2h 05m", "14m", "45s" */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** "just now", "12 s ago", "3 min ago" */
export function ago(unixSeconds: number, nowSeconds: number): string {
  const s = Math.max(0, Math.round(nowSeconds - unixSeconds));
  if (s < 3) return 'just now';
  if (s < 120) return `${s} s ago`;
  return `${Math.round(s / 60)} min ago`;
}
