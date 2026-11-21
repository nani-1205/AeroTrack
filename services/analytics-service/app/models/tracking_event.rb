class TrackingEvent < ApplicationRecord
  scope :since, ->(time) { where(occurred_at: time..) }
end
