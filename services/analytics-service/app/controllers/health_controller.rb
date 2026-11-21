class HealthController < ApplicationController
  def live
    render json: { status: "ok", service: "analytics" }
  end

  def ready
    checks = { postgres: check { ActiveRecord::Base.connection.select_value("SELECT 1") },
               redis: check { AnalyticsService.redis.ping } }
    status = checks.values.all?("ok") ? :ok : :service_unavailable
    render json: { service: "analytics", checks: checks }, status: status
  end

  private

  def check
    Timeout.timeout(2) { yield }
    "ok"
  rescue StandardError => e
    e.message
  end
end
