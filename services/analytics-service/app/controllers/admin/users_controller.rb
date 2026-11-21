module Admin
  # GET /admin/users?search=&limit=&offset= — user directory with tracking activity.
  class UsersController < BaseController
    def index
      limit = params.fetch(:limit, 25).to_i.clamp(1, 100)
      offset = [params.fetch(:offset, 0).to_i, 0].max
      result = ServiceClient.auth.get("/internal/users", { search: params[:search].to_s.strip.first(100), limit: limit, offset: offset })
      users = result["users"]
      ids = users.map { |u| u["id"] }

      sessions = TrackingEvent.where(user_id: ids).group(:user_id).count
      last_tracked = TrackingEvent.where(user_id: ids).group(:user_id).maximum(:occurred_at)
      render json: {
        total: result["total"], limit: limit, offset: offset,
        users: users.map do |u|
          u.merge("trackingSessions" => sessions.fetch(u["id"], 0), "lastTrackedAt" => last_tracked[u["id"]]&.utc&.iso8601)
        end
      }
    rescue ServiceClient::Error => e
      Rails.logger.warn("users directory unavailable: #{e.message}")
      render json: { error: "unavailable", message: "user directory temporarily unavailable" }, status: :service_unavailable
    end
  end
end
