import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { AuthService } from './core/auth.service';
import { LoginPage } from './pages/login/login';

describe('user-portal', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App, LoginPage],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('shows the signed-in user and a sign-out button in the top bar', async () => {
    const fixture = TestBed.createComponent(App);
    const session = TestBed.inject(AuthService).ensureSession();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/account/me')
      .flush({ id: 'u1', githubId: 1, login: 'octocat', name: 'The Octocat', email: null, avatarUrl: null, createdAt: '', lastLoginAt: null });
    await session;
    await fixture.whenStable();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.who')?.textContent).toContain('The Octocat');

    el.querySelector<HTMLButtonElement>('.account-btn')!.click();
    await fixture.whenStable();
    expect(el.querySelector('.menu-head')?.textContent).toContain('@octocat');
    expect(el.querySelector('.menu-item')?.textContent).toContain('Sign out');
  });

  it('hides account controls when nobody is signed in', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('.who')).toBeNull();
  });

  it('explains login errors passed back by the auth-service', async () => {
    const fixture = TestBed.createComponent(LoginPage);
    fixture.componentRef.setInput('error', 'github_not_configured');
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('[role=alert]')?.textContent).toContain('not set up yet');
  });

  it('shows no error on a clean visit', async () => {
    const fixture = TestBed.createComponent(LoginPage);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('[role=alert]')).toBeNull();
  });
});
