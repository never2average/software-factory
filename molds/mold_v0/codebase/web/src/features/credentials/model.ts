// The customer credential vault's model (mold_v0-239): what the console shows of the packs' credential fields, with no
// React and no imports but the console's words (../../lib/value-words.ts), so the placement rules are proven offline
// (scripts/credentials-test.ts).
//
//   one credential  a field, or the fields that share a `group` (an access key id and its secret): set, replaced,
//                   cleared and shown together, one input each
//   its place       a workspace's own credential is on Settings › Credentials; one that belongs to a record (one per
//                   record, or one per record and environment) is on that record's own page, never on Settings
//   its words       what it is for, how to get it (numbered steps), what still works without it, its status (set,
//                   missing or optional), when it was set and when it was last used. Never the binding, how it is
//                   delivered, a variable's name or a pack's id.

import { envWord } from '../../lib/value-words';

/** A credential field as GET /api/credentials answers it (src/credentials.ts fieldSummary). */
export interface CredField {
  pack: string; name: string; label: string; help: string | null; bound_to: 'workspace' | 'asset' | 'environment' | 'tenant';
  area: string | null; environments: string[] | null; deliver_as: { env: string } | { file: string; path_env?: string };
  github_app?: boolean; oauth?: string; optional?: boolean; adds?: string | null;
  purpose?: string | null; steps?: string[] | null; without?: string | null; group?: string; group_label?: string;
  /** mold_v0-260 (flag credential_sets): several labelled values (what each label is, how many at most). */
  entries?: { label: string; max: number };
}
/** A stored value's slot: never the value (an owner sees its last 4 characters). */
export interface CredValue {
  pack: string; name: string; bound_to: string; asset: string | null; environment: string | null;
  last4: string | null; updated_at: string; updated_by: string | null; last_used_at?: string | null;
  /** mold_v0-260: the label of one of a credential's several values. */
  entry?: string | null;
}

/** One credential as a customer sees it: a field alone, or a group's fields. */
export interface Credential {
  /** Its id in the address (?credential=): the pack and the group or the field. */
  id: string;
  pack: string; group: string | null; label: string;
  /** What it is for, one sentence. */
  purpose: string;
  /** How to get it, step by step (the first names the web address to open); empty when the pack gives none. */
  steps: string[];
  /** What still works without it (an optional one), else null. */
  without: string | null;
  optional: boolean;
  place: Place;
  area: string | null;
  /** Its inputs: one per field, in declared order. */
  parts: CredField[];
  /** A file (a key, a kubeconfig): pasted with its line breaks, or chosen from the computer. */
  file: (f: CredField) => boolean;
  github_app: boolean; oauth: string | null;
  /** mold_v0-260: several labelled values (a host and its token, ...): what each label is and how many at most. */
  entries: { label: string; max: number } | null;
}

/** Where a credential lives in the console. */
export type Place = 'settings' | 'record' | 'record-environment';
// mold_v0-260: a tenant's credential is its record's, as an asset's is (on the tenant's own page).
export const placeOf = (f: Pick<CredField, 'bound_to'>): Place => (f.bound_to === 'workspace' ? 'settings' : f.bound_to === 'asset' || f.bound_to === 'tenant' ? 'record' : 'record-environment');

const isFile = (f: CredField) => 'file' in f.deliver_as;

/** "the access key above" style help says nothing alone: the purpose, the help, then the label. */
const purposeOf = (lead: CredField) => (lead.purpose ?? lead.help ?? '').trim();
const withoutOf = (lead: CredField, optional: boolean) =>
  !optional ? null : (lead.without ?? (lead.adds ? `Everything else works without it; with it you also get ${lead.adds.replace(/^[A-Z]/, (c) => c.toLowerCase())}.` : 'Everything else works without it.'));

/** The packs' fields as credentials: a group's fields become one (at its first field's place in the list). */
export function credentialsOf(fields: readonly CredField[]): Credential[] {
  const out: Credential[] = [];
  const seen = new Map<string, Credential>();
  for (const f of fields) {
    const gid = f.group ? `${f.pack}/${f.group}` : null;
    if (gid && seen.has(gid)) { seen.get(gid)!.parts.push(f); continue; }
    const optional = !!f.optional;
    const c: Credential = {
      id: gid ?? `${f.pack}/${f.name}`, pack: f.pack, group: f.group ?? null, label: f.group ? f.group_label ?? f.label : f.label,
      purpose: purposeOf(f), steps: f.steps ?? [], without: withoutOf(f, optional), optional, place: placeOf(f), area: f.area,
      parts: [f], file: isFile, github_app: !!f.github_app, oauth: f.oauth ?? null, entries: f.entries ?? null
    };
    if (gid) seen.set(gid, c);
    out.push(c);
  }
  return out;
}

