import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { FLIGHT_COLORS, MAP_LABEL_FONT, MAP_STYLE_URL, MAP_WORKER_URL } from '../../core/map-config';

/** Show a "basemap unavailable" notice only if the map has not loaded after this long. */
const LOAD_TIMEOUT_MS = 15_000;
import { planeIcon } from './plane-icon';

export interface MapFlight {
  id: string;
  callsign: string;
  lat: number;
  lon: number;
  heading: number;
  colorIndex: number;
  stale: boolean;
}

/** id → [lon, lat] points, oldest first. */
export type MapTrails = Record<string, [number, number][]>;

/** Planned great-circle route with its airports (only when the feed knows the route). */
export interface MapRoute {
  id: string;
  colorIndex: number;
  /** [lon, lat] points, origin → destination, continuous across the antimeridian. */
  path: [number, number][];
  origin: { code: string; lon: number; lat: number };
  destination: { code: string; lon: number; lat: number };
}

@Component({
  selector: 'app-flight-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div #container class="map" role="region" aria-label="Live flight map"></div>
    @if (error(); as message) {
      <div class="map-error alert" role="alert">{{ message }}</div>
    }
  `,
  styles: `
    :host { position: relative; display: block; min-height: 20rem; overflow: hidden; background: #eef1f4; }
    .map { position: absolute; inset: 0; }
    .map-error { position: absolute; left: 1rem; right: 1rem; top: 1rem; margin: 0; }
  `,
})
export class FlightMap {
  readonly flights = input.required<MapFlight[]>();
  readonly trails = input.required<MapTrails>();
  readonly routes = input<MapRoute[]>([]);
  readonly selected = input<string | null>(null);
  readonly select = output<string>();

  private readonly container = viewChild.required<ElementRef<HTMLDivElement>>('container');
  private readonly styleUrl = inject(MAP_STYLE_URL);
  private readonly font = inject(MAP_LABEL_FONT);
  private readonly workerUrl = inject(MAP_WORKER_URL);
  private readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  private map: MapLibreMap | null = null;
  private fitted = false;

  constructor() {
    afterNextRender(() => void this.init());
    effect(() => {
      const flights = this.flights();
      const trails = this.trails();
      const routes = this.routes();
      const selected = this.selected();
      if (this.loaded()) this.render(flights, trails, routes, selected);
    });
    inject(DestroyRef).onDestroy(() => this.map?.remove());
  }

  /** Room kept free for the floating flight panel on the right (desktop layout). */
  private readonly padding = () =>
    window.innerWidth > 900 ? { top: 90, bottom: 90, left: 90, right: 440 } : { top: 60, bottom: 60, left: 40, right: 40 };

  /** Centre the map on one flight (shifted left so the panel does not cover it). */
  focus(lat: number, lon: number): void {
    const offsetX = window.innerWidth > 900 ? -190 : 0;
    this.map?.easeTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), 6), offset: [offsetX, 0], duration: 800 });
  }

  /** Zoom to show every tracked flight together with its whole planned route. */
  fitAll(animate = true): void {
    const flights = this.flights();
    if (!this.map || flights.length === 0) return;
    const points: [number, number][] = [...flights.map((f) => [f.lon, f.lat] as [number, number]), ...this.routes().flatMap((r) => r.path)];
    const lons = points.map((p) => p[0]);
    const lats = points.map((p) => p[1]);
    this.map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {
      padding: this.padding(), maxZoom: 6.5, duration: animate ? 900 : 0,
    });
  }

  private async init(): Promise<void> {
    try {
      const ml = await import('maplibre-gl'); // lazy: keeps MapLibre out of the initial bundle
      ml.setWorkerUrl(this.workerUrl);
      const map = new ml.Map({
        container: this.container().nativeElement, style: this.styleUrl, center: [10, 30], zoom: 2, attributionControl: false,
      });
      this.map = map;
      // Controls live on the left: the right side is covered by the floating flight panel.
      map.addControl(new ml.NavigationControl({ showCompass: true }), 'top-left');
      map.addControl(new ml.ScaleControl({ unit: 'nautical' }), 'bottom-left');
      map.addControl(new ml.AttributionControl({ compact: true }), 'bottom-left');
      // Individual tile/glyph errors are normal on flaky networks; only a map that never loads is an error.
      map.on('error', (e) => console.warn('map error', e.error?.message));
      const timeout = setTimeout(() => {
        if (!this.loaded()) this.error.set('The basemap is taking too long to load. Live data is still shown in the panel.');
      }, LOAD_TIMEOUT_MS);
      map.once('load', () => clearTimeout(timeout));
      map.on('load', () => {
        FLIGHT_COLORS.forEach((color, i) => map.addImage(`plane-${i}`, planeIcon(color, 80), { pixelRatio: 2 }));
        map.addSource('routes', { type: 'geojson', data: empty() });
        map.addSource('airports', { type: 'geojson', data: empty() });
        map.addSource('trails', { type: 'geojson', data: empty() });
        map.addSource('planes', { type: 'geojson', data: empty() });
        // Planned route: dashed, faint — the flown trail (solid) is drawn on top of it.
        map.addLayer({
          id: 'routes',
          type: 'line',
          source: 'routes',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.55, 'line-dasharray': [2, 3] },
        });
        map.addLayer({
          id: 'airports',
          type: 'circle',
          source: 'airports',
          paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-width': 2.5, 'circle-stroke-color': ['get', 'color'] },
        });
        map.addLayer({
          id: 'airport-labels',
          type: 'symbol',
          source: 'airports',
          layout: {
            'text-field': ['get', 'code'],
            'text-font': this.font,
            'text-size': 12,
            'text-offset': [0, 1.1],
            'text-anchor': 'top',
            'text-allow-overlap': true,
          },
          paint: { 'text-color': '#1f2937', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
        });
        map.addLayer({
          id: 'trails',
          type: 'line',
          source: 'trails',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.75 },
        });
        map.addLayer({
          id: 'selected-halo',
          type: 'circle',
          source: 'planes',
          filter: ['==', ['get', 'id'], ''],
          paint: { 'circle-radius': 22, 'circle-color': ['get', 'color'], 'circle-opacity': 0.18, 'circle-stroke-width': 2, 'circle-stroke-color': ['get', 'color'] },
        });
        map.addLayer({
          id: 'planes',
          type: 'symbol',
          source: 'planes',
          layout: {
            'icon-image': ['get', 'icon'],
            'icon-rotate': ['get', 'heading'],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'text-field': ['get', 'callsign'],
            'text-font': this.font,
            'text-size': 12,
            'text-offset': [0, 1.9],
            'text-anchor': 'top',
            'text-optional': true,
          },
          paint: {
            'icon-opacity': ['case', ['get', 'stale'], 0.45, 1],
            'text-color': '#1f2328',
            'text-halo-color': '#ffffff',
            'text-halo-width': 1.5,
          },
        });
        map.on('click', 'planes', (e) => {
          const id = e.features?.[0]?.properties?.['id'];
          if (typeof id === 'string') this.select.emit(id);
        });
        map.on('mouseenter', 'planes', () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', 'planes', () => (map.getCanvas().style.cursor = ''));
        this.error.set(null);
        this.loaded.set(true);
      });
    } catch (err) {
      console.error(err);
      this.error.set('The map could not be started in this browser (WebGL is required).');
    }
  }

  private render(flights: MapFlight[], trails: MapTrails, routes: MapRoute[], selected: string | null): void {
    const map = this.map!;
    const color = (i: number) => FLIGHT_COLORS[i % FLIGHT_COLORS.length]!;
    (map.getSource('routes') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: routes.map((r) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: r.path },
        properties: { color: color(r.colorIndex) },
      })),
    });
    (map.getSource('airports') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: routes.flatMap((r) =>
        [r.origin, r.destination].map((a) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [a.lon, a.lat] },
          properties: { code: a.code, color: color(r.colorIndex) },
        })),
      ),
    });
    (map.getSource('planes') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: flights.map((f) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
        properties: { id: f.id, callsign: f.callsign, heading: f.heading, icon: `plane-${f.colorIndex % FLIGHT_COLORS.length}`, color: color(f.colorIndex), stale: f.stale },
      })),
    });
    (map.getSource('trails') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: flights
        .filter((f) => (trails[f.id]?.length ?? 0) >= 2)
        .map((f) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: trails[f.id]! }, properties: { color: color(f.colorIndex) } })),
    });
    map.setFilter('selected-halo', ['==', ['get', 'id'], selected ?? '']);

    if (!this.fitted && flights.length > 0) {
      this.fitted = true;
      this.fitAll(false);
    }
  }
}

function empty() {
  return { type: 'FeatureCollection' as const, features: [] };
}
