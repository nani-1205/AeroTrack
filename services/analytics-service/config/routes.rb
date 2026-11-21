Rails.application.routes.draw do
  get "/health/live", to: "health#live"
  get "/health/ready", to: "health#ready"
  # GET /metrics is served by Prometheus::Middleware::Exporter.
end
