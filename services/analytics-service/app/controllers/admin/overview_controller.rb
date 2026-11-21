module Admin
  # GET /admin/overview — headline numbers for the console's first screen.
  class OverviewController < BaseController
    def show
      today = Time.now.utc.beginning_of_day
      auth = soft("auth summary") { ServiceClient.auth.get("/internal/users/summary") }
      airlines = soft("tracking airlines") { ServiceClient.tracking.get("/airlines", limit: 500)["airlines"] }
      prom = AnalyticsService.prometheus
      viewers = soft("prometheus viewers") { prom.vector("sum(gateway_ws_connections)", label: "__none__").values.first }
      up = soft("prometheus up") { prom.vector("up") } || {}

      auth_today = AuthEvent.since(today).group(:event_type).count
      render json: {
        users: auth && auth["users"].merge("signedInNow" => auth["signedInUserSessions"]),
        admins: auth && { signedInNow: auth["signedInAdminSessions"] },
        tracking: {
          aircraftNow: airlines&.sum { |a| a["activeFlights"].to_i },
          airlinesNow: airlines&.size,
          liveViewers: viewers&.round,
          sessionsToday: TrackingEvent.since(today).count
        },
        today: {
          userLogins: auth_today.fetch(AuthEvent::USER_LOGIN, 0),
          signups: auth_today.fetch(AuthEvent::USER_SIGNUP, 0),
          failedAdminLogins: auth_today.fetch(AuthEvent::ADMIN_LOGIN_FAILED, 0)
        },
        services: SERVICES.map { |s| s.merge(up: up.key?(s[:job]) ? up[s[:job]] == 1.0 : nil) },
        generatedAt: Time.now.utc.iso8601
      }
    end
  end
end
