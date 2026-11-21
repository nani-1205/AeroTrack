import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MAX_TRACKED_FLIGHTS } from '@aerotrack/shared';
import * as fmt from '../../core/format';
import { predict } from '../../core/geo';
import { LiveSocket } from '../../core/live-socket';
import { FLIGHT_COLORS } from '../../core/map-config';
import type { Airline, Flight } from '../../core/models';
import { TrackingApi } from '../../core/tracking-api';
import { FlightMap, type MapFlight, type MapTrails } from './flight-map';

const ICAO24 = /^[0-9a-f]{6}$/;
/** Add a trail point at most this often (the server samples every 30 s; live frames are denser). */
const TRAIL_STEP_S = 10;
const STALE_AFTER_S = 60;

interface Tracked extends Flight {
  colorIndex: number;
  lost: boolean;
}

/** Parses ?ids=a,b,c — returns null when the selection is not 1–5 valid icao24 codes. */
export function parseIds(raw: string | undefined, max = MAX_TRACKED_FLIGHTS): string[] | null {
  const ids = [...new Set((raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
  return ids.length >= 1 && ids.length <= max && ids.every((id) => ICAO24.test(id)) ? ids : null;
}

@Component({
  selector: 'app-track',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FlightMap],
  providers: [LiveSocket],
  template: `
    @if (!selection()) {
      <div class="card empty">
        Select between 1 and {{ max }} flights of one airline to track.
        <a routerLink="/">Choose an airline</a>
      </div>
    } @else {
      <div class="layout">
        <app-flight-map class="map" [flights]="mapFlights()" [trails]="mapTrails()" [selected]="selectedId()" (select)="choose($event)" />

        <aside class="panel">
          <nav class="breadcrumb">
            <a routerLink="/">Airlines</a> /
            @if (airline(); as a) { <a [routerLink]="['/airlines', a.icao]">{{ a.name }}</a> } @else { … }
          </nav>
          <header class="head">
            <h1>Live tracking</h1>
            <span class="badge" [class]="statusClass()">{{ statusText() }}</span>
          </header>
          @if (live.error(); as message) {
            <div class="alert" role="alert">{{ message }}</div>
          }

          @for (f of tracked(); track f.icao24) {
            <button type="button" class="card flight" [class.active]="f.icao24 === selectedId()" [class.lost]="f.lost" (click)="choose(f.icao24)">
              <span class="title">
                <span class="swatch" [style.background]="colors[f.colorIndex]"></span>
                <strong class="mono">{{ f.callsign }}</strong>
                @if (f.route) { <span class="muted">{{ f.route.origin }} → {{ f.route.destination }}</span> }
              </span>
              @if (f.lost) {
                <span class="badge off">No longer reported — landed or out of coverage</span>
              }
              <dl>
                <dt>Altitude</dt><dd>{{ fmt.altitude(f.altitudeM) }}</dd>
                <dt>Speed</dt><dd>{{ fmt.speed(f.groundSpeedMs) }}</dd>
                <dt>Heading</dt><dd>{{ fmt.heading(f.headingDeg) }}</dd>
                <dt>Vertical</dt><dd>{{ fmt.verticalRate(f.verticalRateMs) }}</dd>
                <dt>Aircraft</dt><dd>{{ f.aircraftType ?? '—' }}{{ f.registration ? ' · ' + f.registration : '' }}</dd>
                <dt>Airborne</dt><dd>{{ fmt.duration(now() - f.firstSeen) }}</dd>
                <dt>Updated</dt><dd>{{ fmt.ago(f.lastContact, now()) }} <span class="muted">({{ sourceName(f.source) }})</span></dd>
              </dl>
            </button>
          } @empty {
            <p class="muted">Connecting to live data…</p>
          }
        </aside>
      </div>
    }
  `,
  styles: `
    :host { display: block; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 21rem; gap: 1rem; height: calc(100vh - 7.5rem); min-height: 28rem; }
    .panel { overflow-y: auto; display: grid; align-content: start; gap: .75rem; padding-right: .25rem; }
    .head { display: flex; align-items: center; justify-content: space-between; }
    .head h1 { margin: 0; font-size: 1.25rem; }
    .flight { text-align: left; font: inherit; color: inherit; cursor: pointer; padding: .85rem 1rem; display: grid; gap: .5rem; }
    .flight.active { border-color: var(--brand); box-shadow: 0 0 0 1px var(--brand); }
    .flight.lost { opacity: .65; }
    .title { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .swatch { width: .8rem; height: .8rem; border-radius: 50%; flex: none; }
    dl { display: grid; grid-template-columns: auto 1fr; gap: .2rem .75rem; margin: 0; font-size: .85rem; }
    dt { color: var(--muted); }
    dd { margin: 0; font-variant-numeric: tabular-nums; }
    @media (max-width: 900px) { .layout { grid-template-columns: 1fr; height: auto; } .map { height: 60vh; } }
  `,
})
export class TrackPage {
  private readonly api = inject(TrackingApi);
  protected readonly live = inject(LiveSocket);
  private readonly map = viewChild(FlightMap);

  /** Query parameter ?ids=a,b,c (withComponentInputBinding). */
  readonly ids = input<string>();

  protected readonly fmt = fmt;
  protected readonly max = MAX_TRACKED_FLIGHTS;
  protected readonly colors = FLIGHT_COLORS;
  protected readonly selection = computed(() => parseIds(this.ids()));
  protected readonly airline = signal<Omit<Airline, 'activeFlights'> | null>(null);
  private readonly flights = signal<Record<string, Tracked>>({});
  private readonly trails = signal<MapTrails>({});
  private readonly lastTrailTs: Record<string, number> = {};
  protected readonly selectedId = signal<string | null>(null);
  protected readonly now = signal(Date.now() / 1000);

  protected readonly tracked = computed(() => Object.values(this.flights()).sort((a, b) => a.colorIndex - b.colorIndex));

  /** Positions advanced by dead reckoning between live updates. */
  protected readonly mapFlights = computed<MapFlight[]>(() => {
    const now = this.now();
    return this.tracked().map((f) => {
      const p = f.lost ? f : predict(f, now);
      return { id: f.icao24, callsign: f.callsign, lat: p.lat, lon: p.lon, heading: f.headingDeg ?? 0, colorIndex: f.colorIndex, stale: f.lost || now - f.lastContact > STALE_AFTER_S };
    });
  });

  /** Recorded trail + a final segment to the (predicted) current position. */
  protected readonly mapTrails = computed<MapTrails>(() => {
    const trails = this.trails();
    const out: MapTrails = {};
    for (const f of this.mapFlights()) out[f.id] = [...(trails[f.id] ?? []), [f.lon, f.lat]];
    return out;
  });

  protected readonly statusText = computed(() => {
    switch (this.live.status()) {
      case 'live': return 'Live';
      case 'connecting': return 'Connecting…';
      case 'reconnecting': return 'Reconnecting…';
      case 'ended': return 'Tracking ended';
      case 'error': return 'Stopped';
      default: return '';
    }
  });
  protected readonly statusClass = computed(() => {
    const s = this.live.status();
    return 'badge ' + (s === 'live' ? '' : s === 'error' ? 'bad' : s === 'ended' ? 'off' : 'warn');
  });

  constructor() {
    let started = false;
    effect(() => {
      const ids = this.selection();
      if (!ids || started) return;
      started = true;
      this.start(ids);
    });
    const clock = setInterval(() => this.now.set(Date.now() / 1000), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(clock));
  }

  protected choose(id: string): void {
    this.selectedId.set(id);
    const f = this.mapFlights().find((x) => x.id === id);
    if (f) this.map()?.focus(f.lat, f.lon);
  }

  protected sourceName(source: Flight['source']): string {
    return source === 'adsbLol' ? 'adsb.lol' : source === 'opensky' ? 'OpenSky' : 'simulator';
  }

  private start(ids: string[]): void {
    const colorOf = (id: string) => Math.max(0, ids.indexOf(id));
    this.live.track(ids, {
      subscribed: (airline, flights) => {
        this.airline.set(airline);
        this.upsert(flights, colorOf);
      },
      positions: (flights, removed) => {
        this.upsert(flights, colorOf);
        if (removed.length) this.markLost(removed);
      },
      ended: () => this.markLost(Object.keys(this.flights())),
    });

    // Recorded trails (and a first position, in case the socket is slower).
    void Promise.all(ids.map((id) => this.api.flight(id, true).catch(() => null))).then((details) => {
      const trails: MapTrails = { ...this.trails() };
      const initial: Flight[] = [];
      for (const d of details) {
        if (!d) continue;
        const recorded = (d.trail ?? []).map(([lat, lon]) => [lon, lat] as [number, number]);
        trails[d.flight.icao24] = [...recorded, ...(trails[d.flight.icao24] ?? [])];
        this.lastTrailTs[d.flight.icao24] = d.trail?.at(-1)?.[3] ?? 0;
        if (!this.flights()[d.flight.icao24]) initial.push(d.flight);
        if (d.airline && !this.airline()) this.airline.set(d.airline);
      }
      this.trails.set(trails);
      this.upsert(initial, colorOf);
    });
  }

  private upsert(flights: Flight[], colorOf: (id: string) => number): void {
    if (flights.length === 0) return;
    const next = { ...this.flights() };
    const trails = { ...this.trails() };
    for (const f of flights) {
      const prev = next[f.icao24];
      if (prev && f.lastContact < prev.lastContact) continue; // out-of-order frame
      next[f.icao24] = { ...f, colorIndex: colorOf(f.icao24), lost: false };
      if (f.lastContact - (this.lastTrailTs[f.icao24] ?? 0) >= TRAIL_STEP_S) {
        trails[f.icao24] = [...(trails[f.icao24] ?? []), [f.lon, f.lat]];
        this.lastTrailTs[f.icao24] = f.lastContact;
      }
    }
    this.flights.set(next);
    this.trails.set(trails);
  }

  private markLost(ids: string[]): void {
    const next = { ...this.flights() };
    for (const id of ids) if (next[id]) next[id] = { ...next[id]!, lost: true };
    this.flights.set(next);
  }
}
