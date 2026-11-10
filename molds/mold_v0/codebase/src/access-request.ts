/**
 * The access-request form's own questions (mold_v0-102): what a build asks someone who requests access, declared by its
 * packs (pack.json `access_request.fields`) or by the app (profile.json `access_request`, which then replaces the packs'),
 * never by the shell. Pure, no imports, so the server (POST /api/access-requests, the staff console's list, the alert
 * email), the console (web/src/features/site/request-access-form.tsx and web/src/features/admin/requests.tsx, through the
 * generated copy) and scripts/gen-packs.mjs (node strips the types) run the same rules.
 *
 *   "access_request": {
 *     "fields": [
 *       { "key": "website", "label": "Company website", "type": "url", "required": true },
 *       { "key": "team", "label": "Team size", "type": "select", "options": [{ "value": "1-10", "label": "1 to 10" }, ...] },
 *       { "key": "tools", "label": "Tools you use", "type": "multi_select", "options": [...] },
 *       { "key": "goal", "label": "What should it do first?", "type": "long_text", "max_length": 1000, "help": "..." },
 *       { "key": "role", "label": "Role", "type": "text", "person": true }
 *     ]
 *   }
 *
 * `key`: lowercase letters, digits and _ (the answer's name where it is stored, access_requests.answers), never one of the
 * shell's own fields (email, name, company, message, source), each once across the build. `type`: text (one line), long_text,
 * url (http or https; one without a scheme gets https://), email, select (one of `options`) or multi_select (any of them).
 * `max_length` (text kinds; default 200, long_text 2000, url and email 500), `help` and `placeholder` are optional, as is
 * `required` (default false), and `person` (mold_v0-171: a text or select answer that says who the requester is, such as
 * their role; the staff list shows it beside their name, "Head of DevRel · sam@…", and the request's Person line). Labels and help are plain text on one line. Without a declaration the form asks the shell's
 * own fields only: a work email, a name, the company and a message.
 *
 * The server stores what the form sends under `answers` (an object of key -> answer); a declared key at the top level of
 * the request is read too, so a host pack's own form that posts its fields flat keeps working. A key nobody declared is
 * dropped, a required field left empty, an option not offered, an address that is not one or an answer over its length is
 * refused (400, naming the field's label).
 */

/** Every data type of a form's field (mold_v0-289: one list for a pack's, a spec's and the staff table's). */
export const ACCESS_FIELD_TYPES = ["text", "long_text", "email", "number", "select", "multi_select", "url", "date", "boolean"] as const;
export type AccessFieldType = (typeof ACCESS_FIELD_TYPES)[number];

export interface AccessFieldOption { value: string; label: string }
export type FieldKind = AccessFieldType;
export interface AccessField {
  key: string;
  label: string;
  type: FieldKind;
  required?: boolean;
  options?: AccessFieldOption[];
  max_length?: number;
  help?: string;
  placeholder?: string;
  /** The answer says who the requester is (a role, a job title): shown beside their name on /admin/requests (mold_v0-171). */
  person?: boolean;
}
export interface AccessRequestSpec { fields: AccessField[] }
/** One stored answer: text, or the chosen options of a multi_select. */
export type AccessAnswer = string | string[];

/** The shell's own fields of a request: never a declared key. */
export const SHELL_REQUEST_FIELDS = ["email", "name", "company", "message", "source"] as const;
export const MAX_ACCESS_FIELDS = 20;
const MAX_OPTIONS = 30;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const DEFAULT_MAX: Record<FieldKind, number> = { text: 200, long_text: 2000, url: 500, email: 500, select: 80, multi_select: 80, number: 40, date: 10, boolean: 5 };
const MAX_LENGTH: Record<FieldKind, number> = { text: 500, long_text: 4000, url: 1000, email: 500, select: 80, multi_select: 80, number: 40, date: 10, boolean: 5 };
const FIELD_KEYS = ["key", "label", "type", "required", "options", "max_length", "help", "placeholder", "person"];

/** Characters a plain-text line may not hold (src/landing.ts NOT_PLAIN, src/legal.ts). */
const NOT_PLAIN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;
/** Control characters an answer may not hold (a long answer keeps its line breaks and tabs). */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

