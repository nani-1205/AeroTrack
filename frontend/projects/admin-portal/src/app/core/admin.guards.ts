import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { apiErrorOf } from '@aerotrack/shared';
import { catchError, throwError } from 'rxjs';
import { AdminAuthService } from './admin-auth.service';

/** Signed-in admins with a final password only. */
export const adminGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const admin = await inject(AdminAuthService).ensureSession();
  if (!admin) return router.createUrlTree(['/login']);
  return admin.mustChangePassword ? router.createUrlTree(['/change-password']) : true;
};

/** Any signed-in admin (also used for voluntary password changes). */
export const signedInGuard: CanActivateFn = async () => {
  const router = inject(Router);
  return (await inject(AdminAuthService).ensureSession()) ? true : router.createUrlTree(['/login']);
};

export const guestGuard: CanActivateFn = async () => {
  const router = inject(Router);
  return (await inject(AdminAuthService).ensureSession()) ? router.createUrlTree(['/']) : true;
};

/** The gateway answers 403 password_change_required until the temporary password is replaced. */
export const passwordChangeInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);
  return next(req).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 403 && apiErrorOf(err)?.error === 'password_change_required') {
        void router.navigateByUrl('/change-password');
      }
      return throwError(() => err);
    }),
  );
};
