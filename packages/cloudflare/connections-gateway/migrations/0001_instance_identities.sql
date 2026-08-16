CREATE TABLE IF NOT EXISTS connection_gateway_callers (
  common_name text PRIMARY KEY,
  instance_id text NOT NULL UNIQUE,
  created_at text NOT NULL,
  revoked_at text
);

CREATE INDEX IF NOT EXISTS connection_gateway_callers_active_idx
  ON connection_gateway_callers (instance_id)
  WHERE revoked_at IS NULL;
