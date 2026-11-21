import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type ActivityRange = '24h' | '7d' | '30d';
export type PerfRange = '1h' | '6h' | '24h';

export interface ServiceUp {
  job: string;
  name: string;
  stack: string;
  up: boolean | null;
}

export interface Overview {
  users: { total: number; newToday: number; new7d: number; activeToday: number; active7d: number; signedInNow: number } | null;
  admins: { signedInNow: number } | null;
  tracking: { aircraftNow: number | null; airlinesNow: number | null; liveViewers: number | null; sessionsToday: number };
  today: { userLogins: number; signups: number; failedAdminLogins: number };
  services: ServiceUp[];
  generatedAt: string;
}

export interface ActivityPoint {
  t: string;
  userLogins: number;
  signups: number;
  trackingSessions: number;
  failedAdminLogins: number;
}

export interface Activity {
  range: ActivityRange;
  unit: 'hour' | 'day';
  points: ActivityPoint[];
  totals: Omit<ActivityPoint, 't'>;
}

export interface Top {
  airlines: { icao: string; name: string; sessions: number; flights: number }[];
  flights: { callsign: string; airlineIcao: string; sessions: number }[];
  users: { id: string; login: string | null; name: string | null; avatarUrl: string | null; sessions: number }[];
}

export interface AdminUser {
  id: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  trackingSessions: number;
  lastTrackedAt: string | null;
}

export interface UserPage {
  total: number;
  limit: number;
  offset: number;
  users: AdminUser[];
}

export interface ActivityEvent {
  type: string;
  at: string;
  subjectType: 'user' | 'admin';
  subjectId: string | null;
  airlineIcao?: string;
  callsigns?: string[];
  user: { login: string; name: string | null; avatarUrl: string | null } | null;
}

export interface ServicePerf extends ServiceUp {
  requestsPerSecond: number | null;
  errorRate: number | null;
  p95Ms: number | null;
  cpuPercent: number | null;
  memoryMb: number | null;
}

export interface Performance {
  range: PerfRange;
  stepSeconds: number;
  services: ServicePerf[];
  series: {
    requestsPerSecond: Record<string, [number, number | null][]>;
    p95Ms: Record<string, [number, number | null][]>;
  };
}

/** Admin analytics API (gateway /api/admin/* → analytics-service). */
@Injectable({ providedIn: 'root' })
export class AnalyticsApi {
  private readonly http = inject(HttpClient);

  overview = () => firstValueFrom(this.http.get<Overview>('/api/admin/overview'));
  activity = (range: ActivityRange) => firstValueFrom(this.http.get<Activity>('/api/admin/activity', { params: { range } }));
  top = (range: ActivityRange) => firstValueFrom(this.http.get<Top>('/api/admin/top', { params: { range } }));
  events = (limit = 12) => firstValueFrom(this.http.get<{ events: ActivityEvent[] }>('/api/admin/events', { params: { limit } }));
  performance = (range: PerfRange) => firstValueFrom(this.http.get<Performance>('/api/admin/performance', { params: { range } }));

  users(search: string, limit: number, offset: number): Promise<UserPage> {
    const params = new HttpParams().set('search', search).set('limit', limit).set('offset', offset);
    return firstValueFrom(this.http.get<UserPage>('/api/admin/users', { params }));
  }
}

const nf = new Intl.NumberFormat('en-US');
export const fmtInt = (v: number | null | undefined) => (v == null ? '—' : nf.format(v));

export function relative(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}
