/**
 * The deployment profile's `domains` section, as the UI reads it.
 *
 * A deployment may REDEFINE the two software-delivery record areas (deployments, implementations) instead of
 * hiding them: another name, other field labels, other words for the enum values, some fields not used. The
 * identifiers never move: a form still submits `releaseStatus: "deployed"`, whatever the person read.
 *
 * Every reader takes the legacy literal it used to hardcode and gets it back unchanged until the profile says
 * something different from profiles/00-default.json. That is what keeps the default deployment exactly as it
 * was, including the places where the old UI used two or three different words for one field.
 *
 * Pure: no React, no fetch. `domains` is a parameter so a preview page or a test can pass another profile's.
 */
import {
  DEFAULT_DOMAINS,
  DEPLOYMENT_PROFILE,
  DOMAIN_FIELDS,
  type DeploymentProfile,
  type DomainArea,
  type DomainFieldMeta,
  type DomainFieldSpec,
} from "./deployment-profile.generated.ts";
import { LEGACY_RECORDS, speak, speakCode, VOCABULARY_RELABELLED } from "../agent/lib/agent-vocabulary.ts";

/**
 * The profile's word for each record, by the stored name a code value may spell (`customer-vpc`, `customer_cloud`,
 * blockerOwner `Customer`): lower case, as prose writes it.
 */
const RECORD_WORD: Record<string, string> = Object.fromEntries(
  (
    [
      [LEGACY_RECORDS.account, DEPLOYMENT_PROFILE.vocabulary.account],
      [LEGACY_RECORDS.deployments, DEPLOYMENT_PROFILE.domains.deployments.label],
      [LEGACY_RECORDS.implementations, DEPLOYMENT_PROFILE.domains.implementations.label],
      [LEGACY_RECORDS.rollouts, DEPLOYMENT_PROFILE.domains.implementations.group_label],
    ] as const
  ).flatMap(([stored, word]) => [
    [stored.singular, lowerFirst(word.singular)],
    [stored.plural, lowerFirst(word.plural)],
  ]),
);

/**
 * A stored code value with each record's stored name read in the profile's word, where the vocabulary does not
 * translate it itself (the default profile; a profile that renames one record and keeps the default word for
 * another): `customer-vpc` -> `account-vpc`, `Customer` -> `Account`. The identity where the profile's word is the
 * stored one.
 */
function inRecordWords(value: string): string {
  return value.replace(/[A-Za-z]+/g, (w) => {
    const stored = w.toLowerCase();
    if (!Object.hasOwn(RECORD_WORD, stored)) return w;
    const word = RECORD_WORD[stored];
    if (word === stored || (VOCABULARY_RELABELLED && speakCode(stored) !== stored)) return w;
    return /^[A-Z]/.test(w) ? word[0].toUpperCase() + word.slice(1) : word;
  });
}

/**
 * A choice's label when the profile gives it none: a stored enum VALUE shown as it is would read a record's stored
 * name (`customer-vpc`, `customer_cloud`, blockerOwner `Customer`), so the record word in it is the profile's, under
 * every profile (`account-vpc`, `Account`); under a relabelling profile it is shown the way the model is told it
 * (`company-vpc`, `Company`) and a built-in label is spoken. The value stored is unchanged. A label the profile
 * gives is its own words and is never touched.
 */
function said(value: string, label: string): string {
  if (label !== value) return VOCABULARY_RELABELLED ? speak(label) : label;
  const words = inRecordWords(value);
  return VOCABULARY_RELABELLED ? speakCode(words) : words;
}

