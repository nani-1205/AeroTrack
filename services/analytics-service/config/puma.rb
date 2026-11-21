require_relative "service_config"

bind "tcp://#{ServiceConfig.listen_host}:#{ServiceConfig.listen_port}"
threads 5, 5
# Single process: workers (fork) are unsupported on Windows and keep Prometheus metrics in-process.
workers 0