const plainProblem = (v: unknown, max: number): string | null =>
  typeof v !== "string" || !v.trim() ? "text is required"
    : v.length > max ? `at most ${max} characters`
      : NOT_PLAIN.test(v) || /[<>{}]/.test(v) ? "plain text on one line: no line breaks, control or invisible characters, angle brackets or braces"
        : null;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Every problem with one `access_request` block (pack.json or profile.json), as "access_request.fields[i].x: ...". */
export function accessRequestProblems(spec: unknown): string[] {
  const out: string[] = [];
  if (!isObject(spec)) return ["access_request: an object with fields"];
  // mold_v0-289: a whole form (its fields include email): the same JSON the staff table saves, its words optional.
  if (isWholeForm(spec)) { const { $comment: _c, ...rest } = spec; return accessFormProblems(wholeForm(rest as Partial<AccessFormConfig>)).map((p) => `access_request.${p}`); }
  for (const k of Object.keys(spec)) if (k !== "fields" && k !== "$comment") out.push(`access_request.${k}: ${k === "submit" || k === "thanks" ? "only in a whole form (one whose fields include email)" : "unknown key (known: fields)"}`);
  if (spec.$comment !== undefined && (typeof spec.$comment !== "string" || spec.$comment.length > 2000)) out.push("access_request.$comment: text of up to 2000 characters");
  const fields = spec.fields;
  if (!Array.isArray(fields) || !fields.length) return [...out, "access_request.fields: a list of 1 to 20 fields"];
  if (fields.length > MAX_ACCESS_FIELDS) out.push(`access_request.fields: at most ${MAX_ACCESS_FIELDS} fields`);
  const seen = new Set<string>();
  fields.forEach((f, i) => {
    const at = `access_request.fields[${i}]`;
    if (!isObject(f)) { out.push(`${at}: an object with key, label and type`); return; }
    for (const k of Object.keys(f)) if (!FIELD_KEYS.includes(k)) out.push(`${at}.${k}: unknown key (known: ${FIELD_KEYS.join(", ")})`);
    const key = f.key;
    if (typeof key !== "string" || !KEY.test(key)) out.push(`${at}.key: 1-40 lowercase letters, digits or _, starting with a letter`);
    else if ((SHELL_REQUEST_FIELDS as readonly string[]).includes(key)) out.push(`${at}.key: ${key} is the shell's own field (${SHELL_REQUEST_FIELDS.join(", ")}): the form always asks it`);
    else if (seen.has(key)) out.push(`${at}.key: ${key} is declared twice`);
    else seen.add(key);
    const lp = plainProblem(f.label, 80);
    if (lp) out.push(`${at}.label: ${lp}`);
    const type = f.type as AccessFieldType;
    if (!(ACCESS_FIELD_TYPES as readonly string[]).includes(type)) { out.push(`${at}.type: one of ${ACCESS_FIELD_TYPES.join(", ")}`); return; }
    if (f.required !== undefined && typeof f.required !== "boolean") out.push(`${at}.required: true or false`);
    if (f.person !== undefined && typeof f.person !== "boolean") out.push(`${at}.person: true or false`);
    else if (f.person === true && type !== "text" && type !== "select") out.push(`${at}.person: only a text or select answer (one line) says who the requester is`);
    for (const [k, max] of [["help", 200], ["placeholder", 120]] as const) {
      if (f[k] === undefined) continue;
      const p = plainProblem(f[k], max);
      if (p) out.push(`${at}.${k}: ${p}`);
    }
    const choice = type === "select" || type === "multi_select";
    if (choice) {
      if (f.max_length !== undefined) out.push(`${at}.max_length: only for a text, long_text, url or email field`);
      if (f.placeholder !== undefined && type === "multi_select") out.push(`${at}.placeholder: not for a multi_select field`);
      const opts = f.options;
      if (!Array.isArray(opts) || !opts.length || opts.length > MAX_OPTIONS) { out.push(`${at}.options: a list of 1 to ${MAX_OPTIONS} options`); return; }
      const values = new Set<string>();
      opts.forEach((o, j) => {
        const oat = `${at}.options[${j}]`;
        if (!isObject(o)) { out.push(`${oat}: an object with value and label`); return; }
        for (const k of Object.keys(o)) if (k !== "value" && k !== "label") out.push(`${oat}.${k}: unknown key (known: value, label)`);
        const vp = plainProblem(o.value, 80);
        if (vp) out.push(`${oat}.value: ${vp}`);
        else if (o.value !== (o.value as string).trim()) out.push(`${oat}.value: no space at either end`);
        else if (values.has(o.value as string)) out.push(`${oat}.value: ${o.value} is offered twice`);
        else values.add(o.value as string);
        const p = plainProblem(o.label, 80);
        if (p) out.push(`${oat}.label: ${p}`);
      });
    } else {
      if (f.options !== undefined) out.push(`${at}.options: only for a select or multi_select field`);
      if (f.max_length !== undefined && (!Number.isInteger(f.max_length) || (f.max_length as number) < 1 || (f.max_length as number) > MAX_LENGTH[type]))
        out.push(`${at}.max_length: a whole number from 1 to ${MAX_LENGTH[type]}`);
    }
  });
  return out;
}

