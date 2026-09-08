-- Operator-adjustable runtime overrides. Secrets and RPC URLs stay in .env.
CREATE TABLE IF NOT EXISTS telegram_runtime_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK(value_type IN ('boolean','number','integer')),
  actor TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
