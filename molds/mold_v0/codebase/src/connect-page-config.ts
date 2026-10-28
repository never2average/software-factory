/**
 * The connect guide (mold_v0-171): one public page that walks a customer from nothing to a first answer, at an address
 * the app chose (the first product's was /connect.html, a link it sent to customers). The shell draws it from config and
 * from what it knows itself (src/install-pages.ts mounts it), next to the generated per-client pages at /install:
 *
 *   the header        the brand (its icon and name, a link to /) and the page's own link (`header_link`, such as the
 *                     request page)
 *   the connector     the build's MCP address (src/console-url.ts mcpUrl: the front door), how a client signs in, and,
 *                     where member keys are on, how a key goes in a header (never the address); with a link to /app
 *   the clients       each `clients` entry: a heading and its numbered steps
 *   the skill         `skill`: a heading, a lead and the steps to install it, around the generated download button of the
 *                     build's client skill (src/client-skill.ts, /downloads/<file>)
 *   the first run     `first_run`: cards (a title and a text each) and a closing note
 *   the footer        "© <year> <product>", `footer.tagline` and `footer.links`
 *
 * A pack declares it in pack.json `connect_page` (one pack per build); a build without one has no such page. Pure, no
 * imports: scripts/gen-packs.mjs runs the same rules (node strips the types) and carries the checked block to the
 * server (src/hosts.generated.ts PACK_CONFIG, src/host.ts connectPageConfig).
 *
 *   "connect_page": {
 *     "path": "/connect.html",            where it is served: a path of its own (never one of the shell's, CONNECT_RESERVED)
 *     "title": "Connect Acme",            the browser's title (one line, up to 120)
 *     "description": "...",               the search engines' summary (optional, up to 300)
 *     "heading": "Connect Acme", "lead": "...",
 *     "accent": "#d9400f", "accent_dark": "#ff6a3d",   the links' and button's colour, light and dark (optional)
 *     "header_link": {"label": "Request access", "href": "/early-access"},
 *     "clients": [{"name": "Claude (web & desktop)", "steps": ["Open **Settings → Connectors**.", ...]}],
 *     "skill": {"heading": "...", "lead": "...", "steps": ["Select `{skill_file}`. ..."]},
 *     "first_run": {"heading": "Your first run", "cards": [{"title": "1. Onboard", "text": "..."}], "note": "..."},
 *     "footer": {"tagline": "...", "links": [{"label": "Home", "href": "/"}]}
 *   }
 *
 * Texts are one line each. Inside them `**bold**`, `` `code` `` and `[a link](/path)` are drawn (a link's address a path on
 * this site, an #anchor of the page or an https:// address); everything else is shown as written (escaped), and
 * {product} and {skill_file} are filled. No other brace.
 */

export interface ConnectLink { label: string; href: string }
export interface ConnectPageConfig {
  path: string;
  title: string;
  description?: string;
  heading: string;
  lead: string;
  accent?: string;
  accent_dark?: string;
  header_link?: ConnectLink;
  clients: { name: string; steps: string[] }[];
  skill?: { heading: string; lead?: string; steps?: string[] };
  first_run?: { heading: string; cards: { title: string; text: string }[]; note?: string };
  footer?: { tagline?: string; links?: ConnectLink[] };
}

export const CONNECT_PAGE_KEYS = ["path", "title", "description", "heading", "lead", "accent", "accent_dark", "header_link", "clients", "skill", "first_run", "footer"] as const;
/** The shell's own addresses (and everything under them): a connect page is never one of them. */
export const CONNECT_RESERVED = ["/install", "/install.json", "/mcp", "/api", "/app", "/admin", "/auth", "/oauth", "/.well-known", "/downloads", "/healthz", "/host", "/declared", "/_next"];
const PATH = /^\/[a-z0-9][a-z0-9._-]{0,60}(\/[a-z0-9][a-z0-9._-]{0,60}){0,3}$/;
const COLOUR = /^#[0-9a-f]{6}$/i;
/** A link's address: a path on this site, an anchor of the page, or an https address. */
export const HREF = /^(\/[A-Za-z0-9._~\-/]*(#[A-Za-z0-9_-]+)?|#[A-Za-z0-9_-]+|https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~\-/%?=&#]*)?)$/;
/** The placeholders a text may use. */
const PLACEHOLDERS = ["product", "skill_file"];
/** Characters a one-line text may not hold (control, line breaks, invisible and bidirectional characters). */
const NOT_PLAIN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A text's problem, or null: one line, up to `max`, no brace but a known placeholder, and every link's address one of HREF. */
export function textProblem(v: unknown, max: number): string | null {
  if (typeof v !== "string" || !v.trim()) return "text is required";
  if (v.length > max) return `at most ${max} characters`;
  if (NOT_PLAIN.test(v)) return "plain text on one line: no line breaks, control or invisible characters";
  const braces = v.replace(/\{([a-z_]+)\}/g, (m, k: string) => (PLACEHOLDERS.includes(k) ? "" : m));
  if (/[{}]/.test(braces)) return `no braces but the placeholders ${PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}`;
  for (const m of v.matchAll(/\]\(([^)\s]*)\)/g)) if (!HREF.test(m[1]!)) return `a link's address is a path on this site, an #anchor or an https:// address (not ${m[1]!.slice(0, 60)})`;
  return null;
}

