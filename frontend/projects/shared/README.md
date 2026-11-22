# @aerotrack/shared

Code and styles shared by the user portal and the admin console. Apps import it as `@aerotrack/shared`; it maps to `src/public-api.ts` through `tsconfig.json`, so no build step is needed.

| Export | Purpose |
|---|---|
| `styles/_base.scss` | Design tokens (colour, type, radius, elevation, motion) and component classes: `.btn`, `.input`, `.card`, `.badge`, `.table`, `.alert`, `.skeleton`, `.checkbox`, layout helpers. Each app `@use`s it in `src/styles.scss`. |
| `Icon` (`<ui-icon [icon]="Plane" [size]="16" />`) | Renders a Lucide icon node (tree-shakeable) |
| `Logo` (`<ui-logo tag="Console" />`) | Brand mark and wordmark; add the class `on-dark` on dark backgrounds |
| `Monogram` (`<ui-monogram code="AIC" label="AI" />`) | Coloured initials tile; the colour is derived from the code |
| `Stat` (`<ui-stat label value hint [icon] [loading] />`) | KPI tile |
| `EmptyState` | Icon, heading and description for empty lists |
| `SystemStatus` (`<lib-system-status />`) | Service health from the gateway's `/health/services` |
| `csrfInterceptor`, `createAuthRefreshInterceptor({...})` | Adds `X-Requested-With: aerotrack` to `/api` calls; on a 401, runs one shared refresh and retries |
| `API_BASE_URL`, `MAX_TRACKED_FLIGHTS`, `apiErrorOf()` | API base (`/api`), the 1–5 flight limit, typed error bodies |

Tests: `npx ng test shared --watch=false`.
