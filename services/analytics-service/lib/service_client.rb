# frozen_string_literal: true

require "json"
require "net/http"
require "uri"

# Service-to-service JSON GETs (auth-service, tracking-service) carrying the internal token.
class ServiceClient
  class Error < StandardError; end

  def self.auth = new(ServiceConfig.calls.fetch("auth"))
  def self.tracking = new(ServiceConfig.calls.fetch("tracking"))

  def initialize(base_url, timeout: Integer(ServiceConfig.calls.fetch("timeoutSeconds", 5)))
    @base = base_url.to_s.chomp("/")
    @timeout = timeout
  end

  def get(path, params = {})
    uri = URI("#{@base}#{path}")
    uri.query = URI.encode_www_form(params) if params.any?
    req = Net::HTTP::Get.new(uri)
    req["X-Internal-Token"] = ServiceConfig.internal_token
    req["Accept"] = "application/json"
    res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", open_timeout: @timeout, read_timeout: @timeout) do |http|
      http.request(req)
    end
    raise Error, "#{uri.host}:#{uri.port}#{path} -> HTTP #{res.code}" unless res.is_a?(Net::HTTPSuccess)

    JSON.parse(res.body)
  rescue JSON::ParserError, SystemCallError, Net::OpenTimeout, Net::ReadTimeout, SocketError, IOError => e
    raise Error, "#{uri&.host}:#{uri&.port}#{path} unreachable: #{e.message}"
  end
end
