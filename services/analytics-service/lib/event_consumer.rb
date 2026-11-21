# frozen_string_literal: true

require "json"
require "socket"
require "time"

# Consumes usage events from Redis streams into Postgres.
#
#   events:auth      (auth-service)  type, subjectType, subjectId, at
#   events:tracking  (gateway)       type, userId, airline, icao24s (JSON), callsigns (JSON), at
#
# A consumer group gives at-least-once delivery; the unique `stream_id` column makes inserts
# idempotent, so a redelivered entry is simply skipped. The group starts at id 0, so history
# already in the streams is back-filled on first start.
class EventConsumer
  def initialize(redis_options:, streams:, logger:)
    @redis_options = redis_options
    @auth_stream = streams.fetch("auth")
    @tracking_stream = streams.fetch("tracking")
    @group = streams.fetch("group")
    @batch = Integer(streams.fetch("batchSize", 500))
    @block_ms = Integer(streams.fetch("blockMs", 5000))
    # Stable per host, so entries left pending by a crash are re-read after restart.
    @consumer = "analytics-#{Socket.gethostname}"
    @logger = logger
    @stopped = false
  end

  def start
    @thread = Thread.new do
      Thread.current.name = "event-consumer"
      run
    end
    self
  end

  def stop
    @stopped = true
    @thread&.join(@block_ms / 1000.0 + 1)
  end

  private

  def streams = [@auth_stream, @tracking_stream]

  def redis
    # Dedicated connection: XREADGROUP BLOCK holds it, so it must outlive the block timeout.
    @redis ||= Redis.new(**@redis_options, read_timeout: (@block_ms / 1000.0) + 5)
  end

  def run
    ensure_groups
    drain_pending
    until @stopped
      begin
        consume(">")
      rescue StandardError => e
        @logger.warn("event consumer: #{e.class}: #{e.message}")
        @redis = nil
        sleep 2
      end
    end
  end

  def ensure_groups
    streams.each do |stream|
      redis.xgroup(:create, stream, @group, "0", mkstream: true)
      @logger.info("event consumer: created group #{@group} on #{stream}")
    rescue Redis::CommandError => e
      raise unless e.message.include?("BUSYGROUP")
    end
  rescue StandardError => e
    @logger.warn("event consumer: cannot create groups (#{e.message}); retrying")
    sleep 2
    retry unless @stopped
  end

  # Entries delivered to this consumer but never acknowledged (e.g. crash mid-batch).
  def drain_pending
    loop do
      break if @stopped || consume("0", block: false).zero?
    end
  rescue StandardError => e
    @logger.warn("event consumer: draining pending failed: #{e.message}")
  end

  # Returns the number of entries processed.
  def consume(id, block: true)
    result = redis.xreadgroup(@group, @consumer, streams, [id] * streams.size, count: @batch, block: block ? @block_ms : nil)
    return 0 if result.nil? || result.empty?

    processed = 0
    result.each do |stream, entries|
      next if entries.empty?

      Rails.application.executor.wrap { store(stream, entries) }
      redis.xack(stream, @group, entries.map(&:first))
      processed += entries.size
    end
    processed
  end

  def store(stream, entries)
    if stream == @auth_stream
      rows = entries.filter_map { |id, f| auth_row(id, f) }
      AuthEvent.insert_all(rows, unique_by: :stream_id) if rows.any?
    else
      rows = entries.filter_map { |id, f| tracking_row(id, f) }
      TrackingEvent.insert_all(rows, unique_by: :stream_id) if rows.any?
    end
  end

  def auth_row(id, fields)
    return nil if fields.nil? || fields["type"].to_s.empty?

    {
      stream_id: id,
      event_type: fields["type"],
      subject_type: fields["subjectType"].presence || "user",
      subject_id: fields["subjectId"].presence,
      occurred_at: parse_time(fields["at"], id)
    }
  end

  def tracking_row(id, fields)
    return nil if fields.nil? || fields["userId"].to_s.empty? || fields["airline"].to_s.empty?

    icao24s = parse_list(fields["icao24s"])
    {
      stream_id: id,
      event_type: fields["type"].presence || "track.start",
      user_id: fields["userId"],
      airline_icao: fields["airline"].upcase,
      icao24s: icao24s,
      callsigns: parse_list(fields["callsigns"]),
      flight_count: icao24s.size,
      occurred_at: parse_time(fields["at"], id)
    }
  end

  def parse_list(raw)
    Array(JSON.parse(raw.to_s)).map(&:to_s).first(5)
  rescue JSON::ParserError
    []
  end

  # Falls back to the stream id's millisecond timestamp.
  def parse_time(raw, id)
    Time.iso8601(raw.to_s)
  rescue ArgumentError
    Time.at(id.to_s.split("-").first.to_i / 1000.0).utc
  end
end
