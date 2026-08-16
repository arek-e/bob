CREATE TABLE IF NOT EXISTS managed_channel_routes (
  id text PRIMARY KEY,
  sender_lookup text NOT NULL UNIQUE,
  provisioning_subject text NOT NULL UNIQUE,
  instance_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS staged_channel_events (
  id text PRIMARY KEY,
  route_id text NOT NULL REFERENCES managed_channel_routes(id),
  provider_event_key text NOT NULL UNIQUE,
  payload_ciphertext text NOT NULL,
  payload_iv text NOT NULL,
  payload_key_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('staged', 'processing', 'delivered')),
  lease_until text,
  attempts integer NOT NULL DEFAULT 0,
  last_failure text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  delivered_at text
);

CREATE INDEX IF NOT EXISTS staged_channel_events_pending_idx
  ON staged_channel_events (state, lease_until, created_at);
