/**
 * Thin client for Granola meeting notes.
 *
 * Granola has no first-party MCP/OpenAPI connector, so we call its API directly
 * with a token from `GRANOLA_API_KEY`. When the key is absent (e.g. local dev
 * before secrets are wired), the search returns an empty, clearly-labeled result
 * instead of throwing, so the rest of the agent keeps working.
 */
export interface GranolaNote {
  id: string;
  title: string;
  date: string;
  summary: string;
  url?: string;
}

const GRANOLA_BASE = process.env.GRANOLA_API_URL ?? "https://api.granola.ai/v1";

export async function searchGranolaNotes(
  query: string,
  limit = 5,
): Promise<{ configured: boolean; notes: GranolaNote[]; message?: string }> {
  const key = process.env.GRANOLA_API_KEY;
  if (!key) {
    return {
      configured: false,
      notes: [],
      message:
        "GRANOLA_API_KEY is not set. Add it to .env.local to enable Granola meeting-note search.",
    };
  }

  const res = await fetch(`${GRANOLA_BASE}/notes/search`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, limit }),
  });

  if (!res.ok) {
    return {
      configured: true,
      notes: [],
      message: `Granola search failed: ${res.status} ${res.statusText}`,
    };
  }

  const data = (await res.json()) as { notes?: GranolaNote[] };
  return { configured: true, notes: data.notes ?? [] };
}
