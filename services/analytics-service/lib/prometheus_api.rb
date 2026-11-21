# frozen_string_literal: true

require "json"
require "net/http"
require "uri"

# Minimal Prometheus HTTP API client (instant + range queries).
class PrometheusApi
  class Error < StandardError; end

  def initialize(base_url, timeout: 5)
    @base = base_url.to_s.chomp("/")
    @timeout = timeout
  end

  # => { "job" => value } for a vector result, grouped by `label`.
  def vector(expr, label: "job")
    query(expr).each_with_object({}) do |row, out|
      value = row.dig("value", 1).to_f
      out[row.dig("metric", label).to_s] = value.finite? ? value : nil
    end
  end

  # => { "job" => [[unix_seconds, value], ...] }
  def series(expr, start:, finish:, step:, label: "job")
    get("/api/v1/query_range", query: expr, start: start.to_i, end: finish.to_i, step: step.to_i)
      .each_with_object({}) do |row, out|
        out[row.dig("metric", label).to_s] = row["values"].map do |ts, v|
          f = v.to_f
          [ts.to_i, f.finite? ? f : nil]
        end
      end
  end

  def query(expr) = get("/api/v1/query", query: expr)

  private

  def get(path, params)
    uri = URI("#{@base}#{path}")
    uri.query = URI.encode_www_form(params)
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", open_timeout: @timeout, read_timeout: @timeout) do |http|
      http.get(uri.request_uri)
    end
    body = JSON.parse(res.body)
    raise Error, "prometheus #{res.code}: #{body['error']}" unless res.is_a?(Net::HTTPSuccess) && body["status"] == "success"

    body.dig("data", "result") || []
  rescue JSON::ParserError, SystemCallError, Net::OpenTimeout, Net::ReadTimeout, SocketError, IOError => e
    raise Error, "prometheus unreachable: #{e.message}"
  end
end
