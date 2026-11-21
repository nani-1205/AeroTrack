# Forward-only. Never edit an applied migration — add a new one.
class CreateDailyStats < ActiveRecord::Migration[8.1]
  def change
    # One row per calendar day (UTC), aggregated from auth/tracking events.
    create_table :daily_stats, id: :date, primary_key: :day do |t|
      t.integer :signups, null: false, default: 0
      t.integer :user_logins, null: false, default: 0
      t.integer :admin_logins, null: false, default: 0
      t.integer :unique_active_users, null: false, default: 0
      t.integer :flight_views, null: false, default: 0
      t.timestamps
    end
  end
end
