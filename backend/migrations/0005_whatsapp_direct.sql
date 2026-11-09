-- Technical receipts for individual WhatsApp deliveries. Never persist phone numbers,
-- message text, links or keys: recipient_hash is a keyed HMAC used only for rate limits.
CREATE TABLE IF NOT EXISTS notify_whatsapp_direct_deliveries (
  project TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  recipient_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('sending','accepted','retry','rejected','uncertain')),
  claim_token TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 3),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(project,event_id)
);
CREATE INDEX IF NOT EXISTS idx_notify_whatsapp_direct_expiration ON notify_whatsapp_direct_deliveries(expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_notify_whatsapp_direct_project_window ON notify_whatsapp_direct_deliveries(project,created_at_ms);
CREATE INDEX IF NOT EXISTS idx_notify_whatsapp_direct_recipient_window ON notify_whatsapp_direct_deliveries(project,recipient_hash,created_at_ms);
