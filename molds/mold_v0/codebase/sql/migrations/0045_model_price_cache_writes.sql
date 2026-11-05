-- Cache writes priced apart, and the Haiku models (mold_v0-246; src/usage.ts priceTokens, src/gateway.ts).
--
-- A model provider bills a prompt-cache write above the plain input price (Anthropic: 1.25x for a 5-minute write, 2x
-- for a 1-hour one), and its usage fields report the writes apart (cache_creation_input_tokens, split by
-- cache_creation.ephemeral_5m/1h_input_tokens). The gateway priced them as plain input, so a cache-heavy agent session
-- was metered about 18% low and a budget kept by the gateway's meter alone let it spend past its cap. Each price row
-- may now name its own write prices; empty, the provider's premium on the input price applies (the code's arithmetic,
-- so no row needs one today). The day's usage keeps how many of its input tokens were cache writes.
--
-- The Haiku models had no row, so a request to one was metered at $0 and no budget held; the gateway now refuses a
-- model with no price, and these two are priced: claude-haiku-5-5 (current) and claude-haiku-4-5 (what Claude Code
-- falls back to on a cloud where the current one is not offered). Existing rows are left as they are, and an operator's
-- own row for either model is kept (ON CONFLICT DO NOTHING). Earlier usage is not repriced: its cache writes were not
-- counted apart, so its figures stay what they were.
ALTER TABLE model_prices ADD COLUMN IF NOT EXISTS cache_write_per_mtok NUMERIC(10, 4);     -- 5-minute writes; empty: 1.25x input
ALTER TABLE model_prices ADD COLUMN IF NOT EXISTS cache_write_1h_per_mtok NUMERIC(10, 4);  -- 1-hour writes; empty: 2x input
ALTER TABLE gateway_model_usage ADD COLUMN IF NOT EXISTS cache_write_tokens BIGINT NOT NULL DEFAULT 0;  -- of input_tokens

INSERT INTO model_prices (model, input_per_mtok, cached_input_per_mtok, output_per_mtok, source) VALUES
  ('claude-haiku-5-5', 0.10, 0.01, 0.50, 'Anthropic list price as Claude Code 2.1.318 lists it (haiku_55), 2026-11-05; Vertex global billed by Google, verify on the GCP invoice'),
  ('claude-haiku-4-5', 1.00, 0.10, 5.00, 'Anthropic list price as Claude Code 2.1.318 lists it (haiku_45), 2026-11-05; Vertex global billed by Google, verify on the GCP invoice')
ON CONFLICT (model) DO NOTHING;
