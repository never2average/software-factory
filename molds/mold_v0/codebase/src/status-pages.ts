/**
 * Unknown addresses opened in a browser (mold_v0-131). The console sends every address that is not one of its pages to
 * this server (web/next.config.ts, the fallback rewrite), so an address that is neither the console's nor this server's
 * ends here. A browser asking for a page (GET or HEAD, Accept: text/html) gets the console's own not-found page, with
 * status 404: the standard status page every other part of the console shows (web/src/features/status/), fetched from
 * the console (consoleUrl()/console-status/not-found, a page that is always a 404) and kept for a minute. Everything
 * else (an API client, a tool, a script) gets this server's answer as before.
 *
 * When the console cannot be reached (this server alone, in development), a plain page in the same words. The fetch
 * carries x-status-relay, and a request that carries it is never relayed again, so a console address that leads back
 * here cannot loop; the console's page is recognised by its status page's marker (in its HTML, or in the page data when it is drawn in the
 * browser), never taken on trust.
 */
import type { NextFunction, Request, Response } from "express";
import { consoleUrl } from "./console-url.js";
import { PROFILE } from "./profile.js";

/** The console's page that is always a 404, drawn on the server (web/src/app/console-status/not-found/page.tsx; web/src/proxy.ts gives it its 404, mold_v0-155). */
export const NOT_FOUND_PAGE = "/console-status/not-found";
const RELAY_HEADER = "x-status-relay";
const KEEP_MS = 60_000;
const WAIT_MS = 2_500;

/** This server's own addresses: never answered with a page, whatever the client accepts. */
const API_PATHS = /^\/(api|mcp|gw|oauth|preview|install|\.well-known|admin\/session$|admin\/mcp$)(\/|$)|^\/(healthz|install\.json)$/;

/** The words of the console's not-found page (web/src/features/status/words.ts statusText('not_found'); scripts/status-pages-test.ts holds them equal). */
export const NOT_FOUND_WORDS = {
  title: "Page not found",
  body: "This page doesn't exist, has moved, or isn't open to you. Check the address, or start again from home.",
  home: "Go to the home page",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The plain page, when the console's cannot be had. */
export function plainNotFound(name = PROFILE.name): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${esc(NOT_FOUND_WORDS.title)} | ${esc(name)}</title>` +
    `<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#171717;color:#ededed}` +
    `main{max-width:32rem;padding:1.5rem;text-align:center}p{color:#a1a1a1}a{display:inline-block;margin-top:1rem;padding:.6rem 1rem;border-radius:.5rem;background:#ededed;color:#171717;text-decoration:none}</style></head>` +
    `<body><main data-status-page="not_found" data-status-code="404"><p>${esc(name)}</p><p>Error 404</p><h1>${esc(NOT_FOUND_WORDS.title)}</h1>` +
    `<p>${esc(NOT_FOUND_WORDS.body)}</p><a href="/">${esc(NOT_FOUND_WORDS.home)}</a></main></body></html>`;
}

let kept: { html: string; at: number; from: string } | null = null;

/** The console's not-found page, or null when it cannot be had (kept for a minute once it is). */
async function consolePage(): Promise<string | null> {
  const from = `${consoleUrl()}${NOT_FOUND_PAGE}`;
  if (kept && kept.from === from && Date.now() - kept.at < KEEP_MS) return kept.html;
  try {
    const r = await fetch(from, { headers: { accept: "text/html", [RELAY_HEADER]: "1" }, redirect: "manual", signal: AbortSignal.timeout(WAIT_MS) });
    const html = await r.text();
    if (r.status !== 404 || !/text\/html/.test(r.headers.get("content-type") ?? "") || !(html.includes('data-status-page="not_found"') || html.includes('\\"kind\\":\\"not_found\\"'))) return null;
    kept = { html, at: Date.now(), from };
    return html;
  } catch {
    return null;
  }
}

/** Is this request a browser opening a page? */
export const wantsPage = (req: Request): boolean =>
  (req.method === "GET" || req.method === "HEAD") && /text\/html/.test(req.headers.accept ?? "") && !API_PATHS.test(req.path) && !req.headers[RELAY_HEADER];

/** The last handler before the error handler: a browser's unknown address gets the not-found page, a 404. */
export function browserNotFound() {
  return function statusNotFound(req: Request, res: Response, next: NextFunction) {
    if (!wantsPage(req)) return next();
    void consolePage().then((html) => {
      res.status(404).type("html").set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }).send(html ?? plainNotFound());
    }, next);
  };
}

/** For tests: forget the kept page. */
export const forgetKeptPage = () => { kept = null; };