/** Settings › Credentials: the workspace's own credentials only. */
export const forSettings = (cs: readonly Credential[]) => cs.filter((c) => c.place === 'settings');
/** A record's own page: the credentials of its area, one per record, then those per record and environment. */
export const forRecord = (cs: readonly Credential[], area: string) => ({
  record: cs.filter((c) => c.place === 'record' && c.area === area),
  environment: cs.filter((c) => c.place === 'record-environment' && c.area === area)
});

export type Status = 'Set' | 'Missing' | 'Optional';
/** One credential in one slot (the workspace, a record, a record's environment): its status and its dates. */
export interface SlotState {
  status: Status;
  /** Some of a group's fields are set and some not (set before they were one credential): it needs setting again. */
  partial: boolean;
  set_at: string | null; set_by: string | null; last_used_at: string | null;
  /** Each part's last 4 characters (owners), by field name. */
  last4: Record<string, string | null>;
  values: CredValue[];
}

/** mold_v0-260: a credential's labelled values in one slot, in label order. */
export const entriesIn = (c: Credential, values: readonly CredValue[], asset: string | null, environment: string | null) =>
  valuesIn(c, values, asset, environment).filter((v) => !!v.entry).sort((a, b) => a.entry!.localeCompare(b.entry!));

/** The values of a credential in one slot. */
export const valuesIn = (c: Credential, values: readonly CredValue[], asset: string | null, environment: string | null) =>
  values.filter((v) => v.pack === c.pack && c.parts.some((p) => p.name === v.name) && (v.asset ?? null) === asset && (v.environment ?? null) === environment);

const latest = (xs: (string | null | undefined)[]) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null;

/** Its status in a slot: Set when every part has a value; else Optional (the runs go ahead without it) or Missing. */
export function stateIn(c: Credential, values: readonly CredValue[], asset: string | null, environment: string | null): SlotState {
  const vs = valuesIn(c, values, asset, environment);
  const all = c.parts.every((p) => vs.some((v) => v.name === p.name));
  const newest = vs.slice().sort((a, b) => a.updated_at.localeCompare(b.updated_at)).at(-1);
  return {
    status: all ? 'Set' : c.optional ? 'Optional' : 'Missing', partial: !all && vs.length > 0,
    set_at: newest?.updated_at ?? null, set_by: newest?.updated_by ?? null,
    // A pair was last used when any of its parts was (they go to a run together).
    last_used_at: latest(vs.map((v) => v.last_used_at)),
    last4: Object.fromEntries(c.parts.map((p) => [p.name, vs.find((v) => v.name === p.name)?.last4 ?? null])),
    values: vs
  };
}

/** An environment's name in words ("prod" reads Production): the console's one mapping (mold_v0-240, lib/value-words.ts). */
export { envWord };

/**
 * The record page's Credentials card, in order (mold_v0-239): the credentials of the record itself, then one group per
 * environment the record has, each with the credentials set per environment.
 */
export function recordSections(cs: readonly Credential[], area: string, environments: readonly string[], values: readonly CredValue[], asset: string,
  fieldEnvironments: Record<string, string[] | null> = {}) {
  const { record, environment } = forRecord(cs, area);
  /** The environments a credential takes on this record (a fixed list narrows it). */
  const takes = (c: Credential, e: string) => { const l = fieldEnvironments[`${c.pack}/${c.parts[0]!.name}`]; return !l || l.includes(e); };
  return {
    record: record.map((c) => ({ c, state: stateIn(c, values, asset, null) })),
    environments: environment.length ? environments.map((e) => ({
      environment: e, label: envWord(e),
      items: environment.filter((c) => takes(c, e)).map((c) => ({ c, state: stateIn(c, values, asset, e) }))
    })) : []
  };
}

