// Every tab's Export, Import, Download and Ask AI live in its search row's one Actions ▾ menu (mold_v0-294,
// web/src/components/layout/actions-menu.tsx; lib/toolbar-actions.ts sets the order): a static scan of the console's
// source (web/src), run by test:console-tabs (and on its own: tsx scripts/console-actions-scan.ts [web/src]; exit 1 with
// the findings), the way scripts/console-outlines.ts keeps every button outlined. A finding is a button of its own
// (the shared Button or a component drawing it, a raw <button>, a menu or popover trigger handed a button):
//   1. labelled Export, Import, Download or Ask AI (its text, aria-label or title), or
//   2. carrying the download or upload icon,
// or (3) one of the old standalone controls by name (ExportCsvButton, ExportRowsButton, ExportButton). A menu's items
// (DropdownMenuItem, RowAction objects) are not buttons and are not scanned. An exception is a line in ALLOW with its
// reason: a file inside a record (a log's, a document's), a form's own submit, a file picker.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
const ts: N = createRequire(path.join(import.meta.dirname, "..", "web", "package.json"))("typescript");

/** The menu itself. */
const HOME = "components/layout/actions-menu.tsx";

/** Exceptions: [file, a piece of the offending element's source, why]. */
export const ALLOW: [string, string, string][] = [
  ["features/records/log-viewer.tsx", "data-log-download", "a record's log, downloaded from inside its own viewer (not a tab's search row)"],
  ["features/records/code-view.tsx", "data-code-download", "one stored file, downloaded from inside the record that holds it"],
  ["features/records/documents.tsx", "Download", "one stored document's card inside a record"],
  ["features/records/staff-import.tsx", "preview ?", "the import form's own submit (Preview, then Import), inside the import card"],
  ["features/tabs/tab-action.tsx", "Choose a file", "a form's file field (pick the file to upload into the record)"],
  ["features/admin/account-agent-icon.tsx", "Replace' : 'Upload'", "a form's image field (an account's agent icon)"],
  ["features/agent/recipes-page.tsx", "data-recipe-new-version", "a recipe's own New version, inside its record panel"],
  ["features/admin/keyvault.tsx", "Import ${rows.length} key", "the import dialog's own submit, inside the dialog Actions ▾ opened"],
  ["features/workspace-files/files-page.tsx", "download />}>Download", "one file of a workspace's stored files, downloaded from its own view"],
  ["components/layout/record-view.tsx", "Export selected", "the selection bar's bulk action (the ticked rows), shown only while rows are ticked"],
];

const SHARED = new Set(["Button", "InputGroupButton", "LoadingButton", "SubmitButton", "ToolbarAction", "CopyButton", "Toggle", "ToggleGroupItem"]);
const TRIGGER = /^(Popover|DropdownMenu|Collapsible|Sheet|Dialog|Drawer|Menu)Trigger$/;
const OLD = new Set(["ExportCsvButton", "ExportRowsButton", "ExportButton", "ImportButton", "AskAiButton"]);
const LABEL = /(^|[\s…])(Export|Import|Download|Ask AI)\b/;
const ICON = /^(Icons\.(download|upload)|IconDownload|IconUpload|IconFileExport|IconFileImport)$/;

const attr = (el: N, name: string) => el.attributes.properties.find((p: N) => ts.isJsxAttribute(p) && p.name.getText() === name);
const attrText = (a: N | undefined): string | undefined => {
  const i = a?.initializer;
  if (!i) return undefined;
  if (ts.isStringLiteral(i)) return i.text;
  const e = ts.isJsxExpression(i) ? i.expression : undefined;
  if (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))) return e.text;
  if (e && ts.isTemplateExpression(e)) return e.head.text;
  return undefined;
};

/** The element's own words and icons: its text, string literals in its children, and icon elements, outer to inner. */
function contents(node: N): { text: string; icon: boolean } {
  let text = "", icon = false;
  const walk = (n: N) => {
    if (ts.isJsxText(n)) text += n.text;
    else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) { if (ts.isJsxExpression(n.parent) || ts.isConditionalExpression(n.parent) || ts.isBinaryExpression(n.parent)) text += ` ${n.text}`; }
    else if (ts.isTemplateExpression(n)) text += ` ${n.head.text}`;
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && ICON.test(n.tagName.getText())) icon = true;
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(node, walk);
  return { text: text.replace(/\s+/g, " ").trim(), icon };
}

export function scanActions(webSrc: string): string[] {
  const findings: string[] = [];
  const used = new Set<(typeof ALLOW)[number]>();
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".tsx")) files.push(p); } };
  walk(webSrc);
  for (const file of files.sort()) {
    const rel = path.relative(webSrc, file).split(path.sep).join("/");
    if (rel === HOME || rel.startsWith("components/ui/")) continue;
    const text = readFileSync(file, "utf8");
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const report = (el: N, why: string) => {
      const piece = el.getText();
      const allowed = ALLOW.find(([f, frag]) => f === rel && piece.includes(frag));
      if (allowed) { used.add(allowed); return; }
      const { line } = src.getLineAndCharacterOfPosition(el.getStart());
      findings.push(`${rel}:${line + 1}: ${why} (move it into the search row's Actions ▾ menu, components/layout/actions-menu.tsx): ${piece.split("\n")[0].slice(0, 120)}`);
    };
    const visit = (n: N) => {
      const el = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
      if (el) {
        const tag = el.tagName.getText();
        const trigger = TRIGGER.test(tag) && !!attr(el, "render");
        if (OLD.has(tag)) report(n, `the old standalone control <${tag}>`);
        else if (SHARED.has(tag) || tag === "button" || trigger) {
          const c = ts.isJsxElement(n) ? contents(n) : { text: "", icon: false };
          const named = [attrText(attr(el, "aria-label")), attrText(attr(el, "title")), attrText(attr(el, "label")), c.text].find((x) => x && LABEL.test(x));
          if (named) report(n, `a button of its own labelled "${named.trim().slice(0, 40)}"`);
          else if (c.icon) report(n, "a button of its own with the download or upload icon");
          if (named || c.icon) return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  // An exception nothing needs any more is a finding too: the list stays exact.
  for (const a of ALLOW) if (!used.has(a)) findings.push(`${a[0]}: ALLOW's "${a[1]}" matches nothing (remove it)`);
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? path.join(import.meta.dirname, "..", "web", "src");
  const f = scanActions(dir);
  if (f.length) { console.error(`✗ ${f.length} Export, Import, Download or Ask AI control(s) outside the Actions ▾ menu:\n  ${f.join("\n  ")}`); process.exit(1); }
  console.log("✓ every Export, Import, Download and Ask AI is an item of a search row's Actions ▾ menu (scripts/console-actions-scan.ts)");
}
