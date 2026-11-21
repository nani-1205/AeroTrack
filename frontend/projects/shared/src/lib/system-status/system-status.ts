import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RefreshCw, Server } from 'lucide';
import { Icon } from '../ui/icon';

interface UpstreamHealth {
  status: number;
  body?: { service?: string; checks?: Record<string, string> };
  error?: string;
}

interface ServiceRow {
  name: string;
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

/** Health of every backend service as reported by the gateway. */
@Component({
  selector: 'lib-system-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <header class="card-header">
      <div class="title"><ui-icon [icon]="server" [size]="16" /> <h2>Service health</h2></div>
      <button type="button" class="btn btn-sm btn-ghost" (click)="refresh()" [disabled]="loading()">
        <ui-icon [icon]="refreshIcon" [size]="14" [class.spin]="loading()" /> Refresh
      </button>
    </header>
    @if (error(); as message) {
      <p class="err">{{ message }}</p>
    } @else {
      <ul>
        @for (svc of services(); track svc.name) {
          <li>
            <span class="badge" [class.success]="svc.ok" [class.danger]="!svc.ok"><span class="dot"></span>{{ svc.ok ? 'Healthy' : 'Down' }}</span>
            <strong>{{ svc.name }}</strong>
            <span class="checks">
              @for (c of svc.checks; track c.name) {
                <span class="check" [class.bad]="!c.ok" [title]="c.detail">{{ c.name }}</span>
              }
            </span>
          </li>
        } @empty {
          @for (i of [1, 2, 3]; track i) { <li><span class="skeleton" style="height:18px;width:100%"></span></li> }
        }
      </ul>
    }
  `,
  styles: `
    :host { display: block; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-xs); }
    .title { display: flex; align-items: center; gap: 8px; color: var(--text-2); }
    ul { list-style: none; margin: 0; padding: 6px 0; }
    li { display: grid; grid-template-columns: 92px 1fr auto; align-items: center; gap: 12px; padding: 10px 20px; }
    li + li { border-top: 1px solid var(--border); }
    strong { text-transform: capitalize; font-weight: 600; }
    .checks { display: flex; gap: 6px; }
    .check { font-size: .75rem; padding: 2px 8px; border-radius: 6px; color: var(--green-700); background: var(--green-50); }
    .check.bad { color: var(--red-700); background: var(--red-50); }
    .err { padding: 16px 20px; color: var(--red-700); }
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `,
})
export class SystemStatus {
  private readonly http = inject(HttpClient);
  protected readonly server = Server;
  protected readonly refreshIcon = RefreshCw;

  protected readonly services = signal<ServiceRow[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.refresh();
  }

  refresh(): void {
    this.loading.set(true);
    this.http.get<Record<string, UpstreamHealth>>('/health/services').subscribe({
      next: (res) => {
        this.services.set(
          Object.entries(res).map(([target, h]) => ({
            name: h.body?.service ?? target,
            ok: h.status === 200,
            checks: Object.entries(h.body?.checks ?? {}).map(([name, v]) => ({ name, ok: v === 'ok', detail: v })),
          })),
        );
        this.error.set(null);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Gateway unreachable — is it running on :8080?');
        this.loading.set(false);
      },
    });
  }
}
