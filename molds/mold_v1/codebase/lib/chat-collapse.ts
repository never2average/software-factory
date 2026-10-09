/**
 * When is a sent message long enough to fold?
 *
 * Judged on RENDERED height, not characters: a 200-character table is tall and
 * a 600-character sentence on a wide screen is three lines, and only the height
 * is what pushes the conversation off screen.
 *
 * The slack matters as much as the threshold. Folding a seven-line message to
 * six puts a button where one line of text would have been — the fold costs
 * more room than it saves, and "Show more" reveals almost nothing. So a message
 * folds only when at least `slackLines` lines would be hidden.
 */
export function foldHeight(lineHeightPx: number, lines: number): number {
  return Math.round(lineHeightPx * lines);
}

export function exceedsFold(
  contentHeightPx: number,
  lineHeightPx: number,
  lines: number,
  slackLines = 2,
): boolean {
  if (!(contentHeightPx > 0) || !(lineHeightPx > 0) || !(lines > 0)) return false;
  return contentHeightPx > lineHeightPx * (lines + slackLines);
}

/** `line-height` as pixels; "normal" and anything unparseable fall back to 1.5 × font size. */
export function lineHeightPx(lineHeight: string, fontSize: string): number {
  const lh = Number.parseFloat(lineHeight);
  if (Number.isFinite(lh) && lh > 0 && /px$/.test(lineHeight.trim())) return lh;
  const fs = Number.parseFloat(fontSize);
  return (Number.isFinite(fs) && fs > 0 ? fs : 14) * 1.5;
}
