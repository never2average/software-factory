-- 0046_model_price_gpt_56_luna (mold_v0-248): a price for gpt-5.6-luna, so the gateway (which refuses a model with no
-- price since mold_v0-246) keeps routing it and meters it at its rate instead of refusing it.
-- OpenAI list price after its 2026-07-30 cut, as API aggregators report it (OpenRouter, Vercel AI Gateway, Requesty):
-- $0.20 input, $0.02 cached input, $1.20 output per million tokens. No long-context tier: the sources disagree on it.
-- Verify against the OpenAI invoice; an operator can change it with `npm run usage -- price`.
INSERT INTO model_prices (model, input_per_mtok, cached_input_per_mtok, output_per_mtok, source) VALUES
  ('gpt-5.6-luna', 0.20, 0.02, 1.20, 'OpenAI list price after the 2026-07-30 cut as API aggregators report it, 2026-11-06; verify on the OpenAI invoice')
ON CONFLICT (model) DO NOTHING;
