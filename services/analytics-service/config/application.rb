require_relative "boot"

require "rails"
require "active_model/railtie"
require "active_record/railtie"
require "action_controller/railtie"

Bundler.require(*Rails.groups)

require_relative "service_config"
require "prometheus/middleware/collector"
require "prometheus/middleware/exporter"

module AnalyticsService
  class Application < Rails::Application
    config.load_defaults 8.1
    config.api_only = true
    config.eager_load = Rails.env.production?

    # All secrets come from config/services.json — no Rails credentials files.
    config.secret_key_base = ServiceConfig.analytics.fetch("secretKeyBase")

    # Requests arrive via the gateway / Prometheus (host.docker.internal), not just localhost.
    config.hosts.clear

    config.logger = ActiveSupport::TaggedLogging.new(ActiveSupport::Logger.new($stdout))
    config.log_level = :info

    # Small lookups (airline names) are cached in-process.
    config.cache_store = :memory_store, { size: 8 * 1024 * 1024 }

    # Migrations run at startup (bin/start); never write schema dumps from the running service.
    config.active_record.dump_schema_after_migration = false

    config.middleware.use Prometheus::Middleware::Collector
    config.middleware.use Prometheus::Middleware::Exporter # serves GET /metrics
  end
end
