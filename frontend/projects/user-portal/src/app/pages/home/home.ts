import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MAX_TRACKED_FLIGHTS } from '@aerotrack/shared';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="intro">
      <h1>Welcome, {{ auth.displayName() }}</h1>
      <p>Pick an airline to see its active flights, then follow up to {{ maxFlights }} of them live on the map.</p>
    </section>

    <section class="card">
      <h2>Airlines</h2>
      <p class="muted">The airline directory and live tracking are being wired up next.</p>
    </section>
  `,
  styles: `
    h2 { margin: 0 0 0.5rem; font-size: 1.1rem; }
    .card p { margin: 0; }
  `,
})
export class HomePage {
  protected readonly auth = inject(AuthService);
  protected readonly maxFlights = MAX_TRACKED_FLIGHTS;
}
