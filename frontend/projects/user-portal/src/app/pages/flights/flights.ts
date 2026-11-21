import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { EmptyState, Icon, MAX_TRACKED_FLIGHTS, Monogram, Stat } from '@aerotrack/shared';
import {
  ArrowDown, ArrowRight, ArrowUp, ChevronRight, ChevronsUpDown, Gauge, Hourglass, ListFilter, MoveRight,
  Navigation2, Plane, PlaneTakeoff, Radar, X,
} from 'lucide';
import * as fmt from '../../core/format';
import { FLIGHT_COLORS } from '../../core/map-config';
import type { AirlineFlights, Flight } from '../../core/models';
import { TrackingApi } from '../../core/tracking-api';

const REFRESH_MS = 20_000;
const MAX_ALTITUDE_M = 13_000; // ~43,000 ft — scale for the altitude bars
type SortKey = 'callsign' | 'altitude' | 'speed' | 'airborne';

@Component({
  selector: 'app-flights',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, Monogram, Stat, EmptyState],
  template: `
    <div class="page">
      <nav class="breadcrumb" aria-label="Breadcrumb">
        <a routerLink="/">Airlines</a><ui-icon [icon]="icons.ChevronRight" [size]="14" /><span>{{ airline()?.name ?? icao() }}</span>
      </nav>

      <header class="page-header">
        <div class="ident">
          <ui-monogram [code]="icao()" [label]="airline()?.iata || icao()" [size]="56" />
          <div class="titles">
            <h1>{{ airline()?.name ?? icao() }}</h1>
            <p class="subtitle">
              <span class="mono">{{ icao() }}</span>@if (airline()?.iata) { · <span class="mono">{{ airline()!.iata }}</span> }
              @if (airline()?.country) { · {{ airline()!.country }} }
              @if (airline()?.callsign) { · callsign “{{ airline()!.callsign }}” }
            </p>
          </div>
        </div>
        <span class="badge success"><span class="dot live"></span> Live · refreshes every {{ refreshSeconds }} s</span>
      </header>

      <section class="grid-kpi" aria-label="Fleet summary">
        <ui-stat label="Aircraft airborne" [value]="flights().length" [loading]="!data()" [icon]="icons.Plane" />
        <ui-stat label="Average altitude" [value]="kpis().altitude" [loading]="!data()" [icon]="icons.PlaneTakeoff" />
        <ui-stat label="Average ground speed" [value]="kpis().speed" [loading]="!data()" [icon]="icons.Gauge" />
        <ui-stat label="Longest airborne" [value]="kpis().longest" [hint]="kpis().longestCallsign" [loading]="!data()" [icon]="icons.Hourglass" />
      </section>

      @if (error(); as message) {
        <div class="alert" role="alert">{{ message }}</div>
      }

      <section class="card table-card">
        <div class="toolbar">
          <div>
            <h2>Flights in the air</h2>
            <p class="subtle">Select up to {{ max }} flights to follow them together on the live map.</p>
          </div>
          <label class="input-icon filter">
            <ui-icon [icon]="icons.ListFilter" [size]="16" />
            <input class="input" type="search" placeholder="Filter by callsign, airport, aircraft…" aria-label="Filter flights"
                   [value]="filter()" (input)="filter.set($any($event.target).value)" />
          </label>
        </div>

        @if (!data()) {
          <div class="loading">@for (i of [1, 2, 3, 4, 5, 6]; track i) { <span class="skeleton" style="height:22px"></span> }</div>
        } @else if (visible().length === 0) {
          <ui-empty-state [icon]="flights().length ? icons.ListFilter : icons.Radar"
                          [heading]="flights().length ? 'No flights match the filter' : 'No aircraft in the air'"
                          [description]="flights().length ? 'Clear the filter to see all ' + flights().length + ' flights.' : 'This airline has no flights reported right now. Check back soon.'" />
        } @else {
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col" class="sel"><span class="sr-only">Select</span></th>
                  <th scope="col"><button type="button" class="sort" (click)="sortBy('callsign')">Flight <ui-icon [icon]="sortIcon('callsign')" [size]="12" /></button></th>
                  <th scope="col">Route</th>
                  <th scope="col"><button type="button" class="sort" (click)="sortBy('altitude')">Altitude <ui-icon [icon]="sortIcon('altitude')" [size]="12" /></button></th>
                  <th scope="col" class="num"><button type="button" class="sort" (click)="sortBy('speed')">Speed <ui-icon [icon]="sortIcon('speed')" [size]="12" /></button></th>
                  <th scope="col">Heading</th>
                  <th scope="col">Vertical</th>
                  <th scope="col" class="num"><button type="button" class="sort" (click)="sortBy('airborne')">Airborne <ui-icon [icon]="sortIcon('airborne')" [size]="12" /></button></th>
                  <th scope="col"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (f of visible(); track f.icao24) {
                  <tr [class.selected]="colorIndex(f.icao24) >= 0" [style.--row-color]="rowColor(f.icao24)" (click)="toggle(f.icao24)">
                    <td class="sel" (click)="$event.stopPropagation()">
                      <input type="checkbox" class="checkbox" [checked]="colorIndex(f.icao24) >= 0" [disabled]="full() && colorIndex(f.icao24) < 0"
                             [attr.aria-label]="'Select ' + f.callsign" (change)="toggle(f.icao24)"
                             [title]="full() && colorIndex(f.icao24) < 0 ? 'You can follow up to ' + max + ' flights at once' : ''" />
                    </td>
                    <td>
                      <div class="flight"><strong class="mono">{{ f.callsign }}</strong><span class="subtle">{{ f.aircraftType ?? 'Aircraft n/a' }}{{ f.registration ? ' · ' + f.registration : '' }}</span></div>
                    </td>
                    <td>
                      @if (f.route) {
                        <span class="route"><span class="ap mono">{{ f.route.origin }}</span><ui-icon [icon]="icons.MoveRight" [size]="14" /><span class="ap mono">{{ f.route.destination }}</span></span>
                      } @else {
                        <span class="subtle">{{ f.originCountry ?? '—' }}</span>
                      }
                    </td>
                    <td>
                      <div class="alt"><span class="tabular">{{ fmt.altitude(f.altitudeM) }}</span><span class="altbar"><span [style.width.%]="altitudePct(f)"></span></span></div>
                    </td>
                    <td class="num">{{ fmt.speed(f.groundSpeedMs) }}</td>
                    <td><span class="hdg"><ui-icon [icon]="icons.Navigation2" [size]="13" [style.transform]="'rotate(' + (f.headingDeg ?? 0) + 'deg)'" /> {{ fmt.heading(f.headingDeg) }}</span></td>
                    <td>
                      @let vr = f.verticalRateMs ?? 0;
                      <span class="vr" [class.up]="vr > 0.5" [class.down]="vr < -0.5">
                        @if (vr > 0.5) { <ui-icon [icon]="icons.ArrowUp" [size]="13" /> } @else if (vr < -0.5) { <ui-icon [icon]="icons.ArrowDown" [size]="13" /> }
                        {{ fmt.verticalRate(f.verticalRateMs) }}
                      </span>
                    </td>
                    <td class="num">{{ fmt.duration(now() - f.firstSeen) }}</td>
                    <td class="act" (click)="$event.stopPropagation()">
                      <button type="button" class="btn btn-sm" (click)="track([f.icao24])">Track <ui-icon [icon]="icons.ArrowRight" [size]="14" /></button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    </div>

    <div class="selection" [class.show]="selected().length > 0" role="region" aria-label="Selected flights">
      <span class="count"><strong>{{ selected().length }} of {{ max }} selected</strong>@if (full()) { <span> · maximum</span> }</span>
      <span class="chips">
        @for (id of selected(); track id; let i = $index) {
          <span class="chip"><span class="dot" [style.color]="colors[i]"></span><span class="mono">{{ callsignOf(id) }}</span>
            <button type="button" (click)="toggle(id)" [attr.aria-label]="'Remove ' + callsignOf(id)"><ui-icon [icon]="icons.X" [size]="12" /></button></span>
        }
      </span>
      <button type="button" class="btn btn-sm btn-ghost clear" (click)="selected.set([])">Clear</button>
      <button type="button" class="btn btn-primary" [disabled]="selected().length === 0" (click)="track(selected())">
        Track {{ selected().length > 1 ? selected().length + ' flights' : 'flight' }} live <ui-icon [icon]="icons.ArrowRight" [size]="15" />
      </button>
    </div>
  `,
  styles: `
    :host { display: block; padding-bottom: 96px; }
    .ident { display: flex; align-items: center; gap: 16px; min-width: 0; }
    .toolbar { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; padding: 18px 20px; border-bottom: 1px solid var(--border); }
    .toolbar p { font-size: .85rem; margin-top: 2px; }
    .filter { width: min(100%, 340px); }
    .loading { display: grid; gap: 14px; padding: 20px; }
    th.sel, td.sel { width: 44px; padding-right: 0; }
    .sort { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; font: inherit; color: inherit; letter-spacing: inherit; text-transform: inherit; cursor: pointer; }
    .sort:hover { color: var(--text); }
    tbody tr { cursor: pointer; }
    tbody tr.selected { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--row-color); }
    tbody tr.selected:hover { background: var(--blue-100); }
    .flight { display: grid; gap: 1px; }
    .flight .subtle { font-size: .78rem; }
    .route { display: inline-flex; align-items: center; gap: 6px; color: var(--text-3); }
    .ap { padding: 2px 7px; border-radius: 6px; font-size: .8rem; font-weight: 600; color: var(--text); background: var(--gray-100); }
    .alt { display: grid; gap: 5px; min-width: 110px; }
    .altbar { height: 4px; border-radius: 4px; background: var(--gray-100); overflow: hidden; }
    .altbar span { display: block; height: 100%; border-radius: 4px; background: linear-gradient(90deg, #93c5fd, var(--blue-600)); }
    .hdg { display: inline-flex; align-items: center; gap: 6px; }
    .hdg ui-icon { color: var(--accent); transition: transform var(--normal) var(--ease); }
    .vr { display: inline-flex; align-items: center; gap: 4px; color: var(--text-3); }
    .vr.up { color: var(--green-700); }
    .vr.down { color: var(--amber-700); }
    td.act { text-align: right; }
    .selection {
      position: fixed; left: 50%; bottom: 24px; z-index: 40; display: flex; align-items: center; gap: 14px; max-width: calc(100vw - 32px);
      padding: 10px 10px 10px 18px; border-radius: 16px; color: var(--shell-text); background: rgba(11, 18, 32, .94);
      backdrop-filter: blur(10px); box-shadow: var(--shadow-lg), 0 0 0 1px var(--shell-border);
      transform: translate(-50%, 140%); opacity: 0; transition: transform var(--normal) var(--ease), opacity var(--normal) var(--ease);
    }
    .selection.show { transform: translate(-50%, 0); opacity: 1; }
    .selection .count { white-space: nowrap; font-size: .875rem; }
    .selection .count span { color: var(--shell-muted); }
    .chips { display: flex; gap: 6px; overflow-x: auto; }
    .chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 4px 0 10px; border-radius: 999px; background: rgba(255, 255, 255, .08); font-size: .8rem; white-space: nowrap; }
    .chip button { display: grid; place-items: center; width: 20px; height: 20px; border: 0; border-radius: 50%; background: transparent; color: var(--shell-muted); cursor: pointer; }
    .chip button:hover { background: rgba(255, 255, 255, .12); color: #fff; }
    .clear { --btn-fg: var(--shell-muted); }
    .clear:hover { --btn-bg: rgba(255, 255, 255, .08) !important; --btn-fg: #fff; }
  `,
})
export class FlightsPage {
  private readonly api = inject(TrackingApi);
  private readonly router = inject(Router);