/** A checked block's fields, with nothing but the known keys (defaults are left to the readers: maxLengthOf). */
export function fieldsOf(spec: AccessRequestSpec): AccessField[] {
  return spec.fields.map((f) => Object.fromEntries(FIELD_KEYS.flatMap((k) => (f[k as keyof AccessField] === undefined ? [] : [[k, f[k as keyof AccessField]]]))) as unknown as AccessField);
}

/**
 * The build's fields: the packs' blocks in pack order, joined (a key declared by two packs is refused), unless the app's
 * profile.json declares its own, which replaces them. -> the fields, or the problems.
 */
export function joinAccessFields(packs: { id: string; spec: unknown }[], profile: unknown): { fields: AccessField[]; form: AccessFormConfig | null; problems: string[] } {
  const problems: string[] = [];
  if (profile !== undefined) {
    const bad = accessRequestProblems(profile);
    if (bad.length) return { fields: [], form: null, problems: bad.map((b) => `profile.json: ${b}`) };
    if (isWholeForm(profile)) { const form = formOf(wholeForm(profile as unknown as Partial<AccessFormConfig>)); return { fields: ownFields(form), form, problems }; }
    return { fields: fieldsOf(profile as AccessRequestSpec), form: null, problems };
  }
  const whole = packs.filter((p) => p.spec !== undefined && isWholeForm(p.spec));
  if (whole.length > 1) return { fields: [], form: null, problems: [`packs/${whole[1]!.id}: access_request: pack ${whole[0]!.id} already declares the whole form (one pack, or the app's profile.json)`] };
  if (whole.length === 1) {
    const bad = accessRequestProblems(whole[0]!.spec);
    if (bad.length) return { fields: [], form: null, problems: bad.map((b) => `packs/${whole[0]!.id}: ${b}`) };
    const form = formOf(wholeForm(whole[0]!.spec as unknown as Partial<AccessFormConfig>));
    return { fields: ownFields(form), form, problems };
  }
  const fields: AccessField[] = [];
  const owner = new Map<string, string>();
  for (const p of packs) {
    if (p.spec === undefined) continue;
    const bad = accessRequestProblems(p.spec);
    if (bad.length) { problems.push(...bad.map((b) => `packs/${p.id}: ${b}`)); continue; }
    for (const f of fieldsOf(p.spec as AccessRequestSpec)) {
      if (owner.has(f.key)) problems.push(`packs/${p.id}: access_request.fields: ${f.key} is already pack ${owner.get(f.key)}'s (a key is declared once in a build)`);
      else { owner.set(f.key, p.id); fields.push(f); }
    }
  }
  if (fields.length > MAX_ACCESS_FIELDS) problems.push(`access_request: the packs declare ${fields.length} fields together, at most ${MAX_ACCESS_FIELDS}`);
  return { fields, form: null, problems };
}

export const maxLengthOf = (f: AccessField) => f.max_length ?? DEFAULT_MAX[f.type];

/** An http(s) address as typed: one without a scheme gets https://. -> the address, or null when it is not one. */
export function normalizeUrl(v: string): string | null {
  const s = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(s);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".") && !u.username && !u.password && !/\s/.test(v) ? s : null;
  } catch { return null; }
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A number as a person types it: digits, an optional minus and decimal part (12, -3, 4.5). */
const NUMBER = /^-?\d{1,15}(\.\d{1,6})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v: string) => DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/**
 * The answers a request carries, checked against the build's fields: `body.answers[key]`, else `body[key]` (a host pack's
 * flat form). -> the answers to store (only what was given), or the first problem, naming the field's label.
 */
