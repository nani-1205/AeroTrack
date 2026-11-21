// JWT verification against the auth-service JWKS. User and admin tokens use different
// audiences, so a user token can never satisfy an admin route.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type JWTVerifyGetKey, createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { GatewayConfig, RouteConfig } from './config.js';

export interface Principal {
  sub: string;
  role: 'user' | 'admin';
  sessionId: string;
  mustChangePassword: boolean;
  /** Access-token expiry, unix seconds. */
  expiresAt: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export type ProtectedAccess = Exclude<RouteConfig['access'], 'public'>;

/** `invalid`: the caller's token is bad (401). `unavailable`: auth-service/JWKS is down (503). */
export class AuthError extends Error {
  constructor(
    readonly kind: 'missing' | 'invalid' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

export type TokenVerifier = ReturnType<typeof createTokenVerifier>;

export function createTokenVerifier(cfg: GatewayConfig, keySet?: JWTVerifyGetKey) {
  const jwks =
    keySet ??
    createRemoteJWKSet(new URL(cfg.jwt.jwksUrl), {
      timeoutDuration: 3_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });

  const audienceFor = (access: ProtectedAccess) => (access === 'admin' ? cfg.jwt.adminAudience : cfg.jwt.userAudience);
  const cookieFor = (access: ProtectedAccess) =>
    access === 'admin' ? cfg.cookie.adminAccessTokenName : cfg.cookie.accessTokenName;

  return {
    /** Bearer header first, then the httpOnly access cookie for that portal. */
    extractToken(req: FastifyRequest, access: ProtectedAccess): string | undefined {
      const header = req.headers.authorization;
      if (header?.startsWith('Bearer ')) return header.slice(7).trim() || undefined;
      return req.cookies[cookieFor(access)];
    },

    async verify(token: string | undefined, access: ProtectedAccess): Promise<Principal> {
      if (!token) throw new AuthError('missing', 'missing credentials');
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: cfg.jwt.issuer,
          audience: audienceFor(access),
          algorithms: ['RS256'],
        });
        if (!payload.sub || typeof payload['sid'] !== 'string' || typeof payload.exp !== 'number') {
          throw new errors.JWTClaimValidationFailed('missing sub/sid/exp', payload, 'sub', 'missing');
        }
        return {
          sub: payload.sub,
          role: access,
          sessionId: payload['sid'],
          mustChangePassword: payload['mcp'] === true,
          expiresAt: payload.exp,
        };
      } catch (err) {
        // Timeouts, network failures and non-200 JWKS responses (generic JOSE error) mean the
        // auth-service is unhealthy — that is a 503, not the caller's fault.
        const down =
          err instanceof errors.JWKSTimeout || !(err instanceof errors.JOSEError) || err.code === 'ERR_JOSE_GENERIC';
        if (down) throw new AuthError('unavailable', `cannot verify token: ${(err as Error).message}`);
        throw new AuthError('invalid', (err as errors.JOSEError).code);
      }
    },
  };
}

/** Returns a factory of Fastify preHandlers that enforce a route's access rules. */
export function createAccessGuard(verifier: TokenVerifier) {
  return function guard(route: Pick<RouteConfig, 'access' | 'allowPendingPasswordChange'>) {
    const { access } = route;
    return async function accessGuard(req: FastifyRequest, reply: FastifyReply) {
      if (access === 'public') return;
      try {
        req.principal = await verifier.verify(verifier.extractToken(req, access), access);
      } catch (err) {
        const e = err as AuthError;
        if (e.kind === 'unavailable') {
          req.log.error({ err }, 'cannot fetch JWKS from auth-service');
          return reply.code(503).send({ error: 'unavailable', message: 'authentication temporarily unavailable' });
        }
        if (e.kind === 'invalid') req.log.info({ code: e.message }, 'token rejected');
        return reply
          .code(401)
          .send({ error: 'unauthorized', message: e.kind === 'missing' ? 'missing credentials' : 'invalid or expired token' });
      }
      if (req.principal.mustChangePassword && !route.allowPendingPasswordChange) {
        return reply
          .code(403)
          .send({ error: 'password_change_required', message: 'change your password before continuing' });
      }
    };
  };
}