  /** Route parameter :icao (withComponentInputBinding). */
  readonly icao = input.required<string>();

  protected readonly fmt = fmt;
  protected readonly icons = { ArrowDown, ArrowRight, ArrowUp, ChevronRight, Gauge, Hourglass, ListFilter, MoveRight, Navigation2, Plane, PlaneTakeoff, Radar, X };
  protected readonly colors = FLIGHT_COLORS;
  protected readonly max = MAX_TRACKED_FLIGHTS;
  protected readonly refreshSeconds = REFRESH_MS / 1000;
  protected readonly data = signal<AirlineFlights | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly filter = signal('');
  /** Selection order = map colour order. */
  protected readonly selected = signal<string[]>([]);
  protected readonly now = signal(Date.now() / 1000);
  protected readonly sort = signal<{ key: SortKey; dir: 1 | -1 }>({ key: 'callsign', dir: 1 });

  protected readonly airline = computed(() => this.data()?.airline ?? null);
  protected readonly flights = computed(() => this.data()?.flights ?? []);
  protected readonly full = computed(() => this.selected().length >= this.max);
  protected readonly visible = computed(() => {
    const q = this.filter().trim().toUpperCase();
    const list = q ? this.flights().filter((f) => matches(f, q)) : [...this.flights()];
    const { key, dir } = this.sort();
    const val = (f: Flight): number | string =>
      key === 'callsign' ? f.callsign : key === 'altitude' ? (f.altitudeM ?? -1) : key === 'speed' ? (f.groundSpeedMs ?? -1) : -f.firstSeen;
    return list.sort((a, b) => (val(a) < val(b) ? -dir : val(a) > val(b) ? dir : 0));
  });
  protected readonly kpis = computed(() => {
    const fl = this.flights();
    const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
    const longest = fl.reduce<Flight | null>((best, f) => (!best || f.firstSeen < best.firstSeen ? f : best), null);
    return {
      altitude: fmt.altitude(avg(fl.flatMap((f) => (f.altitudeM == null ? [] : [f.altitudeM])))),
      speed: fmt.speed(avg(fl.flatMap((f) => (f.groundSpeedMs == null ? [] : [f.groundSpeedMs])))),
      longest: longest ? fmt.duration(this.now() - longest.firstSeen) : '—',
      longestCallsign: longest?.callsign ?? null,
    };
  });

