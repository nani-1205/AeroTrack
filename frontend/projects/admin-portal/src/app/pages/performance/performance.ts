import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { Icon } from '@aerotrack/shared';
import { CircleCheck, CircleHelp, CircleX, RefreshCw, TriangleExclamationPoint } from 'lucide';
import { ChartCard } from '../../charts/chart-card';
import { LineChart, type LineSeries } from '../../charts/line-chart';
import { SERIES_COLORS } from '../../charts/scale';
import { AnalyticsApi, type PerfRange, type Performance, relative } from '../../core/analytics-api';

const REFRESH_MS = 30_000;
const RANGES: { key: PerfRange; label: string }[] = [
  { key: '1h', label: 'Last hour' },
  { key: '6h', label: 'Last 6 hours' },
  { key: '24h', label: 'Last 24 hours' },
];
const num = (digits: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

@Component({
  selector: 'app-performance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, ChartCard, LineChart],
  template: `
    <div class="page">
      <header class="page-header">
        <div class="titles">
          <span class="eyebrow">Monitoring</span>
          <h1>System performance</h1>
          <p class="subtitle">Throughput, latency, errors and resource use of every service, from Prometheus.</p>
        </div>
      </header>

      <div class="filters">
        <div class="seg" role="group" aria-label="Time range">
          @for (r of ranges; track r.key) {
            <button type="button" [class.on]="range() === r.key" (click)="range.set(r.key)" [attr.aria-pressed]="range() === r.key">{{ r.label }}</button>
          }
        </div>
        <button type="button" class="btn btn-sm" (click)="load(range())" [disabled]="loading()">
          <ui-icon [icon]="icons.RefreshCw" [size]="14" /> Refresh
        </button>
        <span class="subtle updated">Updated {{ updated() }} · current values use a 5-minute window</span>
      </div>

      @if (error(); as message) {
        <div class="alert warning" role="status"><ui-icon [icon]="icons.Alert" [size]="16" /><span>{{ message }}</span></div>
      }

      <section class="card table-card" [class.stale]="loading() && !!data()">
        <header class="card-header"><h2>Services</h2><span class="hint">{{ upCount() }} of {{ data()?.services?.length ?? 4 }} up</span></header>
        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr><th>Service</th><th>Status</th><th class="num">Requests / s</th><th class="num">Error rate</th><th class="num">p95 latency</th><th class="num">CPU</th><th class="num">Memory</th></tr>
            </thead>
            <tbody>
              @for (s of data()?.services ?? []; track s.job; let i = $index) {
                <tr>
                  <td><span class="svc"><i [style.background]="colors[i]"></i><strong>{{ s.name }}</strong><span class="subtle">{{ s.stack }}</span></span></td>
                  <td>
                    @if (s.up === true) { <span class="status ok"><ui-icon [icon]="icons.CircleCheck" [size]="15" /> Up</span> }
                    @else if (s.up === false) { <span class="status down"><ui-icon [icon]="icons.CircleX" [size]="15" /> Down</span> }
                    @else { <span class="status unknown"><ui-icon [icon]="icons.CircleHelp" [size]="15" /> No data</span> }
                  </td>
                  <td class="num">{{ show(s.requestsPerSecond, 2) }}</td>
                  <td class="num">
                    @if (s.errorRate == null) { — } @else {
                      <span [class.bad]="s.errorRate > 0.01">{{ show(s.errorRate * 100, 2) }}%</span>
                    }
                  </td>
                  <td class="num">{{ s.p95Ms == null ? '—' : show(s.p95Ms, 1) + ' ms' }}</td>
                  <td class="num">{{ s.cpuPercent == null ? '—' : show(s.cpuPercent, 1) + '%' }}</td>
                  <td class="num">{{ s.memoryMb == null ? '—' : show(s.memoryMb, 0) + ' MB' }}</td>
                </tr>
              } @empty {
                @for (i of [1, 2, 3, 4]; track i) { <tr><td colspan="7"><span class="skeleton" style="height:18px"></span></td></tr> }
              }
            </tbody>
          </table>
        </div>
      </section>

      <div class="charts">
        <ui-chart-card heading="Requests per second" subheading="by service" [stale]="loading() && !!data()">
          @if (data()) {
            <ui-line-chart [series]="rpsSeries()" [xFormat]="xTick()" [xTooltip]="xTooltip()" [valueFormat]="fmtRps" [height]="240" ariaLabel="Requests per second by service" />
          } @else { <span class="skeleton" style="height:240px"></span> }
          <div table class="table-scroll">
            <table class="table">
              <thead><tr><th>Time</th>@for (s of rpsSeries(); track s.key) { <th class="num">{{ s.label }}</th> }</tr></thead>
              <tbody>@for (t of times(); track t; let i = $index) { <tr><td>{{ xTooltip()(i) }}</td>@for (s of rpsSeries(); track s.key) { <td class="num">{{ s.values[i] == null ? '—' : fmtRps(s.values[i]!) }}</td> }</tr> }</tbody>
            </table>
          </div>
        </ui-chart-card>

        <ui-chart-card heading="p95 latency" subheading="milliseconds, by service" [stale]="loading() && !!data()">
          @if (data()) {
            <ui-line-chart [series]="p95Series()" [xFormat]="xTick()" [xTooltip]="xTooltip()" [valueFormat]="fmtMs" [height]="240" ariaLabel="95th percentile latency in milliseconds by service" />
          } @else { <span class="skeleton" style="height:240px"></span> }
          <div table class="table-scroll">
            <table class="table">
              <thead><tr><th>Time</th>@for (s of p95Series(); track s.key) { <th class="num">{{ s.label }}</th> }</tr></thead>
              <tbody>@for (t of times(); track t; let i = $index) { <tr><td>{{ xTooltip()(i) }}</td>@for (s of p95Series(); track s.key) { <td class="num">{{ s.values[i] == null ? '—' : fmtMs(s.values[i]!) }}</td> }</tr> }</tbody>
            </table>
          </div>
        </ui-chart-card>
      </div>
    </div>
  `,
  styles: `
    .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
    .seg { display: inline-flex; padding: 3px; border-radius: 9px; background: var(--gray-100); box-shadow: inset 0 0 0 1px var(--border); }
    .seg button { height: 30px; padding: 0 14px; border: 0; border-radius: 7px; background: transparent; color: var(--text-2); font-weight: 550; cursor: pointer; white-space: nowrap; }
    .seg button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); }
    .updated { font-size: .8rem; }
    .table-card { transition: opacity var(--normal) var(--ease); }
    .table-card.stale { opacity: .55; }
    .svc { display: inline-flex; align-items: center; gap: 10px; }
    .svc i { width: 14px; height: 2px; border-radius: 2px; }
    .svc .subtle { font-size: .78rem; }
    .status { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: .82rem; }
    .status.ok { color: var(--green-700); }
    .status.down { color: var(--red-700); }
    .status.unknown { color: var(--text-3); }
    .bad { color: var(--red-700); font-weight: 600; }
    .charts { display: grid; gap: 16px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @media (max-width: 1180px) { .charts { grid-template-columns: 1fr; } }
  `,
})
export class PerformancePage {
  private readonly api = inject(AnalyticsApi);
  protected readonly icons = { CircleCheck, CircleHelp, CircleX, RefreshCw, Alert: TriangleExclamationPoint };
  protected readonly ranges = RANGES;
  protected readonly colors = SERIES_COLORS;
  protected readonly fmtRps = (v: number) => `${num(2).format(v)} req/s`;
  protected readonly fmtMs = (v: number) => `${num(1).format(v)} ms`;

  protected readonly range = signal<PerfRange>('1h');
  protected readonly data = signal<Performance | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly updatedAt = signal<number | null>(null);
  private readonly now = signal(Date.now());

  protected readonly upCount = computed(() => (this.data()?.services ?? []).filter((s) => s.up).length);
  /** Shared time axis: union of timestamps across services. */
  protected readonly times = computed(() => {
    const d = this.data();
    if (!d) return [];
    const all = new Set<number>();
    for (const pts of Object.values(d.series.requestsPerSecond)) for (const [t] of pts) all.add(t);
    return [...all].sort((a, b) => a - b);
  });
  protected readonly rpsSeries = computed(() => this.toSeries(this.data()?.series.requestsPerSecond ?? {}));
  protected readonly p95Series = computed(() => this.toSeries(this.data()?.series.p95Ms ?? {}));
  protected readonly xTick = computed(() => {
    const t = this.times();
    const f = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
    return (i: number) => (t[i] ? f.format(new Date(t[i]! * 1000)) : '');
  });
  protected readonly xTooltip = computed(() => {
    const t = this.times();
    const f = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return (i: number) => (t[i] ? f.format(new Date(t[i]! * 1000)) : '');
  });
  protected readonly updated = computed(() => {
    const at = this.updatedAt();
    return at ? relative(new Date(at).toISOString(), this.now()) : '—';
  });

  constructor() {
    effect(() => void this.load(this.range()));
    const refresh = setInterval(() => void this.load(this.range()), REFRESH_MS);
    const clock = setInterval(() => this.now.set(Date.now()), 5_000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(refresh);
      clearInterval(clock);
    });
  }

  protected show(v: number | null, digits: number): string {
    return v == null ? '—' : num(digits).format(v);
  }

  protected async load(range: PerfRange): Promise<void> {
    this.loading.set(true);
    try {
      const d = await this.api.performance(range);
      if (range !== this.range()) return;
      this.data.set(d);
      this.error.set(null);
      this.updatedAt.set(Date.now());
    } catch {
      this.error.set('Metrics are temporarily unavailable (is Prometheus running?). Showing the last values.');
    } finally {
      this.loading.set(false);
    }
  }

  private toSeries(byJob: Record<string, [number, number | null][]>): LineSeries[] {
    const times = this.times();
    return (this.data()?.services ?? []).map((s, i) => {
      const lookup = new Map(byJob[s.job] ?? []);
      return { key: s.job, label: s.name, color: SERIES_COLORS[i % SERIES_COLORS.length]!, values: times.map((t) => lookup.get(t) ?? null) };
    });
  }
}
