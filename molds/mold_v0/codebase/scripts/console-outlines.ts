// Every button has a visible outline (mold_v0-251): a static scan of the console's source (web/src), run by
// test:console-tabs (and on its own: tsx scripts/console-outlines.ts [web/src]; exit 1 with the findings).
// What a page measures in a browser is testing/console/outlines.mjs (render.py --suite outlines); this keeps a change from
// adding a button without an outline in the first place:
//   1. The shared variants (components/ui/button.tsx buttonVariants, components/ui/toggle.tsx toggleVariants): every
//      variant draws a border on all four sides in a colour (the theme's border token, or its own fill's), none drops it.
//   2. A class handed to the shared Button (or a component built on it) never drops the border (border-0, border-none,
//      border-transparent).
//   3. A raw <button> (also one handed to a trigger's `render`, and a trigger that draws its own button: PopoverTrigger,
//      DropdownMenuTrigger, CollapsibleTrigger, a primitive's .Trigger...) carries the shared variants
//      (buttonVariants(...)) or a border class of its own, unless it is not a button to a person (role tab, radio,
//      switch, checkbox, option, menu item) or sits inside a frame that outlines it (data-outline='group': a chip, a
//      segmented control).
//   4. No <div>, <span>, <li>... acts as a button (role='button', or an onClick that does more than stop the click from
//      reaching the row): use the shared Button.
// The sidebar's navigation is left as it is, by design: its files are not scanned (SIDEBAR below). An exception is a line
// in ALLOW with its reason.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// The console's own TypeScript (web/package.json pins 5.x): its compiler API parses the TSX. The shell's (7.x, native)
// has no JavaScript API, so its types are not imported here either: a node is `N`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;
const ts: N = createRequire(path.join(import.meta.dirname, "..", "web", "package.json"))("typescript");

/** The sidebar's navigation: its entries stay as they are (the operator's call, mold_v0-251). */
export const SIDEBAR = ["components/ui/sidebar.tsx", "components/layout/app-sidebar.tsx", "components/nav-main.tsx", "components/nav-user.tsx", "components/org-switcher.tsx",
  // The docs' own page list, a sidebar inside the docs page (its <nav data-sidebar-nav>, which the browser check skips too).
  "features/docs/docs-nav.tsx"];

/** Exceptions: [file, a piece of the offending element's source, why]. */
export const ALLOW: [string, string, string][] = [
  ["lib/auth/builtin-client.tsx", "role='presentation' onClick={go}", "wraps the caller's own button (already outlined) to sign out on its click; never drawn alone"],
  ["components/kbar/ask-ai.tsx", "onClick={onLinkClick}", "one listener for the links inside an answer (it follows the clicked <a>); not a control itself"],
  ["app/global-error.tsx", "<button", "the last-resort error page draws without the console's styles (inline style, its own border)"],
  ["components/ui/input-group.tsx", "data-slot='input-group-addon'", "a click on the box's label or icon moves the focus into its text box (mouse only); the box is outlined, the addon is not a control"],
  ["components/ui/table/data-table-filter-clear.tsx", "role='button'", "the clear mark inside a filter's trigger, which is the shared outlined Button (a button inside a button is invalid HTML)"],
  ["components/ui/calendar.tsx", "data-day=", "a date picker's day cells: a grid of dates (the grid is the control, framed by its popover); its month arrows are outlined Buttons"],
  ["components/ui/infobar.tsx", "data-infobar='rail'", "the info panel's edge, a pointer-only handle out of the tab order, like the sidebar's rail"],
  ["features/tabs/tab-action.tsx", "data-side-panel-backdrop=''", "the dimmed page behind a form's side panel (mold_v0-256): a click outside the panel closes it (pointer only, aria-hidden); Esc and the panel's outlined Close and Cancel buttons are its controls"],
];

