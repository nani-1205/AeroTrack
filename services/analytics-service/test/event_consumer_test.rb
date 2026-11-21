# frozen_string_literal: true

# Unit tests for stream-entry parsing (no Rails, Redis or Postgres needed):
#   ruby test/event_consumer_test.rb
require "bundler/setup"
require "minitest/autorun"
require "active_support"
require "active_support/core_ext/object/blank"
require_relative "../lib/event_consumer"

class EventConsumerTest < Minitest::Test
  STREAMS = { "auth" => "events:auth", "tracking" => "events:tracking", "group" => "analytics" }.freeze

  def consumer = EventConsumer.new(redis_options: {}, streams: STREAMS, logger: nil)

  def test_auth_row_maps_stream_fields
    row = consumer.send(:auth_row, "1795280000000-0",
                        { "type" => "user.login", "subjectType" => "user", "subjectId" => "abc", "at" => "2026-11-21T18:00:00Z" })
    assert_equal "1795280000000-0", row[:stream_id]
    assert_equal "user.login", row[:event_type]
    assert_equal "abc", row[:subject_id]
    assert_equal Time.utc(2026, 11, 21, 18), row[:occurred_at]
  end

  def test_auth_row_without_subject_keeps_nil_and_defaults_type
    row = consumer.send(:auth_row, "1-0", { "type" => "admin.login_failed", "subjectId" => "", "at" => "2026-11-21T18:00:00Z" })
    assert_nil row[:subject_id]
    assert_equal "user", row[:subject_type]
  end

  def test_invalid_entries_are_skipped
    assert_nil consumer.send(:auth_row, "1-0", {})
    assert_nil consumer.send(:tracking_row, "1-0", { "type" => "track.start", "airline" => "AIC" }) # no user
  end

  def test_tracking_row_parses_json_lists_and_caps_at_five
    ids = %w[a1 a2 a3 a4 a5 a6]
    row = consumer.send(:tracking_row, "2-0", {
                          "type" => "track.start", "userId" => "u1", "airline" => "aic",
                          "icao24s" => ids.to_json, "callsigns" => %w[AIC1 AIC2].to_json, "at" => "2026-11-21T18:30:00Z"
                        })
    assert_equal "AIC", row[:airline_icao]
    assert_equal 5, row[:flight_count]
    assert_equal %w[AIC1 AIC2], row[:callsigns]
  end

  def test_bad_timestamp_falls_back_to_stream_id_time
    row = consumer.send(:auth_row, "1795280000000-3", { "type" => "user.login", "at" => "not-a-time" })
    assert_equal Time.at(1_795_280_000).utc, row[:occurred_at]
  end

  def test_malformed_json_lists_become_empty
    row = consumer.send(:tracking_row, "3-0", { "userId" => "u1", "airline" => "BAW", "icao24s" => "{oops", "at" => "2026-11-21T18:30:00Z" })
    assert_equal [], row[:icao24s]
    assert_equal 0, row[:flight_count]
  end
end
