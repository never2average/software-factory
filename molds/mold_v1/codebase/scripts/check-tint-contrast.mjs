#!/usr/bin/env node
/**
 * TEXT ON A TINTED PANEL MUST READ 4.5:1 (WCAG 2.1 AA, 1.4.3) ON EVERY SURFACE THE PANEL CAN SIT ON.
 *
 * The notice pattern this app uses everywhere — `bg-amber-500/10 text-amber-700`, `bg-red-500/10 text-red-600`, … —
 * puts a translucent tint over whatever surface is underneath, and the light theme's surfaces are not white:
 * --background is oklch(0.971 0 0) and --muted is oklch(0.94 0 0). A shade that clears 4.5:1 on a white tint fails on
 * those. The accessibility lane found exactly that live: the chat sidebar's "Your chat list isn't saving" notice
 * rendered #bb4d00 (amber-700) on #f6ead7 (amber-500/10 over muted/20 over the page) at 4.23:1, against 4.5:1 needed.
 * Nothing the type checker or a build sees catches this, and the notice only shows when a save fails, so a screenshot
 * of the happy path never shows it either.
 *
 * This check reads every string literal under app/, components/ and lib/ that carries BOTH an unprefixed text colour
 * from the palette (`text-<hue>-<shade>[/<alpha>]`) and an unprefixed palette background (`bg-<hue>-<shade>[/<alpha>]`),
 * composites the background over each light surface token in app/globals.css, and fails when the text falls under
 * 4.5:1 on any of them. A `dark:text-…` in the same literal is checked the same way against the dark surface tokens
 * (with the `dark:bg-…` if there is one, else the unprefixed background). The colours come from the installed
 * tailwindcss theme.css and from globals.css, never from a copy, so a palette or token change is re-checked.
 *
 * The maths is the browser's: oklch -> linear sRGB -> gamma-encoded sRGB clipped to gamut and rounded to 8 bits,
 * alpha composited in that space, then WCAG relative luminance. --self-test pins it to the live axe measurement above.
 *
 * NOT CHECKED: a colour pair split across separate literals (e.g. two arguments of cn()), arbitrary values
 * (`text-[#…]`), state variants (hover:, focus:, …), and large text, which WCAG lets read 3:1 — every literal here
 * is held to 4.5:1, the stricter bar.
 *
 *   node scripts/check-tint-contrast.mjs              check the tree
 *   node scripts/check-tint-contrast.mjs --self-test  prove the maths and the rule, both ways
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ROOTS = ["app", "components", "lib"];
const SOURCE = /\.(?:tsx|ts|jsx|js|mjs)$/;
const REQUIRED = 4.5;
/** The surfaces a panel can sit on, per theme. A tint is composited over each; the worst one decides. */
const SURFACES = ["background", "card", "muted", "popover", "secondary", "accent"];

// ---- colour maths ------------------------------------------------------------------------------------------------

