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
import { FLIGHT_COLORS, MAP_LABEL_FONT, MAP_STYLE_URL } from '../../core/map-config';
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
    :host { position: relative; display: block; min-height: 20rem; border-radius: var(--radius); overflow: hidden; border: 1px solid var(--border); }
    .map { position: absolute; inset: 0; }
    .map-error { position: absolute; left: 1rem; right: 1rem; top: 1rem; margin: 0; }
  `,
})
export class FlightMap {
  readonly flights = input.required<MapFlight[]>();
  readonly trails = input.required<MapTrails>();
  readonly selected = input<string | null>(null);
  readonly select = output<string>();

  private readonly container = viewChild.required<ElementRef<HTMLDivElement>>('container');
  private readonly styleUrl = inject(MAP_STYLE_URL);
  private readonly font = inject(MAP_LABEL_FONT);
  private readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  private map: MapLibreMap | null = null;
  private fitted = false;

  constructor() {
    afterNextRender(() => void this.init());
    effect(() => {
      const flights = this.flights();
      const trails = this.trails();
      const selected = this.selected();
      if (this.loaded()) this.render(flights, trails, selected);
    });
    inject(DestroyRef).onDestroy(() => this.map?.remove());
  }

  /** Centre the map on one flight. */
  focus(lat: number, lon: number): void {
    this.map?.easeTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), 6), duration: 800 });
  }

  private async init(): Promise<void> {
    try {
      const ml = await import('maplibre-gl'); // lazy: keeps MapLibre out of the initial bundle
      const map = new ml.Map({ container: this.container().nativeElement, style: this.styleUrl, center: [10, 30], zoom: 2 });
      this.map = map;
      map.addControl(new ml.NavigationControl({ showCompass: true }), 'top-right');
      map.addControl(new ml.ScaleControl({ unit: 'nautical' }), 'bottom-left');
      map.on('error', (e) => {
        if (!this.loaded()) this.error.set('The basemap could not be loaded. Live data is still shown in the panel.');
        console.warn('map error', e.error?.message);
      });
      map.on('load', () => {
        FLIGHT_COLORS.forEach((color, i) => map.addImage(`plane-${i}`, planeIcon(color), { pixelRatio: 2 }));
        map.addSource('trails', { type: 'geojson', data: empty() });
        map.addSource('planes', { type: 'geojson', data: empty() });
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

  private render(flights: MapFlight[], trails: MapTrails, selected: string | null): void {
    const map = this.map!;
    const color = (i: number) => FLIGHT_COLORS[i % FLIGHT_COLORS.length]!;
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
      const lons = flights.map((f) => f.lon);
      const lats = flights.map((f) => f.lat);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 80, maxZoom: 7, duration: 0 });
    }
  }
}

function empty() {
  return { type: 'FeatureCollection' as const, features: [] };
}
