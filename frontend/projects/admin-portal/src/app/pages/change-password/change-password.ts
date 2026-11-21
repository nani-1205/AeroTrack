import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  type AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidationErrors,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import { apiErrorOf } from '@aerotrack/shared';
import { AdminAuthService, MIN_ADMIN_PASSWORD_LENGTH } from '../../core/admin-auth.service';

const passwordsMatch = (group: AbstractControl): ValidationErrors | null =>
  group.get('newPassword')?.value === group.get('confirm')?.value ? null : { mismatch: true };

@Component({
  selector: 'app-change-password',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  template: `
    <section class="card auth-card">
      <h1>{{ required() ? 'Choose a new password' : 'Change password' }}</h1>
      <p class="lead">
        @if (required()) {
          You signed in with a temporary password. Set your own to continue.
        } @else {
          Other signed-in sessions will be signed out.
        }
      </p>

      @if (error(); as message) {
        <div class="alert" role="alert">{{ message }}</div>
      }

      <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <div class="field">
          <label for="current">Current password</label>
          <input id="current" type="password" formControlName="currentPassword" autocomplete="current-password" />
        </div>
        <div class="field">
          <label for="new">New password</label>
          <input id="new" type="password" formControlName="newPassword" autocomplete="new-password"
                 [attr.aria-invalid]="touched('newPassword') && form.controls.newPassword.invalid" />
          <span class="hint">At least {{ minLength }} characters.</span>
        </div>
        <div class="field">
          <label for="confirm">Confirm new password</label>
          <input id="confirm" type="password" formControlName="confirm" autocomplete="new-password"
                 [attr.aria-invalid]="touched('confirm') && form.hasError('mismatch')" />
          @if (touched('confirm') && form.hasError('mismatch')) {
            <span class="error">Passwords do not match.</span>
          }
        </div>
        <button type="submit" class="btn btn-primary btn-block" [disabled]="submitting()">
          {{ submitting() ? 'Saving…' : 'Save password' }}
        </button>
      </form>
    </section>
  `,
})
export class ChangePasswordPage {
  private readonly auth = inject(AdminAuthService);
  private readonly router = inject(Router);

  protected readonly minLength = MIN_ADMIN_PASSWORD_LENGTH;
  protected readonly required = computed(() => this.auth.admin()?.mustChangePassword ?? false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly form = new FormGroup(
    {
      currentPassword: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
      newPassword: new FormControl('', {
        nonNullable: true,
        validators: [Validators.required, Validators.minLength(MIN_ADMIN_PASSWORD_LENGTH)],
      }),
      confirm: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    },
    { validators: passwordsMatch },
  );

  protected touched(name: 'newPassword' | 'confirm'): boolean {
    const c = this.form.controls[name];
    return c.touched || c.dirty;
  }

  async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set(
        this.form.hasError('mismatch')
          ? 'Passwords do not match.'
          : `Fill in all fields; the new password needs at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`,
      );
      return;
    }
    this.submitting.set(true);
    this.error.set(null);
    try {
      const { currentPassword, newPassword } = this.form.getRawValue();
      await this.auth.changePassword(currentPassword, newPassword);
      await this.router.navigateByUrl('/');
    } catch (err) {
      const api = err instanceof HttpErrorResponse ? apiErrorOf(err) : null;
      this.error.set(
        api?.error === 'invalid_credentials'
          ? 'Your current password is incorrect.'
          : (api?.message ?? 'Could not change the password. Please try again.'),
      );
    } finally {
      this.submitting.set(false);
    }
  }
}
