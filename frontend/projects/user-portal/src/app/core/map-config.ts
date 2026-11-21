import { InjectionToken } from '@angular/core';

/**
 * Basemap style. OpenFreeMap is free and open (OpenStreetMap data, no API key).
 * Swap for any MapLibre-compatible style URL.
 */
export const MAP_STYLE_URL = new InjectionToken<string>('MAP_STYLE_URL', {
  // "positron": a muted, low-contrast basemap so the coloured aircraft and trails stand out.
  factory: () => 'https://tiles.openfreemap.org/styles/positron',
});

/**
 * MapLibre's tile worker, copied to /maplibre/ by angular.json "assets". MapLibre would otherwise
 * resolve it relative to its own bundle, which breaks once the bundler (dev cache or prod chunk) moves it.
 */
export const MAP_WORKER_URL = new InjectionToken<string>('MAP_WORKER_URL', {
  factory: () => new URL('/maplibre/maplibre-gl-worker.mjs', document.baseURI).href,
});

/** A font served by the style's glyph endpoint (OpenFreeMap serves Noto Sans). */
export const MAP_LABEL_FONT = new InjectionToken<string[]>('MAP_LABEL_FONT', {
  factory: () => ['Noto Sans Regular'],
});

/** One colour per tracked flight (max 5), distinguishable on a light basemap. */
export const FLIGHT_COLORS = ['#d6336c', '#1971c2', '#2f9e44', '#e8590c', '#7048e8'] as const;