/** Roles that are not a button to a person: each has its own look (tabs, switches, boxes, menu items). */
const NOT_BUTTON = new Set(["tab", "radio", "switch", "checkbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "slider", "treeitem", "presentation", "none", "link"]);
/** Components that draw the shared Button (their classes go through buttonVariants). */
const SHARED = new Set(["Button", "InputGroupButton", "LoadingButton", "SubmitButton", "ToolbarAction", "CopyButton", "Toggle", "ToggleGroupItem", "PaginationLink", "PaginationPrevious", "PaginationNext"]);
/** Triggers that draw a raw <button> of their own unless handed one through `render`. */
const RAW_TRIGGER = /^(Popover|DropdownMenu|Collapsible|Sheet|Dialog|AlertDialog|Drawer|Tooltip|PreviewCard|HoverCard|Menu|ContextMenu|Menubar)Trigger$/;
/** A primitive's trigger inside a components/ui wrapper: unstyled there, it passes its caller's button through (the
 *  caller is scanned as one of the triggers above); styled there, its classes must carry the outline. */
const PRIMITIVE_TRIGGER = /^[A-Za-z]+Primitive\.(Trigger|SubmenuTrigger)$/;
/** Triggers with a look of their own (a field, a tab, the sidebar's): judged in their own files. */
const STYLED_TRIGGER = new Set(["SelectTrigger", "TabsTrigger", "SidebarTrigger", "ComboboxTrigger", "AccordionTrigger", "InfobarTrigger", "DropdownMenuSubTrigger", "MenubarTrigger", "NavigationMenuTrigger", "SelectPrimitive.Trigger", "TabsPrimitive.Tab", "NavigationMenuPrimitive.Trigger", "ComboboxPrimitive.Trigger", "MenuPrimitive.SubmenuTrigger", "ContextMenuPrimitive.SubmenuTrigger", "ContextMenuPrimitive.Trigger"]);
const NOT_A_CONTROL = new Set(["div", "span", "li", "ul", "p", "td", "tr", "th", "img", "label", "section", "article", "header", "footer", "nav", "figure", "svg", "small", "strong", "em", "code", "pre"]);

const plain = (tokens: string[]) => tokens.filter((t) => !t.includes(":"));
const DROPS = /^(border-0|border-none|border-transparent|border-hidden)$/;
/** A border on all four sides: `border` or `border-<n>` (not one side: border-b, border-x...). */
const hasBorder = (tokens: string[]) => plain(tokens).some((t) => /^border(-[0-9]+|-\[[^\]]+\])?$/.test(t)) && !plain(tokens).some((t) => DROPS.test(t));

/** The string pieces of a class expression: literals, templates, and cn()/clsx() arguments, both arms of a condition. */
function classTokens(e: N | undefined): { tokens: string[]; variants: boolean } {
  const out: string[] = [];
  let variants = false;
  const walk = (n: N | undefined) => {
    if (!n) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) { out.push(...n.text.split(/\s+/).filter(Boolean)); return; }
    if (ts.isTemplateExpression(n)) { out.push(...n.head.text.split(/\s+/).filter(Boolean)); for (const s of n.templateSpans) { walk(s.expression); out.push(...s.literal.text.split(/\s+/).filter(Boolean)); } return; }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /Variants$/.test(n.expression.text)) { variants = true; }
    if (ts.isJsxExpression(n)) return walk(n.expression);
    ts.forEachChild(n, walk);
  };
  walk(e);
  return { tokens: out, variants };
}

const tagName = (t: N) => t.getText();
function attr(el: N, name: string) {
  return el.attributes.properties.find((p: N) => ts.isJsxAttribute(p) && p.name.getText() === name);
}
const attrText = (a: N | undefined) =>
  !a?.initializer ? undefined : ts.isStringLiteral(a.initializer) ? a.initializer.text : ts.isJsxExpression(a.initializer) && a.initializer.expression && ts.isStringLiteral(a.initializer.expression) ? a.initializer.expression.text : a.initializer.getText();

