require Rails.root.join("lib/process_metrics").to_s

# Refresh process CPU/memory gauges just before Prometheus::Middleware::Exporter serves /metrics.
Rails.application.config.middleware.insert_before Prometheus::Middleware::Exporter, ProcessMetrics
