/**
 * Dependency-free on purpose: dashboard.tsx (client) imports this, and importing it from dashboard-spec.ts put all of
 * zod into every page's first-load JavaScript for one string scan.
 */

/**
 * Extract the first balanced JSON object from a string, ignoring anything
 * before the opening brace or after the matching close. Makes spec parsing
 * robust to the model emitting trailing chatter (e.g. a stray "[blocked]" note)
 * or a prose preamble despite being told not to — which otherwise makes
 * `JSON.parse` throw and blanks the whole dashboard. String-aware so braces
 * inside string values don't confuse the depth count.
 */
export function extractLeadingJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
