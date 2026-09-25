#!/usr/bin/env node
/**
 * NO INVENTED RECORDS IN A REAL WORKSPACE — the product never shows a person bundled sample accounts or people.
 *
 * Why this exists (factory task mold_v1-120): the data room's Master.xlsx previews were built from the bundled
 * data/customers.json and data/people.json, so EVERY live workspace showed "Acme Bank" and "Northwind Capital",
 * and its People → Internal Staff sheet listed a real person's email as a "Forward-Deployed Engineer" on those
 * invented accounts. The chat's company picker started from the same bundled list and kept it whenever the
 * workspace had no companies, so a person could ground a chat on an id that does not exist. And the no-database
 * fallback wrote its store back into data/customers.json, so a local run's records ("Surface Probe Co") shipped
 * in the next bundle.
 *
 * Two passes over a PRODUCTION build (`npm run build` first; CI's Build step leaves one in .next/):
 *
 *   1. THE BUILT BUNDLE: every file under .next/static/ (what a browser downloads) and every prerendered page under
 *      .next/server/app/ is searched for the sample records' names and emails (read from the sample and fixture
 *      files themselves, so a new sample record is covered without editing this) and for any @onfinance.in address.
 *   2. RENDERED PAGES: `next start`, Chromium, the ops API faked (scripts/lib/rendered-text.mjs):
 *        - an EMPTY workspace: the data room's Master.xlsx previews and the chat's company picker show the empty
 *          state in the profile's words ("No customers yet"), never a sample record;
 *        - a workspace WITH records: they show those records;
 *        - the picker while its list is loading, and when the list could not be read, says so (with a Retry that
 *          loads it);
 *        - the data room while its records load, when they could not be read, when ONE table could not be read (that
 *          sheet says so, the others still show their records: never "no records" over real ones), and when a table
 *          was capped (the sheet says it shows only the first rows).
 *
 *   npm run check:no-sample-data                 both passes (needs Chromium: npx playwright install chromium)
 *   npm run check:no-sample-data -- --no-render  the bundle only
 *   npm run check:no-sample-data -- --dir <d>    a built checkout other than this one
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { renderedText } from "./lib/rendered-text.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const argAfter = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
const DIR = argAfter("--dir") ?? ROOT;
const NO_RENDER = process.argv.includes("--no-render");

const { W } = await import(join(ROOT, "lib/ui-words.ts"));
const { DEPLOYMENT_PROFILE } = await import(join(ROOT, "lib/deployment-profile.generated.ts"));

/* ------------------------------------------------------------------------------------------- the needles */

/**
 * What a sample record is recognised by: every account's name and legal name, every person's name, and every
 * email anywhere in the sample and fixture files. Read from the files, wherever this checkout keeps them (the
 * sample set moved from data/*.json to data/sample/; both are read so this also runs against the old layout).
 * Ids (`acme-bank`) are not needles: the product's own help text uses one as an example of the id format.
 */
const SAMPLE_FILES = [
  "data/sample/customers.json",
  "data/sample/people.json",
  "data/customers.json",
  "data/people.json",
  "scripts/fixtures/customers.fixture.json",
  "scripts/fixtures/people.fixture.json",
].filter((f) => existsSync(join(ROOT, f)));

/** The records this task found in live workspaces, pinned so they stay caught whatever the files say. */
const KNOWN = ["Acme Bank", "Northwind Capital", "Surface Probe Co", "priyesh@onfinance.in"];

function needles() {
  const found = new Set(KNOWN);
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const walk = (v, key) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
    if (v && typeof v === "object") return Object.entries(v).forEach(([k, x]) => walk(x, k));
    if (typeof v !== "string") return;
    if (EMAIL.test(v)) found.add(v);
    else if (["name", "legalEntityName", "employerOrg"].includes(key) && v.trim().length >= 6 && /\s/.test(v)) found.add(v);
  };
  for (const f of SAMPLE_FILES) walk(JSON.parse(readFileSync(join(ROOT, f), "utf8")));
  // The product's own company is the operator, not sample data: "OnFinance" as an employer is not a needle.
  return [...found].filter((n) => !/^onfinance$/i.test(n));
}
const NEEDLES = needles();
/** Any address at the operator's own domain is a real person's, whatever file it came from. */
const REAL_EMAIL = /[A-Za-z0-9._%+-]+@onfinance\.in\b/g;

/* ------------------------------------------------------------------------------------------- 1. the bundle */

function bundleFiles(dir) {
  const out = [];
  const walk = (d, keep) => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p, keep);
      else if (keep(n)) out.push(p);
    }
  };
  walk(join(dir, ".next/static"), (n) => /\.(js|mjs|css|html|json|txt|map)$/.test(n) && !n.endsWith(".map"));
  walk(join(dir, ".next/server/app"), (n) => /\.(html|rsc|body|meta)$/.test(n));
  return out;
}

