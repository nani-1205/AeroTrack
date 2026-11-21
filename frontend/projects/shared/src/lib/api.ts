import { InjectionToken } from '@angular/core';

/**
 * Base URL of the API gateway. The portals hold NO secrets — only this URL.
 * In development the Angular dev server proxies /api, /health and /ws to the gateway (proxy.conf.json).
 */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', { factory: () => '/api' });

/** Users may track 1–5 flights at a time, all from the same airline (also enforced by gateway + backend). */
export const MAX_TRACKED_FLIGHTS = 5;

/** Must match config/gateway.json → csrf. Custom headers force a CORS preflight. */
export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_VALUE = 'aerotrack';

/** Error body returned by the gateway and every service. */
export interface ApiError {
  error: string;
  message: string;
}

export function apiErrorOf(err: unknown): ApiError | null {
  const body = (err as { error?: unknown } | null)?.error;
  if (body && typeof body === 'object' && 'error' in body && 'message' in body) {
    return body as ApiError;
  }
  return null;
}
