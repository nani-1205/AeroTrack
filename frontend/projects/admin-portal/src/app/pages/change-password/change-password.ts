import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  type AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidationErrors,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import { Icon, Logo, apiErrorOf } from '@aerotrack/shared';
import { Check, Circle, Eye, EyeOff, TriangleExclamationPoint } from 'lucide';
import { AdminAuthService, MIN_ADMIN_PASSWORD_LENGTH } from '../../core/admin-auth.service';

const passwordsMatch = (group: AbstractControl): ValidationErrors | null =>
  group.get('newPassword')?.value === group.get('confirm')?.value ? null : { mismatch: true };

const LABELS = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'] as const;

/** Rough strength score 0–4 for UI feedback (the server enforces the actual policy). */
export function passwordStrength(pw: string, minLength = MIN_ADMIN_PASSWORD_LENGTH): { score: number; label: string } {
  if (!pw) return { score: 0, label: '' };
  let score = 0;
  if (pw.length >= minLength) score++;
  if (pw.length >= minLength + 4) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  if (pw.length < minLength) score = Math.min(score, 1);
  return { score, label: LABELS[score]! };
}

@Component({
  selector: 'app-change-password',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, Logo, Icon],
  host: { '[class.embedded]': '!required()' },
  template: `
    <div>
      <section class="auth-card">
        <header class="auth-head">
          @if (required()) { <ui-logo [markSize]="34" tag="Console" /> }
          <h1>{{ required() ? 'Choose a new password' : 'Change password' }}</h1>
          <p>
            @if (required()) { You signed in with a temporary password. Set your own to continue. }
            @else { Other signed-in sessions of this account will be signed out. }
          </p>
        </header>

        @if (error(); as message) {
          <div class="alert" role="alert"><ui-icon [icon]="icons.Alert" [size]="16" /><span>{{ message }}</span></div>
        }

        <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
          <div class="field">
            <label for="current">Current password</label>
            <input id="current" class="input" type="password" formControlName="currentPassword" autocomplete="current-password" />
          </div>
          <div class="field">
            <label for="new">New password</label>
            <span class="pw">
              <input id="new" class="input" [type]="reveal() ? 'text' : 'password'" formControlName="newPassword" autocomplete="new-password"
                     [attr.aria-invalid]="touched('newPassword') && form.controls.newPassword.invalid" />
              <button type="button" class="reveal" (click)="reveal.set(!reveal())" [attr.aria-label]="reveal() ? 'Hide password' : 'Show password'">
                <ui-icon [icon]="reveal() ? icons.EyeOff : icons.Eye" [size]="16" />
              </button>
            </span>
            <span class="meter" [attr.data-score]="strength().score" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
            @if (strength().label) { <span class="hint">Strength: <strong>{{ strength().label }}</strong></span> }
          </div>
          <div class="field">
            <label for="confirm">Confirm new password</label>
            <input id="confirm" class="input" [type]="reveal() ? 'text' : 'password'" formControlName="confirm" autocomplete="new-password"
                   [attr.aria-invalid]="touched('confirm') && form.hasError('mismatch')" />
            @if (touched('confirm') && form.hasError('mismatch')) { <span class="error">Passwords do not match.</span> }
          </div>

          <ul class="rules">
            @for (rule of rules(); track rule.text) {
              <li [class.ok]="rule.ok"><ui-icon [icon]="rule.ok ? icons.Check : icons.Circle" [size]="13" [strokeWidth]="rule.ok ? 3 : 2" /> {{ rule.text }}</li>
            }
          </ul>

          <button type="submit" class="btn btn-primary btn-lg btn-block" [disabled]="submitting()">
            {{ submitting() ? 'Saving…' : 'Save password' }}
          </button>
        </form>
      </section>
    </div>
  `,
  styleUrls: ['../auth-layout.scss'],
  styles: `
    .meter { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-top: 2px; }
    .meter i { height: 4px; border-radius: 4px; background: var(--gray-200); transition: background var(--normal) var(--ease); }
    .meter[data-score='1'] i:nth-child(-n + 1) { background: var(--red-500); }
    .meter[data-score='2'] i:nth-child(-n + 2) { background: var(--amber-500); }
    .meter[data-score='3'] i:nth-child(-n + 3) { background: #84cc16; }
    .meter[data-score='4'] i { background: var(--green-500); }
    .rules { list-style: none; margin: 0; padding: 12px 14px; display: grid; gap: 6px; border-radius: var(--radius); background: var(--surface-2); border: 1px solid var(--border); font-size: .82rem; color: var(--text-2); }
    .rules li { display: flex; align-items: center; gap: 8px; }
    .rules li ui-icon { color: var(--gray-400); }
    .rules li.ok { color: var(--green-700); }
    .rules li.ok ui-icon { color: var(--green-500); }
  `,
})
export class ChangePasswordPage {
  private readonly auth = inject(AdminAuthService);
  private readonly router = inject(Router);
  protected readonly icons = { Check, Circle, Eye, EyeOff, Alert: TriangleExclamationPoint };

  protected readonly minLength = MIN_ADMIN_PASSWORD_LENGTH;
  protected readonly required = computed(() => this.auth.admin()?.mustChangePassword ?? false);
  protected readonly submitting = signal(false);
  protected readonly reveal = signal(false);
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
  private readonly values = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });

  protected readonly strength = computed(() => passwordStrength(this.values().newPassword ?? ''));
  protected readonly rules = computed(() => {
    const v = this.values();
    const next = v.newPassword ?? '';
    return [
      { text: `At least ${MIN_ADMIN_PASSWORD_LENGTH} characters`, ok: next.length >= MIN_ADMIN_PASSWORD_LENGTH },
      { text: 'Different from the current password', ok: !!next && next !== v.currentPassword },
      { text: 'Both new passwords match', ok: !!next && next === v.confirm },
    ];
  });

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