function scanBundle(dir) {
  const files = bundleFiles(dir);
  if (!files.some((f) => f.includes("/.next/static/"))) {
    console.error(`check-no-sample-data: no production build in ${relative(process.cwd(), dir) || "."}/.next — run \`npm run build\` first.`);
    process.exit(2);
  }
  const hits = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const n of NEEDLES) if (text.includes(n)) hits.push({ file: relative(dir, f), what: n });
    for (const m of new Set(text.match(REAL_EMAIL) ?? [])) if (!NEEDLES.includes(m)) hits.push({ file: relative(dir, f), what: m });
  }
  return { files: files.length, hits };
}

/* ------------------------------------------------------------------------------------------- 2. rendered */

const EMPTY_ACCOUNTS = `No ${W.accounts} yet`;
const PICKER = DEPLOYMENT_PROFILE.vocabulary.account_context;
const EMPTY_PEOPLE = { internalStaffAssignments: [], customerStakeholders: [] };
/** A real workspace's records, as the org-scoped APIs answer: neutral invented data, none of it a sample record. */
const REAL = {
  customers: [{ id: "harbor-lane", name: "Harbor Lane Finance", tier: "Enterprise", status: "On Track", fdeOwner: "dana.ruiz@harbor.example" }],
  people: {
    internalStaffAssignments: [{ customer_id: "harbor-lane", staffRole: "solution_engineer", name: "Dana Ruiz", title: "Engagement lead", employerOrg: "Harbor Lane", email: "dana.ruiz@harbor.example" }],
    customerStakeholders: [{ customer_id: "harbor-lane", stakeholderRole: "champion", name: "Ola Brandt", title: "Head of Research", employerOrg: "Harbor Lane Finance", email: "ola.brandt@harbor.example" }],
  },
};
const REAL_OPTIONS = { customers: [{ id: "harbor-lane", name: "Harbor Lane Finance" }], items: [{ id: "harbor-lane", name: "Harbor Lane Finance" }] };
const NO_OPTIONS = { customers: [], items: [] };

