# frozen_string_literal: true

require "prometheus/client"

# Exposes process_cpu_seconds_total and process_resident_memory_bytes (the names the other
# services use) by refreshing two gauges right before each /metrics scrape.
class ProcessMetrics
  PAGE_SIZE = 4096

  def initialize(app, registry: Prometheus::Client.registry)
    @app = app
    @cpu = registry.gauge(:process_cpu_seconds_total, docstring: "Total user and system CPU time spent in seconds.")
    @memory = registry.gauge(:process_resident_memory_bytes, docstring: "Resident memory size in bytes.")
  end

  def call(env)
    refresh if env["PATH_INFO"] == "/metrics"
    @app.call(env)
  end

  private

  def refresh
    # Process.times is portable; CLOCK_PROCESS_CPUTIME_ID returns garbage on Windows.
    t = Process.times
    @cpu.set(t.utime + t.stime)
    rss = self.class.resident_memory_bytes
    @memory.set(rss) if rss
  rescue StandardError, LoadError
    nil # metrics must never break the scrape
  end

  def self.resident_memory_bytes
    if File.readable?("/proc/self/statm")
      File.read("/proc/self/statm").split[1].to_i * PAGE_SIZE
    elsif Gem.win_platform?
      windows_working_set
    end
  end

  # PROCESS_MEMORY_COUNTERS.WorkingSetSize via psapi!GetProcessMemoryInfo (x64 layout).
  def self.windows_working_set
    require "fiddle"
    @get_process ||= Fiddle::Function.new(Fiddle.dlopen("kernel32.dll")["GetCurrentProcess"], [], Fiddle::TYPE_VOIDP)
    @get_memory ||= Fiddle::Function.new(Fiddle.dlopen("psapi.dll")["GetProcessMemoryInfo"],
                                         [Fiddle::TYPE_VOIDP, Fiddle::TYPE_VOIDP, Fiddle::TYPE_INT], Fiddle::TYPE_INT)
    buf = Fiddle::Pointer.malloc(72, Fiddle::RUBY_FREE)
    buf[0, 4] = [72].pack("L")
    return nil if @get_memory.call(@get_process.call, buf, 72).zero?

    buf[16, 8].unpack1("Q")
  end
end
