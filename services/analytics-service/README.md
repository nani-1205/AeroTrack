# analytics-service (Ruby on Rails)

Consumes usage events from Redis streams, combines them with user counts (auth), live traffic (tracking) and Prometheus metrics, and serves the admin console API.

```sh
bundle config set --local path vendor/bundle && bundle install
ruby bin/start             # from the repo root: npm run dev:analytics (not `bundle exec` on Windows)
ruby test/event_consumer_test.rb
```

Configuration: `config/services.json` → `shared` + `analytics`. **Operating guide: [docs/runbooks/analytics-service.md](../../docs/runbooks/analytics-service.md).**
