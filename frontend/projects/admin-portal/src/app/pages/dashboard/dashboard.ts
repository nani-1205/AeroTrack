import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SystemStatus } from '@aerotrack/shared';
import { AdminAuthService } from '../../core/admin-auth.service';

@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SystemStatus, DatePipe],
  template: `
    <div class="page">
      <header class="page-header">
        <div class="titles">
          <span class="eyebrow">Monitoring</span>
          <h1>Overview</h1>
          <p class="subtitle">
            Signed in as <strong>{{ auth.admin()?.username }}</strong>
            @if (auth.admin()?.lastLoginAt; as last) { · last sign-in {{ last | date: 'medium' }} }
          </p>
        </div>
      </header>
      <lib-system-status />
    </div>
  `,
})
export class DashboardPage {
  protected readonly auth = inject(AdminAuthService);
}
