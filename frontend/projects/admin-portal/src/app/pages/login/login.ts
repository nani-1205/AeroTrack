import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { Icon, Logo, apiErrorOf } from '@aerotrack/shared';
import { Eye, EyeOff, Lock, ShieldCheck, TriangleExclamationPoint, User } from 'lucide';
import { AdminAuthService } from '../../core/admin-auth.service';

@Component({
  selector: 'app-admin-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, Logo, Icon],
  template: `
    <div>
      <section class="auth-card">
        <header class="auth-head">
          <ui-logo [markSize]="34" tag="Console" />
          <h1>Sign in to the admin console</h1>
          <p>Monitoring, users and system performance for AeroTrack.</p>
        </header>

        @if (error(); as message) {
          <div class="alert" role="alert"><ui-icon [icon]="icons.Alert" [size]="16" /><span>{{ message }}</span></div>
        } @else if (expired()) {
          <div class="alert warning" role="alert"><ui-icon [icon]="icons.Alert" [size]="16" /><span>Your session expired. Please sign in again.</span></div>
        }

        <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
          <div class="field">
            <label for="username">Username</label>
            <span class="input-icon">
              <ui-icon [icon]="icons.User" [size]="16" />
              <input id="username" class="input" formControlName="username" autocomplete="username" autofocus [attr.aria-invalid]="invalid('username')" />
            </span>
            @if (invalid('username')) { <span class="error">Username is required.</span> }
          </div>
          <div class="field">
            <label for="password">Password</label>
            <span class="input-icon pw">
              <ui-icon [icon]="icons.Lock" [size]="16" />
              <input id="password" class="input" [type]="reveal() ? 'text' : 'password'" formControlName="password" autocomplete="current-password" [attr.aria-invalid]="invalid('password')" />
              <button type="button" class="reveal" (click)="reveal.set(!reveal())" [attr.aria-label]="reveal() ? 'Hide password' : 'Show password'">
                <ui-icon [icon]="reveal() ? icons.EyeOff : icons.Eye" [size]="16" />
              </button>
            </span>
            @if (invalid('password')) { <span class="error">Password is required.</span> }
          </div>
          <button type="submit" class="btn btn-primary btn-lg btn-block" [disabled]="submitting()">
            {{ submitting() ? 'Signing in…' : 'Sign in' }}
          </button>
        </form>

        <p class="foot"><ui-icon [icon]="icons.ShieldCheck" [size]="14" /> Restricted area · every sign-in attempt is logged</p>
      </section>
      <p class="below">AeroTrack administration</p>
    </div>
  `,
  styleUrl: '../auth-layout.scss',
})
export class AdminLoginPage {
  private readonly auth = inject(AdminAuthService);
  private readonly router = inject(Router);
  protected readonly icons = { Eye, EyeOff, Lock, ShieldCheck, User, Alert: TriangleExclamationPoint };

  /** ?expired=1 after the session could not be refreshed. */
  readonly expired = input<string>();

  protected readonly form = new FormGroup({
    username: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });
  protected readonly submitting = signal(false);
  protected readonly reveal = signal(false);
  protected readonly error = signal<string | null>(null);

  protected invalid(name: 'username' | 'password'): boolean {
    const c = this.form.controls[name];
    return c.invalid && (c.touched || c.dirty);
  }

  async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.error.set(null);
    try {
      const { username, password } = this.form.getRawValue();
      const admin = await this.auth.login(username, password);
      await this.router.navigateByUrl(admin.mustChangePassword ? '/change-password' : '/');
    } catch (err) {
      this.error.set(messageFor(err));
      this.form.controls.password.reset();
    } finally {
      this.submitting.set(false);
    }
  }
}

function messageFor(err: unknown): string {
  if (!(err instanceof HttpErrorResponse)) return 'Sign-in failed. Please try again.';
  switch (err.status) {
    case 401:
      return 'Invalid username or password.';
    case 423:
      return apiErrorOf(err)?.message ?? 'This account is temporarily locked.';
    case 429:
      return 'Too many attempts. Please wait a minute and try again.';
    case 0:
    case 502:
    case 503:
      return 'The service is unavailable. Please try again shortly.';
    default:
      return 'Sign-in failed. Please try again.';
  }
}
