#!/usr/bin/env bash
# Production build for Linux (x86_64 or arm64). Builds every component — or only the ones
# named — into ./release/, ready to copy to a server:
#
#   ./scripts/build-linux.sh                      # everything
#   ./scripts/build-linux.sh auth tracking        # only some: frontend gateway auth tracking analytics
#   RELEASE_DIR=/opt/aerotrack ./scripts/build-linux.sh
#
# Output (RELEASE_DIR, default ./release):
#   user-portal/  admin-portal/   static files (serve with nginx/Caddy, SPA fallback to index.html)
#   gateway/                      dist/ + production node_modules → node dist/main.js
#   auth-service/auth             static Go binary (migrations embedded)
#   tracking-service/tracking-service   Rust binary (migrations + airline seed embedded)
#   analytics-service/            Rails app + vendored gems → ruby bin/start
#
# Requirements: see docs/runbooks/README.md ("Building on Linux").
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${RELEASE_DIR:-$ROOT/release}"
ALL=(frontend gateway auth tracking analytics)
TARGETS=("${@:-${ALL[@]}}")

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "✘ '$1' not found — $2" >&2; exit 1; }; }

build_frontend() {
  need node "install Node.js 22+"; need npm "install Node.js 22+"
  say "frontend: user portal + admin console"
  cd "$ROOT/frontend"
  npm ci --no-audit --no-fund
  npx ng build user-portal --configuration production
  npx ng build admin-portal --configuration production
  rm -rf "$OUT/user-portal" "$OUT/admin-portal"
  mkdir -p "$OUT"
  cp -r dist/user-portal/browser "$OUT/user-portal"
  cp -r dist/admin-portal/browser "$OUT/admin-portal"
}

build_gateway() {
  need node "install Node.js 22+"; need npm "install Node.js 22+"
  say "gateway: TypeScript → dist/, production dependencies only"
  cd "$ROOT/gateway"
  npm ci --no-audit --no-fund
  npm run build
  rm -rf "$OUT/gateway" && mkdir -p "$OUT/gateway"
  cp -r dist package.json package-lock.json "$OUT/gateway/"
  (cd "$OUT/gateway" && npm ci --omit=dev --no-audit --no-fund)
}

build_auth() {
  need go "install Go 1.25+ (https://go.dev/dl/)"
  say "auth-service: static Go binary"
  cd "$ROOT/services/auth-service"
  mkdir -p "$OUT/auth-service"
  CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$OUT/auth-service/auth" ./cmd/auth
}

build_tracking() {
  need cargo "install Rust 1.85+ (https://rustup.rs)"
  say "tracking-service: Rust release binary"
  cd "$ROOT/services/tracking-service"
  cargo build --release --locked
  mkdir -p "$OUT/tracking-service"
  cp target/release/tracking-service "$OUT/tracking-service/"
}

build_analytics() {
  need ruby "install Ruby 3.3+"; need bundle "gem install bundler"
  say "analytics-service: Rails app with vendored production gems"
  rm -rf "$OUT/analytics-service" && mkdir -p "$OUT/analytics-service"
  cd "$ROOT/services/analytics-service"
  # Copy the app without local state (gems, logs, tmp).
  tar --exclude=./vendor --exclude=./log --exclude=./tmp --exclude=./.bundle -cf - . | tar -xf - -C "$OUT/analytics-service"
  cd "$OUT/analytics-service"
  # Keep Bundler settings inside the release (some environments, e.g. the official ruby
  # Docker image, point BUNDLE_APP_CONFIG elsewhere) so the folder is self-contained.
  export BUNDLE_APP_CONFIG="$PWD/.bundle"
  bundle config set --local deployment true
  bundle config set --local path vendor/bundle
  bundle config set --local without 'development test'
  bundle install --jobs 4
}

for t in "${TARGETS[@]}"; do
  case "$t" in
    frontend|gateway|auth|tracking|analytics) "build_$t" ;;
    *) echo "✘ unknown component '$t' (use: ${ALL[*]})" >&2; exit 2 ;;
  esac
done

say "done → $OUT"
ls -1 "$OUT"
