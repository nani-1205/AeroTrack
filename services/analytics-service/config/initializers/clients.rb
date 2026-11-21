require Rails.root.join("lib/prometheus_api").to_s
require Rails.root.join("lib/service_client").to_s
require Rails.root.join("lib/event_consumer").to_s

module AnalyticsService
  def self.prometheus
    @prometheus ||= PrometheusApi.new(ServiceConfig.calls.fetch("prometheus"),
                                      timeout: Integer(ServiceConfig.calls.fetch("timeoutSeconds", 5)))
  end

  def self.redis_options
    r = ServiceConfig.redis
    { host: r.fetch("host"), port: Integer(r.fetch("port")), password: r.fetch("password"), db: Integer(r.fetch("db", 0)) }
  end
end
