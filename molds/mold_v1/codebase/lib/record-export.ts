/**
 * A record's export, as a person reads it: the TODO / deployment / implementation detail panel's "Copy as JSON" and
 * "Copy as Markdown". The bundle comes from GET /api/ops/export, which stays RAW (stored keys, stored values) for any
 * program that reads it; what is copied for a person has its keys and its code values in the profile's words
 * (lib/ui-keys.ts: `containerType: deployment` -> `containerType: coverage report`, blockerOwner `Customer` -> its
 * label), the profile's own custom fields and every piece of data verbatim. Byte-identical to the former output
 * under the default profile.
 */
import { humanizeKey, jsonForPeople, speakKeys, speakValues } from "./ui-keys.ts";

export type ExportBundle = {
  type?: string;
  record?: Record<string, unknown>;
  resolved?: Record<string, unknown>;
  dataroom?: { customerId: string | null; context: string | null; files: Record<string, unknown> };
};

/** The product's own parts of a bundle with code values spoken; the data-room files are stored DATA (keys only). */
function spokenBundle(raw: ExportBundle): ExportBundle {
  // Entry by entry, so the key order (and so the copied JSON) is exactly the API's.
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, k === "dataroom" ? v : speakValues({ [k]: v })[k]])) as ExportBundle;
}

/** Copy as JSON: keys and code values spoken (the data-room files: keys only). */
export function exportJson(bundle: ExportBundle): string {
  return JSON.stringify(speakKeys(spokenBundle(bundle)), null, 2);
}

/** A flat record → `**Field:** value` bullets, skipping empty values. `obj`'s code values are already spoken. */
function fieldsToMarkdown(obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") continue;
    const val = typeof v === "object" ? jsonForPeople(v) : String(v);
    out.push(`- **${humanizeKey(k)}:** ${val}`);
  }
  return out;
}

/** The enriched export bundle → readable Markdown: the record's own fields, then its resolved pointers (container /
 *  cycle / subtasks / comments), then the customer's data-room context. */
export function bundleToMarkdown(title: string, raw: ExportBundle): string {
  const bundle = spokenBundle(raw);
  const lines = [`# ${title}`, ""];
  lines.push(...fieldsToMarkdown(bundle.record ?? {}));
  const resolved = bundle.resolved ?? {};
  for (const [key, val] of Object.entries(resolved)) {
    if (val === null || val === undefined || (Array.isArray(val) && val.length === 0)) continue;
    lines.push("", `## ${humanizeKey(key)}`);
    if (Array.isArray(val)) {
      for (const item of val) {
        lines.push(
          typeof item === "object" && item
            ? `- ${Object.entries(item as Record<string, unknown>).map(([k, v]) => `${humanizeKey(k)}: ${typeof v === "object" ? jsonForPeople(v) : v}`).join(" · ")}`
            : `- ${String(item)}`,
        );
      }
    } else if (typeof val === "object") {
      lines.push(...fieldsToMarkdown(val as Record<string, unknown>));
    } else {
      lines.push(String(val));
    }
  }
  const dr = bundle.dataroom;
  if (dr?.context || (dr?.files && Object.keys(dr.files).length)) {
    lines.push("", `## Data-room context${dr.customerId ? ` — ${dr.customerId}` : ""}`);
    if (dr.context) lines.push("", dr.context);
    for (const [k, v] of Object.entries(dr.files ?? {})) {
      lines.push("", `### ${humanizeKey(k)}`, "```json", jsonForPeople(v, 2), "```");
    }
  }
  return lines.join("\n");
}
