// The customer credential vault's model (mold_v0-239): what the console shows of the packs' credential fields, with no
// React and no imports, so the placement rules are proven offline (scripts/credentials-test.ts).
//
//   one credential  a field, or the fields that share a `group` (an access key id and its secret): set, replaced,
//                   cleared and shown together, one input each
//   its place       a workspace's own credential is on Settings › Credentials; one that belongs to a record (one per
//                   record, or one per record and environment) is on that record's own page, never on Settings
//   its words       what it is for, how to get it (numbered steps), what still works without it, its status (set,
//                   missing or optional), when it was set and when it was last used. Never the binding, how it is
//                   delivered, a variable's name or a pack's id.

/** A credential field as GET /api/credentials answers it (src/credentials.ts fieldSummary). */
export interface CredField {
  pack: string; name: string; label: string; help: string | null; bound_to: 'workspace' | 'asset' | 'environment';
  area: string | null; environments: string[] | null; deliver_as: { env: string } | { file: string; path_env?: string };
  github_app?: boolean; oauth?: string; optional?: boolean; adds?: string | null;
  purpose?: string | null; steps?: string[] | null; without?: string | null; group?: string; group_label?: string;
}
/** A stored value's slot: never the value (an owner sees its last 4 characters). */
export interface CredValue {
  pack: string; name: string; bound_to: string; asset: string | null; environment: string | null;
  last4: string | null; updated_at: string; updated_by: string | null; last_used_at?: string | null;
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
}

/** Where a credential lives in the console. */
export type Place = 'settings' | 'record' | 'record-environment';
export const placeOf = (f: Pick<CredField, 'bound_to'>): Place => (f.bound_to === 'workspace' ? 'settings' : f.bound_to === 'asset' ? 'record' : 'record-environment');

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
      parts: [f], file: isFile, github_app: !!f.github_app, oauth: f.oauth ?? null
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

/** The usual names of an environment, in words ("prod" reads Production); any other name capitalised. */
const ENV_WORDS: Record<string, string> = {
  prod: 'Production', production: 'Production', prd: 'Production', live: 'Live', staging: 'Staging', stage: 'Staging', stg: 'Staging',
  uat: 'UAT', qa: 'QA', test: 'Test', testing: 'Test', dev: 'Development', development: 'Development', sandbox: 'Sandbox', preprod: 'Pre-production',
  'pre-prod': 'Pre-production', dr: 'Disaster recovery', demo: 'Demo', local: 'Local'
};
export const envWord = (e: string) => ENV_WORDS[e.toLowerCase()] ?? e.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

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
