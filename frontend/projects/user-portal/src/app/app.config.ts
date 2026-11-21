import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, inject, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { createAuthRefreshInterceptor, csrfInterceptor } from '@aerotrack/shared';
import { routes } from './app.routes';
import { AuthService } from './core/auth.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(
      withFetch(),
      withInterceptors([
        csrfInterceptor,
        createAuthRefreshInterceptor({
          refreshUrl: '/api/auth/refresh',
          skipUrls: ['/api/auth/logout'],
          onSessionExpired: () => inject(AuthService).sessionExpired(),
        }),
      ]),
    ),
  ],
};