export type Domains = DeploymentProfile["domains"];
export type DomainOption = { value: string; label: string };
export type DomainFormField =
  | { key: string; label: string; kind: "text" | "number"; placeholder?: string; help?: string; required?: boolean }
  | { key: string; label: string; kind: "select"; options: DomainOption[]; help?: string }
  | { key: string; label: string; kind: "group"; help?: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** "Coverage report" -> "coverage report"; "KPI table" stays. For use mid-sentence ("Loading …", "New …"). */
export function lowerFirst(s: string): string {
  return s.length > 1 && s[1] === s[1].toLowerCase() ? s[0].toLowerCase() + s.slice(1) : s;
}

/** "affordable-housing" -> "Affordable housing": a group's slug, as a person reads it. */
export function groupTitle(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : slug;
}

/** "Affordable housing" -> "affordable-housing": what a person names a new group, as the slug that is stored. */
export function groupSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function domainView(area: DomainArea, domains: Domains = DEPLOYMENT_PROFILE.domains) {
  const spec = domains[area];
  const def = DEFAULT_DOMAINS[area];
  const meta: Record<string, DomainFieldMeta> = DOMAIN_FIELDS[area];
  const field = (key: string): DomainFieldSpec => spec.fields[key] ?? {};
  const labelRedefined = (key: string) => {
    const f = field(key);
    const d = def.fields[key] ?? {};
    return Boolean(f.label) && (f.label !== d.label || f.short_label !== d.short_label);
  };
  const optionsRedefined = (key: string) => Boolean(field(key).options) && !same(field(key).options, def.fields[key]?.options);
  const nameRedefined = !same(spec.label, def.label);

  const grouped = "group_by" in spec && (spec as Domains["implementations"]).group_by ? (spec as Domains["implementations"]) : null;

  const view = {
    area,
    spec,
    /** The area's heading (a tab, a panel): the GROUPS' name when rows are grouped ("Portfolios"), else the plural. */
    title: grouped ? grouped.group_label.plural : spec.label.plural,
    /** Has this deployment said anything about the area that the default does not? */
    redefined: !same(spec, def),
    singular: spec.label.singular,
    plural: spec.label.plural,
    /** Mid-sentence forms: "Loading deployments…", "New deployment". */
    noun: lowerFirst(spec.label.singular),
    nouns: lowerFirst(spec.label.plural),
    /** `legacy` while the area keeps its default name; the profile's name once it is renamed. */
    name: (legacy: string, form: "singular" | "plural" = "plural") =>
      !nameRedefined ? legacy : form === "plural" && grouped ? grouped.group_label.plural : spec.label[form],
    description: spec.description,
    idLabel: spec.id_label,
    hidden: (key: string) => field(key).hidden === true,
    /** Does this deployment show other words than the default for the field's enum values? */
    optionsRedefined,
    help: (key: string) => field(key).help,
    placeholder: (key: string, legacy?: string) => field(key).placeholder ?? legacy,
    /** The label a person reads for a field. `legacy` is what this spot said before profiles. */
    label: (key: string, legacy: string, variant: "full" | "short" = "full"): string => {
      if (!labelRedefined(key)) return legacy;
      const f = field(key);
      return variant === "short" ? (f.short_label ?? f.label ?? legacy) : (f.label ?? legacy);
    },
    /** The choices of an enum field: real values, display labels. `legacy` is the list this spot offered before. */
    options: (key: string, legacy?: readonly DomainOption[]): DomainOption[] => {
      const o = field(key).options;
      if (o && (optionsRedefined(key) || !legacy)) return Object.entries(o).map(([value, label]) => ({ value, label }));
      if (legacy) return legacy.map((c) => ({ value: c.value, label: said(c.value, c.label) }));
      return (meta[key]?.values ?? []).map((value) => ({ value, label: said(value, value) }));
    },
    /** A stored value, as a person reads it. `legacy` is how this spot rendered it before (default: the value). */
    display: (key: string, value: string | null | undefined, legacy?: string): string => {
      if (value == null || value === "") return legacy ?? "";
      if (!optionsRedefined(key)) return legacy ?? said(value, value);
      return field(key).options?.[value] ?? said(value, value);
    },
    /** The reverse: what a person read or typed, as the value to store. Unknown text is returned as it came. */
    valueOf: (key: string, shown: string): string => {
      const hit = Object.entries(field(key).options ?? {}).find(([, label]) => label.toLowerCase() === shown.trim().toLowerCase());
      return hit ? hit[0] : shown;
    },
    /** What the forms submit for the fields nobody sees. */
    fixedValues: (): Record<string, string | number> =>
      Object.fromEntries(
        Object.entries(spec.fields).flatMap(([k, f]) => (f.hidden && f.fixed !== undefined ? [[k, f.fixed] as [string, string | number]] : [])),
      ),
    /** The deployment's OWN fields on the area (values live under `custom`); the ones a list shows as columns. */
    customFields: spec.custom_fields ?? [],
    listCustomFields: (spec.custom_fields ?? []).filter((f) => f.show_in_list),
    groupBy: "group_by" in spec ? (spec as Domains["implementations"]).group_by : null,
    groupLabel: "group_label" in spec ? (spec as Domains["implementations"]).group_label : null,
    /** A form field for any real field key, typed from the schema: the profile's create_fields / detail_fields. */
    formField: (key: string): DomainFormField | null => {
      const m = meta[key];
      if (!m || m.type === "list" || view.hidden(key)) return null;
      const label = key === (view.groupBy ?? "") && view.groupLabel ? view.groupLabel.singular : (field(key).label ?? key);
      const help = field(key).help;
      if (key === view.groupBy) return { key, label, kind: "group", help };
      if (key === spec.kind_field) return { key, label, kind: "select", options: spec.kinds.map((k) => ({ value: k, label: k })), help };
      if (m.type === "enum") return { key, label, kind: "select", options: view.options(key), help };
      return { key, label, kind: m.type === "number" ? "number" : "text", placeholder: field(key).placeholder, help, required: m.required };
    },
  };
  return view;
}

export type DomainView = ReturnType<typeof domainView>;

/** The built-in form fields, minus the ones this deployment hides, plus the profile's extra ones. */
export function withProfileFields<F extends { key: string }>(view: DomainView, builtIn: readonly F[], extra: readonly string[]): (F | DomainFormField)[] {
  const kept = builtIn.filter((f) => !view.hidden(f.key));
  const have = new Set(kept.map((f) => f.key));
  return [...kept, ...extra.filter((k) => !have.has(k)).flatMap((k) => view.formField(k) ?? [])];
}

export type DomainGroup<T> = { key: string; title: string; owner: string | null; rows: T[]; averageProgress: number | null };

/** Rows gathered by the profile's group_by value (a portfolio, a programme…). Ungrouped rows come last under "". */
export function groupRows<T>(rows: readonly T[], groupOf: (t: T) => string | null | undefined, ownerOf: (t: T) => string | null, progressOf: (t: T) => number | null): DomainGroup<T>[] {
  const by = new Map<string, T[]>();
  for (const r of rows) {
    const k = groupOf(r)?.trim() ?? "";
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([key, list]) => {
      const owners = new Map<string, number>();
      for (const r of list) { const o = ownerOf(r); if (o) owners.set(o, (owners.get(o) ?? 0) + 1); }
      const pcts = list.map(progressOf).filter((n): n is number => n != null);
      return {
        key,
        title: key ? groupTitle(key) : "",
        owner: [...owners.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
        rows: list,
        averageProgress: pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
      };
    });
}
