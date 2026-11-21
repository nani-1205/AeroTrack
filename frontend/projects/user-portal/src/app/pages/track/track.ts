import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { EmptyState, Icon, MAX_TRACKED_FLIGHTS, Monogram } from '@aerotrack/shared';
import { ArrowLeft, Maximize, Navigation2, Plane, PlaneLanding, RadioTower } from 'lucide';
import * as fmt from '../../core/format';
import { nearLon, predict, unwrapPath } from '../../core/geo';
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
  imports: [RouterLink, FlightMap, Icon, Monogram, EmptyState],
  providers: [LiveSocket],
  template: `
    @if (!selection()) {
      <div class="page">
        <div class="card">
          <ui-empty-state [icon]="icons.Plane" heading="Nothing to track yet" [description]="'Select between 1 and ' + max + ' flights of one airline to follow them live.'">
            <a class="btn btn-primary" routerLink="/">Choose an airline</a>
          </ui-empty-state>
        </div>
      </div>
    } @else {
      <app-flight-map class="map" [flights]="mapFlights()" [trails]="mapTrails()" [selected]="selectedId()" (select)="choose($event)" />

      <aside class="panel glass" aria-label="Tracked flights">
        <header class="panel-head">
          <a class="btn btn-icon btn-sm btn-ghost" [routerLink]="airline() ? ['/airlines', airline()!.icao] : ['/']" aria-label="Back to flights">
            <ui-icon [icon]="icons.ArrowLeft" [size]="16" />
          </a>
          @if (airline(); as a) {
            <ui-monogram [code]="a.icao" [label]="a.iata || a.icao" [size]="36" />
            <div class="who"><strong>{{ a.name }}</strong><span class="subtle">{{ tracked().length }} {{ tracked().length === 1 ? 'flight' : 'flights' }} tracked</span></div>
          } @else {
            <div class="who"><span class="skeleton" style="height:14px;width:120px"></span></div>
          }
          <button type="button" class="btn btn-icon btn-sm" (click)="map()?.fitAll()" title="Fit all flights" aria-label="Fit all flights">
            <ui-icon [icon]="icons.Maximize" [size]="15" />
          </button>
        </header>

        <div class="status" [class]="'status ' + live.status()">
          <span class="dot" [class.live]="live.status() === 'live'"></span>
          <span>{{ statusText() }}</span>
        </div>

        @if (live.error(); as message) {
          <div class="alert" role="alert">{{ message }}</div>
        }

        <div class="flights">
          @for (f of tracked(); track f.icao24) {
            <button type="button" class="flight" [class.active]="f.icao24 === selectedId()" [class.lost]="f.lost"
                    [style.--c]="colors[f.colorIndex]" (click)="choose(f.icao24)">
              <span class="top">
                <span class="cs mono">{{ f.callsign }}</span>
                @if (f.aircraftType) { <span class="badge outline">{{ f.aircraftType }}</span> }
                <span class="flex"></span>
                @if (f.lost) {
                  <span class="badge"><ui-icon [icon]="icons.PlaneLanding" [size]="12" /> Landed / out of range</span>
                } @else {
                  <span class="age subtle">{{ fmt.ago(f.lastContact, now()) }}</span>
                }
              </span>

              @if (f.route) {
                <span class="route">
                  <span class="code mono">{{ f.route.origin }}</span>
                  <span class="line"><ui-icon [icon]="icons.Plane" [size]="13" /></span>
                  <span class="code mono">{{ f.route.destination }}</span>
                </span>
              } @else if (f.originCountry) {
                <span class="subtle reg">Registered in {{ f.originCountry }}</span>
              }

              <span class="telemetry">
                <span><em>Altitude</em><b>{{ fmt.altitude(f.altitudeM) }}</b></span>
                <span><em>Speed</em><b>{{ fmt.speed(f.groundSpeedMs) }}</b></span>
                <span><em>Heading</em><b class="hdg"><ui-icon [icon]="icons.Navigation2" [size]="11" [style.transform]="'rotate(' + (f.headingDeg ?? 0) + 'deg)'" />{{ fmt.heading(f.headingDeg) }}</b></span>
                <span><em>Vertical</em><b>{{ fmt.verticalRate(f.verticalRateMs) }}</b></span>
                <span><em>Airborne</em><b>{{ fmt.duration(now() - f.firstSeen) }}</b></span>
                <span><em>Source</em><b>{{ sourceName(f.source) }}</b></span>
              </span>
              @if (f.registration) { <span class="subtle reg">Registration <span class="mono">{{ f.registration }}</span></span> }
            </button>
          } @empty {
            @for (i of [1, 2]; track i) { <span class="skeleton" style="height:150px;border-radius:12px"></span> }
          }
        </div>
      </aside>
    }
  `,
  styles: `
    :host { position: relative; display: block; height: calc(100vh - var(--appbar-h)); overflow: hidden; }
    .map { position: absolute; inset: 0; border: 0; border-radius: 0; }
    .panel { position: absolute; top: 16px; right: 16px; bottom: 16px; width: 380px; display: flex; flex-direction: column; gap: 12px; padding: 14px; overflow: hidden; }
    .panel-head { display: flex; align-items: center; gap: 10px; }
    .who { display: grid; flex: 1; min-width: 0; line-height: 1.3; }
    .who strong { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .who .subtle { font-size: .8rem; }
    .status { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 10px; font-size: .82rem; font-weight: 600; color: var(--text-2); background: var(--gray-100); }
    .status.live { color: var(--green-700); background: var(--green-50); }
    .status.reconnecting, .status.connecting { color: var(--amber-700); background: var(--amber-50); }
    .status.error { color: var(--red-700); background: var(--red-50); }
    .flights { display: grid; gap: 10px; overflow-y: auto; padding: 2px; margin: -2px; }
    .flight {
      position: relative; display: grid; gap: 12px; padding: 14px 14px 14px 18px; text-align: left; font: inherit; color: inherit; cursor: pointer;
      border: 1px solid var(--border); border-radius: 12px; background: var(--surface);
      transition: box-shadow var(--normal) var(--ease), border-color var(--fast) var(--ease);
    }
    .flight::before { content: ''; position: absolute; left: 0; top: 10px; bottom: 10px; width: 4px; border-radius: 0 4px 4px 0; background: var(--c); }
    .flight:hover { box-shadow: var(--shadow-md); }
    .flight.active { border-color: var(--c); box-shadow: 0 0 0 1px var(--c), var(--shadow-md); }
    .flight.lost { opacity: .6; }
    .top { display: flex; align-items: center; gap: 8px; }
    .flex { flex: 1; }
    .cs { font-size: 1.05rem; font-weight: 700; letter-spacing: -.01em; }
    .age { font-size: .78rem; }
    .route { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px; }
    .code { font-size: 1.25rem; font-weight: 700; letter-spacing: .02em; }
    .line { position: relative; display: grid; place-items: center; height: 18px; color: var(--c); }
    .line::before { content: ''; position: absolute; left: 0; right: 0; top: 50%; border-top: 1.5px dashed var(--gray-300); }
    .line ui-icon { position: relative; padding: 0 6px; background: var(--surface); transform: rotate(45deg); }
    .telemetry { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 12px; padding-top: 12px; border-top: 1px solid var(--border); }
    .telemetry span { display: grid; gap: 2px; min-width: 0; }
    .telemetry em { font-style: normal; font-size: .7rem; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--text-3); }
    .telemetry b { font-weight: 600; font-size: .85rem; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hdg { display: inline-flex; align-items: center; gap: 4px; }
    .hdg ui-icon { color: var(--c); }
    .reg { font-size: .78rem; }
    @media (max-width: 900px) {
      :host { height: auto; overflow: visible; }
      .map { position: relative; display: block; height: 55vh; }
      .panel { position: static; width: auto; margin: 12px; }
    }
  `,
})
export class TrackPage {
  private readonly api = inject(TrackingApi);
  protected readonly live = inject(LiveSocket);
  protected readonly map = viewChild(FlightMap);