export function answersOf(body: unknown, fields: readonly AccessField[]): { answers: Record<string, AccessAnswer>; problem: string | null } {
  const b = isObject(body) ? body : {};
  const given = isObject(b.answers) ? b.answers : {};
  const answers: Record<string, AccessAnswer> = {};
  for (const f of fields) {
    const raw = Object.prototype.hasOwnProperty.call(given, f.key) ? given[f.key] : Object.prototype.hasOwnProperty.call(b, f.key) ? b[f.key] : undefined;
    if (f.type === "multi_select") {
      const list = raw === undefined || raw === null || raw === "" ? [] : Array.isArray(raw) ? raw : [raw];
      const offered = new Set((f.options ?? []).map((o) => o.value));
      const chosen: string[] = [];
      for (const x of list) {
        if (typeof x !== "string" || !offered.has(x)) return { answers: {}, problem: `${f.label}: choose from the options offered.` };
        if (!chosen.includes(x)) chosen.push(x);
      }
      if (!chosen.length) { if (f.required) return { answers: {}, problem: `${f.label}: choose at least one.` }; continue; }
      answers[f.key] = chosen;
      continue;
    }
    if (f.type === "boolean") {
      const yes = raw === true || (typeof raw === "string" && /^(yes|true)$/i.test(raw.trim())), no = raw === false || (typeof raw === "string" && /^(no|false)$/i.test(raw.trim()));
      if (yes || no) { answers[f.key] = yes ? "yes" : "no"; continue; }
      if (raw === undefined || raw === null || raw === "") { if (f.required) return { answers: {}, problem: `${f.label} is required.` }; continue; }
      return { answers: {}, problem: `${f.label}: answer yes or no.` };
    }
    if (raw !== undefined && raw !== null && typeof raw !== "string") return { answers: {}, problem: `${f.label}: send text.` };
    const v = typeof raw === "string" ? raw.trim() : "";
    if (!v) { if (f.required) return { answers: {}, problem: `${f.label} is required.` }; continue; }
    if (v.length > maxLengthOf(f)) return { answers: {}, problem: `${f.label}: at most ${maxLengthOf(f)} characters.` };
    if (CONTROL.test(v) || (f.type !== "long_text" && /[\r\n\t]/.test(v))) return { answers: {}, problem: `${f.label}: plain text only.` };
    if (f.type === "select") {
      if (!(f.options ?? []).some((o) => o.value === v)) return { answers: {}, problem: `${f.label}: choose one of the options offered.` };
      answers[f.key] = v;
    } else if (f.type === "url") {
      const u = normalizeUrl(v);
      if (!u) return { answers: {}, problem: `${f.label}: enter a web address, such as https://example.com.` };
      answers[f.key] = u;
    } else if (f.type === "email") {
      if (!EMAIL.test(v)) return { answers: {}, problem: `${f.label}: enter a valid email address.` };
      answers[f.key] = v;
    } else if (f.type === "number") {
      if (!NUMBER.test(v)) return { answers: {}, problem: `${f.label}: enter a number, such as 12 or 4.5.` };
      answers[f.key] = v;
    } else if (f.type === "date") {
      if (!validDate(v)) return { answers: {}, problem: `${f.label}: enter a date, such as 2026-11-10.` };
      answers[f.key] = v;
    } else answers[f.key] = v;
  }
  return { answers, problem: null };
}

/** An answer as a person reads it: an option's label for a select, the labels joined for a multi_select. */
export function answerText(f: AccessField | undefined, v: AccessAnswer | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (f?.type === "boolean" && typeof v === "string" && /^(yes|no)$/i.test(v)) return /^yes$/i.test(v) ? "Yes" : "No";
  const label = (x: string) => f?.options?.find((o) => o.value === x)?.label ?? x;
  return Array.isArray(v) ? v.map((x) => label(String(x))).join(", ") : label(String(v));
}

/** What the answers say of the requester (the fields declared `person`, mold_v0-171), in their order: "Head of DevRel". */
export function personText(fields: readonly AccessField[], answers: Record<string, unknown> | null | undefined): string {
  const a = isObject(answers) ? answers : {};
  return fields.filter((f) => f.person).map((f) => answerText(f, typeof a[f.key] === "string" ? (a[f.key] as string).trim() : null)).filter(Boolean).join(" · ");
}

/**
 * The answers of a stored request in the order the build declares its fields, then any answer it no longer declares (an
 * older form's) under its key: [label, text, field].
 */
