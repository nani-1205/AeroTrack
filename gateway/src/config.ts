// Loads and validates the gateway's own JSON config (config/gateway.json).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const ENV_CONFIG_PATH = 'GATEWAY_CONFIG';
const PLACEHOLDER = 'CHANGE_ME';

const secret = z
  .string()
  .min(1)
  .refine((v) => v !== PLACEHOLDER, { message: `still "${PLACEHOLDER}" — run \`npm run setup\`` });

const RouteSchema = z.object({
  prefix: z.string().regex(/^\/api\/[a-z0-9/-]+[a-z0-9]$/, 'must look like /api/<segment>[/<segment>]'),
  target: z.url(),
  access: z.enum(['public', 'user', 'admin']),
});

export const GatewayConfigSchema = z
  .object({
    env: z.enum(['development', 'test', 'production']).default('development'),
    listen: z.object({ host: z.string().min(1), port: z.number().int().positive() }),
    cors: z.object({ origins: z.array(z.url()).min(1), credentials: z.boolean() }),
    cookie: z.object({
      secret,
      secure: z.boolean(),
      sameSite: z.enum(['lax', 'strict', 'none']),
      accessTokenName: z.string().min(1),
      adminAccessTokenName: z.string().min(1),
    }),
    jwt: z.object({
      jwksUrl: z.url(),
      issuer: z.string().min(1),
      userAudience: z.string().min(1),
      adminAudience: z.string().min(1),
    }),
    redis: z.object({
      host: z.string().min(1),
      port: z.number().int().positive(),
      password: secret,
      db: z.number().int().min(0),
    }),
    internalToken: secret,
    rateLimit: z.object({ max: z.number().int().positive(), windowSeconds: z.number().int().positive() }),
    websocket: z.object({
      path: z.string().startsWith('/'),
      maxFlightsPerClient: z.number().int().min(1).max(5),
      sameAirlineOnly: z.boolean(),
    }),
    routes: z.array(RouteSchema).min(1),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const r of cfg.routes) {
      if (seen.has(r.prefix)) ctx.addIssue({ code: 'custom', path: ['routes'], message: `duplicate prefix ${r.prefix}` });
      seen.add(r.prefix);
    }
    if (cfg.env === 'production' && !cfg.cookie.secure) {
      ctx.addIssue({ code: 'custom', path: ['cookie', 'secure'], message: 'must be true in production' });
    }
  });

export type GatewayConfig = z.infer<typeof GatewayConfigSchema> & { path: string };
export type RouteConfig = GatewayConfig['routes'][number];
export type Access = RouteConfig['access'];

export function loadConfig(): GatewayConfig {
  const defaultPath = fileURLToPath(new URL('../../config/gateway.json', import.meta.url));
  const file = path.resolve(process.env[ENV_CONFIG_PATH] ?? defaultPath);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`read config ${file} (set ${ENV_CONFIG_PATH} to override): ${(err as Error).message}`);
  }
  const parsed = GatewayConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid config ${file}:\n${z.prettifyError(parsed.error)}`);
  }
  return { ...parsed.data, path: file };
}
