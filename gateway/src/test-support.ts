// Shared fixtures for gateway tests (not imported by production code).
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { GatewayConfigSchema, type GatewayConfig } from './config.js';

export const ISSUER = 'aerotrack-auth';
export const USER_AUD = 'aerotrack-user';
export const ADMIN_AUD = 'aerotrack-admin';
export const PORTAL_ORIGIN = 'http://localhost:4200';

export function testConfig(target: string): GatewayConfig {
  return {
    ...GatewayConfigSchema.parse({
      env: 'test',
      listen: { host: '127.0.0.1', port: 8080 }, // never bound: tests use app.inject()/injectWS()
      cors: { origins: [PORTAL_ORIGIN], credentials: true },
      cookie: { secret: 'test-cookie-secret', secure: false, sameSite: 'lax', accessTokenName: 'aerotrack_at', adminAccessTokenName: 'aerotrack_admin_at' },
      jwt: { jwksUrl: 'http://127.0.0.1:1/jwks', issuer: ISSUER, userAudience: USER_AUD, adminAudience: ADMIN_AUD },
      redis: { host: '127.0.0.1', port: 6379, password: 'unused', db: 0 },
      internalToken: 'internal-secret',
      csrf: { header: 'x-requested-with', value: 'aerotrack' },
      rateLimit: { max: 1000, windowSeconds: 60 },
      websocket: {
        path: '/ws',
        maxFlightsPerClient: 5,
        sameAirlineOnly: true,
        watchUrl: `${target}/flights/watch`,
        heartbeatSeconds: 30,
        maxMessagesPer10s: 20,
      },
      routes: [
        { prefix: '/api/auth', target, access: 'public' },
        { prefix: '/api/airlines', target, access: 'user' },
        { prefix: '/api/admin/account', target, access: 'admin', allowPendingPasswordChange: true },
        { prefix: '/api/admin', target, access: 'admin' },
      ],
    }),
    path: 'test',
  };
}

/** In-memory signing key + JWKS; `sign()` mints tokens the gateway accepts. */
export async function testKeys() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
  return {
    keySet: createLocalJWKSet({ keys: [jwk] }),
    sign: (aud: string, claims: Record<string, unknown> = {}, expiresIn: string | number = '5m') =>
      new SignJWT({ sid: 'sess-1', ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer(ISSUER)
        .setAudience(aud)
        .setSubject('subject-1')
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .sign(privateKey),
  };
}
