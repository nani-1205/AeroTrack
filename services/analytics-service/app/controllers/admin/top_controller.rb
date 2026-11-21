module Admin
  # GET /admin/top?range=… — what people track most, and who tracks most.
  class TopController < BaseController
    def show
      from = range_start
      scope = TrackingEvent.since(from)

      airline_rows = scope.group(:airline_icao)
                          .order(Arel.sql("count(*) DESC"))
                          .limit(8)
                          .pluck(:airline_icao, Arel.sql("count(*)"), Arel.sql("sum(flight_count)"))
      names = airline_names(airline_rows.map(&:first))

      flight_rows = TrackingEvent.connection.select_rows(TrackingEvent.sanitize_sql([<<~SQL, from]))
        SELECT c AS callsign, airline_icao, count(*) AS sessions
        FROM tracking_events, unnest(callsigns) AS c
        WHERE occurred_at >= ?
        GROUP BY c, airline_icao
        ORDER BY sessions DESC, c
        LIMIT 10
      SQL

      user_rows = scope.group(:user_id).order(Arel.sql("count(*) DESC")).limit(5).pluck(:user_id, Arel.sql("count(*)"))
      users = users_by_id(user_rows.map(&:first))

      render json: {
        range: range_key,
        airlines: airline_rows.map { |icao, sessions, flights| { icao: icao, name: names[icao] || icao, sessions: sessions, flights: flights.to_i } },
        flights: flight_rows.map { |callsign, icao, sessions| { callsign: callsign, airlineIcao: icao, sessions: sessions.to_i } },
        users: user_rows.map do |id, sessions|
          u = users[id] || {}
          { id: id, login: u["login"], name: u["name"], avatarUrl: u["avatarUrl"], sessions: sessions }
        end
      }
    end
  end
end
