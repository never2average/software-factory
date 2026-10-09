"use client";

/**
 * Streamdown's plugins, loaded the first time a message needs one.
 *
 * `{ cjk, code, math, mermaid }` used to be imported at the top of message.tsx and reasoning.tsx, which put shiki
 * (its oniguruma engine included), katex and mermaid into the first-load JavaScript of every page that can show a
 * message: about a megabyte and a half of brotli-compressed script downloaded, parsed and compiled before the person
 * had typed a word, for a chat that usually holds prose. Each plugin is now fetched when a rendered message actually
 * contains what it renders: a code fence (code), a ```mermaid fence (mermaid), `$$` (math), CJK text (cjk).
 *
 * While a plugin loads the message renders without it, which is Streamdown's own plain output for that block: a code
 * fence is the same box, uncoloured; a diagram is its source in a code box; `$$…$$` is its source text.
 *
 * EACH MESSAGE GETS ONLY THE PLUGINS IT NEEDS, as one object per combination that never changes once built. So a
 * plugin arriving for one message changes nothing for any other: a diagram already drawn in another message is not
 * re-rendered, let alone remounted. The parser plugins (math, cjk) are the exception for their OWN message only:
 * Streamdown memoises each block by its markdown, so a remark/rehype plugin that lands after the first render is only
 * applied by remounting that message (`streamdownParseKey`).
 */

import { useEffect, useSyncExternalStore } from "react";
import type { PluginConfig } from "streamdown";

export type StreamdownPluginKey = "cjk" | "code" | "math" | "mermaid";

// A fence and its info string, ANYWHERE on a line: a fence inside a list item or a blockquote is indented or
// prefixed (`1.     ```mermaid`, `> ```python`), and a check that only looked at the start of a line left those as
// source forever. Detection errs on the side of loading: a stray ``` costs one chunk, a missed fence costs the render.
const FENCE = /(`{3,}|~{3,})[ \t]*([^\s`~]*)/g;
// remark-math is configured without single-dollar inline math, so only `$$` opens math.
const MATH = /\$\$/;
// Han, Hiragana/Katakana, Hangul and full-width forms: what remark-cjk-friendly exists for.
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/;

/** Which plugins this markdown needs. Pure; exported for tests. */
export function neededStreamdownPlugins(text: string | null | undefined, opts?: { mermaid?: boolean }): StreamdownPluginKey[] {
  const out: StreamdownPluginKey[] = [];
  if (!text) return opts?.mermaid ? ["mermaid"] : out;
  let fences = 0;
  let mermaidFences = 0;
  let labelledCode = false;
  for (const m of text.matchAll(FENCE)) {
    fences += 1;
    const info = m[2].toLowerCase();
    if (info === "mermaid") mermaidFences += 1;
    else if (info) labelledCode = true;
  }
  const mermaid = Boolean(opts?.mermaid) || mermaidFences > 0;
  // Every diagram accounts for two fence marks (open, close); any mark beyond those is a code block (or might be).
  const code = labelledCode || fences > mermaidFences * 2;
  if (code) out.push("code");
  if (mermaid) out.push("mermaid");
  if (MATH.test(text)) out.push("math");
  if (CJK.test(text)) out.push("cjk");
  return out;
}

const LOADERS: Record<StreamdownPluginKey, () => Promise<Partial<PluginConfig>>> = {
  code: () => import("@streamdown/code").then((m) => ({ code: m.code })),
  mermaid: () => import("@streamdown/mermaid").then((m) => ({ mermaid: m.mermaid })),
  math: () =>
    Promise.all([
      import("@streamdown/math"),
      // The plugin asks for katex's stylesheet (getStyles) and nothing loaded it, so formulas rendered unstyled.
      import("katex/dist/katex.min.css").catch(() => undefined),
    ]).then(([m]) => ({ math: m.math })),
  cjk: () => import("@streamdown/cjk").then((m) => ({ cjk: m.cjk })),
};

let snapshot: PluginConfig = {};
const EMPTY: PluginConfig = {};
const inflight = new Map<StreamdownPluginKey, Promise<void>>();
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Start loading `key` (once per page). Resolves when it is in the snapshot; a failed load may be retried later. */
export function loadStreamdownPlugin(key: StreamdownPluginKey): Promise<void> {
  if (snapshot[key]) return Promise.resolve();
  let p = inflight.get(key);
  if (!p) {
    p = LOADERS[key]()
      .then((part) => {
        snapshot = { ...snapshot, ...part };
        for (const fn of listeners) fn();
      })
      .catch(() => {
        // Offline or a stale deployment's chunk: the message stays plain, and the next render may try again.
        inflight.delete(key);
      });
    inflight.set(key, p);
  }
  return p;
}

/** One object per combination of loaded plugins, so a message's `plugins` prop only changes when ITS set changes. */
const combos = new Map<string, PluginConfig>();
function pluginsFor(keys: readonly StreamdownPluginKey[], loaded: PluginConfig): PluginConfig {
  const have = keys.filter((k) => loaded[k]);
  const id = have.join(",");
  let c = combos.get(id);
  if (!c) {
    c = Object.fromEntries(have.map((k) => [k, loaded[k]])) as PluginConfig;
    combos.set(id, c);
  }
  return c;
}

/**
 * The plugins to hand Streamdown for `text`: those this text needs that have loaded, and a load started for any that
 * have not. `mermaid: true` asks for the diagram plugin whatever the text (a caller that renders a diagram on purpose).
 */
export function useStreamdownPlugins(text: string | null | undefined, opts?: { mermaid?: boolean }): PluginConfig {
  const needs = neededStreamdownPlugins(text, opts);
  // Subscribed to ITS plugins only: the snapshot is this message's combination, the same object until one of its
  // own plugins lands, so React skips re-rendering it when another message's plugin arrives. (A re-render reaches
  // Streamdown's diagram, whose effect then draws the diagram again: a drawn mermaid SVG was replaced, and the page
  // jumped, every time an unrelated message's katex arrived.)
  const plugins = useSyncExternalStore(
    subscribe,
    () => pluginsFor(needs, snapshot),
    () => EMPTY,
  );
  const missing = needs.filter((k) => !plugins[k]).join(",");
  useEffect(() => {
    if (!missing) return;
    for (const k of missing.split(",") as StreamdownPluginKey[]) void loadStreamdownPlugin(k);
  }, [missing]);
  return plugins;
}

/**
 * A key for the message's <Streamdown> that changes when one of ITS parser plugins (math, cjk) arrives: Streamdown
 * memoises blocks by their markdown, so a remark/rehype plugin that lands later is only applied by a remount. Built
 * from the message's own plugins, so no other message remounts.
 */
export function streamdownParseKey(plugins: PluginConfig): string {
  return `${plugins.math ? "m" : ""}${plugins.cjk ? "c" : ""}`;
}
