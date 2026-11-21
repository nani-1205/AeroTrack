import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { ChangePasswordPage } from './pages/change-password/change-password';
import { AdminLoginPage } from './pages/login/login';

describe('admin-portal', () => {
  let backend: HttpTestingController;
  let navigated: string[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminLoginPage, ChangePasswordPage],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    backend = TestBed.inject(HttpTestingController);
    navigated = [];
    const router = TestBed.inject(Router);
    router.navigateByUrl = async (url) => (navigated.push(String(url)), true);
  });

  /** Create and render once so the reactive-form directives are attached before we type. */
  async function render<T>(component: Type<T>) {
    const fixture = TestBed.createComponent(component);
    await fixture.whenStable();
    return fixture;
  }

  function fill(el: HTMLElement, id: string, value: string) {
    const input = el.querySelector<HTMLInputElement>(`#${id}`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  async function submit(fixture: { nativeElement: HTMLElement; whenStable(): Promise<unknown> }) {
    fixture.nativeElement.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
  }

  it('sends an admin with a temporary password to the change-password page', async () => {
    const fixture = await render(AdminLoginPage);
    const el = fixture.nativeElement as HTMLElement;
    fill(el, 'username', 'admin');
    fill(el, 'password', 'temporary-secret');
    fixture.nativeElement.querySelector('form')!.dispatchEvent(new Event('submit'));

    const req = backend.expectOne('/api/admin/auth/login');
    expect(req.request.body).toEqual({ username: 'admin', password: 'temporary-secret' });
    req.flush({ admin: { id: 'a1', username: 'admin', mustChangePassword: true, lastLoginAt: null } });
    await fixture.whenStable();
    expect(navigated).toEqual(['/change-password']);
  });

  it('shows a generic message for bad credentials', async () => {
    const fixture = await render(AdminLoginPage);
    const el = fixture.nativeElement as HTMLElement;
    fill(el, 'username', 'admin');
    fill(el, 'password', 'wrong');
    el.querySelector('form')!.dispatchEvent(new Event('submit'));

    backend.expectOne('/api/admin/auth/login').flush(
      { error: 'invalid_credentials', message: 'invalid username or password' },
      { status: 401, statusText: 'Unauthorized' },
    );
    await fixture.whenStable();
    expect(el.querySelector('[role=alert]')?.textContent).toContain('Invalid username or password');
    expect(navigated).toEqual([]);
  });

  it('does not submit a password change when confirmation does not match', async () => {
    const fixture = await render(ChangePasswordPage);
    const el = fixture.nativeElement as HTMLElement;
    fill(el, 'current', 'temporary-secret');
    fill(el, 'new', 'a-much-better-password');
    fill(el, 'confirm', 'something-else-entirely');
    await submit(fixture);

    backend.expectNone('/api/admin/account/password');
    expect(el.querySelector('[role=alert]')?.textContent).toContain('do not match');
  });

  it('submits a valid password change and returns to the dashboard', async () => {
    const fixture = await render(ChangePasswordPage);
    const el = fixture.nativeElement as HTMLElement;
    fill(el, 'current', 'temporary-secret');
    fill(el, 'new', 'a-much-better-password');
    fill(el, 'confirm', 'a-much-better-password');
    el.querySelector('form')!.dispatchEvent(new Event('submit'));

    const req = backend.expectOne('/api/admin/account/password');
    expect(req.request.body).toEqual({ currentPassword: 'temporary-secret', newPassword: 'a-much-better-password' });
    req.flush({ admin: { id: 'a1', username: 'admin', mustChangePassword: false, lastLoginAt: null } });
    await fixture.whenStable();
    expect(navigated).toEqual(['/']);
  });
});