/** 1. A cva() of a shared control: every variant, with the base, draws a coloured border on all four sides. */
function scanVariants(file: string, src: N, rel: string, findings: string[]) {
  const visit = (n: N) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "cva" && n.arguments[1] && ts.isObjectLiteralExpression(n.arguments[1])) {
      const base = classTokens(n.arguments[0]).tokens;
      const vs = n.arguments[1].properties.find((p: N) => p.name?.getText() === "variants");
      const variant = vs && ts.isPropertyAssignment(vs) && ts.isObjectLiteralExpression(vs.initializer) ? vs.initializer.properties.find((p: N) => p.name?.getText() === "variant") : undefined;
      if (!variant || !ts.isPropertyAssignment(variant) || !ts.isObjectLiteralExpression(variant.initializer)) { findings.push(`${rel}: its cva() has no variant list to judge`); return; }
      for (const p of variant.initializer.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const own = classTokens(p.initializer).tokens, all = [...base, ...own];
        const colour = plain(all).some((t) => /^border-(?!0$|none$|transparent$|hidden$|[xytblrse]$|[xytblrse]-|[0-9]|\[)/.test(t));
        if (!hasBorder(all) || !colour || plain(own).some((t) => DROPS.test(t)))
          findings.push(`${rel}: variant '${p.name.getText().replace(/['"]/g, "")}' draws no visible outline (needs \`border\` and a border colour such as border-border; has: ${plain(all).filter((t) => t.startsWith("border")).join(" ") || "none"})`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
}

/** Scan one console source tree; returns the findings (empty: every button outlined). */
export function scanOutlines(webSrc: string): string[] {
  const findings: string[] = [];
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".tsx")) files.push(p); } };
  walk(webSrc);
  for (const file of files.sort()) {
    const rel = path.relative(webSrc, file).split(path.sep).join("/");
    if (SIDEBAR.includes(rel)) continue;
    const text = readFileSync(file, "utf8");
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    if (rel === "components/ui/button.tsx" || rel === "components/ui/toggle.tsx") scanVariants(file, src, rel, findings);
    const allowed = (el: N) => ALLOW.some(([f, piece]) => f === rel && el.getText().includes(piece));
    const line = (n: N) => src.getLineAndCharacterOfPosition(n.getStart()).line + 1;
    const say = (n: N, what: string) => { if (!allowed(n)) findings.push(`${rel}:${line(n)}: ${what}`); };
    /** Inside a frame that outlines its parts (data-outline='group'), in this file. */
    const inGroup = (n: N) => {
      for (let p: N | undefined = n.parent; p; p = p.parent) {
        const o = ts.isJsxElement(p) ? p.openingElement : ts.isJsxSelfClosingElement(p) ? p : undefined;
        if (o && attrText(attr(o, "data-outline")) === "group") return true;
      }
      return false;
    };
    const visit = (n: N) => {
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const tag = tagName(n.tagName);
        const role = attrText(attr(n, "role"));
        const cls = classTokens(attr(n, "className"));
        const render = attr(n, "render");
        if (tag === "button") {
          if (!(role && NOT_BUTTON.has(role)) && !cls.variants && !hasBorder(cls.tokens) && !inGroup(n))
            say(n, `a raw <button> without an outline ("${n.parent.getText().replace(/\s+/g, " ").slice(0, 70)}"): use the shared Button (components/ui/button.tsx), or give it \`border\``);
        } else if (SHARED.has(tag)) {
          const drop = plain(cls.tokens).find((t) => DROPS.test(t));
          if (drop) say(n, `<${tag}> handed \`${drop}\`, which drops the shared outline`);
        } else if (PRIMITIVE_TRIGGER.test(tag) && !STYLED_TRIGGER.has(tag) && !render && plain(cls.tokens).length && !cls.variants && !hasBorder(cls.tokens)) {
          say(n, `<${tag}> is styled here without an outline: give it \`border\` and a border colour`);
        } else if ((RAW_TRIGGER.test(tag) && !STYLED_TRIGGER.has(tag)) && !render && !cls.variants && !hasBorder(cls.tokens) && !inGroup(n)) {
          if (!(role && NOT_BUTTON.has(role))) say(n, `<${tag}> draws a raw button without an outline: hand it the shared Button (render={<Button variant='outline' />})`);
        } else if (NOT_A_CONTROL.has(tag) && !(role && NOT_BUTTON.has(role))) {
          const click = attr(n, "onClick");
          const onlyStops = click && /^\{?\s*\(?\s*\w*\s*\)?\s*=>\s*\{?\s*\w+\.stopPropagation\(\)\s*;?\s*\}?\s*\}?$/.test(click.initializer?.getText() ?? "");
          if (role === "button") say(n, `<${tag} role='button'> acts as a button: use the shared Button`);
          else if (click && !onlyStops) say(n, `<${tag} onClick> acts as a button: use the shared Button`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("console-outlines.ts")) {
  const dir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "..", "web", "src"));
  const f = scanOutlines(dir);
  for (const x of f) console.log(`✗ ${x}`);
  console.log(f.length ? `${f.length} control(s) without an outline in ${dir}` : `✓ every button in ${dir} has an outline`);
  process.exit(f.length ? 1 : 0);
}
