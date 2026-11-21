import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

export interface Admin {
  id: string;
  username: string;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
}

/** Must match config/services.json → auth.admin.minPasswordLength (the server is the authority). */
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

/** Admin session state. Tokens are httpOnly cookies; this only tracks who is signed in. */
@Injectable({ providedIn: 'root' })
export class AdminAuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  private readonly current = signal<Admin | null>(null);
  private loaded = false;

  readonly admin = this.current.asReadonly();

  async ensureSession(): Promise<Admin | null> {
    if (!this.loaded) {
      try {
        this.current.set(await firstValueFrom(this.http.get<Admin>('/api/admin/account/me')));
      } catch {
        this.current.set(null);
      }
      this.loaded = true;
    }
    return this.current();
  }

  async login(username: string, password: string): Promise<Admin> {
    const res = await firstValueFrom(this.http.post<{ admin: Admin }>('/api/admin/auth/login', { username, password }));
    this.current.set(res.admin);
    this.loaded = true;
    return res.admin;
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<Admin> {
    const res = await firstValueFrom(
      this.http.post<{ admin: Admin }>('/api/admin/account/password', { currentPassword, newPassword }),
    );
    this.current.set(res.admin);
    return res.admin;
  }

  async signOut(): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/admin/auth/logout', null));
    } finally {
      this.reset();
      await this.router.navigateByUrl('/login');
    }
  }

  /** Called by the refresh interceptor when the session can no longer be renewed. */
  sessionExpired(): void {
    const wasSignedIn = this.current() !== null;
    this.reset();
    if (wasSignedIn) void this.router.navigateByUrl('/login?expired=1');
  }

  private reset(): void {
    this.current.set(null);
    this.loaded = true;
  }
}
