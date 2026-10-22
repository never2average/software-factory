// The docs corpus behind the docs answers (src/docs-answers.ts): the customer guide (web/src/content/customer-guide.ts,
// the text /app/docs renders) and the internal docs (docs/**/*.md, what /admin/docs renders), cut at their h2/h3
// headings into chunks {area, title, href, heading, text}, written to src/docs-corpus.generated.json. Hrefs use the
// pages' own slugs and heading anchors, so a citation opens the section it came from. The smoke test fails when the
// committed file is stale.
//   npx tsx scripts/sync-docs-corpus.ts          write it
//   npx tsx scripts/sync-docs-corpus.ts --check  exit 1 if it differs from the docs
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostPackDirs } from "./lib/host-packs.js";
import path from "node:path";
import { CUSTOMER_DOCS_PATH, guidePages, type ToolCatalog } from "../web/src/content/customer-guide.js";
import { markdownSections } from "../web/src/content/docs-text.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "src/docs-corpus.generated.json");
const DOCS = path.join(ROOT, "docs");
/** A section longer than this is cut at paragraphs into several chunks with the same heading (one excerpt each). */
const MAX_CHARS = 1800;

export interface DocsChunk { area: "customer" | "admin"; title: string; href: string; heading: string | null; text: string }

/** Markdown as excerpt text: link targets and images dropped (their text stays), blank-line runs squeezed. */
const plain = (md: string) =>
  md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();

function pieces(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n\s*\n/)) {
    if (cur && cur.length + para.length + 2 > MAX_CHARS) { out.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${para}` : para;
    while (cur.length > MAX_CHARS * 1.5) { out.push(cur.slice(0, MAX_CHARS)); cur = cur.slice(MAX_CHARS); } // one huge table or code block
  }
  if (cur) out.push(cur);
  return out;
}

/** One page's chunks: its lead (before the first heading) at the page's href, then each section at its anchor. */
function pageChunks(area: DocsChunk["area"], title: string, href: string, md: string): DocsChunk[] {
  return markdownSections(md).flatMap((s) => {
    const text = plain(s.body);
    if (!text) return [];
    return pieces(text).map((t) => ({ area, title, href: s.heading ? `${href}#${s.heading.id}` : href, heading: s.heading?.text ?? null, text: t }));
  });
}

const walk = (dir: string): string[] => readdirSync(dir).sort().flatMap((name) => {
  const p = path.join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : name.endsWith(".md") ? [p] : [];
});

export function docsCorpus(): DocsChunk[] {
  const catalog = JSON.parse(readFileSync(path.join(ROOT, "web/src/content/mcp-tools.generated.json"), "utf8")) as ToolCatalog;
  const customer = guidePages(catalog).flatMap((p) => pageChunks("customer", p.title, `${CUSTOMER_DOCS_PATH}/${p.slug}`, p.body));
  // The same slugs, titles and body as web/scripts/sync-docs.mjs and features/docs/admin-docs.tsx.
  // The shell's docs and a host pack's own (mold_v0-039: packs/<id>/docs), as one folder, in web/scripts/sync-docs.mjs's order.
  const roots = [DOCS, ...hostPackDirs(ROOT).map((p) => path.join(p.dir, "docs")).filter((d) => existsSync(d))];
  const bySegments = (a: string, b: string) => { const x = a.split("/"), y = b.split("/"); for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return x.length - y.length; };
  const files = roots.flatMap((root) => walk(root).map((file) => ({ file, rel: path.relative(root, file).split(path.sep).join("/") }))).sort((a, b) => bySegments(a.rel, b.rel));
  const admin = files.flatMap(({ file, rel }) => {
    const body = readFileSync(file, "utf8");
    const title = body.match(/^#\s+(.+)$/m)?.[1].trim() ?? rel;
    const slug = rel.replace(/\.md$/, "").replace(/\//g, "-");
    return pageChunks("admin", title, `/admin/docs/${slug}`, body.replace(/^\s*#\s+.+\n/, ""));
  });
  return [...customer, ...admin];
}

const render = () => `${JSON.stringify({ generated_by: "scripts/sync-docs-corpus.ts: do not edit, change the docs and rerun it", chunks: docsCorpus() }, null, 1)}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const json = render();
  if (process.argv.includes("--check")) {
    const ok = (() => { try { return readFileSync(OUT, "utf8") === json; } catch { return false; } })();
    console.log(ok ? "docs-corpus.generated.json is current" : "docs-corpus.generated.json is stale: run npx tsx scripts/sync-docs-corpus.ts");
    process.exit(ok ? 0 : 1);
  }
  writeFileSync(OUT, json);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}
