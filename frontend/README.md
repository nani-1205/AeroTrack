# AeroTrack frontend

Angular 22 workspace with three projects:

| Project | What | Dev URL | Runbook |
|---|---|---|---|
| `user-portal` | GitHub sign-in, airlines → flights → live map | http://localhost:4200 | [docs/runbooks/user-portal.md](../docs/runbooks/user-portal.md) |
| `admin-portal` | Admin console: overview, users, performance | http://localhost:4201 | [docs/runbooks/admin-portal.md](../docs/runbooks/admin-portal.md) |
| `shared` | Design system (tokens, Inter, Lucide icon/logo/monogram/stat components), HTTP interceptors (CSRF, silent refresh), service-health card | — | [projects/shared/README.md](projects/shared/README.md) |

```sh
npm install
npm run start:user          # or: npm run dev:user-portal from the repo root
npm run start:admin
npm run build:all           # → dist/user-portal, dist/admin-portal
npm run test:all            # shared + both portals (Vitest)
```

In development, [proxy.conf.json](proxy.conf.json) forwards `/api`, `/ws` and `/health` to the gateway at `http://127.0.0.1:8080`. The apps contain no secrets and no backend URLs.

Shared styles live in [projects/shared/styles/_base.scss](projects/shared/styles/_base.scss); each app imports them in its `src/styles.scss` and overrides only its shell colours. Import shared code as `@aerotrack/shared`; it maps to the library's source through `tsconfig.json`, so it doesn't need building first.
