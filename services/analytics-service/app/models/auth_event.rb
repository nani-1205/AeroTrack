class AuthEvent < ApplicationRecord
  USER_SIGNUP = "user.signup"
  USER_LOGIN = "user.login"
  ADMIN_LOGIN_FAILED = "admin.login_failed"

  scope :since, ->(time) { where(occurred_at: time..) }
end
