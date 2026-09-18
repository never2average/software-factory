/**
 * Exa web search client (https://exa.ai). Uses EXA_API_KEY. When the key is
 * absent, returns an empty, clearly-labeled result instead of throwing so the
 * rest of the agent keeps working.
 */
export interface ExaResult {
  title?: string;
  url: string;
  publishedDate?: string;
  author?: string;
  snippet?: string;
}

export async function searchExa(
  query: string,
  numResults: number,
): Promise<{ configured: boolean; results: ExaResult[]; message?: string }> {
  const key = process.env.EXA_API_KEY;
  if (!key) {
    return {
      configured: false,
      results: [],
      message: "EXA_API_KEY is not set. Add it to .env.local / Vercel env to enable web search.",
    };
  }

  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      query,
      numResults,
      type: "auto",
      contents: { text: { maxCharacters: 1200 } },
    }),
  });

  if (!res.ok) {
    return {
      configured: true,
      results: [],
      message: `Exa search failed: ${res.status} ${res.statusText}`,
    };
  }

  const data = (await res.json()) as {
    results?: Array<{
      title?: string;
      url: string;
      publishedDate?: string;
      author?: string;
      text?: string;
    }>;
  };
  return {
    configured: true,
    results: (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      publishedDate: r.publishedDate,
      author: r.author,
      snippet: r.text?.slice(0, 1000),
    })),
  };
}
