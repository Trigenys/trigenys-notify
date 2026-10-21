-- Preserve every existing approval while allowing several groups per project.
CREATE TABLE notify_whatsapp_routes_v2 (
  project TEXT NOT NULL,
  session TEXT NOT NULL,
  group_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  approved_at TEXT,
  PRIMARY KEY(project,session,group_id),
  FOREIGN KEY(session,group_id) REFERENCES notify_whatsapp_groups(session,group_id)
);
INSERT INTO notify_whatsapp_routes_v2
  SELECT project,session,group_id,enabled,approved_at FROM notify_whatsapp_routes;
DROP TABLE notify_whatsapp_routes;
ALTER TABLE notify_whatsapp_routes_v2 RENAME TO notify_whatsapp_routes;
CREATE INDEX idx_notify_routes_group ON notify_whatsapp_routes(session,group_id,enabled);

CREATE TABLE notify_whatsapp_discovery (
  session TEXT PRIMARY KEY,
  last_synced_ms INTEGER NOT NULL
);

-- A frozen recipient list prevents retries from broadcasting old alerts to
-- newly approved groups. Receipts prevent resending to successful groups.
CREATE TABLE notify_whatsapp_events (
  project TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(project,event_id)
);
CREATE TABLE notify_whatsapp_receipts (
  project TEXT NOT NULL,
  event_id TEXT NOT NULL,
  session TEXT NOT NULL,
  group_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','sending','accepted')),
  claim_token TEXT NOT NULL,
  lease_until_ms INTEGER NOT NULL,
  PRIMARY KEY(project,event_id,session,group_id),
  FOREIGN KEY(project,event_id) REFERENCES notify_whatsapp_events(project,event_id)
);
