Rails.application.routes.draw do
  get "/health/live", to: "health#live"
  get "/health/ready", to: "health#ready"
  # GET /metrics is served by Prometheus::Middleware::Exporter.

  # Admin console API — the gateway maps /api/admin/* here (admin JWT required).
  namespace :admin do
    get "overview", to: "overview#show"
    get "activity", to: "activity#show"
    get "top", to: "top#show"
    get "users", to: "users#index"
    get "events", to: "events#index"
    get "performance", to: "performance#show"
  end
end
