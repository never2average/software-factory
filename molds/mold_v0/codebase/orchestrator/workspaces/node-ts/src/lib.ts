export interface Summary {
  count: number;
  min: number;
  max: number;
  mean: number;
}

export function summarize(values: number[]): Summary {
  const count = values.length;
  const sum = values.reduce((a, b) => a + b, 0);
  return { count, min: Math.min(...values), max: Math.max(...values), mean: count ? sum / count : 0 };
}

export function formatReport(s: Summary): string {
  return `count=${s.count} min=${s.min} max=${s.max} mean=${s.mean.toFixed(2)}`;
}
