import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { AuthService } from '../../core/auth.service';

/** Error codes the auth-service puts on /login?error=… */
const MESSAGES: Record<string, string> = {
  github_not_configured: 'GitHub sign-in is not set up yet. An administrator needs to add the GitHub OAuth app credentials.',
  github_denied: 'GitHub sign-in was cancelled.',
  invalid_state: 'That sign-in link expired or was already used. Please try again.',
  github_error: 'We could not reach GitHub. Please try again.',
  account_disabled: 'This account has been disabled.',
  server_error: 'Something went wrong on our side. Please try again.',
  session_expired: 'Your session expired. Please sign in again.',
};

@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card auth-card">
      <h1>Sign in to AeroTrack</h1>
      <p class="lead">Track live flights by airline — follow up to 5 at once on the map.</p>

      @if (message(); as text) {
        <div class="alert" role="alert">{{ text }}</div>
      }

      <button type="button" class="btn btn-primary btn-block" (click)="signIn()" [disabled]="redirecting()">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
            0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52
            -.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89
            -3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27
            2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82
            2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013
            8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
        {{ redirecting() ? 'Redirecting to GitHub…' : 'Continue with GitHub' }}
      </button>
    </section>
  `,
})
export class LoginPage {
  private readonly auth = inject(AuthService);

  /** Bound from the ?error= query parameter (withComponentInputBinding). */
  readonly error = input<string>();

  protected readonly message = computed(() => {
    const code = this.error();
    return code ? (MESSAGES[code] ?? 'Sign-in failed. Please try again.') : null;
  });
  protected readonly redirecting = signal(false);

  signIn(): void {
    this.redirecting.set(true);
    this.auth.signInWithGitHub();
  }
}