/** Each case: what it renders, what it must show, and that it shows no sample record. */
const CASES = [
  {
    name: "empty workspace: accounts Master.xlsx",
    path: "/?dataroom=customers",
    ready: "Master.xlsx",
    mocks: { "/api/ops/workbook": { customers: [], people: EMPTY_PEOPLE }, "/api/ops/customers": NO_OPTIONS },
    shows: [EMPTY_ACCOUNTS],
  },
  {
    name: "empty workspace: People Master.xlsx",
    path: "/?dataroom=people",
    ready: "Master.xlsx",
    mocks: { "/api/ops/workbook": { customers: [], people: EMPTY_PEOPLE }, "/api/ops/customers": NO_OPTIONS },
    shows: [EMPTY_ACCOUNTS],
  },
  {
    name: "empty workspace: Tickets Master.xlsx",
    path: "/?dataroom=tickets",
    ready: "Master.xlsx",
    mocks: { "/api/ops/workbook": { customers: [], people: EMPTY_PEOPLE }, "/api/ops/customers": NO_OPTIONS },
    shows: [EMPTY_ACCOUNTS],
  },
  {
    name: "empty workspace: chat picker",
    path: "/",
    ready: "css:textarea",
    mocks: { "/api/ops/customers": NO_OPTIONS },
    then: [{ click: PICKER, expect: "css:[cmdk-input]" }],
    shows: [EMPTY_ACCOUNTS],
  },
  {
    name: "real records: accounts Master.xlsx",
    path: "/?dataroom=customers",
    ready: "Master.xlsx",
    mocks: { "/api/ops/workbook": REAL, "/api/ops/customers": REAL_OPTIONS },
    shows: ["Harbor Lane Finance", "dana.ruiz@harbor.example"],
    hides: [EMPTY_ACCOUNTS],
  },
  {
    name: "real records: People Master.xlsx",
    path: "/?dataroom=people",
    ready: "Master.xlsx",
    mocks: { "/api/ops/workbook": REAL, "/api/ops/customers": REAL_OPTIONS },
    shows: ["Dana Ruiz", "dana.ruiz@harbor.example"],
    hides: [EMPTY_ACCOUNTS],
  },
  {
    name: "real records: chat picker",
    path: "/",
    ready: "css:textarea",
    mocks: { "/api/ops/customers": REAL_OPTIONS },
    then: [{ click: PICKER, expect: "Harbor Lane Finance" }],
    shows: ["Harbor Lane Finance"],
    hides: [EMPTY_ACCOUNTS],
  },
  {
    name: "chat picker while its list loads",
    path: "/",
    ready: "css:textarea",
    mocks: { "/api/ops/customers": { $delayMs: 8_000, $body: REAL_OPTIONS } },
    then: [{ click: PICKER, expect: "css:[cmdk-input]" }],
    shows: [`Loading ${W.accounts}`],
    hides: [EMPTY_ACCOUNTS],
  },
  {
    name: "chat picker when its list could not be read",
    path: "/",
    ready: "css:textarea",
    mocks: { "/api/ops/customers": { $status: 503, $body: { error: "store unavailable" } } },
    then: [{ click: PICKER, expect: "css:[cmdk-input]" }],
    shows: [`could not be loaded`],
    hides: [EMPTY_ACCOUNTS],
  },
  {
    name: "chat picker Retry after a failed read loads the list",
    path: "/",
    ready: "css:textarea",
    mocks: { "/api/ops/customers": { $status: 503, $body: { error: "store unavailable" } } },
    then: [
      { click: PICKER, expect: "could not be loaded", keepOpen: true },
      { mocks: { "/api/ops/customers": REAL_OPTIONS }, click: "Retry", expect: "Harbor Lane Finance" },
    ],
    shows: ["Harbor Lane Finance"],
  },
  {
    name: "data room while the records load",
    path: "/?dataroom=customers",
    ready: "Master.xlsx",
    mocks: { "/api/ops/workbook": { $delayMs: 8_000, $body: REAL } },
    shows: [`Loading ${W.account} records`],
    hides: [EMPTY_ACCOUNTS],
  },
  {
    name: "data room when the records could not be read",
    path: "/?dataroom=customers",
    ready: "Master.xlsx",
    mocks: { "/api/ops/workbook": { $status: 503, $body: { error: "store unavailable" } } },
    shows: ["could not be loaded"],
    hides: [EMPTY_ACCOUNTS],
  },
  {
    // One table that failed is that sheet's problem, said on that sheet: never "no records" over real ones.
    name: "one table could not be read: its sheet says so",
    path: "/?dataroom=tickets",
    ready: "Master.xlsx",
    mocks: { "/api/ops/workbook": { ...REAL, unavailable: ["tickets"] } },
    shows: ["could not be loaded"],
    hides: [EMPTY_ACCOUNTS, "No records."],
  },
  {
    name: "one table could not be read: the other sheets still show their records",
    path: "/?dataroom=customers",
    ready: "Master.xlsx",
    mocks: { "/api/ops/workbook": { ...REAL, unavailable: ["tickets"] } },
    shows: ["Harbor Lane Finance"],
    hides: [EMPTY_ACCOUNTS, "could not be loaded"],
  },
  {
    // A table past the route's cap is flagged, and the sheet says it is showing only part of it.
    name: "a capped table says it shows only the first rows",
    path: "/?dataroom=tickets",
    ready: "Master.xlsx",
    mocks: {
      "/api/ops/workbook": {
        ...REAL,
        customers: [{ ...REAL.customers[0], tickets: [{ ticketId: "HL-1", summary: "Refresh the Q2 model", ticketStatus: "Open" }] }],
        tables: { tickets: { rows: 5000, truncated: true, cap: 5000 } },
      },
    },
    shows: ["Showing the first 5,000", "Refresh the Q2 model"],
    hides: [EMPTY_ACCOUNTS],
  },
];

/* ------------------------------------------------------------------------------------------- run */

let failed = false;
const { files, hits } = scanBundle(DIR);
if (hits.length) {
  failed = true;
  console.error(`check-no-sample-data: the production client build carries sample records (${hits.length}):`);
  for (const h of hits.slice(0, 40)) console.error(`  ${h.file}: ${h.what}`);
} else {
  console.log(`check-no-sample-data: ${files} built client files and prerendered pages carry none of ${NEEDLES.length} sample names/emails, and no @onfinance.in address`);
}

if (!NO_RENDER) {
  const { lines, failures } = await renderedText({ dir: DIR, root: ROOT, specs: CASES });
  for (const c of CASES) {
    const seen = lines.filter((l) => l.name === c.name).map((l) => l.text);
    const all = seen.join("\n");
    const problems = [];
    const broke = failures.find((f) => f.name === c.name);
    if (broke) problems.push(broke.why);
    for (const s of c.shows ?? []) if (!all.includes(s)) problems.push(`does not show "${s}"`);
    for (const s of c.hides ?? []) if (all.includes(s)) problems.push(`shows "${s}"`);
    const leaked = NEEDLES.filter((n) => all.includes(n));
    if (leaked.length) problems.push(`shows sample records: ${leaked.join(", ")}`);
    if (problems.length) {
      failed = true;
      console.error(`check-no-sample-data: RENDERED ${c.path} — ${c.name}: ${problems.join("; ")}`);
    } else {
      console.log(`  ok   ${c.name}`);
    }
  }
}

if (failed) process.exit(1);
console.log("check-no-sample-data: no sample record reaches a person");
