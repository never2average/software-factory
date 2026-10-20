/**
 * Customer-supplied text (personas, tasks, product descriptions) placed inside our LLM prompts is data, never
 * instructions (docs/security.md, prompt injection). Before it goes between our tags:
 *  - control, bidi and zero-width characters are removed (they can hide text from a reviewer),
 *  - "<" becomes "＜" (U+FF1C), so the text can never close our tag and start "new instructions",
 *  - it is clipped to a length limit.
 * Models read the full-width bracket fine, so the meaning of ordinary text is unchanged.
 */
export function asData(text: unknown, max: number): string {
  const t = String(text ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/</g, "＜");
  return t.length > max ? t.slice(0, max) + "…" : t;
}
