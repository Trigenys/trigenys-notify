-- Staff gestures relayed from approved WhatsApp groups (Xeption ADR-003, step 3).
-- Additive and idempotent: an existing database keeps working; until this migration runs the
-- relay still works, follow-up replies are simply not correlated and reminders are not sent.

-- Follow-up messages Notify posted in reply to an alert (key id only, never a phone number),
-- so that a reply quoting the follow-up ("reply 1 to 5") still reaches the same event.
CREATE TABLE IF NOT EXISTS notify_whatsapp_action_messages (
  session TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  project TEXT NOT NULL,
  event_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session,provider_message_id)
);
CREATE INDEX IF NOT EXISTS idx_notify_whatsapp_action_messages_expiry
  ON notify_whatsapp_action_messages(expires_at_ms);

-- At most one "link your number" reminder per author, per project and per day.
-- actor_fingerprint is the keyed HMAC already sent to the project, never the number.
CREATE TABLE IF NOT EXISTS notify_whatsapp_action_reminders (
  project TEXT NOT NULL,
  actor_fingerprint TEXT NOT NULL,
  day TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (project,actor_fingerprint,day)
);
CREATE INDEX IF NOT EXISTS idx_notify_whatsapp_action_reminders_expiry
  ON notify_whatsapp_action_reminders(expires_at_ms);