  /** Query parameter ?ids=a,b,c (withComponentInputBinding). */
  readonly ids = input<string>();

  protected readonly fmt = fmt;
  protected readonly icons = { ArrowLeft, Maximize, Navigation2, Plane, PlaneLanding, RadioTower };
  protected readonly max = MAX_TRACKED_FLIGHTS;
  protected readonly colors = FLIGHT_COLORS;
  protected readonly selection = computed(() => parseIds(this.ids()));
  protected readonly airline = signal<Omit<Airline, 'activeFlights'> | null>(null);
  private readonly flights = signal<Record<string, Tracked>>({});
  private readonly trails = signal<Record<string, [number, number][]>>({});
  private readonly lastTrailTs: Record<string, number> = {};
  protected readonly selectedId = signal<string | null>(null);
  protected readonly now = signal(Date.now() / 1000);

  protected readonly tracked = computed(() => Object.values(this.flights()).sort((a, b) => a.colorIndex - b.colorIndex));

  /** Continuous trails (no antimeridian jumps). */
  private readonly unwrapped = computed(() => {
    const out: MapTrails = {};
    for (const [id, pts] of Object.entries(this.trails())) out[id] = unwrapPath(pts);
    return out;
  });

  /** Positions advanced by dead reckoning, placed next to the end of their trail. */
  protected readonly mapFlights = computed<MapFlight[]>(() => {
    const now = this.now();
    const trails = this.unwrapped();
    return this.tracked().map((f) => {
      const p = f.lost ? f : predict(f, now);
      const last = trails[f.icao24]?.at(-1);
      return {
        id: f.icao24, callsign: f.callsign, lat: p.lat, lon: last ? nearLon(p.lon, last[0]) : p.lon, heading: f.headingDeg ?? 0,
        colorIndex: f.colorIndex, stale: f.lost || now - f.lastContact > STALE_AFTER_S,
      };
    });
  });

  /** Recorded trail + a final segment to the (predicted) current position. */
  protected readonly mapTrails = computed<MapTrails>(() => {
    const trails = this.unwrapped();
    const out: MapTrails = {};
    for (const f of this.mapFlights()) out[f.id] = [...(trails[f.id] ?? []), [f.lon, f.lat]];
    return out;
  });

  protected readonly statusText = computed(() => {
    switch (this.live.status()) {
      case 'live': return 'Live — positions stream in real time';
      case 'connecting': return 'Connecting to live data…';
      case 'reconnecting': return 'Connection lost — reconnecting…';
      case 'ended': return 'Tracking ended — every flight has landed';
      case 'error': return 'Live tracking stopped';
      default: return 'Starting…';
    }
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
    return source === 'adsbLol' ? 'adsb.lol' : source === 'opensky' ? 'OpenSky' : 'Simulator';
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
      const trails = { ...this.trails() };
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
