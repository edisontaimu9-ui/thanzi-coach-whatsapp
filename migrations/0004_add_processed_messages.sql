-- Dedup table for inbound WhatsApp webhook deliveries. Meta redelivers a
-- webhook on any non-200 response or slow reply, so the same message.id
-- (wamid) can arrive more than once for a single real user action.
-- handleIncomingMessage checks/inserts here before doing any work, so a
-- repeat delivery is dropped instead of producing a duplicate reply.
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL
);

-- No automatic cleanup of old rows yet — table will grow unbounded over
-- time. Fine at current volume; revisit (e.g. a cron that prunes rows
-- older than a few days) if this ever becomes a real dataset.
CREATE INDEX IF NOT EXISTS idx_processed_messages_ts ON processed_messages (ts);
