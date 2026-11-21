import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { createAuthRefreshInterceptor, csrfInterceptor } from './interceptors';

describe('auth interceptors', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let expired: number;

  beforeEach(() => {
    expired = 0;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(
          withInterceptors([
            csrfInterceptor,
            createAuthRefreshInterceptor({
              refreshUrl: '/api/auth/refresh',
              skipUrls: ['/api/auth/logout'],
              onSessionExpired: () => expired++,
            }),
          ]),
        ),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('adds the CSRF header to API calls only', () => {
    http.post('/api/auth/logout', null).subscribe();
    http.get('/health/services').subscribe();
    expect(backend.expectOne('/api/auth/logout').request.headers.get('X-Requested-With')).toBe('aerotrack');
    expect(backend.expectOne('/health/services').request.headers.has('X-Requested-With')).toBe(false);
  });

  it('refreshes once on 401 and retries the request', () => {
    let result: unknown;
    http.get('/api/account/me').subscribe((r) => (result = r));

    backend.expectOne('/api/account/me').flush({ error: 'unauthorized' }, { status: 401, statusText: 'Unauthorized' });
    backend.expectOne('/api/auth/refresh').flush({ expiresAt: 'later' });
    backend.expectOne('/api/account/me').flush({ login: 'octocat' });

    expect(result).toEqual({ login: 'octocat' });
    expect(expired).toBe(0);
  });

  it('shares one refresh between concurrent 401s', () => {
    http.get('/api/a').subscribe();
    http.get('/api/b').subscribe();
    backend.expectOne('/api/a').flush(null, { status: 401, statusText: 'Unauthorized' });
    backend.expectOne('/api/b').flush(null, { status: 401, statusText: 'Unauthorized' });

    backend.expectOne('/api/auth/refresh').flush({});
    backend.expectOne('/api/a').flush({});
    backend.expectOne('/api/b').flush({});
  });

  it('reports an expired session when the refresh fails', () => {
    let failed = false;
    http.get('/api/account/me').subscribe({ error: () => (failed = true) });

    backend.expectOne('/api/account/me').flush(null, { status: 401, statusText: 'Unauthorized' });
    backend.expectOne('/api/auth/refresh').flush(null, { status: 401, statusText: 'Unauthorized' });

    expect(failed).toBe(true);
    expect(expired).toBe(1);
  });
});