export function labelledAnswers(fields: readonly AccessField[], answers: Record<string, unknown> | null | undefined): { key: string; label: string; text: string; field?: AccessField }[] {
  const a = isObject(answers) ? answers : {};
  const out: { key: string; label: string; text: string; field?: AccessField }[] = [];
  const asAnswer = (v: unknown): AccessAnswer | null => (typeof v === "string" ? v : Array.isArray(v) ? v.map(String) : v === null || v === undefined ? null : String(v));
  for (const f of fields) {
    const t = answerText(f, asAnswer(a[f.key]));
    if (t) out.push({ key: f.key, label: f.label, text: t, field: f });
  }
  for (const [k, v] of Object.entries(a)) {
    if (fields.some((f) => f.key === k)) continue;
    const t = answerText(undefined, asAnswer(v));
    if (t) out.push({ key: k, label: k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), text: t });
  }
  return out;
}

// ---------- the form as one JSON config (mold_v0-266, mold_v0-289) ----------
//
// One JSON shape, the access-request form, end to end: the packs' or profile.json's `access_request` may declare the
// whole of it (a block whose fields include email; its words are optional), it is what Admin › Access requests › Edit
// early access form reads and writes (a table of its fields), and it drives the public form (rendering and validation by
// data type), the stored request, the Access requests list columns and side panel, the CSV and the notification email,
// with no per-field code. Staff's saved copy (src/access-pages.ts, versioned and audited) wins over the declared one.
// Nothing saved and nothing declared: every form is exactly what the build declares (the shell's fields, the packs' or
// profile.json's fields, the landing's request_page), drawn by the same code as before. Saved: the whole form, as staff
// left it, every field the shell's own included:
//
//   { "fields": [{ "key": "email", "label": "Work email", "type": "email", "required": true },
//                { "key": "company", "label": "Organisation", "type": "text", "required": false },
//                { "key": "seats", "label": "Seats", "type": "number", "help": "Roughly is fine." }, ...],
//     "submit": "Request access", "thanks": { "title": "Request sent", "lines": ["We will email {email}."] } }
//
// The shell's own fields (email, name, company, message) keep their keys and land in the request's own columns; any other
// is stored under answers, as a pack's. Email is always asked, required and of the email kind; the others may be hidden,
// optional, required or retyped (not to several choices: each is one column). A hidden field is not asked and an answer
// sent for it is dropped. The defaults the editor starts from are what the build shows today (defaultRequestForm).

/** Every data type the table offers: text, long text, email, number, choice, multi-choice, web address, date, yes or no. */
export const FORM_FIELD_TYPES = ACCESS_FIELD_TYPES;
/** The shell's own fields, in the request's own columns: their keys are fixed, and email is always asked. */
export const SHELL_FORM_KEYS = ["email", "name", "company", "message"] as const;
export type ShellFormKey = (typeof SHELL_FORM_KEYS)[number];
/** The longest each of the shell's own columns keeps (POST /api/access-requests cut them at these before mold_v0-266). */
export const SHELL_FIELD_MAX: Record<ShellFormKey, number> = { email: 254, name: 120, company: 200, message: 4000 };
export const MAX_FORM_FIELDS = 40;
const MAX_THANKS_LINES = 6;

export interface FormField extends AccessField {
  /** Not asked: the field stays in the form (and its older answers keep their label), the public page leaves it out. */
  hidden?: boolean;
}
export interface AccessFormConfig {
  fields: FormField[];
  /** The submit button's words. */
  submit: string;
  /** What the person reads once it is sent: a title and one to six lines; {email} and {company} are their own. */
  thanks: { title: string; lines: string[] };
}
const FORM_FIELD_KEYS = [...FIELD_KEYS, "hidden"];
const isShell = (k: string): k is ShellFormKey => (SHELL_FORM_KEYS as readonly string[]).includes(k);
export const isShellFormKey = isShell;

/** Text that may hold the named {tokens} and nothing else in braces. */
const tokenProblem = (v: unknown, max: number, tokens: readonly string[]) =>
  typeof v !== "string" ? "text is required" : plainProblem(tokens.reduce((t, k) => t.split(`{${k}}`).join(k), v), max + 20 * tokens.length) ?? (v.length > max ? `at most ${max} characters` : null);

