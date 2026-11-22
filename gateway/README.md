# API gateway

The single entry point for both portals: JWT verification, CSRF, rate limits, routing by prefix, and the live-tracking WebSocket (`/ws`).

```sh
npm install && npm run dev        # from the repo root: npm run dev:gateway
npm test                          # node:test suite
```

Configuration: `config/gateway.json`. **Operating guide: [docs/runbooks/gateway.md](../docs/runbooks/gateway.md).**