/** A record as GET /api/credentials?records=<area> answers it (mold_v0-241; src/credentials.ts areaCredentials). */
export interface AreaRecord { key: string; title: string; environments: string[]; field_environments: Record<string, string[] | null> }

/** One credential in one slot of a record, as Settings › Credentials counts it: its status and whether it is required. */
export interface RecordSlot { c: Credential; environment: string | null; state: SlotState; required: boolean }

/**
 * A record's row on Settings › Credentials (mold_v0-241): its credentials counted one by one (each of the record's own,
 * and each environment's for every environment the record has), in one line of plain words: "All set", "N missing" (N
 * required and not set), "Optional only" (only optional ones are not set), or "No environments yet" (it needs them per
 * environment and lists none); when one of them last changed and who changed it, and when one was last used.
 */
export function recordSummary(cs: readonly Credential[], area: string, rec: AreaRecord, values: readonly CredValue[]) {
  const sec = recordSections(cs, area, rec.environments, values, rec.key, rec.field_environments);
  const slots: RecordSlot[] = [
    ...sec.record.map((x) => ({ c: x.c, environment: null, state: x.state, required: !x.c.optional })),
    ...sec.environments.flatMap((g) => g.items.map((x) => ({ c: x.c, environment: g.environment, state: x.state, required: !x.c.optional })))
  ];
  const missing = slots.filter((x) => x.state.status === 'Missing').length;
  const optional = slots.filter((x) => x.state.status === 'Optional').length;
  const status: Status = missing ? 'Missing' : optional || !slots.length ? 'Optional' : 'Set';
  const words = !slots.length ? 'No environments yet' : missing ? `${missing} missing` : optional ? 'Optional only' : 'All set';
  const newest = slots.filter((x) => x.state.set_at).sort((a, b) => a.state.set_at!.localeCompare(b.state.set_at!)).at(-1)?.state ?? null;
  return { slots, missing, optional, status, words, changed_at: newest?.set_at ?? null, changed_by: newest?.set_by ?? null,
    used_at: latest(slots.map((x) => x.state.last_used_at)) };
}

/** What a record's credentials are for, in its area's words ("Credentials for this application and its environments"). */
export const recordPurpose = (cs: readonly Credential[], area: string, noun: string) =>
  `Credentials for this ${noun}${forRecord(cs, area).environment.length ? ' and its environments' : ''}`;

/** The anchor of a record page's Credentials card: a Settings › Credentials row opens the record's page scrolled to it. */
export const CREDENTIALS_ANCHOR = 'credentials';
/** A record's own page, at its Credentials card. */
export const recordCredentialsHref = (area: string, key: string) => `/app/records/${encodeURIComponent(area)}/${encodeURIComponent(key)}#${CREDENTIALS_ANCHOR}`;

/** One credential the four cards count: a workspace row's, or one of a record's (each environment's apart). */
export interface Unit { status: Status; required: boolean; changed_at: string | null }
/** Settings › Credentials' four cards (mold_v0-241: credentials, not rows): set, not set, required and not set, changed this week. */
export function settingsCounts(units: readonly Unit[], now = Date.now()) {
  const n = (f: (u: Unit) => boolean) => units.filter(f).length;
  return { set: n((u) => u.status === 'Set'), missing: n((u) => u.status !== 'Set'), required_missing: n((u) => u.status === 'Missing' && u.required),
    recent: n((u) => !!u.changed_at && now - new Date(u.changed_at).getTime() < 7 * 86_400_000) };
}

/**
 * Words a customer never reads in the vault (mold_v0-239): the binding, the delivery, the record role. The console's
 * text is held to it (scripts/record-pages-test.ts), with every variable name and pack id the build declares.
 */
export const INTERNAL_WORDS = ['bound_to', 'deliver_as', 'asset', 'path_env', 'environments_from', 'group_label'] as const;

/** A step's text as pieces: plain text and web addresses (shown as links). */
export function stepPieces(step: string): { text: string; href?: string }[] {
  const out: { text: string; href?: string }[] = [];
  let last = 0;
  for (const m of step.matchAll(/https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@/?#-]*)?/g)) {
    const url = m[0].replace(/[.,;:)]+$/, '');
    if (m.index! > last) out.push({ text: step.slice(last, m.index) });
    out.push({ text: url, href: url });
    last = m.index! + url.length;
  }
  if (last < step.length) out.push({ text: step.slice(last) });
  return out;
}
