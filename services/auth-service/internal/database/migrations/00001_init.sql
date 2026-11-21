-- Forward-only migration. Never edit an applied migration; add a new file instead.
-- +goose Up

-- GitHub SSO users of the user portal.
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT uuidv7(),
    github_id     BIGINT      NOT NULL UNIQUE,
    login         TEXT        NOT NULL,
    name          TEXT,
    email         TEXT,
    avatar_url    TEXT,
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);

-- Admin portal accounts: username + password (argon2id), separate from GitHub users.
CREATE TABLE admins (
    id                   UUID PRIMARY KEY DEFAULT uuidv7(),
    username             TEXT        NOT NULL UNIQUE,
    password_hash        TEXT        NOT NULL,
    must_change_password BOOLEAN     NOT NULL DEFAULT TRUE,
    failed_attempts      INT         NOT NULL DEFAULT 0,
    locked_until         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at        TIMESTAMPTZ
);

-- Audit trail of every login attempt (feeds admin analytics).
CREATE TABLE login_events (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subject_type TEXT        NOT NULL CHECK (subject_type IN ('user', 'admin')),
    subject_id   UUID,
    success      BOOLEAN     NOT NULL,
    reason       TEXT,
    ip           INET,
    user_agent   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX login_events_created_at_idx ON login_events (created_at);
CREATE INDEX login_events_subject_idx ON login_events (subject_type, subject_id);