/** Whether an access_request block is a whole form (its fields include email; mold_v0-289). */
function isWholeForm(spec: unknown): boolean {
  return isObject(spec) && Array.isArray(spec.fields) && spec.fields.some((f) => isObject(f) && f.key === "email");
}
/** A declared whole form with its words filled in when it leaves them out. */
function wholeForm(spec: Partial<AccessFormConfig>): AccessFormConfig {
  return { fields: spec.fields ?? [], submit: spec.submit ?? "Request access", thanks: spec.thanks ?? { title: "Request sent", lines: ["We will email {email} once it is approved."] } };
}
/** A form's own questions (not the shell's columns). */
const ownFields = (form: AccessFormConfig): AccessField[] => form.fields.filter((f) => !isShell(f.key));

/** Every problem with a saved form (AccessFormConfig), as "fields[i].x: ...". */
export function accessFormProblems(cfg: unknown): string[] {
  const out: string[] = [];
  if (!isObject(cfg)) return ["the form: an object with fields, submit and thanks"];
  for (const k of Object.keys(cfg)) if (!["fields", "submit", "thanks"].includes(k)) out.push(`${k}: unknown key (known: fields, submit, thanks)`);
  const sp = plainProblem(cfg.submit, 60);
  if (sp) out.push(`submit: ${sp}`);
  const th = cfg.thanks;
  if (!isObject(th)) out.push("thanks: an object with title and lines");
  else {
    for (const k of Object.keys(th)) if (k !== "title" && k !== "lines") out.push(`thanks.${k}: unknown key (known: title, lines)`);
    const tp = plainProblem(th.title, 80);
    if (tp) out.push(`thanks.title: ${tp}`);
    if (!Array.isArray(th.lines) || !th.lines.length || th.lines.length > MAX_THANKS_LINES) out.push(`thanks.lines: 1 to ${MAX_THANKS_LINES} lines`);
    else th.lines.forEach((l, i) => { const p = tokenProblem(l, 300, ["email", "company"]); if (p) out.push(`thanks.lines[${i}]: ${p} ({email} and {company} are the only words in braces)`); });
  }
  const fields = cfg.fields;
  if (!Array.isArray(fields) || !fields.length) return [...out, `fields: a list of 1 to ${MAX_FORM_FIELDS} fields`];
  if (fields.length > MAX_FORM_FIELDS) out.push(`fields: at most ${MAX_FORM_FIELDS} fields`);
  const seen = new Set<string>();
  fields.forEach((f, i) => {
    const at = `fields[${i}]`;
    if (!isObject(f)) { out.push(`${at}: an object with key, label and type`); return; }
    for (const k of Object.keys(f)) if (!FORM_FIELD_KEYS.includes(k)) out.push(`${at}.${k}: unknown key (known: ${FORM_FIELD_KEYS.join(", ")})`);
    const key = f.key;
    if (typeof key !== "string" || !KEY.test(key)) { out.push(`${at}.key: 1-40 lowercase letters, digits or _, starting with a letter`); return; }
    if (key === "source") out.push(`${at}.key: source is where the request came from, never a question`);
    if (seen.has(key)) out.push(`${at}.key: ${key} is in the form twice`);
    seen.add(key);
    const lp = plainProblem(f.label, 80);
    if (lp) out.push(`${at}.label: ${lp}`);
    const type = f.type as FieldKind;
    if (!(FORM_FIELD_TYPES as readonly string[]).includes(type)) { out.push(`${at}.type: one of ${FORM_FIELD_TYPES.join(", ")}`); return; }
    for (const k of ["required", "hidden", "person"] as const) if (f[k] !== undefined && typeof f[k] !== "boolean") out.push(`${at}.${k}: true or false`);
    if (f.required === true && f.hidden === true) out.push(`${at}: a hidden field cannot be required`);
    if (key === "email") {
      if (type !== "email") out.push(`${at}.type: the email field is always an email address`);
      if (f.required !== true) out.push(`${at}.required: the email field is always required`);
      if (f.hidden === true) out.push(`${at}.hidden: the email field is always asked`);
    } else if (isShell(key) && type === "multi_select") out.push(`${at}.type: ${key} is one answer (its own column): any kind but several choices`);
    if (f.person === true && (type !== "text" && type !== "select" || isShell(key))) out.push(`${at}.person: only a text or select answer of your own (not the shell's ${SHELL_FORM_KEYS.join(", ")}) says who the requester is`);
    for (const [k, max] of [["help", 200], ["placeholder", 120]] as const) {
      if (f[k] === undefined) continue;
      const p = plainProblem(f[k], max);
      if (p) out.push(`${at}.${k}: ${p}`);
    }
    const choice = type === "select" || type === "multi_select";
    if (choice) {
      if (f.max_length !== undefined) out.push(`${at}.max_length: only for a field one types into`);
      if (f.placeholder !== undefined && type === "multi_select") out.push(`${at}.placeholder: not for a field of several choices`);
      const opts = f.options;
      if (!Array.isArray(opts) || !opts.length || opts.length > MAX_OPTIONS) { out.push(`${at}.options: a list of 1 to ${MAX_OPTIONS} options`); return; }
      const values = new Set<string>();
      opts.forEach((o, j) => {
        const oat = `${at}.options[${j}]`;
        if (!isObject(o)) { out.push(`${oat}: an object with value and label`); return; }
        for (const k of Object.keys(o)) if (k !== "value" && k !== "label") out.push(`${oat}.${k}: unknown key (known: value, label)`);
        const vp = plainProblem(o.value, 80);
        if (vp) out.push(`${oat}.value: ${vp}`);
        else if (o.value !== (o.value as string).trim()) out.push(`${oat}.value: no space at either end`);
        else if (values.has(o.value as string)) out.push(`${oat}.value: ${o.value} is offered twice`);
        else values.add(o.value as string);
        const p = plainProblem(o.label, 80);
        if (p) out.push(`${oat}.label: ${p}`);
      });
    } else {
      if (f.options !== undefined) out.push(`${at}.options: only for a field of one or several choices`);
      const ceiling = isShell(key) ? Math.min(SHELL_FIELD_MAX[key], MAX_LENGTH[type]) : MAX_LENGTH[type];
      if (f.max_length !== undefined && (!Number.isInteger(f.max_length) || (f.max_length as number) < 1 || (f.max_length as number) > ceiling))
        out.push(`${at}.max_length: a whole number from 1 to ${ceiling}`);
    }
  });
  if (!seen.has("email")) out.push("fields: the email field is always in the form");
  return out;
}

