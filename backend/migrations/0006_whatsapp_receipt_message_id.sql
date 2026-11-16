-- Provider message key of each accepted group delivery (WAHA `key.id`, never a phone number).
-- Lets a later signed reaction/reply webhook find the event it refers to (Xeption ADR-003).
-- Nullable: receipts written before this migration, and providers that return no id, stay valid.
ALTER TABLE notify_whatsapp_receipts ADD COLUMN provider_message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_notify_whatsapp_receipts_message
  ON notify_whatsapp_receipts(session,provider_message_id) WHERE provider_message_id IS NOT NULL;
