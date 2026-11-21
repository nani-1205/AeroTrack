// JWT verification against the auth-service JWKS. User and admin tokens use different
// audiences, so a user token can never satisfy an admin route.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { Access, GatewayConfig } from './config.js';

export interface Principal {
  sub: string;
  role: 'user' | 'admin';
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

type Protected = Exclude<Access, 'public'>;

export function createAccessGuard(cfg: GatewayConfig) {
  const jwks = createRemoteJWKSet(new URL(cfg.jwt.jwksUrl), {
    timeoutDuration: 3_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });

  const audienceFor = (access: Protected) => (access === 'admin' ? cfg.jwt.adminAudience : cfg.jwt.userAudience);
  const cookieFor = (access: Protected) =>
    access === 'admin' ? cfg.cookie.adminAccessTokenName : cfg.cookie.accessTokenName;

  function extractToken(req: FastifyRequest, access: Protected): string | undefined {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7).trim() || undefined;
    return req.cookies[cookieFor(access)];
  }

  /** Returns a Fastify preHandler that enforces the given access level. */
  return function guard(access: Access) {
    return async function accessGuard(req: FastifyRequest, reply: FastifyReply) {
      if (access === 'public') return;

      const token = extractToken(req, access);
      if (!token) return reply.code(401).send({ error: 'unauthorized', message: 'missing credentials' });

      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: cfg.jwt.issuer,
          audience: audienceFor(access),
          algorithms: ['RS256'],
        });
        if (!payload.sub) throw new errors.JWTClaimValidationFailed('missing sub', payload, 'sub', 'missing');
        req.principal = { sub: payload.sub, role: access };
      } catch (err) {
        // Timeouts, network failures and non-200 JWKS responses (generic JOSE error) mean the
        // auth-service is unhealthy — that is a 503, not the caller's fault.
        const authServiceDown =
          err instanceof errors.JWKSTimeout ||
          !(err instanceof errors.JOSEError) ||
          err.code === 'ERR_JOSE_GENERIC';
        if (authServiceDown) {
          req.log.error({ err }, 'cannot fetch JWKS from auth-service');
          return reply.code(503).send({ error: 'unavailable', message: 'authentication temporarily unavailable' });
        }
        req.log.info({ code: (err as errors.JOSEError).code }, 'token rejected');
        return reply.code(401).send({ error: 'unauthorized', message: 'invalid or expired token' });
      }
    };
  };
}
