module AnalyticsService
  def self.redis
    @redis ||= begin
      r = ServiceConfig.redis
      Redis.new(host: r.fetch("host"), port: Integer(r.fetch("port")), password: r.fetch("password"),
                db: Integer(r.fetch("db", 0)), connect_timeout: 2, read_timeout: 2)
    end
  end
end