/** "oklch(55.5% 0.163 48.998)" | "oklch(0.971 0 0)" -> [r,g,b] 0..255, gamma-encoded, clipped, rounded. */
export function oklchToRgb(css) {
  const m = /oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(css);
  if (!m) throw new Error(`not an oklch() colour: ${css}`);
  const L = Number(m[1]) / (m[2] ? 100 : 1);
  const C = Number(m[3]);
  const h = (Number(m[4]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const [l, mm, s] = [l_ ** 3, m_ ** 3, s_ ** 3];
  const lin = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ];
  return lin.map((v) => {
    const c = Math.min(1, Math.max(0, v));
    const g = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(g * 255);
  });
}

/** Source-over: `top` at `alpha` (0..1) over opaque `under`, per 8-bit channel, as the browser paints it. */
export const over = (top, alpha, under) => top.map((c, i) => Math.round(c * alpha + under[i] * (1 - alpha)));

const luminance = (rgb) => {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratio = (x, y) => {
  const [a, b] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
};
export const hex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;

// ---- inputs ------------------------------------------------------------------------------------------------------

export function palette() {
  const themeCss = createRequire(path.join(ROOT, "package.json")).resolve("tailwindcss/theme.css");
  const out = new Map();
  for (const m of readFileSync(themeCss, "utf8").matchAll(/--color-([a-z]+-\d{2,3}):\s*(oklch\([^)]*\))/g)) {
    out.set(m[1], oklchToRgb(m[2]));
  }
  if (!out.size) throw new Error(`no palette colours found in ${themeCss}`);
  return out;
}

/** The surface tokens of the light (:root) and dark ([data-theme="dark"]) blocks of app/globals.css. */
export function surfaces(css) {
  const block = (sel) => {
    const i = css.indexOf(sel);
    if (i < 0) throw new Error(`app/globals.css has no ${sel} block`);
    const body = css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i));
    const out = {};
    for (const name of SURFACES) {
      const m = new RegExp(`--${name}:\\s*(oklch\\([^)]*\\))`).exec(body);
      if (!m) throw new Error(`app/globals.css ${sel} does not define --${name}`);
      out[name] = oklchToRgb(m[1]);
    }
    return out;
  };
  return { light: block(":root {"), dark: block('[data-theme="dark"] {') };
}

// ---- the rule ----------------------------------------------------------------------------------------------------

const COLOUR = (prefix, util) =>
  new RegExp(`(?:^|\\s)${prefix.replace(":", "\\:")}${util}-([a-z]+-\\d{2,3})(?:/(\\d{1,3}))?(?=\\s|$)`);

/** The pairs one class list asks the browser to paint: [{ theme, fg, fgAlpha, bg, bgAlpha }]. */
export function pairsIn(classes) {
  const grab = (prefix, util) => {
    const m = COLOUR(prefix, util).exec(classes);
    return m ? { name: m[1], alpha: m[2] ? Number(m[2]) / 100 : 1 } : null;
  };
  const bg = grab("", "bg");
  if (!bg) return [];
  const out = [];
  const fg = grab("", "text");
  if (fg) out.push({ theme: "light", fg, bg });
  const dfg = grab("dark:", "text");
  if (dfg) out.push({ theme: "dark", fg: dfg, bg: grab("dark:", "bg") ?? bg });
  return out;
}

/** Worst contrast of one pair over the theme's surfaces: { ratio, fgHex, bgHex, surface } or null if unknown colours. */
export function worst(pair, pal, surf) {
  const fg = pal.get(pair.fg.name);
  const bg = pal.get(pair.bg.name);
  if (!fg || !bg) return null;
  let low = null;
  for (const [surface, base] of Object.entries(surf[pair.theme])) {
    const under = over(bg, pair.bg.alpha, base);
    const text = over(fg, pair.fg.alpha, under);
    const r = ratio(text, under);
    if (!low || r < low.ratio) low = { ratio: r, fgHex: hex(text), bgHex: hex(under), surface };
  }
  return low;
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (SOURCE.test(name) && !name.endsWith(".d.ts")) yield p;
  }
}

const LITERAL = /"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g;

export function findings(text, pal, surf) {
  const out = [];
  for (const m of text.matchAll(LITERAL)) {
    const classes = m[1] ?? m[2] ?? m[3];
    for (const pair of pairsIn(classes)) {
      const w = worst(pair, pal, surf);
      if (w && w.ratio < REQUIRED) {
        const line = text.slice(0, m.index).split("\n").length;
        out.push({ line, pair, ...w });
      }
    }
  }
  return out;
}

// ---- self-test ---------------------------------------------------------------------------------------------------

