ENV["BUNDLE_GEMFILE"] ||= File.expand_path("../Gemfile", __dir__)

# Use the app's own Bundler settings (vendored gem path, deployment mode) when present, even
# if the environment points BUNDLE_APP_CONFIG elsewhere (e.g. the official ruby Docker image).
app_bundle_config = File.expand_path("../.bundle", __dir__)
ENV["BUNDLE_APP_CONFIG"] = app_bundle_config if File.exist?(File.join(app_bundle_config, "config"))

require "bundler/setup"
