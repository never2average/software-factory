/**
 * THE KEYS AN OWN FIELD IS READ UNDER. An area's own field is stored by key in the row's `custom` object. A field
 * renamed after rows were written declares the key (or keys) those rows carry it under: `renamed_from` is one earlier
 * key or a list of them, newest first. A field renamed twice lists both, so a row written under either still reads.
 *
 * Every reader takes the same order: the field's own key first, then each earlier key; the first key the row holds
 * wins (a key present with `null` holds "cleared", as it always did). A write stores the field's own key; clearing it
 * clears every earlier key too, so an older value never comes back. Rows are never migrated or rewritten.
 *
 * Pure: no database, no React, so the agent, the server query, the web app and the scripts share it.
 */

/** What a field declares about its keys (a compiled RecordField, or the legacy form's custom field spec). */
export interface OwnKeyed {
  key: string;
  renamed_from?: string | readonly string[];
}

/** The earlier keys, newest first: `renamed_from` as a list, without the field's own key or a repeat. */
export function earlierKeys(f: OwnKeyed): string[] {
  const r = f.renamed_from;
  const list = r === undefined || r === null ? [] : typeof r === "string" ? [r] : [...r];
  return list.filter((k, i) => typeof k === "string" && k !== "" && k !== f.key && list.indexOf(k) === i);
}

/** Every key the field is read under, in order: its own, then each earlier key. */
export function ownKeys(f: OwnKeyed): string[] {
  return [f.key, ...earlierKeys(f)];
}

/** Is this field read under more than its own key? */
export function isRenamed(f: OwnKeyed): boolean {
  return earlierKeys(f).length > 0;
}

/**
 * The field's stored value in a row's `custom`: under the first of its keys the object holds, else undefined. A
 * `custom` that is absent, null or not an object holds nothing (never a throw).
 */
export function ownValue(custom: unknown, f: OwnKeyed): unknown {
  if (custom === null || typeof custom !== "object" || Array.isArray(custom)) return undefined;
  const c = custom as Record<string, unknown>;
  for (const k of ownKeys(f)) if (k in c) return c[k];
  return undefined;
}
