// A record's json field in words (mold_v0-240), with no React and no imports but the console's words, so it is proven
// offline (scripts/record-pages-test.ts check 13). Generic: nothing here knows a pack's documents.
//
//   a list of objects   one item each: its name (its name, title or label, else its id) and its other meaningful
//                       fields ("Production · Hosting: AWS, ap-south-1")
//   an object           one "Label: value" line per meaningful field
//   a nested object     flattened to its values, comma-joined ("Hosting: AWS, ap-south-1")
//   bookkeeping         hidden: schemaVersion, kind, $schema and keys like it, and any value that repeats the record's
//                       own key (an appId inside the application's own record); a field that only repeats its item's
//                       name is not said twice
//   short values        in words, with the credentials card's mapping (lib/value-words.ts: prod reads Production)
//
// jsonView is what a record's page and an open row draw (json-value.tsx); jsonLine is the one line a list's cell, its
// search text and a board's card read.

import { valueWord } from '../../lib/value-words';

export type JsonPart = { label: string; text: string };
export type JsonItem = { name: string | null; parts: JsonPart[] };
export type JsonView =
  | { kind: 'items'; items: JsonItem[] }
  | { kind: 'fields'; parts: JsonPart[] }
  | { kind: 'text'; text: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether a value is a document (an object, or a list holding one) rather than a scalar or a list of scalars. */
export const isDocument = (v: unknown): boolean => isObj(v) || (Array.isArray(v) && v.some((x) => isObj(x) || Array.isArray(x)));

/** Keys that keep a document's books, never its meaning. */
const BOOKKEEPING = new Set(['schemaversion', 'schema_version', 'schema', 'kind', 'apiversion', 'api_version', 'typename']);
const bookkeeping = (k: string) => /^[$@_]/.test(k) || BOOKKEEPING.has(k.toLowerCase());
/** The keys that name an item, in order; else its first id. */
const NAME_KEYS = ['name', 'title', 'label', 'display_name', 'displayName'];
const isIdKey = (k: string) => /^(id|key)$|[a-z]Id$|_id$/.test(k);

/** A key in words: "envId" reads Env ID, "hosting_region" Hosting region. */
export function keyLabel(k: string): string {
  const words = k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase().split(/\s+/)
    .map((w) => (w === 'id' || w === 'url' || w === 'api' ? w.toUpperCase() : w));
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A scalar in words. */
function scalar(v: unknown): string {
  if (v == null || v === '') return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string') return valueWord(v);
  return String(v);
}

/** An object's meaningful entries: no bookkeeping key, no empty value, no value repeating the record's own key. */
function meaningful(o: Obj, recordKey?: string): [string, unknown][] {
  return Object.entries(o).filter(([k, v]) => !bookkeeping(k) && !(recordKey && v === recordKey) && flat(v, recordKey) !== '');
}

/** Any value flattened to one comma-joined line of its values (a nested object's labels left out). */
function flat(v: unknown, recordKey?: string): string {
  if (Array.isArray(v)) return v.map((x) => (isObj(x) ? itemLine(item(x, recordKey)) : flat(x, recordKey))).filter(Boolean).join(v.some(isObj) ? '; ' : ', ');
  if (isObj(v)) return meaningful(v, recordKey).map(([, x]) => flat(x, recordKey)).filter(Boolean).join(', ');
  return scalar(v);
}

/** An object as an item: its name and its other meaningful fields (one only repeating the name left out). */
function item(o: Obj, recordKey?: string): JsonItem {
  const entries = meaningful(o, recordKey);
  const nameKey = NAME_KEYS.find((k) => entries.some(([x, v]) => x === k && typeof v === 'string'))
    ?? entries.find(([k, v]) => isIdKey(k) && (typeof v === 'string' || typeof v === 'number'))?.[0];
  const name = nameKey ? scalar(o[nameKey]) : null;
  const parts = entries.filter(([k]) => k !== nameKey).map(([k, v]) => ({ label: keyLabel(k), text: flat(v, recordKey) }))
    .filter((p) => p.text !== name);
  return { name, parts };
}

const itemLine = (it: JsonItem) => {
  const rest = it.parts.map((p) => p.text).join(', ');
  return it.name ? (rest ? `${it.name} (${rest})` : it.name) : rest;
};

/** A json value as a record's page draws it: items, an object's fields, or (anything else) one line of text. */
export function jsonView(v: unknown, recordKey?: string): JsonView {
  if (Array.isArray(v) && v.some(isObj)) return { kind: 'items', items: v.map((x) => (isObj(x) ? item(x, recordKey) : { name: flat(x, recordKey), parts: [] })).filter((x) => x.name || x.parts.length) };
  if (isObj(v)) return { kind: 'fields', parts: meaningful(v, recordKey).map(([k, x]) => ({ label: keyLabel(k), text: flat(x, recordKey) })) };
  return { kind: 'text', text: flat(v, recordKey) };
}

/** A json value on one line, as a list's cell reads it: "Production (AWS, ap-south-1); Staging (AWS, ap-south-1)". */
export function jsonLine(v: unknown, recordKey?: string): string {
  const view = jsonView(v, recordKey);
  if (view.kind === 'items') return view.items.map(itemLine).filter(Boolean).join('; ');
  if (view.kind === 'fields') return view.parts.map((p) => `${p.label}: ${p.text}`).join('; ');
  return view.text;
}
