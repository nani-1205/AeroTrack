# frozen_string_literal: true

require "json"

# Loads the `analytics` section (plus `shared`) from the single services JSON file.
module ServiceConfig
  ENV_CONFIG_PATH = "AEROTRACK_CONFIG"
  DEFAULT_PATH = File.expand_path("../../../config/services.json", __dir__)
  PLACEHOLDER = "CHANGE_ME"

  REQUIRED = [
    %w[shared postgres host], %w[shared postgres database],
    %w[shared redis host], %w[shared redis password],
    %w[shared internalToken],
    %w[analytics listen], %w[analytics secretKeyBase],
    %w[analytics db schema], %w[analytics db user], %w[analytics db password],
    %w[analytics calls prometheus]
  ].freeze

  class Error < StandardError; end

  class << self
    def path
      File.expand_path(ENV.fetch(ENV_CONFIG_PATH, DEFAULT_PATH))
    end

    def data
      @data ||= load!
    end

    def env = data.fetch("env", "development")
    def shared = data.fetch("shared")
    def analytics = data.fetch("analytics")
    def postgres = shared.fetch("postgres")
    def redis = shared.fetch("redis")
    def db = analytics.fetch("db")

    def listen_host = analytics.fetch("listen").rpartition(":").first
    def listen_port = Integer(analytics.fetch("listen").rpartition(":").last)

    private

    def load!
      raw = File.read(path)
      parsed = JSON.parse(raw)
      validate!(parsed)
      parsed.freeze
    rescue Errno::ENOENT
      raise Error, "config not found at #{path} (set #{ENV_CONFIG_PATH} to override)"
    rescue JSON::ParserError => e
      raise Error, "parse config #{path}: #{e.message}"
    end

    def validate!(cfg)
      errors = REQUIRED.filter_map do |keys|
        value = cfg.dig(*keys)
        name = keys.join(".")
        if value.nil? || value.to_s.strip.empty? then "#{name} is required"
        elsif value == PLACEHOLDER then "#{name} is still #{PLACEHOLDER.inspect} — run `npm run setup`"
        end
      end
      raise Error, "invalid config #{path}: #{errors.join('; ')}" if errors.any?
    end
  end
end