/** Every problem of a `connect_page` block, as "connect_page.<field>: message"; [] when it is well formed. */
export function connectPageProblems(v: unknown, at = "connect_page"): string[] {
  if (!isObject(v)) return [`${at}: an object (path, title, heading, lead, clients; the rest optional)`];
  const out: string[] = [];
  const say = (k: string, p: string | null) => { if (p) out.push(`${at}.${k}: ${p}`); };
  const keys = (o: Record<string, unknown>, where: string, known: readonly string[]) => {
    for (const k of Object.keys(o)) if (k !== "$comment" && !known.includes(k)) out.push(`${at}${where}.${k}: unknown field (known: ${known.join(", ")})`);
  };
  const list = (x: unknown, where: string, min: number, max: number): unknown[] | null => {
    if (!Array.isArray(x) || x.length < min || x.length > max) { say(where, `a list of ${min} to ${max}`); return null; }
    return x;
  };
  const link = (x: unknown, where: string) => {
    if (!isObject(x)) { say(where, "an object {label, href}"); return; }
    keys(x, `.${where}`, ["label", "href"]);
    say(`${where}.label`, textProblem(x.label, 60));
    if (typeof x.href !== "string" || !HREF.test(x.href)) say(`${where}.href`, "a path on this site, an #anchor or an https:// address");
  };
  keys(v, "", CONNECT_PAGE_KEYS);
  if (v.$comment !== undefined && (typeof v.$comment !== "string" || v.$comment.length > 2000)) say("$comment", "text of up to 2000 characters");
  const p = v.path;
  if (typeof p !== "string" || !PATH.test(p) || p.includes("..")) say("path", "a path of its own: lowercase letters, digits, ., _ and -, up to four segments (\"/connect.html\")");
  else {
    const hit = CONNECT_RESERVED.find((r) => p === r || p.startsWith(`${r}/`) || p.startsWith(`${r}.`));
    if (hit || p === "/") say("path", `${p} is the shell's own address (${hit ?? "/"}): choose another`);
  }
  say("title", textProblem(v.title, 120));
  if (v.description !== undefined) say("description", textProblem(v.description, 300));
  say("heading", textProblem(v.heading, 120));
  say("lead", textProblem(v.lead, 600));
  for (const k of ["accent", "accent_dark"] as const) if (v[k] !== undefined && (typeof v[k] !== "string" || !COLOUR.test(v[k] as string))) say(k, "a colour as #rrggbb");
  if (v.header_link !== undefined) link(v.header_link, "header_link");
  const clients = list(v.clients, "clients", 1, 8);
  clients?.forEach((c, i) => {
    const w = `clients[${i}]`;
    if (!isObject(c)) { say(w, "an object {name, steps}"); return; }
    keys(c, `.${w}`, ["name", "steps"]);
    say(`${w}.name`, textProblem(c.name, 80));
    list(c.steps, `${w}.steps`, 1, 10)?.forEach((s, j) => say(`${w}.steps[${j}]`, textProblem(s, 600)));
  });
  if (v.skill !== undefined) {
    const s = v.skill;
    if (!isObject(s)) say("skill", "an object {heading, lead, steps}");
    else {
      keys(s, ".skill", ["heading", "lead", "steps"]);
      say("skill.heading", textProblem(s.heading, 120));
      if (s.lead !== undefined) say("skill.lead", textProblem(s.lead, 600));
      if (s.steps !== undefined) list(s.steps, "skill.steps", 1, 10)?.forEach((x, j) => say(`skill.steps[${j}]`, textProblem(x, 600)));
    }
  }
  if (v.first_run !== undefined) {
    const f = v.first_run;
    if (!isObject(f)) say("first_run", "an object {heading, cards, note}");
    else {
      keys(f, ".first_run", ["heading", "cards", "note"]);
      say("first_run.heading", textProblem(f.heading, 120));
      list(f.cards, "first_run.cards", 1, 6)?.forEach((c, j) => {
        const w = `first_run.cards[${j}]`;
        if (!isObject(c)) { say(w, "an object {title, text}"); return; }
        keys(c, `.${w}`, ["title", "text"]);
        say(`${w}.title`, textProblem(c.title, 80));
        say(`${w}.text`, textProblem(c.text, 400));
      });
      if (f.note !== undefined) say("first_run.note", textProblem(f.note, 600));
    }
  }
  if (v.footer !== undefined) {
    const f = v.footer;
    if (!isObject(f)) say("footer", "an object {tagline, links}");
    else {
      keys(f, ".footer", ["tagline", "links"]);
      if (f.tagline !== undefined) say("footer.tagline", textProblem(f.tagline, 120));
      if (f.links !== undefined) list(f.links, "footer.links", 1, 6)?.forEach((l, j) => link(l, `footer.links[${j}]`));
    }
  }
  return out;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * One text as HTML: escaped, its placeholders filled, then `**bold**`, `` `code` `` and `[label](href)` drawn (an address
 * that is not one of HREF stays text). Code is never read for the other two.
 */
export function inlineHtml(text: string, fill: Record<string, string>): string {
  const filled = text.replace(/\{([a-z_]+)\}/g, (m, k: string) => fill[k] ?? m);
  return filled.split(/(`[^`]+`)/).map((part) => {
    if (/^`[^`]+`$/.test(part)) return `<code>${esc(part.slice(1, -1))}</code>`;
    return esc(part)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, href: string) => {
        const raw = href.replace(/&amp;/g, "&");
        return HREF.test(raw) ? `<a href="${esc(raw)}">${label}</a>` : m;
      });
  }).join("");
}
