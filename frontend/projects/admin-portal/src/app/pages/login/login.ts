import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { apiErrorOf } from '@aerotrack/shared';
import { AdminAuthService } from '../../core/admin-auth.service';

@Component({
  selector: 'app-admin-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  template: `
    <section class="card auth-card">
      <h1>Admin sign-in</h1>
      <p class="lead">Restricted to AeroTrack administrators.</p>

      @if (error(); as message) {
        <div class="alert" role="alert">{{ message }}</div>
      } @else if (expired()) {
        <div class="alert" role="alert">Your session expired. Please sign in again.</div>
      }

      <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <div class="field">
          <label for="username">Username</label>
          <input id="username" formControlName="username" autocomplete="username" autofocus
                 [attr.aria-invalid]="invalid('username')" />
          @if (invalid('username')) { <span class="error">Username is required.</span> }
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" type="password" formControlName="password" autocomplete="current-password"
                 [attr.aria-invalid]="invalid('password')" />
          @if (invalid('password')) { <span class="error">Password is required.</span> }
        </div>
        <button type="submit" class="btn btn-primary btn-block" [disabled]="submitting()">
          {{ submitting() ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
    </section>
  `,
})
export class AdminLoginPage {
  private readonly auth = inject(AdminAuthService);
  private readonly router = inject(Router);

  /** ?expired=1 after the session could not be refreshed. */
  readonly expired = input<string>();

  protected readonly form = new FormGroup({
    username: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });
  protected readonly submitting = signal(false);
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
