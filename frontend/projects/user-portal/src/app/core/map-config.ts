import { InjectionToken } from '@angular/core';

/**
 * Basemap style. OpenFreeMap is free and open (OpenStreetMap data, no API key).
 * Swap for any MapLibre-compatible style URL.
 */
export const MAP_STYLE_URL = new InjectionToken<string>('MAP_STYLE_URL', {
  factory: () => 'https://tiles.openfreemap.org/styles/liberty',
});

/** A font served by the style's glyph endpoint (OpenFreeMap serves Noto Sans). */
export const MAP_LABEL_FONT = new InjectionToken<string[]>('MAP_LABEL_FONT', {
  factory: () => ['Noto Sans Regular'],
});

/** One colour per tracked flight (max 5), distinguishable on a light basemap. */
export const FLIGHT_COLORS = ['#d6336c', '#1971c2', '#2f9e44', '#e8590c', '#7048e8'] as const;
