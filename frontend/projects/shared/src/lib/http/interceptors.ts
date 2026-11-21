import { HttpErrorResponse, type HttpInterceptorFn, HttpClient } from '@angular/common/http';
import { Injector, inject, runInInjectionContext } from '@angular/core';
import { type Observable, catchError, finalize, shareReplay, switchMap, throwError } from 'rxjs';
import { CSRF_HEADER, CSRF_VALUE } from '../api';

const isApi = (url: string) => url.startsWith('/api/');

/** Adds the CSRF header the gateway requires on mutating /api calls (harmless on GETs). */
export const csrfInterceptor: HttpInterceptorFn = (req, next) =>
  next(isApi(req.url) ? req.clone({ setHeaders: { [CSRF_HEADER]: CSRF_VALUE } }) : req);

export interface AuthRefreshOptions {
  /** e.g. '/api/auth/refresh' or '/api/admin/auth/refresh' */
  refreshUrl: string;
  /** URLs that must never trigger a refresh (login, logout, the refresh call itself). */
  skipUrls: string[];
  /** Called once the session is definitely gone (refresh failed). Runs in an injection context. */
  onSessionExpired: () => void;
}

/**
 * On a 401 from the API, refreshes the session once (shared by concurrent requests) and
 * retries the original request. Access/refresh tokens live in httpOnly cookies, so there is
 * nothing to store in JS — the browser sends the rotated cookies automatically.
 */
export function createAuthRefreshInterceptor(opts: AuthRefreshOptions): HttpInterceptorFn {
  let inFlight: Observable<unknown> | null = null;
  const skip = (url: string) => url === opts.refreshUrl || opts.skipUrls.some((u) => url.startsWith(u));

  return (req, next) => {
    if (!isApi(req.url) || skip(req.url)) return next(req);
    const http = inject(HttpClient);
    const injector = inject(Injector);

    return next(req).pipe(
      catchError((err: unknown) => {
        if (!(err instanceof HttpErrorResponse) || err.status !== 401) return throwError(() => err);

        inFlight ??= http.post(opts.refreshUrl, null).pipe(
          finalize(() => (inFlight = null)),
          shareReplay({ bufferSize: 1, refCount: false }),
        );
        return inFlight.pipe(
          catchError((refreshErr: unknown) => {
            runInInjectionContext(injector, opts.onSessionExpired);
            return throwError(() => refreshErr);
          }),
          switchMap(() => next(req)),
        );
      }),
    );
  };
}
