# Forward-only. Never edit an applied migration — add a new one.
# Raw usage events consumed from the Redis streams (events:auth, events:tracking).
# `stream_id` is the Redis stream entry id: the unique key that makes ingestion idempotent.
class CreateEvents < ActiveRecord::Migration[8.1]
  def change
    create_table :auth_events do |t|
      t.string :stream_id, null: false
      t.string :event_type, null: false      # user.signup, user.login, admin.login_failed, …
      t.string :subject_type, null: false    # user | admin
      t.string :subject_id                   # uuid; empty for unknown usernames
      t.timestamptz :occurred_at, null: false
      t.timestamptz :created_at, null: false, default: -> { "now()" }
    end
    add_index :auth_events, :stream_id, unique: true
    add_index :auth_events, [:event_type, :occurred_at]
    add_index :auth_events, :occurred_at

    create_table :tracking_events do |t|
      t.string :stream_id, null: false
      t.string :event_type, null: false      # track.start
      t.string :user_id, null: false
      t.string :airline_icao, null: false
      t.string :icao24s, array: true, null: false, default: []
      t.string :callsigns, array: true, null: false, default: []
      t.integer :flight_count, null: false, default: 0
      t.timestamptz :occurred_at, null: false
      t.timestamptz :created_at, null: false, default: -> { "now()" }
    end
    add_index :tracking_events, :stream_id, unique: true
    add_index :tracking_events, :occurred_at
    add_index :tracking_events, [:airline_icao, :occurred_at]
    add_index :tracking_events, [:user_id, :occurred_at]
  end
end