/** A checked form with nothing but the known keys. */
export function formOf(cfg: AccessFormConfig): AccessFormConfig {
  const pick = (f: FormField) => Object.fromEntries(FORM_FIELD_KEYS.flatMap((k) => (f[k as keyof FormField] === undefined ? [] : [[k, f[k as keyof FormField]]]))) as unknown as FormField;
  return { fields: cfg.fields.map(pick), submit: cfg.submit, thanks: { title: cfg.thanks.title, lines: [...cfg.thanks.lines] } };
}

/** The fields a form asks (not hidden), in its order. */
export const askedFields = (cfg: AccessFormConfig) => cfg.fields.filter((f) => !f.hidden);

/** A request's own facts and its answers, checked against a saved form. */
export interface FormSubmission { email: string; name: string; company: string; message: string; answers: Record<string, AccessAnswer>; problem: string | null }

/**
 * A request checked against the form in force (mold_v0-266): email always; the shell's other fields as the form asks
 * them (a hidden one is left empty, whatever was sent); every other field it asks, under answers (answersOf), a field it
 * hides or never had dropped. -> what to store, or the first problem, naming the field's label.
 */
export function formSubmission(body: unknown, cfg: AccessFormConfig): FormSubmission {
  const b = isObject(body) ? body : {};
  const out: FormSubmission = { email: "", name: "", company: "", message: "", answers: {}, problem: null };
  const fail = (problem: string) => ({ ...out, answers: {}, problem });
  const email = typeof b.email === "string" ? b.email.trim().slice(0, 200) : "";
  if (!EMAIL.test(email)) return fail("Please enter a valid email.");
  out.email = email;
  for (const key of ["name", "company", "message"] as const) {
    const f = cfg.fields.find((x) => x.key === key);
    if (!f || f.hidden) continue;
    // As before mold_v0-266, a longer answer is cut at its column's length (the form's own limit is the browser's), and an
    // empty required one is asked for in the words the API always used ("Please tell us your company.").
    const max = Math.min(f.max_length ?? SHELL_FIELD_MAX[key], SHELL_FIELD_MAX[key]);
    const raw = typeof b[key] === "string" ? (b[key] as string).trim().slice(0, max) : b[key];
    if (f.required && (raw === undefined || raw === null || raw === "")) return fail(key === "company" && f.label === "Company" ? "Please tell us your company." : `${f.label} is required.`);
    const one = answersOf({ answers: { [key]: raw } }, [{ ...f, max_length: max }]);
    if (one.problem) return fail(one.problem);
    out[key] = typeof one.answers[key] === "string" ? (one.answers[key] as string) : "";
  }
  const own = askedFields(cfg).filter((f) => !isShell(f.key));
  const { answers, problem } = answersOf(b, own);
  if (problem) return fail(problem);
  out.answers = answers;
  return out;
}

