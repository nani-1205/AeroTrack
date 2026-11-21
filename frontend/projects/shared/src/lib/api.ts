import { InjectionToken } from '@angular/core';

/**
 * Base URL of the API gateway. The portals hold NO secrets — only this URL.
 * In development the Angular dev server proxies /api, /health and /ws to the gateway (proxy.conf.json).
 */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', { factory: () => '/api' });

/** Users may track 1–5 flights at a time, all from the same airline (also enforced by gateway + backend). */
export const MAX_TRACKED_FLIGHTS = 5;
