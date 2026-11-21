import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Icon, Logo } from '@aerotrack/shared';
import { Radar, Route, ShieldCheck, TriangleExclamationPoint } from 'lucide';
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
  imports: [Logo, Icon],
  template: `
    <section class="hero" aria-hidden="false">
      <svg class="arcs" viewBox="0 0 600 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <path d="M40 470 Q 300 120 560 300" />
        <path d="M20 250 Q 320 40 590 160" />
        <path d="M80 590 Q 260 330 520 520" />
        <circle cx="40" cy="470" r="4" /><circle cx="560" cy="300" r="4" /><circle cx="20" cy="250" r="4" />
        <circle cx="590" cy="160" r="4" /><circle cx="80" cy="590" r="4" /><circle cx="520" cy="520" r="4" />
      </svg>
      <div class="hero-inner">
        <ui-logo class="on-dark" [markSize]="36" />
        <div class="pitch">
          <span class="eyebrow">Live air traffic</span>
          <h2>Every flight, in&nbsp;real time.</h2>
          <p>Pick any airline and follow up to five of its aircraft live on the map — altitude, speed and heading, updated every few seconds.</p>
        </div>
        <ul class="features">
          <li><span class="fi"><ui-icon [icon]="icons.Radar" [size]="18" /></span><div><strong>Worldwide coverage</strong><span>Open ADS-B data from OpenSky and adsb.lol</span></div></li>
          <li><span class="fi"><ui-icon [icon]="icons.Route" [size]="18" /></span><div><strong>Smooth live motion</strong><span>Trails and dead-reckoned positions between updates</span></div></li>
          <li><span class="fi"><ui-icon [icon]="icons.ShieldCheck" [size]="18" /></span><div><strong>Secure sign-in</strong><span>GitHub single sign-on — no new password to remember</span></div></li>
        </ul>
      </div>
    </section>

    <section class="panel">
      <div class="signin">
        <ui-logo class="mobile-logo" [markSize]="32" />
        <h1>Sign in</h1>
        <p class="muted">Use your GitHub account to continue.</p>

        @if (message(); as text) {
          <div class="alert" role="alert"><ui-icon [icon]="icons.Alert" [size]="16" /> <span>{{ text }}</span></div>
        }

        <button type="button" class="btn btn-dark btn-lg btn-block" (click)="signIn()" [disabled]="redirecting()">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          {{ redirecting() ? 'Redirecting to GitHub…' : 'Continue with GitHub' }}
        </button>
        <p class="fine">We only read your public profile and primary email address.</p>
      </div>
    </section>
  `,
  styles: `
    :host { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); min-height: 100vh; }
    .hero {
      position: relative; overflow: hidden; color: var(--shell-text);
      background:
        radial-gradient(60% 50% at 20% 20%, rgba(37, 99, 235, .35), transparent 70%),
        radial-gradient(50% 50% at 90% 90%, rgba(34, 211, 238, .18), transparent 70%),
        radial-gradient(rgba(255, 255, 255, .07) 1px, transparent 1px) 0 0 / 22px 22px,
        var(--shell);
    }
    .arcs { position: absolute; inset: 0; width: 100%; height: 100%; opacity: .3; }
    .arcs path { fill: none; stroke: rgba(125, 211, 252, .55); stroke-width: 1.5; stroke-dasharray: 6 8; animation: dash 18s linear infinite; }
    .arcs circle { fill: #7dd3fc; }
    @keyframes dash { to { stroke-dashoffset: -280; } }
    .hero-inner { position: relative; height: 100%; display: grid; align-content: space-between; gap: 48px; padding: 48px 56px; }
    .pitch { display: grid; gap: 16px; max-width: 30rem; }
    .pitch .eyebrow { color: #7dd3fc; }
    .pitch h2 { font-size: clamp(2rem, 3.6vw, 3rem); font-weight: 700; letter-spacing: -.035em; color: #fff; line-height: 1.08; }
    .pitch p { color: var(--shell-muted); font-size: 1.05rem; line-height: 1.6; }
    .features { list-style: none; margin: 0; padding: 0; display: grid; gap: 18px; }
    .features li { display: flex; gap: 14px; align-items: flex-start; }
    .features div { display: grid; gap: 2px; }
    .features strong { color: #fff; font-weight: 600; }
    .features span:not(.fi) { color: var(--shell-muted); font-size: .9rem; }
    .fi { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; color: #7dd3fc; background: rgba(255, 255, 255, .06); box-shadow: inset 0 0 0 1px var(--shell-border); flex: none; }
    .panel { display: grid; place-items: center; padding: 32px; background: var(--surface); }
    .signin { width: min(100%, 380px); display: grid; gap: 14px; }
    .signin h1 { font-size: 1.75rem; font-weight: 700; letter-spacing: -.03em; }
    .signin > .muted { margin-top: -6px; margin-bottom: 10px; }
    .mobile-logo { display: none; margin-bottom: 18px; }
    .fine { font-size: .8rem; color: var(--text-3); text-align: center; }
    @media (max-width: 900px) {
      :host { grid-template-columns: 1fr; }
      .hero { display: none; }
      .mobile-logo { display: inline-flex; }
    }
  `,
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  protected readonly icons = { Radar, Route, ShieldCheck, Alert: TriangleExclamationPoint };

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
