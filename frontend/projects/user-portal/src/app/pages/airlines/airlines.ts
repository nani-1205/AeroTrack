import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MAX_TRACKED_FLIGHTS } from '@aerotrack/shared';
import { AuthService } from '../../core/auth.service';
import type { Airline } from '../../core/models';
import { TrackingApi } from '../../core/tracking-api';

const REFRESH_MS = 30_000;
const DEBOUNCE_MS = 300;

@Component({
  selector: 'app-airlines',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <header class="page-head">
      <div>
        <h1>Airlines</h1>
        <p>Hi {{ auth.displayName() }} — pick an airline, then follow up to {{ maxFlights }} of its flights live.</p>
      </div>
      <input class="search" type="search" placeholder="Search by name, ICAO or IATA code…" aria-label="Search airlines"
             [value]="query()" (input)="query.set($any($event.target).value)" />
    </header>

    @if (error(); as message) {
      <div class="alert" role="alert">{{ message }}</div>
    }

    @if (loading() && airlines().length === 0) {
      <p class="muted">Loading airlines…</p>
    } @else if (airlines().length === 0) {
      <div class="card empty">
        {{ query() ? 'No airlines match "' + query() + '".' : 'No airline flights are being reported right now.' }}
      </div>
    } @else {
      <p class="muted summary">
        {{ query() ? 'Search results' : airlines().length + ' airlines with flights in the air' }}
      </p>
      <ul class="grid">
        @for (a of airlines(); track a.icao) {
          <li>
            <a class="card airline" [routerLink]="['/airlines', a.icao]" [class.inactive]="a.activeFlights === 0">
              <span class="name">{{ a.name }}</span>
              <span class="codes mono">{{ a.icao }}{{ a.iata ? ' · ' + a.iata : '' }}</span>
              <span class="country muted">{{ a.country || '—' }}</span>
              @if (a.activeFlights > 0) {
                <span class="badge">{{ a.activeFlights }} in the air</span>
              } @else {
                <span class="badge off">No active flights</span>
              }
            </a>
          </li>
        }
      </ul>
    }
  `,
  styles: `
    .summary { margin: 0; font-size: 0.85rem; }
    .grid { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); }
    .airline { display: grid; gap: 0.2rem; padding: 1rem; text-decoration: none; color: inherit; height: 100%; transition: border-color .15s, box-shadow .15s; }
    .airline:hover, .airline:focus-visible { border-color: var(--brand); box-shadow: 0 1px 6px rgba(11, 61, 145, .15); outline: none; }
    .airline.inactive { opacity: .7; }
    .name { font-weight: 600; }
    .codes { font-size: .8rem; color: var(--muted); }
    .country { font-size: .85rem; }
    .badge { justify-self: start; margin-top: .35rem; }
  `,
})
export class AirlinesPage {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(TrackingApi);

  protected readonly maxFlights = MAX_TRACKED_FLIGHTS;
  protected readonly query = signal('');
  protected readonly airlines = signal<Airline[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  private requestSeq = 0;

  constructor() {
    // Debounced search; an empty query shows the live "busiest first" list.
    effect((onCleanup) => {
      const q = this.query();
      const timer = setTimeout(() => void this.load(q), q ? DEBOUNCE_MS : 0);
      onCleanup(() => clearTimeout(timer));
    });
    const refresh = setInterval(() => void this.load(this.query()), REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(refresh));
  }

  private async load(q: string): Promise<void> {
    const seq = ++this.requestSeq;
    this.loading.set(true);
    try {
      const airlines = await this.api.airlines(q, q ? 30 : 100);
      if (seq !== this.requestSeq) return; // a newer search superseded this one
      this.airlines.set(airlines);
      this.error.set(null);
    } catch {
      if (seq === this.requestSeq) this.error.set('Could not load airlines. Retrying shortly…');
    } finally {
      if (seq === this.requestSeq) this.loading.set(false);
    }
  }
}
