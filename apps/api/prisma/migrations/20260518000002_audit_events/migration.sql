CREATE TABLE IF NOT EXISTS audit_events (
  id           TEXT        NOT NULL PRIMARY KEY,
  "userId"     TEXT        REFERENCES users(id) ON DELETE SET NULL,
  type         TEXT        NOT NULL,
  action       TEXT        NOT NULL,
  "targetType" TEXT,
  "targetId"   TEXT,
  ip           TEXT,
  "userAgent"  TEXT,
  metadata     JSONB,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "audit_events_userId_createdAt_idx"
  ON audit_events("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "audit_events_type_createdAt_idx"
  ON audit_events(type, "createdAt");
