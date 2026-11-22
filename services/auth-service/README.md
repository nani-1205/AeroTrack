# auth-service (Go)

GitHub SSO for users; username and password for admins (argon2id, lockout, forced first password change); RS256 access tokens with JWKS; rotating refresh sessions in Redis; sign-in audit and usage events.

```sh
go run ./cmd/auth          # from the repo root: npm run dev:auth
go test ./...              # integration tests need `npm run infra:up`
```

Configuration: `config/services.json` → `shared` + `auth`. **Operating guide: [docs/runbooks/auth-service.md](../../docs/runbooks/auth-service.md).**
