import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { EmptyState, Icon, Monogram, Stat } from '@aerotrack/shared';
import {
  CircleCheck, CircleX, Eye, LogIn, LogOut, Plane, RefreshCw, ShieldAlert, ShieldCheck, TriangleExclamationPoint, UserPlus, Users,
} from 'lucide';
import { BarList, type BarItem } from '../../charts/bar-list';
import { ChartCard } from '../../charts/chart-card';
import { LineChart, type LineSeries } from '../../charts/line-chart';
import { SERIES_COLORS } from '../../charts/scale';
import {
  type Activity, type ActivityEvent, type ActivityRange, AnalyticsApi, type Overview, type Top, fmtInt, relative,
} from '../../core/analytics-api';

const REFRESH_MS = 30_000;
const RANGES: { key: ActivityRange; label: string }[] = [
  { key: '24h', label: 'Last 24 hours' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
];

@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Stat, Icon, Monogram, EmptyState, ChartCard, LineChart, BarList],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class DashboardPage {
  private readonly api = inject(AnalyticsApi);

  protected readonly fmt = fmtInt;
  protected readonly ranges = RANGES;
  protected readonly colors = SERIES_COLORS;
  protected readonly icons = { Users, Plane, Eye, LogIn, RefreshCw, ShieldCheck, ShieldAlert, Alert: TriangleExclamationPoint, CircleCheck, CircleX };

  protected readonly range = signal<ActivityRange>('24h');
  protected readonly overview = signal<Overview | null>(null);
  protected readonly activity = signal<Activity | null>(null);
  protected readonly top = signal<Top | null>(null);
  protected readonly events = signal<ActivityEvent[] | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly updatedAt = signal<number | null>(null);
  protected readonly now = signal(Date.now());

  protected readonly rangeLabel = computed(() => RANGES.find((r) => r.key === this.range())!.label.toLowerCase());

  protected readonly activitySeries = computed<LineSeries[]>(() => {
    const pts = this.activity()?.points ?? [];
    return [
      { key: 'logins', label: 'User sign-ins', color: SERIES_COLORS[0], values: pts.map((p) => p.userLogins) },
      { key: 'sessions', label: 'Tracking sessions', color: SERIES_COLORS[1], values: pts.map((p) => p.trackingSessions) },
      { key: 'signups', label: 'Sign-ups', color: SERIES_COLORS[2], values: pts.map((p) => p.signups) },
    ];
  });
  protected readonly xTick = computed(() => {
    const a = this.activity();
    const pts = a?.points ?? [];
    const f = a?.unit === 'hour'
      ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
      : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
    return (i: number) => (pts[i] ? f.format(new Date(pts[i]!.t)) : '');
  });
  protected readonly xTooltip = computed(() => {
    const a = this.activity();
    const pts = a?.points ?? [];
    const f = new Intl.DateTimeFormat(undefined, a?.unit === 'hour'
      ? { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    return (i: number) => (pts[i] ? f.format(new Date(pts[i]!.t)) : '');
  });

  protected readonly airlineBars = computed<BarItem[]>(() =>
    (this.top()?.airlines ?? []).map((a) => ({
      key: a.icao, label: a.name, sublabel: a.icao, value: a.sessions, detail: `${fmtInt(a.flights)} flights followed`,
    })),
  );

  protected readonly servicesUp = computed(() => (this.overview()?.services ?? []).filter((s) => s.up).length);

  constructor() {
    effect(() => void this.load(this.range()));
    const refresh = setInterval(() => void this.load(this.range()), REFRESH_MS);
    const clock = setInterval(() => this.now.set(Date.now()), 5_000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(refresh);
      clearInterval(clock);
    });
  }

  protected async load(range: ActivityRange): Promise<void> {
    this.loading.set(true);
    const [overview, activity, top, events] = await Promise.allSettled([
      this.api.overview(), this.api.activity(range), this.api.top(range), this.api.events(12),
    ]);
    if (range !== this.range()) return; // a newer range was picked meanwhile
    if (overview.status === 'fulfilled') this.overview.set(overview.value);
    if (activity.status === 'fulfilled') this.activity.set(activity.value);
    if (top.status === 'fulfilled') this.top.set(top.value);
    if (events.status === 'fulfilled') this.events.set(events.value.events);
    const failed = [overview, activity, top, events].filter((r) => r.status === 'rejected').length;
    this.error.set(failed ? 'Some analytics could not be loaded — showing the latest available data.' : null);
    this.updatedAt.set(Date.now());
    this.now.set(Date.now());
    this.loading.set(false);
  }

  protected ago(at: number | null): string {
    return at ? relative(new Date(at).toISOString(), this.now()) : '—';
  }

  protected when(iso: string): string {
    return relative(iso, this.now());
  }

  protected bucketLabel(iso: string): string {
    return this.xTooltip()(this.activity()!.points.findIndex((p) => p.t === iso));
  }

  protected describe(e: ActivityEvent): { icon: typeof Users; tone: '' | 'warning' | 'danger' | 'success'; text: string } {
    const who = e.user?.name || e.user?.login || (e.subjectType === 'admin' ? 'An admin' : 'A user');
    switch (e.type) {
      case 'user.signup': return { icon: UserPlus, tone: 'success', text: `${who} signed up` };
      case 'user.login': return { icon: LogIn, tone: '', text: `${who} signed in` };
      case 'user.logout': return { icon: LogOut, tone: '', text: `${who} signed out` };
      case 'admin.login': return { icon: ShieldCheck, tone: '', text: 'Admin signed in to the console' };
      case 'admin.logout': return { icon: LogOut, tone: '', text: 'Admin signed out' };
      case 'admin.login_failed': return { icon: ShieldAlert, tone: 'warning', text: 'Failed admin sign-in attempt' };
      case 'admin.locked': return { icon: TriangleExclamationPoint, tone: 'danger', text: 'Admin account locked after failed attempts' };
      case 'admin.password_changed': return { icon: ShieldCheck, tone: '', text: 'Admin password changed' };
      case 'track.start': {
        const n = e.callsigns?.length ?? 0;
        return { icon: Plane, tone: '', text: `${who} started tracking ${n} ${e.airlineIcao ?? ''} ${n === 1 ? 'flight' : 'flights'}` };
      }
      default: return { icon: LogIn, tone: '', text: e.type };
    }
  }
}
