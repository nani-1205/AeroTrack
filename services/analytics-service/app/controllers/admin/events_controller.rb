module Admin
  # GET /admin/events?limit=20 — recent sign-ins, sign-ups, failures and tracking sessions.
  class EventsController < BaseController
    def index
      limit = params.fetch(:limit, 20).to_i.clamp(1, 100)
      auth = AuthEvent.order(occurred_at: :desc).limit(limit).map do |e|
        { type: e.event_type, at: e.occurred_at.utc.iso8601, subjectType: e.subject_type, subjectId: e.subject_id }
      end
      tracking = TrackingEvent.order(occurred_at: :desc).limit(limit).map do |e|
        { type: e.event_type, at: e.occurred_at.utc.iso8601, subjectType: "user", subjectId: e.user_id,
          airlineIcao: e.airline_icao, callsigns: e.callsigns }
      end
      events = (auth + tracking).sort_by { |e| e[:at] }.reverse.first(limit)
      users = users_by_id(events.select { |e| e[:subjectType] == "user" }.map { |e| e[:subjectId] })
      render json: {
        events: events.map do |e|
          u = users[e[:subjectId]]
          e.merge(user: u && { login: u["login"], name: u["name"], avatarUrl: u["avatarUrl"] })
        end
      }
    end
  end
end
