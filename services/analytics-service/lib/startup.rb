# frozen_string_literal: true

# Startup routine shared policy with the other AeroTrack services:
#   * wait (with backoff) until Postgres is reachable;
#   * apply ONLY pending migrations, forward-only, under ActiveRecord's advisory lock;
#   * never force/reset — if the DB has applied versions that no longer exist in
#     db/migrate, refuse to start instead of guessing.
module Startup
  class MigrationStateError < StandardError; end

  module_function

  def logger = Rails.logger

  def wait_for_database!
    retries = [Integer(ServiceConfig.postgres.fetch("startupRetries", 30)), 1].max
    backoff = 1.0
    1.step do |attempt|
      ActiveRecord::Base.connection_pool.with_connection { |c| c.select_value("SELECT 1") }
      logger.info("postgres is available (schema=#{ServiceConfig.db['schema']}, attempt=#{attempt})")
      return
    rescue ActiveRecord::ConnectionNotEstablished, ActiveRecord::DatabaseConnectionError, PG::Error => e
      raise if attempt >= retries

      logger.warn("waiting for postgres (attempt #{attempt}/#{retries}): #{e.message.lines.first&.strip}")
      sleep backoff
      backoff = [backoff * 2, 5.0].min
    end
  end

  def migrate!
    context = ActiveRecord::Base.connection_pool.migration_context
    known = context.migrations.map(&:version)
    applied = context.get_all_versions
    unknown = applied - known
    if unknown.any?
      raise MigrationStateError,
            "database has applied migrations missing from db/migrate: #{unknown.join(', ')} — refusing to start (nothing forced)"
    end

    pending = context.migrations.reject { |m| applied.include?(m.version) }
    if pending.empty?
      logger.info("schema up to date — no pending migrations (applied=#{applied.size})")
      return
    end

    logger.info("applying #{pending.size} pending migration(s): #{pending.map(&:name).join(', ')}")
    context.migrate # takes a Postgres advisory lock internally
    logger.info("migrations applied (version=#{context.current_version})")
  end
end
