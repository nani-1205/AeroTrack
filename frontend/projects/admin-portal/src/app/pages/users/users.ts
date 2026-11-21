import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { EmptyState, Icon, Monogram } from '@aerotrack/shared';
import { ChevronLeft, ChevronRight, Search, Users } from 'lucide';
import { type AdminUser, AnalyticsApi, type UserPage, fmtInt, relative } from '../../core/analytics-api';

const PAGE = 25;

@Component({
  selector: 'app-users',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, Icon, Monogram, EmptyState],
  template: `
    <div class="page">
      <header class="page-header">
        <div class="titles">
          <span class="eyebrow">Monitoring</span>
          <h1>Users</h1>
          <p class="subtitle">Everyone who has signed in to the user portal with GitHub.</p>
        </div>
      </header>

      <div class="filters">
        <label class="input-icon search">
          <ui-icon [icon]="icons.Search" [size]="16" />
          <input class="input" type="search" placeholder="Search by login, name or email" aria-label="Search users"
                 [value]="query()" (input)="query.set($any($event.target).value)" />
        </label>
        <span class="subtle">{{ data() ? fmt(data()!.total) + (query() ? ' matching users' : ' users') : '' }}</span>
      </div>

      @if (error(); as message) { <div class="alert" role="alert">{{ message }}</div> }

      <section class="card table-card" [class.stale]="loading() && !!data()">
        @if (!data()) {
          <div class="pad">@for (i of [1, 2, 3, 4, 5]; track i) { <span class="skeleton" style="height:28px"></span> }</div>
        } @else if (data()!.users.length === 0) {
          <ui-empty-state [icon]="icons.Users" [heading]="query() ? 'No users match “' + query() + '”' : 'No users yet'"
                          [description]="query() ? 'Try a different login, name or email.' : 'Users appear here after their first GitHub sign-in.'" />
        } @else {
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr><th>User</th><th>Email</th><th>Joined</th><th>Last sign-in</th><th class="num">Tracking sessions</th><th>Last tracked</th><th>Status</th></tr>
              </thead>
              <tbody>
                @for (u of data()!.users; track u.id) {
                  <tr>
                    <td>
                      <span class="user">
                        @if (u.avatarUrl) { <img [src]="u.avatarUrl" alt="" /> } @else { <ui-monogram [code]="u.id" [label]="u.login.slice(0, 2).toUpperCase()" [size]="32" /> }
                        <span class="id"><strong>{{ u.name || u.login }}</strong><span class="subtle">&#64;{{ u.login }}</span></span>
                      </span>
                    </td>
                    <td class="muted">{{ u.email ?? '—' }}</td>
                    <td [title]="u.createdAt | date: 'medium'">{{ u.createdAt | date: 'mediumDate' }}</td>
                    <td [title]="u.lastLoginAt ? (u.lastLoginAt | date: 'medium') : ''">{{ ago(u.lastLoginAt) }}</td>
                    <td class="num">{{ fmt(u.trackingSessions) }}</td>
                    <td [title]="u.lastTrackedAt ? (u.lastTrackedAt | date: 'medium') : ''">{{ ago(u.lastTrackedAt) }}</td>
                    <td><span class="badge" [class.success]="u.isActive" [class.danger]="!u.isActive"><span class="dot"></span>{{ u.isActive ? 'Active' : 'Disabled' }}</span></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <footer class="pager">
            <span class="subtle">Showing {{ from() }}–{{ to() }} of {{ fmt(data()!.total) }}</span>
            <span class="buttons">
              <button type="button" class="btn btn-sm" [disabled]="offset() === 0" (click)="offset.set(offset() - pageSize)"><ui-icon [icon]="icons.ChevronLeft" [size]="14" /> Previous</button>
              <button type="button" class="btn btn-sm" [disabled]="to() >= data()!.total" (click)="offset.set(offset() + pageSize)">Next <ui-icon [icon]="icons.ChevronRight" [size]="14" /></button>
            </span>
          </footer>
        }
      </section>
    </div>
  `,
  styles: `
    .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; }
    .search { width: min(100%, 380px); }
    .pad { display: grid; gap: 12px; padding: 20px; }
    .table-card { transition: opacity var(--normal) var(--ease); }
    .table-card.stale { opacity: .55; }
    .user { display: inline-flex; align-items: center; gap: 10px; }
    .user img { width: 32px; height: 32px; border-radius: 50%; }
    .id { display: grid; line-height: 1.3; }
    .id .subtle { font-size: .78rem; }
    .pager { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--border); font-size: .85rem; }
    .buttons { display: flex; gap: 8px; }
  `,
})
export class UsersPage {
  private readonly api = inject(AnalyticsApi);
  protected readonly icons = { ChevronLeft, ChevronRight, Search, Users };
  protected readonly fmt = fmtInt;
  protected readonly pageSize = PAGE;

  protected readonly query = signal('');
  protected readonly offset = signal(0);
  protected readonly data = signal<UserPage | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly now = signal(Date.now());
  private seq = 0;

  protected readonly from = computed(() => (this.data()?.total ? this.offset() + 1 : 0));
  protected readonly to = computed(() => Math.min(this.offset() + PAGE, this.data()?.total ?? 0));

  constructor() {
    let lastQuery = '';
    effect((onCleanup) => {
      const q = this.query();
      const offset = this.offset();
      if (q !== lastQuery && offset !== 0) {
        lastQuery = q;
        this.offset.set(0); // a new search starts from the first page
        return;
      }
      lastQuery = q;
      const timer = setTimeout(() => void this.load(q, offset), q ? 250 : 0);
      onCleanup(() => clearTimeout(timer));
    });
    const clock = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(clock));
  }

  protected ago(iso: string | null): string {
    return relative(iso, this.now());
  }

  private async load(q: string, offset: number): Promise<void> {
    const seq = ++this.seq;
    this.loading.set(true);
    try {
      const page = await this.api.users(q, PAGE, offset);
      if (seq !== this.seq) return;
      this.data.set(page);
      this.error.set(null);
    } catch {
      if (seq === this.seq) this.error.set('The user directory is temporarily unavailable.');
    } finally {
      if (seq === this.seq) this.loading.set(false);
    }
  }
}

export type { AdminUser };
