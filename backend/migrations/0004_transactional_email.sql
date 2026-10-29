-- Technical receipts only. Never persist recipients, credentials, HTML, OTPs or magic links.
CREATE TABLE IF NOT EXISTS notify_email_deliveries (
  project TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('sending','accepted','retry','uncertain')),
  claim_token TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 3),
  expires_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(project,event_id)
);
CREATE INDEX IF NOT EXISTS idx_notify_email_expiration ON notify_email_deliveries(expires_at_ms);
