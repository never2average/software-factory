/**
 * An HTML sanitiser for documents the console shows inline (mold_v0-220): an email's body, a fetched page. Allowlist
 * only, no dependency: what is not named here never reaches the output.
 *
 *   kept       text, and the plain formatting tags of mail (p, div, span, tables, lists, headings, b/i/u, a, img, br ...)
 *              with a few presentational attributes; `style` attributes without url(), expression(), @import, behavior
 *              or -moz-binding
 *   dropped    with their content: script, style, iframe, object, embed, svg, math, template, noscript, head, title,
 *              form controls, audio and video; every other tag (its text stays); comments, doctypes, CDATA and
 *              processing instructions; every on* handler and every attribute not listed
 *   links      only http:, https: and mailto: (entities and control characters decoded first); each opens in a new tab
 *              with rel="noopener noreferrer nofollow"
 *   images     inline data: images (png, jpeg, gif, webp) always; a remote (http/https) image only with `remoteImages:
 *              "allow"`, else its address is cut and counted (`blocked`), so nothing is fetched until the reader asks;
 *              cid: and anything else is cut
 *
 * The result is a whole document (`documentOf`) served with a Content-Security-Policy that runs no script and loads no
 * remote image unless allowed, in a sandboxed frame: the sanitiser is the first of three walls, not the only one.
 */

const KEEP = new Set([
  "a", "abbr", "address", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center", "cite", "code", "col", "colgroup", "dd", "del",
  "dfn", "div", "dl", "dt", "em", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre",
  "q", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul", "wbr",
]);
const VOID = new Set(["br", "col", "hr", "img", "wbr"]);
/** Dropped with everything inside them. */
const DROP = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "svg", "math", "template", "noscript", "noembed", "noframes",
  "head", "title", "textarea", "select", "option", "button", "audio", "video", "canvas", "xml", "xmp", "plaintext", "portal",
]);
const ATTRS = new Set([
  "align", "alt", "bgcolor", "border", "cellpadding", "cellspacing", "color", "colspan", "dir", "face", "height", "href", "lang", "rowspan",
  "size", "span", "src", "start", "style", "title", "type", "valign", "width",
]);

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", colon: ":", tab: "\t", newline: "\n" };
/** Character references decoded (named basics and numeric), as a browser would before reading a URL. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A URL as the browser reads it: entities decoded, control characters and whitespace removed. */
const urlOf = (raw: string) => decodeEntities(raw).replace(/[\u0000- \u007f-\u009f]+/g, "");
const safeHref = (raw: string): string | null => {
  const u = urlOf(raw);
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
};
const DATA_IMAGE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const safeStyle = (raw: string): string | null => {
  const s = decodeEntities(raw).replace(/\\/g, "");
  if (/url\s*\(|expression\s*\(|@import|behavior\s*:|-moz-binding|javascript:|vbscript:|position\s*:\s*fixed/i.test(s)) return null;
  return s.replace(/[\u0000-\u001f]/g, " ").slice(0, 2000);
};

export interface SanitiseOptions { remoteImages?: "block" | "allow" | "keep" }
export interface Sanitised { html: string; blocked: number }

/**
 * The HTML with only the allowlist kept (above). `remoteImages`: "block" (the default) cuts remote image addresses and
 * counts them; "allow" keeps them; "keep" keeps them as they are (for storing: the reader's choice is made at preview).
 */
export function sanitiseHtml(input: string, opts: SanitiseOptions = {}): Sanitised {
  const remote = opts.remoteImages ?? "block";
  const src = input.replace(/\u0000/g, "");
  let out = "", blocked = 0, i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { out += src.slice(i).replace(/>/g, "&gt;"); break; }
    out += src.slice(i, lt).replace(/>/g, "&gt;");
    i = lt;
    // Comments, CDATA, doctypes and processing instructions: dropped.
    if (src.startsWith("<!--", i)) { const e = src.indexOf("-->", i + 4); i = e < 0 ? n : e + 3; continue; }
    if (src[i + 1] === "!" || src[i + 1] === "?") { const e = src.indexOf(">", i); i = e < 0 ? n : e + 1; continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(src.slice(i, i + 64));
    if (!m) { out += "&lt;"; i++; continue; }
    // The tag's end: the first ">" outside a quoted attribute value.
    let j = i + m[0].length, q: string | null = null;
    for (; j < n; j++) {
      const c = src[j]!;
      if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === ">") break;
    }
    if (j >= n) break; // an unterminated tag: the rest is dropped
    const closing = m[1] === "/", name = m[2]!.toLowerCase(), attrText = src.slice(i + m[0].length, j);
    i = j + 1;
    if (DROP.has(name)) {
      if (closing) continue;
      if (/\/\s*$/.test(attrText)) continue;
      // Everything up to its own closing tag goes (no closing tag: the rest of the document).
      const close = new RegExp(`</${name}\\s*>`, "i").exec(src.slice(i));
      i = close ? i + close.index + close[0].length : n;
      continue;
    }
    if (!KEEP.has(name)) continue;
    if (closing) { if (!VOID.has(name)) out += `</${name}>`; continue; }
    const attrs: string[] = [];
    const seen = new Set<string>();
    const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let a: RegExpExecArray | null;
    while ((a = re.exec(attrText))) {
      const an = a[1]!.toLowerCase();
      const av = a[2] ?? a[3] ?? a[4] ?? "";
      if (seen.has(an) || !ATTRS.has(an)) continue;
      seen.add(an);
      if (an === "href") {
        if (name !== "a") continue;
        const h = safeHref(av);
        if (h) attrs.push(`href="${esc(h)}"`);
        continue;
      }
      if (an === "src") {
        if (name !== "img") continue;
        const u = urlOf(av);
        if (DATA_IMAGE.test(u)) attrs.push(`src="${esc(u)}"`);
        else if (/^https?:\/\//i.test(u)) {
          if (remote === "block") { blocked++; attrs.push(`data-blocked-src=""`); }
          else attrs.push(`src="${esc(u)}"`);
        }
        continue;
      }
      if (an === "style") { const s = safeStyle(av); if (s) attrs.push(`style="${esc(s)}"`); continue; }
      const v = decodeEntities(av);
      if (/javascript:|vbscript:|data:/i.test(v.replace(/\s+/g, ""))) continue;
      attrs.push(`${an}="${esc(v.slice(0, 500))}"`);
    }
    if (name === "a") attrs.push('target="_blank"', 'rel="noopener noreferrer nofollow"');
    out += `<${name}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`;
  }
  return { html: out, blocked };
}

/**
 * A whole document around sanitised HTML, for a sandboxed frame: no referrer, links to a new tab, a light page as a mail
 * client shows it (mail is written for one).
 */
export function documentOf(body: string): string {
  return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\"><base target=\"_blank\">" +
    "<style>html{color-scheme:light}body{margin:16px;font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#111;background:#fff;overflow-wrap:anywhere}" +
    "img{max-width:100%;height:auto}img[data-blocked-src]{display:inline-block;min-width:24px;min-height:16px;background:#eee}pre{white-space:pre-wrap}table{max-width:100%}</style>" +
    `</head><body>${body}</body></html>`;
}

/** The Content-Security-Policy an inline HTML document is served with: no script, no remote load unless images are allowed. */
export const htmlPolicy = (images: boolean) =>
  `default-src 'none'; style-src 'unsafe-inline'; img-src data:${images ? " https: http:" : ""}; font-src data:; base-uri 'none'; form-action 'none'; ` +
  "frame-ancestors 'self'; sandbox allow-popups allow-popups-to-escape-sandbox";
