import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

export interface User {
  id: string;
  githubId: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

/**
 * Session state for the user portal. Tokens live in httpOnly cookies set by the auth-service,
 * so this service only knows *who* is signed in — never the tokens themselves.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  private readonly current = signal<User | null>(null);
  private loaded = false;

  readonly user = this.current.asReadonly();
  readonly isSignedIn = computed(() => this.current() !== null);
  readonly displayName = computed(() => this.current()?.name || this.current()?.login || '');

  /** Resolves the signed-in user (loaded once; the interceptor refreshes expired access tokens). */
  async ensureSession(): Promise<User | null> {
    if (!this.loaded) {
      try {
        this.current.set(await firstValueFrom(this.http.get<User>('/api/account/me')));
      } catch {
        this.current.set(null);
      }
      this.loaded = true;
    }
    return this.current();
  }

  /** Full-page redirect: the gateway → auth-service → GitHub → back to the portal. */
  signInWithGitHub(): void {
    window.location.assign('/api/auth/github/login');
  }

  async signOut(): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/auth/logout', null));
    } finally {
      this.reset();
      await this.router.navigateByUrl('/login');
    }
  }

  /** Called by the refresh interceptor when the session can no longer be renewed. */
  sessionExpired(): void {
    const wasSignedIn = this.isSignedIn();
    this.reset();
    if (wasSignedIn) void this.router.navigateByUrl('/login?error=session_expired');
  }

  private reset(): void {
    this.current.set(null);
    this.loaded = true;
  }
}