  constructor() {
    effect(() => void this.load(this.icao()));
    const timer = setInterval(() => void this.load(this.icao()), REFRESH_MS);
    const clock = setInterval(() => this.now.set(Date.now() / 1000), 15_000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      clearInterval(clock);
    });
  }

  protected colorIndex(id: string): number {
    return this.selected().indexOf(id);
  }

  protected rowColor(id: string): string | null {
    const i = this.colorIndex(id);
    return i >= 0 ? FLIGHT_COLORS[i]! : null;
  }

  protected callsignOf(id: string): string {
    return this.flights().find((f) => f.icao24 === id)?.callsign ?? id;
  }

  protected altitudePct(f: Flight): number {
    return Math.min(100, Math.max(2, ((f.altitudeM ?? 0) / MAX_ALTITUDE_M) * 100));
  }

  protected sortBy(key: SortKey): void {
    this.sort.update((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'callsign' ? 1 : -1 }));
  }

  protected sortIcon(key: SortKey) {
    const s = this.sort();
    return s.key !== key ? ChevronsUpDown : s.dir === 1 ? ArrowUp : ArrowDown;
  }

  toggle(id: string): void {
    this.selected.update((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : sel.length < this.max ? [...sel, id] : sel));
  }

  track(ids: string[]): void {
    void this.router.navigate(['/track'], { queryParams: { ids: ids.join(',') } });
  }

  private async load(icao: string): Promise<void> {
    try {
      const data = await this.api.airlineFlights(icao);
      this.data.set(data);
      this.error.set(null);
      this.now.set(Date.now() / 1000);
      // Drop selections for flights that have landed since.
      const active = new Set(data.flights.map((f) => f.icao24));
      this.selected.update((sel) => sel.filter((id) => active.has(id)));
    } catch (err) {
      const status = (err as { status?: number }).status;
      this.error.set(status === 404 ? 'Unknown airline.' : 'Could not load flights. Retrying shortly…');
    }
  }
}

function matches(f: Flight, q: string): boolean {
  return [f.callsign, f.route?.origin, f.route?.destination, f.aircraftType, f.registration, f.originCountry].some((v) =>
    v?.toUpperCase().includes(q),
  );
}
