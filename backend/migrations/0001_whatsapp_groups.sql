-- Trigenys Notify Cloudflare D1 database migration.
-- Group discovery DOES NOT authorize sending. Routes require admin approval.
CREATE TABLE IF NOT EXISTS notify_whatsapp_groups (
  session TEXT NOT NULL,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'available' CHECK (state IN ('available','left')),
  last_seen_ms INTEGER NOT NULL,
  PRIMARY KEY(session,group_id)
);

CREATE TABLE IF NOT EXISTS notify_whatsapp_routes (
  project TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  group_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  approved_at TEXT,
  FOREIGN KEY (session,group_id)
    REFERENCES notify_whatsapp_groups(session,group_id)
);

CREATE INDEX IF NOT EXISTS idx_notify_groups_last_seen
  ON notify_whatsapp_groups(last_seen_ms DESC);
CREATE INDEX IF NOT EXISTS idx_notify_routes_group
  ON notify_whatsapp_routes(session,group_id,enabled);
