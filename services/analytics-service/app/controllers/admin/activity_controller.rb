module Admin
  # GET /admin/activity?range=24h|7d|30d — usage over time, zero-filled per bucket (UTC).
  class ActivityController < BaseController
    def show
      unit = range[:unit]
      from = range_start
      trunc = Arel.sql("date_trunc('#{unit}', occurred_at AT TIME ZONE 'UTC')")

      auth = AuthEvent.since(from)
                      .where(event_type: [AuthEvent::USER_SIGNUP, AuthEvent::USER_LOGIN, AuthEvent::ADMIN_LOGIN_FAILED])
                      .group(trunc).group(:event_type).count
      tracking = TrackingEvent.since(from).group(trunc).count
      by_bucket = Hash.new { |h, k| h[k] = Hash.new(0) }
      auth.each { |(t, type), n| by_bucket[t.to_i][type] = n }
      tracking.each { |t, n| by_bucket[t.to_i]["track.start"] = n }

      points = buckets.map do |t|
        b = by_bucket[t.to_i]
        {
          t: t.iso8601,
          userLogins: b[AuthEvent::USER_LOGIN],
          signups: b[AuthEvent::USER_SIGNUP],
          trackingSessions: b["track.start"],
          failedAdminLogins: b[AuthEvent::ADMIN_LOGIN_FAILED]
        }
      end
      totals = %i[userLogins signups trackingSessions failedAdminLogins].index_with { |k| points.sum { |p| p[k] } }
      render json: { range: range_key, unit: unit, points: points, totals: totals }
    end
  end
end
