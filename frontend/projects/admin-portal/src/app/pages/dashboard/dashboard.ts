import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SystemStatus } from '@aerotrack/shared';
import { AdminAuthService } from '../../core/admin-auth.service';

@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SystemStatus, DatePipe, RouterLink],
  template: `
    <section class="intro">
      <h1>Administration</h1>
      <p>
        Signed in as <strong>{{ auth.admin()?.username }}</strong>
        @if (auth.admin()?.lastLoginAt; as last) { · last sign-in {{ last | date: 'medium' }} }
        · <a routerLink="/change-password">Change password</a>
      </p>
    </section>

    <lib-system-status />

    <section class="card">
      <h2>Analytics</h2>
      <p class="muted">Signed-in users, usage and performance charts will appear here.</p>
    </section>
  `,
  styles: `
    h2 { margin: 0 0 0.5rem; font-size: 1.1rem; }
    .card p { margin: 0; }
  `,
})
export class DashboardPage {
  protected readonly auth = inject(AdminAuthService);
}
