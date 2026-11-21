import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MAX_TRACKED_FLIGHTS } from '@aerotrack/shared';
import * as fmt from '../../core/format';
import type { AirlineFlights, Flight } from '../../core/models';
import { TrackingApi } from '../../core/tracking-api';

const REFRESH_MS = 20_000;

@Component({
  selector: 'app-flights',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <nav class="breadcrumb"><a routerLink="/">Airlines</a> / {{ data()?.airline?.name ?? icao() }}</nav>
    <header class="page-head">
      <div>
        <h1>{{ data()?.airline?.name ?? icao() }} <span class="muted mono code">{{ icao() }}</span></h1>
        <p>
          @if (data(); as d) { {{ d.flights.length }} active flights · updates every {{ refreshSeconds }} s } @else { Loading flights… }
        </p>
      </div>
      <input class="search" type="search" placeholder="Filter by callsign, airport or aircraft…" aria-label="Filter flights"
             [value]="filter()" (input)="filter.set($any($event.target).value)" />
    </header>

    @if (error(); as message) {
      <div class="alert" role="alert">{{ message }}</div>
    }

    <div class="selection card" [class.has]="selected().length > 0">
      <span>
        <strong>{{ selected().length }}</strong> of {{ max }} selected
        @if (full()) { <span class="muted"> — that's the maximum</span> }
      </span>
      <span class="actions">
        @if (selected().length > 0) {
          <button type="button" class="btn btn-sm" (click)="selected.set([])">Clear</button>
        }
        <button type="button" class="btn btn-primary btn-sm" [disabled]="selected().length === 0" (click)="track(selected())">
          Track {{ selected().length > 1 ? selected().length + ' flights' : 'flight' }} live
        </button>
      </span>
    </div>

    @if (data(); as d) {
      @if (visible().length === 0) {
        <div class="card empty">{{ d.flights.length === 0 ? 'No flights of this airline are in the air right now.' : 'No flights match the filter.' }}</div>
      } @else {
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th scope="col"><span class="sr-only">Select</span></th>
                <th scope="col">Flight</th>
                <th scope="col">Route</th>
                <th scope="col" class="num">Altitude</th>
                <th scope="col" class="num">Speed</th>
                <th scope="col">Heading</th>
                <th scope="col">Aircraft</th>
                <th scope="col" class="num">Airborne</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (f of visible(); track f.icao24) {
                <tr [class.selected]="isSelected(f.icao24)">
                  <td>
                    <input type="checkbox" [checked]="isSelected(f.icao24)" [disabled]="full() && !isSelected(f.icao24)"
                           [attr.aria-label]="'Select ' + f.callsign" (change)="toggle(f.icao24)"
                           [title]="full() && !isSelected(f.icao24) ? 'You can track up to ' + max + ' flights at once' : ''" />
                  </td>
                  <td class="mono"><strong>{{ f.callsign }}</strong></td>
                  <td>{{ f.route ? f.route.origin + ' → ' + f.route.destination : (f.originCountry ?? '—') }}</td>
                  <td class="num">{{ fmt.altitude(f.altitudeM) }}</td>
                  <td class="num">{{ fmt.speed(f.groundSpeedMs) }}</td>
                  <td>{{ fmt.heading(f.headingDeg) }}</td>
                  <td>{{ f.aircraftType ?? '—' }}</td>
                  <td class="num">{{ fmt.duration(now() - f.firstSeen) }}</td>
                  <td><button type="button" class="btn btn-sm" (click)="track([f.icao24])">Track</button></td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    }
  `,
  styles: `
    .code { font-size: 1rem; font-weight: 400; }
    .selection { position: sticky; top: 0; z-index: 1; display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: .65rem 1rem; }
    .selection.has { border-color: var(--brand); }
    .actions { display: flex; gap: .5rem; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  `,
})
export class FlightsPage {
  private readonly api = inject(TrackingApi);
  private readonly router = inject(Router);

  /** Route parameter :icao (withComponentInputBinding). */
  readonly icao = input.required<string>();

  protected readonly fmt = fmt;
  protected readonly max = MAX_TRACKED_FLIGHTS;
  protected readonly refreshSeconds = REFRESH_MS / 1000;
  protected readonly data = signal<AirlineFlights | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly filter = signal('');
  protected readonly selected = signal<string[]>([]);
  protected readonly now = signal(Date.now() / 1000);

  protected readonly full = computed(() => this.selected().length >= this.max);
  protected readonly visible = computed(() => {
    const flights = this.data()?.flights ?? [];
    const q = this.filter().trim().toUpperCase();
    return q ? flights.filter((f) => matches(f, q)) : flights;
  });

  constructor() {
    effect(() => void this.load(this.icao()));
    const timer = setInterval(() => {
      this.now.set(Date.now() / 1000);
      void this.load(this.icao());
    }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected isSelected(id: string): boolean {
    return this.selected().includes(id);
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
  return [f.callsign, f.route?.origin, f.route?.destination, f.aircraftType, f.registration, f.originCountry]
    .some((v) => v?.toUpperCase().includes(q));
}
