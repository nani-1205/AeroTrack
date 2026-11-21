#!/bin/sh
# Runs once, when the Postgres volume is first initialised.
# Creates one login role + one schema per microservice (database-per-service, lite).
# Each service then owns and migrates ONLY its own schema at startup.
set -eu

create_service_role() {
  role="$1"
  password="$2"
  schema="$3"
  echo "aerotrack-init: creating role '${role}' with schema '${schema}'"
  psql -v ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v role="$role" -v password="$password" -v schema="$schema" -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE :"role" LOGIN PASSWORD :'password';
CREATE SCHEMA :"schema" AUTHORIZATION :"role";
ALTER ROLE :"role" SET search_path = :"schema";
GRANT CONNECT ON DATABASE :"db" TO :"role";
SQL
}

# Nobody connects or creates in public unless explicitly granted.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v db="$POSTGRES_DB" <<'SQL'
REVOKE CONNECT ON DATABASE :"db" FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL

create_service_role "$AUTH_DB_USER"      "$AUTH_DB_PASSWORD"      "$AUTH_DB_SCHEMA"
create_service_role "$TRACKING_DB_USER"  "$TRACKING_DB_PASSWORD"  "$TRACKING_DB_SCHEMA"
create_service_role "$ANALYTICS_DB_USER" "$ANALYTICS_DB_PASSWORD" "$ANALYTICS_DB_SCHEMA"
