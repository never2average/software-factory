// Fixture price table for app_usage.py --self-test: $1 per million input tokens, $2 per million output, one model.
export function estimateCostUsd(model: string | null, t: { inputTokens?: number; outputTokens?: number }): number | null {
  if (model !== "m1") return null;
  return ((t.inputTokens ?? 0) * 1 + (t.outputTokens ?? 0) * 2) / 1_000_000;
}
// Speech to text: $0.01 per audio minute, one model ("a1"); any other is unpriced (null).
export function estimateAudioCostUsd(model: string | null, audioMs: number | null): number | null {
  if (model !== "a1") return null;
  return Math.round((((audioMs ?? 0) / 60_000) * 0.01) * 1_000_000) / 1_000_000;
}
