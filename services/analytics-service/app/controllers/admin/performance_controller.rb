module Admin
  # GET /admin/performance?range=1h|6h|24h — per-service health from Prometheus.
  class PerformanceController < BaseController
    PERF_RANGES = { "1h" => 1.hour, "6h" => 6.hours, "24h" => 24.hours }.freeze
    POINTS = 60

    # Go, Rust and Node expose http_requests_total{status}; Rails' Rack collector exposes
    # http_server_requests_total{code}. `or` merges both into one series per job.
    RPS = "sum by (job) (rate(http_requests_total[%<w>s])) or sum by (job) (rate(http_server_requests_total[%<w>s]))".freeze
    ERRORS = 'sum by (job) (rate(http_requests_total{status=~"5.."}[%<w>s])) or ' \
             'sum by (job) (rate(http_server_requests_total{code=~"5.."}[%<w>s]))'.freeze
    P95 = "histogram_quantile(0.95, sum by (job, le) (rate(http_request_duration_seconds_bucket[%<w>s]))) or " \
          "histogram_quantile(0.95, sum by (job, le) (rate(http_server_request_duration_seconds_bucket[%<w>s])))".freeze
    CPU = "sum by (job) (rate(process_cpu_seconds_total[%<w>s]))".freeze
    MEMORY = "sum by (job) (process_resident_memory_bytes)".freeze

    def show
      key = PERF_RANGES.key?(params[:range]) ? params[:range] : "1h"
      duration = PERF_RANGES.fetch(key)
      step = (duration / POINTS).to_i
      window = "#{[300, step * 2].max}s"
      prom = AnalyticsService.prometheus
      now = Time.now.utc

      current = {
        up: prom.vector("up"),
        rps: prom.vector(format(RPS, w: "5m")),
        errors: prom.vector(format(ERRORS, w: "5m")),
        p95: prom.vector(format(P95, w: "5m")),
        cpu: prom.vector(format(CPU, w: "5m")),
        memory: prom.vector(MEMORY)
      }
      rps_series = prom.series(format(RPS, w: window), start: now - duration, finish: now, step: step)
      p95_series = prom.series(format(P95, w: window), start: now - duration, finish: now, step: step)

      render json: {
        range: key, stepSeconds: step,
        services: SERVICES.map do |s|
          job = s[:job]
          rps = current[:rps][job]
          {
            **s,
            up: current[:up].key?(job) ? current[:up][job] == 1.0 : nil,
            requestsPerSecond: rps&.round(3),
            errorRate: rps&.positive? ? ((current[:errors][job] || 0) / rps).round(4) : (rps ? 0.0 : nil),
            p95Ms: current[:p95][job]&.then { |v| (v * 1000).round(1) },
            cpuPercent: current[:cpu][job]&.then { |v| (v * 100).round(1) },
            memoryMb: current[:memory][job]&.then { |v| (v / 1_048_576.0).round(1) }
          }
        end,
        series: {
          requestsPerSecond: SERVICES.to_h { |s| [s[:job], rps_series.fetch(s[:job], [])] },
          p95Ms: SERVICES.to_h { |s| [s[:job], p95_series.fetch(s[:job], []).map { |t, v| [t, v && (v * 1000).round(2)] }] }
        }
      }
    rescue PrometheusApi::Error => e
      Rails.logger.warn("performance unavailable: #{e.message}")
      render json: { error: "unavailable", message: "metrics backend (Prometheus) is unreachable" }, status: :service_unavailable
    end
  end
end
