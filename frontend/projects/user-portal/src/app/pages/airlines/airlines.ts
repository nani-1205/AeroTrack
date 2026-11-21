import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, computed, effect, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { EmptyState, Icon, MAX_TRACKED_FLIGHTS, Monogram, Stat } from '@aerotrack/shared';
import { ArrowRight, Building, Clock, Plane, Search, SearchX, Trophy } from 'lucide';
import { ago } from '../../core/format';
import type { Airline } from '../../core/models';
import { TrackingApi } from '../../core/tracking-api';

const REFRESH_MS = 30_000;
const DEBOUNCE_MS = 250;
type Sort = 'busiest' | 'name';

@Component({
  selector: 'app-airlines',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, Monogram, Stat, EmptyState],
  template: `
    <div class="page">
      <header class="page-header">
        <div class="titles">
          <span class="eyebrow">Live overview</span>
          <h1>Airlines</h1>
          <p class="subtitle">Choose an airline to see its flights in the air, then follow up to {{ maxFlights }} of them live.</p>
        </div>
      </header>

      <section class="grid-kpi" aria-label="Summary">
        <ui-stat label="Aircraft airborne" [value]="overview()?.flights ?? null" [loading]="!overview()" [icon]="icons.Plane" hint="Airline flights currently tracked" />
        <ui-stat label="Airlines flying" [value]="overview()?.airlines ?? null" [loading]="!overview()" [icon]="icons.Building" hint="With at least one aircraft aloft" />
        <ui-stat label="Busiest right now" [value]="overview()?.top?.name ?? '—'" [loading]="!overview()" [icon]="icons.Trophy"
                 [hint]="overview()?.top ? overview()!.top!.activeFlights + ' aircraft in the air' : null" />
        <ui-stat label="Last update" [value]="updatedAgo()" [loading]="!overview()" [icon]="icons.Clock" hint="Refreshes every 30 seconds" />
      </section>

      <section class="card list">
        <div class="toolbar">
          <label class="input-icon search">
            <ui-icon [icon]="icons.Search" [size]="16" />
            <input #searchBox class="input" type="search" placeholder="Search airlines by name, ICAO or IATA code" aria-label="Search airlines"
                   [value]="query()" (input)="query.set($any($event.target).value)" />
            @if (!query()) { <span class="kbd">/</span> }
          </label>
          <div class="segmented" role="group" aria-label="Sort airlines">
            <button type="button" [class.on]="sort() === 'busiest'" (click)="sort.set('busiest')">Busiest</button>
            <button type="button" [class.on]="sort() === 'name'" (click)="sort.set('name')">A–Z</button>
          </div>
        </div>

        @if (error(); as message) {
          <div class="alert" role="alert" style="margin: 0 20px 16px">{{ message }}</div>
        }

        @if (loading() && airlines().length === 0) {
          <ul class="grid">
            @for (i of skeletons; track i) {
              <li class="tile skeleton-tile"><span class="skeleton sq"></span><span class="skeleton" style="height:14px;width:70%"></span><span class="skeleton" style="height:12px;width:45%"></span></li>
            }
          </ul>
        } @else if (sorted().length === 0) {
          <ui-empty-state [icon]="query() ? icons.SearchX : icons.Plane"
                          [heading]="query() ? 'No airlines match “' + query() + '”' : 'No airline flights right now'"
                          [description]="query() ? 'Try an ICAO code like AIC, an IATA code like 6E, or part of the name.' : 'Live data will appear here as soon as the tracking feed reports aircraft.'" />
        } @else {
          <p class="count subtle">{{ query() ? sorted().length + ' matching airlines' : sorted().length + ' airlines with aircraft in the air' }}</p>
          <ul class="grid">
            @for (a of sorted(); track a.icao) {
              <li>
                <a class="tile" [routerLink]="['/airlines', a.icao]" [class.idle]="a.activeFlights === 0">
                  <div class="head">
                    <ui-monogram [code]="a.icao" [label]="a.iata || a.icao" [size]="42" />
                    <div class="id">
                      <span class="name">{{ a.name }}</span>
                      <span class="meta subtle"><span class="mono">{{ a.icao }}</span>@if (a.iata) { · <span class="mono">{{ a.iata }}</span> } · {{ a.country || '—' }}</span>
                    </div>
                    <ui-icon class="go" [icon]="icons.ArrowRight" [size]="16" />
                  </div>
                  <div class="foot">
                    @if (a.activeFlights > 0) {
                      <span class="n tabular">{{ a.activeFlights }}</span><span class="subtle">airborne</span>
                    } @else {
                      <span class="subtle">No aircraft in the air</span>
                    }
                  </div>
                  <span class="bar"><span [style.width.%]="share(a)"></span></span>
                </a>
              </li>
            }
          </ul>
        }
      </section>
    </div>
  `,
  styles: `
    .list { padding-bottom: 8px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 16px 20px; }
    .search { flex: 1 1 320px; max-width: 460px; }
    .segmented { display: inline-flex; padding: 3px; border-radius: 9px; background: var(--gray-100); box-shadow: inset 0 0 0 1px var(--border); }
    .segmented button { height: 30px; padding: 0 14px; border: 0; border-radius: 7px; background: transparent; color: var(--text-2); font-weight: 550; cursor: pointer; }
    .segmented button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); }
    .count { padding: 0 20px 10px; font-size: .82rem; }
    .grid { list-style: none; margin: 0; padding: 0 20px 16px; display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
    .tile {
      position: relative; display: grid; gap: 14px; padding: 16px 16px 18px; height: 100%; overflow: hidden;
      border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); color: inherit; text-decoration: none !important;
      transition: border-color var(--fast) var(--ease), box-shadow var(--normal) var(--ease), transform var(--normal) var(--ease);
    }
    a.tile:hover, a.tile:focus-visible { border-color: var(--blue-100); box-shadow: var(--shadow-md); transform: translateY(-2px); }
    a.tile:hover .go { color: var(--accent); transform: translateX(2px); }
    .tile.idle { background: var(--surface-2); }
    .head { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .id { display: grid; gap: 2px; min-width: 0; flex: 1; }
    .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta { font-size: .8rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .go { color: var(--gray-400); transition: transform var(--fast) var(--ease), color var(--fast) var(--ease); }
    .foot { display: flex; align-items: baseline; gap: 6px; font-size: .85rem; }
    .n { font-size: 1.35rem; font-weight: 650; letter-spacing: -.02em; color: var(--text); }
    .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: var(--gray-100); }
    .bar span { display: block; height: 100%; background: linear-gradient(90deg, var(--blue-500), var(--cyan-400)); border-radius: 0 3px 3px 0; }
    .skeleton-tile { display: grid; gap: 10px; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); }
    .sq { width: 42px; height: 42px; border-radius: 12px; }
  `,
})
export class AirlinesPage {
  private readonly api = inject(TrackingApi);
  private readonly searchBox = viewChild<ElementRef<HTMLInputElement>>('searchBox');