function selfTest() {
  const pal = palette();
  const surf = surfaces(readFileSync(path.join(ROOT, "app/globals.css"), "utf8"));
  const fails = [];
  const expect = (ok, what) => (ok ? console.log(`  ok   ${what}`) : fails.push(what));

  // The live measurement (accessibility lane, chat sidebar notice): axe read #bb4d00 on #f6ead7, 4.23:1. That
  // deployment's page colour was brand-tinted, so the background is pinned as measured rather than rebuilt from
  // this file's tokens; the replacement shade must clear it with room for a tint like it.
  const amber700 = pal.get("amber-700");
  expect(hex(amber700) === "#bb4d00", `amber-700 renders #bb4d00 as axe measured it (got ${hex(amber700)})`);
  const live = [0xf6, 0xea, 0xd7];
  const r = ratio(amber700, live);
  expect(Math.abs(r - 4.23) < 0.01, `amber-700 on the measured #f6ead7 reads 4.23:1, axe's own figure (got ${r.toFixed(2)})`);
  const r8 = ratio(pal.get("amber-800"), live);
  expect(r8 >= 5, `amber-800 on the same #f6ead7 reads at least 5:1 (got ${r8.toFixed(2)})`);

  // The rule, both ways.
  const bad = findings('<div className="bg-amber-500/10 text-amber-700 text-3xs" />', pal, surf);
  expect(bad.length === 1 && bad[0].ratio < REQUIRED, "flags text-amber-700 on bg-amber-500/10");
  const good = findings('<div className="bg-amber-500/10 text-amber-800 dark:text-amber-400" />', pal, surf);
  expect(good.length === 0, "passes text-amber-800 on bg-amber-500/10, and dark:text-amber-400 over the dark surfaces");
  const darkBad = findings('<div className="bg-amber-500/10 text-amber-800 dark:text-amber-700" />', pal, surf);
  expect(darkBad.length === 1 && darkBad[0].pair.theme === "dark", "flags a dark: text colour that fails on the dark surfaces");
  const prefixed = findings('<div className="hover:bg-amber-500/10 text-amber-700" />', pal, surf);
  expect(prefixed.length === 0, "ignores a state-prefixed background (not what is painted at rest)");
  const fgAlpha = findings('<div className="bg-red-500/10 text-red-800/40" />', pal, surf);
  expect(fgAlpha.length === 1, "applies a text colour's own alpha (text-red-800/40 fails)");

  if (fails.length) {
    for (const f of fails) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log("check-tint-contrast self-test: ok");
}

// ---- main --------------------------------------------------------------------------------------------------------

function main() {
  const pal = palette();
  const surf = surfaces(readFileSync(path.join(ROOT, "app/globals.css"), "utf8"));
  let n = 0;
  let checked = 0;
  for (const root of ROOTS) {
    const dir = path.join(ROOT, root);
    try {
      statSync(dir);
    } catch {
      continue;
    }
    for (const file of files(dir)) {
      const text = readFileSync(file, "utf8");
      checked++;
      for (const f of findings(text, pal, surf)) {
        n++;
        const rel = path.relative(ROOT, file);
        const want = f.pair.theme === "dark" ? "dark:text" : "text";
        console.error(
          `${rel}:${f.line}  ${want}-${f.pair.fg.name}${f.pair.fg.alpha < 1 ? `/${f.pair.fg.alpha * 100}` : ""} on ` +
            `bg-${f.pair.bg.name}/${Math.round(f.pair.bg.alpha * 100)} (${f.pair.theme}, over --${f.surface}): ` +
            `${f.fgHex} on ${f.bgHex} = ${f.ratio.toFixed(2)}:1, needs ${REQUIRED}:1`,
        );
      }
    }
  }
  if (n) {
    console.error(`\n${n} tinted text pair(s) under ${REQUIRED}:1. Use a darker shade in light mode (a lighter one in dark).`);
    process.exit(1);
  }
  console.log(`check-tint-contrast: ${checked} files, every tinted text pair reads ${REQUIRED}:1 on every surface`);
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct && process.argv.includes("--self-test")) selfTest();
else if (direct) main();
