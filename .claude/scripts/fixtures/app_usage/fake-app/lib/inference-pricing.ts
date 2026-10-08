// Fixture price table for app_usage.py --self-test: $1 per million input tokens, $2 per million output, one model.
export function estimateCostUsd(model: string | null, t: { inputTokens?: number; outputTokens?: number }): number | null {
  if (model !== "m1") return null;
  return ((t.inputTokens ?? 0) * 1 + (t.outputTokens ?? 0) * 2) / 1_000_000;
}