  protected readonly icons = { ArrowRight, Building, Clock, Plane, Search, SearchX, Trophy };
  protected readonly maxFlights = MAX_TRACKED_FLIGHTS;
  protected readonly skeletons = Array.from({ length: 9 }, (_, i) => i);
  protected readonly query = signal('');
  protected readonly sort = signal<Sort>('busiest');
  protected readonly airlines = signal<Airline[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  /** Live-list totals (kept while a search is shown). */
  protected readonly overview = signal<{ flights: number; airlines: number; top: Airline | null; at: number } | null>(null);
  private readonly now = signal(Date.now());
  private requestSeq = 0;

  protected readonly sorted = computed(() => {
    const list = [...this.airlines()];
    if (this.sort() === 'name') return list.sort((a, b) => a.name.localeCompare(b.name));
    return this.query() ? list : list.sort((a, b) => b.activeFlights - a.activeFlights);
  });
  private readonly maxCount = computed(() => Math.max(1, ...this.airlines().map((a) => a.activeFlights)));
  protected readonly updatedAgo = computed(() => {
    const o = this.overview();
    return o ? ago(o.at / 1000, this.now() / 1000) : '—';
  });

  constructor() {
    effect((onCleanup) => {
      const q = this.query();
      const timer = setTimeout(() => void this.load(q), q ? DEBOUNCE_MS : 0);
      onCleanup(() => clearTimeout(timer));
    });
    const refresh = setInterval(() => void this.load(this.query()), REFRESH_MS);
    const clock = setInterval(() => this.now.set(Date.now()), 5_000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(refresh);
      clearInterval(clock);
    });
  }

  /** "/" focuses the search box, like most data tools. */
  @HostListener('document:keydown', ['$event'])
  protected shortcut(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(target?.tagName ?? '')) {
      e.preventDefault();
      this.searchBox()?.nativeElement.focus();
    }
  }

  protected share(a: Airline): number {
    return Math.round((a.activeFlights / this.maxCount()) * 100);
  }

  private async load(q: string): Promise<void> {
    const seq = ++this.requestSeq;
    this.loading.set(true);
    try {
      const airlines = await this.api.airlines(q, q ? 30 : 200);
      if (seq !== this.requestSeq) return; // a newer search superseded this one
      this.airlines.set(airlines);
      if (!q) {
        const top = airlines.reduce<Airline | null>((best, a) => (!best || a.activeFlights > best.activeFlights ? a : best), null);
        this.overview.set({ flights: airlines.reduce((n, a) => n + a.activeFlights, 0), airlines: airlines.length, top, at: Date.now() });
      }
      this.error.set(null);
    } catch {
      if (seq === this.requestSeq) this.error.set('Could not load airlines. Retrying shortly…');
    } finally {
      if (seq === this.requestSeq) this.loading.set(false);
    }
  }
}