/**
 * The fields whose labels name a stored request's answers (Admin › Access requests, list_access_requests, the alert email):
 * a saved form's own fields (hidden ones too: their older answers keep their label), then the build's declared ones it
 * no longer has. Without a saved form, the build's.
 */
export function labelFields(declared: readonly AccessField[], cfg: AccessFormConfig | null | undefined): AccessField[] {
  if (!cfg) return [...declared];
  const mine = cfg.fields.filter((f) => !isShell(f.key)) as AccessField[];
  return [...mine, ...declared.filter((d) => !mine.some((f) => f.key === d.key))];
}

/** A line said once sent, with the sender's company and address in it. */
export const thanksLine = (line: string, company: string, email: string) =>
  line.replace(/\{company\}/g, company || "your company").replace(/\{email\}/g, email || "you");

/** The words the shell's own forms say in the build's words ({product} filled by the caller: src/vocabulary.ts fill). */
export interface FormWords {
  /** "What would you like to use {product} for?" */
  message: string;
  /** /request-access: "Thank you. The {product} team will look at it". */
  thanks: string;
  /** The request page: "The {product} team looks at your request." */
  first_step: string;
}
/** The landing's request page's form (src/landing.ts request_page.form). */
export interface RequestPageFormSpec { submit?: string; message_label?: string; fields?: string[]; more?: { label: string; fields?: string[] }; done?: { title: string; steps?: string[] } }

const own = (f: AccessField): FormField => ({ ...f });

/**
 * What the build shows today, as a form the editor starts from (and Reset to defaults returns to): the shell's
 * /request-access form, or, when the landing has a request page, that page's form (its order, its fold's fields, the
 * placeholders, its submit and done words; a declared field the page does not ask is there, hidden).
 */
export function defaultRequestForm(declared: readonly AccessField[], words: FormWords, page?: RequestPageFormSpec | null): AccessFormConfig {
  if (!page) {
    return {
      fields: [
        { key: "email", label: "Work email", type: "email", required: true, max_length: 200 },
        { key: "name", label: "Your name", type: "text", max_length: 120 },
        { key: "company", label: "Company", type: "text", required: true, max_length: 200 },
        ...declared.map(own),
        { key: "message", label: words.message, type: "long_text", max_length: 4000 },
      ],
      submit: "Request access",
      thanks: { title: "Request sent", lines: [`${words.thanks} and, once it is approved, send an invitation to {email}. Nothing else is needed from you for now.`] },
    };
  }
  const byKey = (keys: readonly string[]) => keys.flatMap((k) => declared.filter((f) => f.key === k));
  const folded = byKey(page.more?.fields ?? []);
  const shown = page.fields ? byKey(page.fields) : declared.filter((f) => !folded.includes(f));
  const notAsked = declared.filter((f) => !shown.includes(f) && !folded.includes(f));
  const name: FormField = { key: "name", label: "Your name", type: "text", max_length: 120 };
  return {
    fields: [
      { key: "email", label: "Work email", type: "email", required: true, placeholder: "you@company.com", max_length: 254 },
      { key: "company", label: "Company", type: "text", required: true, placeholder: "Acme", max_length: 200 },
      ...(page.more ? [...shown.map(own), name, ...folded.map(own)] : [name, ...shown.map(own)]),
      ...notAsked.map(({ required: _asked, ...f }): FormField => ({ ...f, hidden: true })),
      { key: "message", label: page.message_label ?? words.message, type: "long_text", max_length: 4000 },
    ],
    submit: page.submit ?? "Request access",
    thanks: { title: page.done?.title ?? "Request sent", lines: page.done?.steps ?? [words.first_step, "Once it is approved, an invitation goes to {email}."] },
  };
}
