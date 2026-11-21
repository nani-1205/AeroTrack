import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

interface UpstreamHealth {
  status: number;
  body?: { service?: string; checks?: Record<string, string> };
  error?: string;
}

interface ServiceRow {
  name: string;
  ok: boolean;
  detail: string;
}

/** Shows the health of every backend service as reported by the gateway (development aid). */
@Component({
  selector: 'lib-system-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="status">
      <header>
        <h2>System status</h2>
        <button type="button" (click)="refresh()" [disabled]="loading()">Refresh</button>
      </header>
      @if (error(); as message) {
        <p class="bad">{{ message }}</p>
      } @else {
        <ul>
          @for (svc of services(); track svc.name) {
            <li>
              <span class="dot" [class.ok]="svc.ok"></span>
              <strong>{{ svc.name }}</strong>
              <span class="detail">{{ svc.detail }}</span>
            </li>
          } @empty {
            <li>{{ loading() ? 'Checking…' : 'No services reported' }}</li>
          }
        </ul>
      }
    </section>
  `,
  styles: `
    .status { border: 1px solid #d0d7de; border-radius: 8px; padding: 1rem 1.25rem; max-width: 36rem; }
    header { display: flex; justify-content: space-between; align-items: center; }
    h2 { font-size: 1rem; margin: 0; }
    ul { list-style: none; padding: 0; margin: 0.75rem 0 0; display: grid; gap: 0.5rem; }
    li { display: flex; align-items: center; gap: 0.5rem; }
    .dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: #cf222e; }
    .dot.ok { background: #1a7f37; }
    .detail { color: #57606a; font-size: 0.85rem; }
    .bad { color: #cf222e; }
  `,
})
export class SystemStatus {
  private readonly http = inject(HttpClient);

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
            detail: h.error ?? Object.entries(h.body?.checks ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · '),
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
