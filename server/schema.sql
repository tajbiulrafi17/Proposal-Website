-- Proposal site analytics schema

CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent    TEXT,
  viewport      JSONB,
  ended_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq         INT NOT NULL,
  event       TEXT NOT NULL,
  screen      TEXT,
  label       TEXT,
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at);
