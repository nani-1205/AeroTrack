import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/** Signed-in users only; everyone else goes to /login. */
export const authGuard: CanActivateFn = async () => {
  const router = inject(Router);
  return (await inject(AuthService).ensureSession()) ? true : router.createUrlTree(['/login']);
};

/** The login page is pointless once signed in. */
export const guestGuard: CanActivateFn = async () => {
  const router = inject(Router);
  return (await inject(AuthService).ensureSession()) ? router.createUrlTree(['/']) : true;
};
