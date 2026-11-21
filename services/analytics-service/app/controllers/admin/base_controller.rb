module Admin
  # Everything under /admin is reached through the gateway's admin route only:
  # the internal token proves the gateway sent it, X-User-Role proves it verified an admin JWT.
  class BaseController < ApplicationController
    RANGES = {
      "24h" => { duration: 24.hours, unit: "hour" },
      "7d" => { duration: 7.days, unit: "day" },
      "30d" => { duration: 30.days, unit: "day" }
    }.freeze

    before_action :require_gateway_admin

    private

    def require_gateway_admin
      token = request.headers["X-Internal-Token"].to_s
      admin = request.headers["X-User-Role"] == "admin"
      return if admin && ActiveSupport::SecurityUtils.secure_compare(token, ServiceConfig.internal_token)

      render json: { error: "unauthorized", message: "admin access through the gateway required" }, status: :unauthorized
    end

    def range_key
      RANGES.key?(params[:range]) ? params[:range] : "24h"
    end

    def range = RANGES.fetch(range_key)

    # First bucket start (UTC, truncated to the bucket unit).
    def range_start
      t = Time.now.utc - range[:duration]
      range[:unit] == "hour" ? t.beginning_of_hour : t.beginning_of_day
    end

    def buckets
      step = range[:unit] == "hour" ? 1.hour : 1.day
      now = Time.now.utc
      last = range[:unit] == "hour" ? now.beginning_of_hour : now.beginning_of_day
      out = []
      t = range_start
      while t <= last
        out << t
        t += step
      end
      out
    end

    # Calls an upstream; logs and returns nil on failure so one dependency never blanks the page.
    def soft(label)
      yield
    rescue StandardError => e
      Rails.logger.warn("#{label} unavailable: #{e.message}")
      nil
    end

    # Display names keyed by Prometheus job, in a fixed order (chart colours follow the entity).
    SERVICES = [
      { job: "gateway", name: "Gateway", stack: "Node.js" },
      { job: "auth-service", name: "Auth", stack: "Go" },
      { job: "tracking-service", name: "Tracking", stack: "Rust" },
      { job: "analytics-service", name: "Analytics", stack: "Ruby" }
    ].freeze

    # Airline names for ICAO codes (cached: the catalogue rarely changes).
    def airline_names(codes)
      codes.uniq.index_with do |code|
        Rails.cache.fetch("airline-name/#{code}", expires_in: 1.hour) do
          soft("tracking airline #{code}") { ServiceClient.tracking.get("/airlines/#{code}")["name"] }
        end
      end
    end

    # User display info for ids (auth-service internal lookup).
    def users_by_id(ids)
      ids = ids.compact.uniq
      return {} if ids.empty?

      users = soft("auth users") { ServiceClient.auth.get("/internal/users", ids: ids.join(","))["users"] } || []
      users.index_by { |u| u["id"] }
    end
  end
end
