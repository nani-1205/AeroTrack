import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, inject, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { createAuthRefreshInterceptor, csrfInterceptor } from '@aerotrack/shared';
import { routes } from './app.routes';
import { AdminAuthService } from './core/admin-auth.service';
import { passwordChangeInterceptor } from './core/admin.guards';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(
      withFetch(),
      withInterceptors([
        csrfInterceptor,
        passwordChangeInterceptor,
        createAuthRefreshInterceptor({
          refreshUrl: '/api/admin/auth/refresh',
          // A 401 from login means "wrong password", not "session expired".
          skipUrls: ['/api/admin/auth/login', '/api/admin/auth/logout'],
          onSessionExpired: () => inject(AdminAuthService).sessionExpired(),
        }),
      ]),
    ),
  ],
};
