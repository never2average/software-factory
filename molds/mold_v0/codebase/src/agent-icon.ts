/**
 * A workspace's own agent icon (mold_v0-252): what the console's top-bar agent button and the agent pages' heading show
 * for this workspace, over the app's (its brand's, profile.json `agent_icon`, written by the factory's branding step) and
 * the console's default. Only while the app's profile turns `agent_harness` on.
 *
 *   who        any person of the workspace reads it (GET /api/agent/icon); its owners change and reset it
 *              (PUT and DELETE, src/agent-routes.ts). Staff do not: the staff console shows the app's.
 *   what       an SVG, sanitised here (an allowlist of drawing elements and attributes: no script, event handler,
 *              foreignObject, style sheet, picture, link or reference outside the file, no DOCTYPE, entity, comment or
 *              processing instruction) and, when drawn in one colour (or none), redrawn in currentColor so the console
 *              paints it in the text colour in light and dark; or a picture, PNG, JPG or WebP, of at most 256 KB as sent:
 *              a PNG is decoded and re-encoded here (trimmed of its transparent margin and fitted inside 64 px, so
 *              nothing but its pixels is kept), a JPG or WebP is kept only when it is already at most 64 px a side (the
 *              console resizes every picture to a 64 px PNG in the browser before it sends it). Anything else is
 *              refused, by its bytes, whatever it claims to be.
 *   where      the workspace's prefix of the object store, workspaces/org-<id>/.agent-icon/icon.wse, sealed with the
 *              workspace's data key (src/orgcrypto.ts sealBytes, as record files are) and bound to the workspace: a
 *              blob copied under another workspace does not open. It goes with the workspace (src/tenancy.ts removes
 *              its prefix). Reset removes it, and the app's icon shows again.
 */
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { vaultUnlocked } from "./keyvault.js";
import { openBytes, sealBytes } from "./orgcrypto.js";
import { PackError } from "./pack-api.js";
import { objectStore } from "./storage.js";
import { asPlatform } from "./tenant-scope.js";

/** The most bytes an icon may have as sent. */
export const AGENT_ICON_MAX_BYTES = 256 * 1024;
/** The most bytes a cleaned SVG may keep. */
export const AGENT_ICON_SVG_MAX = 64 * 1024;
/** A picture is kept at most this many pixels a side (three times the 20 px it is drawn at). */
export const AGENT_ICON_PX = 64;
const MAX_PIXELS = 2048 * 2048;

export interface AgentIcon {
  content_type: "image/svg+xml" | "image/png" | "image/jpeg" | "image/webp";
  /** The bytes, base64 (at most 64 KB). */
  data: string;
  /** An SVG drawn in currentColor: the console paints it in the text colour. */
  follows_color: boolean;
  width: number | null;
  height: number | null;
  sha256: string;
  updated_at: string;
  updated_by: string | null;
}

// ---------- SVG ----------

const ELEMENTS = new Set(["svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "defs", "lineargradient", "radialgradient", "stop", "clippath", "mask", "use", "symbol"]);
const CASE: Record<string, string> = { lineargradient: "linearGradient", radialgradient: "radialGradient", clippath: "clipPath" };
const ATTRS = new Set(["viewbox", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "fr", "d", "points", "width", "height", "transform",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
  "stroke-opacity", "opacity", "clip-rule", "clip-path", "mask", "id", "offset", "stop-color", "stop-opacity", "gradientunits", "gradienttransform", "spreadmethod",
  "maskunits", "maskcontentunits", "clippathunits", "preserveaspectratio", "vector-effect", "color", "display", "href"]);
const ATTR_CASE: Record<string, string> = { viewbox: "viewBox", gradientunits: "gradientUnits", gradienttransform: "gradientTransform", spreadmethod: "spreadMethod",
  maskunits: "maskUnits", maskcontentunits: "maskContentUnits", clippathunits: "clipPathUnits", preserveaspectratio: "preserveAspectRatio" };
const STYLE_PROPS = new Set(["fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
  "stroke-dashoffset", "stroke-opacity", "opacity", "clip-rule", "stop-color", "stop-opacity", "color", "display", "vector-effect"]);
const PAINT = ["fill", "stroke", "stop-color", "color"];
const DRAWN = new Set(["path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "use"]);
const BAD_VALUE = /javascript:|vbscript:|data:|expression\s*\(|@import|[<>\\`]/i;
const URL_REF = /^url\(\s*#[A-Za-z][\w.-]{0,63}\s*\)$/;
const NAMED_ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; }
  return NAMED_ENTITY[e.toLowerCase()] ?? m;
});
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const normColour = (v: string) => { const c = v.trim().toLowerCase(); const l = /^#[0-9a-f]{3}$/.test(c) ? `#${[...c.slice(1)].map((x) => x + x).join("")}` : c; return l === "black" ? "#000000" : l === "white" ? "#ffffff" : l; };

function cleanValue(name: string, raw: string): string | null {
  const v = decode(raw).trim();
  if (!v || v.length > 20000 || BAD_VALUE.test(v)) return null;
  if (name === "href") return /^#[A-Za-z][\w.-]{0,63}$/.test(v) ? v : null;
  if (/url\(/i.test(v)) return URL_REF.test(v) ? v : null;
  if (name === "id") return /^[A-Za-z][\w.-]{0,63}$/.test(v) ? v : null;
  return v;
}

interface Node { tag: string; attrs: Map<string, string>; kids: Node[] }

/**
 * An SVG's bytes -> the cleaned SVG and whether it is drawn in currentColor. Throws a PackError (400) with a plain
 * sentence when it cannot be an icon. The same allowlist as the factory's .claude/scripts/lib/agent_icon.py.
 */
export function sanitiseSvg(raw: Buffer): { svg: string; follows_color: boolean } {
  if (raw.length > AGENT_ICON_MAX_BYTES) throw new PackError(`the SVG is ${Math.ceil(raw.length / 1024)} KB; an icon is at most ${AGENT_ICON_MAX_BYTES / 1024} KB`, 413);
  const text = raw.toString("utf8");
  if (Buffer.byteLength(text) !== raw.length || text.includes("�")) throw new PackError("the SVG is not UTF-8 text", 400);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new PackError("an SVG with a DOCTYPE or entities is refused (they can reach outside the file)", 400);
  // Comments, CDATA (its text is never drawn) and processing instructions go first; nothing in them is kept.
  const body = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<\?[\s\S]*?\?>/g, "");
  if (/<!--|<!\[CDATA\[|<\?|<!/.test(body)) throw new PackError("the SVG does not read as XML (an unclosed comment or declaration)", 400);
  const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/y;
  const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
  const stack: { name: string; node: Node | null }[] = [];
  let root: Node | null = null, rootAttrs: Map<string, string> | null = null, done = false;
  const colours = new Set<string>(); let gradients = false, fills = false;
  let i = 0;
  while (i < body.length) {
    const lt = body.indexOf("<", i);
    if (lt < 0) break;
    if (done) throw new PackError("the SVG has something after its closing </svg>", 400);
    TAG.lastIndex = lt;
    const m = TAG.exec(body);
    if (!m) throw new PackError("the SVG does not read as XML (a tag that does not close)", 400);
    i = TAG.lastIndex;
    const [, closing, qname, attrText, selfClose] = m;
    const local = qname!.split(":").pop()!.toLowerCase();
    const prefixed = qname!.includes(":");
    if (closing) {
      const top = stack.pop();
      if (!top || top.name !== qname) throw new PackError("the SVG does not read as XML (its tags are not nested)", 400);
      if (!stack.length) done = true;
      continue;
    }
    const parent = stack.length ? stack[stack.length - 1]!.node : undefined;
    // An element outside the allowlist goes with everything inside it; so does anything under one already gone.
    let node: Node | null = null;
    if (!stack.length) {
      if (local !== "svg" || prefixed) throw new PackError("the file's root element is not <svg>", 400);
    }
    if ((parent !== null || !stack.length) && !prefixed && ELEMENTS.has(local)) {
      node = { tag: CASE[local] ?? local, attrs: new Map(), kids: [] };
      if (local === "lineargradient" || local === "radialgradient") gradients = true;
      const raw = new Map<string, string>();
      for (const a of (attrText ?? "").matchAll(ATTR)) raw.set(a[1]!, a[2] ?? a[3] ?? "");
      for (const decl of (raw.get("style") ?? "").split(";")) {
        const at = decl.indexOf(":");
        if (at < 0) continue;
        const k = decl.slice(0, at).trim().toLowerCase();
        if (!STYLE_PROPS.has(k)) continue;
        const v = cleanValue(k, decl.slice(at + 1));
        if (v !== null) node.attrs.set(k, v);
      }
      for (const [k, v] of raw) {
        const [p, n] = k.includes(":") ? [k.slice(0, k.indexOf(":")).toLowerCase(), k.slice(k.indexOf(":") + 1).toLowerCase()] : ["", k.toLowerCase()];
        if (p && !(p === "xlink" && n === "href")) continue;     // xmlns:*, sodipodi:*, xml:space ... go
        if (!ATTRS.has(n) || n.startsWith("on")) continue;
        if (!stack.length && (n === "width" || n === "height")) continue;
        const cv = cleanValue(n, v);
        if (cv !== null) node.attrs.set(n, cv);
      }
      if (node.attrs.has("fill")) fills = true;
      for (const p of PAINT) {
        const c = node.attrs.get(p);
        if (c === undefined) continue;
        const n = normColour(c);
        if (!["none", "transparent", "currentcolor", "inherit"].includes(n) && !n.startsWith("url(")) colours.add(n);
      }
      if (!stack.length) { root = node; rootAttrs = raw; }
      else parent!.kids.push(node);
    }
    if (selfClose) { if (!stack.length) done = true; continue; }
    stack.push({ name: qname!, node });
  }
  if (stack.length || !root) throw new PackError("the SVG does not read as XML (an element that does not close)", 400);
  let vb = root.attrs.get("viewbox");
  if (!vb) {
    const w = rootAttrs!.get("width") ?? "", h = rootAttrs!.get("height") ?? "";
    if (/^[\d.]+(px)?$/.test(w) && /^[\d.]+(px)?$/.test(h)) vb = `0 0 ${parseFloat(w)} ${parseFloat(h)}`;
  }
  const nums = (vb ?? "").match(/-?[\d.]+/g) ?? [];
  if (nums.length !== 4 || !(Number(nums[2]) > 0) || !(Number(nums[3]) > 0)) throw new PackError("the SVG has no viewBox (or width and height) to size it by", 400);
  root.attrs.set("viewbox", nums.join(" "));
  const follows = !gradients && colours.size <= 1;
  if (follows) {
    const recolour = (n: Node) => { for (const p of PAINT) { const c = n.attrs.get(p); if (c !== undefined && colours.has(normColour(c))) n.attrs.set(p, "currentColor"); } n.kids.forEach(recolour); };
    recolour(root);
    if (!colours.size && !fills) root.attrs.set("fill", "currentColor");
  }
  const drawn = (n: Node): boolean => DRAWN.has(n.tag) || n.kids.some(drawn);
  if (!drawn(root)) throw new PackError("nothing is left to draw once the SVG is cleaned", 400);
  const emit = (n: Node, isRoot = false): string => {
    const parts: string[] = [];
    if (isRoot) {
      const [, , w, h] = nums.map(Number);
      parts.push(` xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"`);
    }
    for (const [k, v] of n.attrs) parts.push(` ${ATTR_CASE[k] ?? k}="${esc(v)}"`);
    const inner = n.kids.map((k) => emit(k)).join("");
    return inner ? `<${n.tag}${parts.join("")}>${inner}</${n.tag}>` : `<${n.tag}${parts.join("")}/>`;
  };
  const svg = emit(root, true);
  if (Buffer.byteLength(svg) > AGENT_ICON_SVG_MAX) throw new PackError(`the SVG is still ${Math.ceil(Buffer.byteLength(svg) / 1024)} KB once cleaned; an icon is at most ${AGENT_ICON_SVG_MAX / 1024} KB`, 413);
  return { svg, follows_color: follows };
}

// ---------- pictures ----------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** What a picture's bytes are (never what it claims): png, jpeg, webp or null. */
export function pictureKind(b: Buffer): "png" | "jpeg" | "webp" | null {
  if (b.length > 24 && b.subarray(0, 8).equals(PNG_SIG)) return "png";
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length > 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

/** A JPEG's or WebP's size from its header, without decoding it; null when it does not say. */
export function headerSize(b: Buffer, kind: "jpeg" | "webp"): { width: number; height: number } | null {
  if (kind === "webp") {
    const chunk = b.toString("latin1", 12, 16);
    if (chunk === "VP8 " && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L" && b.length >= 25) { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 }; }
    if (chunk === "VP8X" && b.length >= 30) return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    return null;
  }
  let p = 2;
  while (p + 9 < b.length) {
    if (b[p] !== 0xff) return null;
    const marker = b[p + 1]!;
    if (marker === 0xff) { p++; continue; }
    const len = b.readUInt16BE(p + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) };
    p += 2 + len;
  }
  return null;
}

interface Rgba { w: number; h: number; px: Uint8Array }

/** PNG bytes -> RGBA (every colour type and bit depth, tRNS, interlaced or not). Throws a PackError on anything else. */
export function decodePng(b: Buffer): Rgba {
  const bad = (why: string) => new PackError(`the PNG could not be read (${why})`, 400);
  if (!b.subarray(0, 8).equals(PNG_SIG)) throw bad("not a PNG");
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0, plte: Buffer | null = null, trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (pos + 8 <= b.length) {
    const n = b.readUInt32BE(pos), kind = b.toString("latin1", pos + 4, pos + 8);
    if (pos + 12 + n > b.length) throw bad("it is cut short");
    const body = b.subarray(pos + 8, pos + 8 + n);
    if (kind === "IHDR") { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]!; ctype = body[9]!; interlace = body[12]!; }
    else if (kind === "PLTE") plte = body;
    else if (kind === "tRNS") trns = body;
    else if (kind === "IDAT") idat.push(body);
    else if (kind === "IEND") break;
    pos += 12 + n;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!w || !h || !channels || ![1, 2, 4, 8, 16].includes(depth) || (ctype === 3 && !plte)) throw bad("its header is not valid");
  if (w * h > MAX_PIXELS) throw new PackError(`the PNG is ${w}x${h}; an icon that large is not an icon (at most ${Math.sqrt(MAX_PIXELS)} px a side)`, 413);
  const bits = channels * depth, bpp = Math.max(1, bits >> 3);
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  let expected = 0;
  for (const [x0, y0, dx, dy] of passes) { const pw = Math.ceil((w - x0!) / dx!), ph = Math.ceil((h - y0!) / dy!); if (pw > 0 && ph > 0) expected += ph * (1 + Math.ceil((pw * bits) / 8)); }
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1024 }); } catch { throw bad("its pixels do not inflate"); }
  if (raw.length < expected) throw bad("it is cut short");
  const out: Rgba = { w, h, px: new Uint8Array(w * h * 4) };
  const sample = (line: Uint8Array, i: number): number => {
    if (depth === 8) return line[i]!;
    if (depth === 16) return line[i * 2]!;
    const per = 8 / depth, byte = line[Math.floor(i / per)]!, shift = 8 - depth * ((i % per) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  const scale = (v: number) => (depth >= 8 ? v : Math.round((v * 255) / ((1 << depth) - 1)));
  // tRNS of a grey or RGB picture: the one colour that is transparent, two bytes a channel whatever the depth.
  const tr = trns && ctype !== 3 && trns.length >= 2 ? [...Array(Math.floor(trns.length / 2)).keys()].map((k) => trns!.readUInt16BE(k * 2)) : null;
  let p = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((w - x0!) / dx!), ph = Math.ceil((h - y0!) / dy!);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * bits) / 8);
    let prev = new Uint8Array(rowBytes);
    for (let j = 0; j < ph; j++) {
      const ft = raw[p++]!, line = new Uint8Array(raw.subarray(p, p + rowBytes)); p += rowBytes;
      for (let k = 0; k < rowBytes; k++) {
        const a = k >= bpp ? line[k - bpp]! : 0, up = prev[k]!, c = k >= bpp ? prev[k - bpp]! : 0;
        const add = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? up : ft === 3 ? (a + up) >> 1 : ft === 4 ? (() => { const q = a + up - c, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c); return pa <= pb && pa <= pc ? a : pb <= pc ? up : c; })() : -1;
        if (add < 0) throw bad("a row's filter is not valid");
        line[k] = (line[k]! + add) & 0xff;
      }
      prev = line;
      const y = y0! + j * dy!;
      for (let i = 0; i < pw; i++) {
        const o = (y * w + x0! + i * dx!) * 4;
        const s = (ch: number) => sample(line, i * channels + ch);
        const full = (ch: number) => (depth === 16 ? (line[(i * channels + ch) * 2]! << 8) | line[(i * channels + ch) * 2 + 1]! : s(ch));
        if (ctype === 3) {
          const ix = s(0);
          out.px[o] = plte![ix * 3] ?? 0; out.px[o + 1] = plte![ix * 3 + 1] ?? 0; out.px[o + 2] = plte![ix * 3 + 2] ?? 0; out.px[o + 3] = trns && ix < trns.length ? trns[ix]! : 255;
        } else if (ctype === 0 || ctype === 4) {
          const g = scale(s(0));
          out.px[o] = out.px[o + 1] = out.px[o + 2] = g;
          out.px[o + 3] = ctype === 4 ? scale(s(1)) : tr && full(0) === tr[0] ? 0 : 255;
        } else {
          out.px[o] = s(0); out.px[o + 1] = s(1); out.px[o + 2] = s(2);
          out.px[o + 3] = ctype === 6 ? s(3) : tr && full(0) === tr[0] && full(1) === tr[1] && full(2) === tr[2] ? 0 : 255;
        }
      }
    }
  }
  return out;
}

/** The picture without its transparent margin. */
function trim(img: Rgba): Rgba {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (img.px[(y * img.w + x) * 4 + 3]! > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) throw new PackError("the picture is transparent all over: nothing to show", 400);
  if (x0 === 0 && y0 === 0 && x1 === img.w - 1 && y1 === img.h - 1) return img;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) px.set(img.px.subarray(((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x0 + w) * 4), y * w * 4);
  return { w, h, px };
}

/** Fitted inside `size` px (never enlarged, the aspect kept), by area average over premultiplied alpha. */
function fit(img: Rgba, size: number): Rgba {
  const k = Math.min(1, size / Math.max(img.w, img.h));
  if (k === 1) return img;
  const nw = Math.max(1, Math.round(img.w * k)), nh = Math.max(1, Math.round(img.h * k));
  const px = new Uint8Array(nw * nh * 4), sx = img.w / nw, sy = img.h / nh;
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    let r = 0, g = 0, b = 0, a = 0, wsum = 0;
    const fx0 = x * sx, fx1 = (x + 1) * sx, fy0 = y * sy, fy1 = (y + 1) * sy;
    for (let yy = Math.floor(fy0); yy < Math.ceil(fy1); yy++) {
      const wy = Math.min(yy + 1, fy1) - Math.max(yy, fy0);
      for (let xx = Math.floor(fx0); xx < Math.ceil(fx1); xx++) {
        const wgt = wy * (Math.min(xx + 1, fx1) - Math.max(xx, fx0)), o = (yy * img.w + xx) * 4, al = img.px[o + 3]! / 255;
        r += img.px[o]! * al * wgt; g += img.px[o + 1]! * al * wgt; b += img.px[o + 2]! * al * wgt; a += al * wgt; wsum += wgt;
      }
    }
    const o = (y * nw + x) * 4;
    px[o + 3] = Math.round((a / wsum) * 255);
    if (a > 0) { px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a); }
  }
  return { w: nw, h: nh, px };
}

/** RGBA -> a plain PNG (no chunk but its header, pixels and end: nothing of the original file is carried). */
export function encodePng(img: Rgba): Buffer {
  const chunk = (kind: string, body: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const kb = Buffer.from(kind, "latin1"); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([kb, body]))); return Buffer.concat([len, kb, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc((img.w * 4 + 1) * img.h);
  for (let y = 0; y < img.h; y++) { rows[y * (img.w * 4 + 1)] = 0; rows.set(img.px.subarray(y * img.w * 4, (y + 1) * img.w * 4), y * (img.w * 4 + 1) + 1); }
  return Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * An upload's bytes -> the icon kept (validated by what the bytes are, whatever `declared` says). Throws a PackError:
 * 413 over the size limit, 400 for anything that is not an SVG, a PNG, a JPG or a WebP an icon can be.
 */
export function checkAgentIcon(data: Buffer, declared = ""): Omit<AgentIcon, "updated_at" | "updated_by"> {
  if (!data.length) throw new PackError("the file is empty", 400);
  if (data.length > AGENT_ICON_MAX_BYTES) throw new PackError(`an icon is at most ${AGENT_ICON_MAX_BYTES / 1024} KB; this one is ${Math.ceil(data.length / 1024)} KB`, 413);
  const kind = pictureKind(data);
  const keep = (content_type: AgentIcon["content_type"], bytes: Buffer, follows: boolean, width: number | null, height: number | null) =>
    ({ content_type, data: bytes.toString("base64"), follows_color: follows, width, height, sha256: createHash("sha256").update(bytes).digest("hex") });
  if (kind === "png") {
    const img = fit(trim(decodePng(data)), AGENT_ICON_PX);
    return keep("image/png", encodePng(img), false, img.w, img.h);
  }
  if (kind === "jpeg" || kind === "webp") {
    const size = headerSize(data, kind);
    if (!size || !size.width || !size.height) throw new PackError(`the ${kind === "jpeg" ? "JPG" : "WebP"} does not say its size`, 400);
    if (Math.max(size.width, size.height) > AGENT_ICON_PX)
      throw new PackError(`the ${kind === "jpeg" ? "JPG" : "WebP"} is ${size.width}x${size.height}: send a PNG (it is resized here) or one at most ${AGENT_ICON_PX} px a side; the console's upload resizes it for you`, 400);
    return keep(kind === "jpeg" ? "image/jpeg" : "image/webp", data, false, size.width, size.height);
  }
  const head = data.subarray(0, 512).toString("utf8").replace(/^﻿/, "").trimStart();
  if (head.startsWith("<") && (/<svg\b/i.test(data.toString("utf8")) || /svg/i.test(declared))) {
    const { svg, follows_color } = sanitiseSvg(data);
    return keep("image/svg+xml", Buffer.from(svg, "utf8"), follows_color, null, null);
  }
  throw new PackError("an agent icon is an SVG, a PNG, a JPG or a WebP", 400);
}

// ---------- the workspace's own ----------

const objectKey = (orgId: number) => `workspaces/org-${Math.trunc(orgId)}/.agent-icon/icon.wse`;
const aad = (orgId: number) => `agent-icon:v1:org-${Math.trunc(orgId)}`;

/** The workspace's own agent icon, or null (none, or the vault locked: the app's shows). */
export async function readAgentIcon(orgId: number): Promise<AgentIcon | null> {
  if (!vaultUnlocked()) return null;
  const sealed = await (await objectStore()).get(objectKey(orgId));
  if (!sealed) return null;
  try {
    const icon = JSON.parse((await asPlatform(() => openBytes(orgId, sealed, aad(orgId)))).toString("utf8")) as AgentIcon;
    return createHash("sha256").update(Buffer.from(icon.data, "base64")).digest("hex") === icon.sha256 ? icon : null;
  } catch { return null; }
}

/** Keep `data` as the workspace's own agent icon (checked, sealed with its key). */
export async function saveAgentIcon(orgId: number, by: string | null, data: Buffer, declared = ""): Promise<AgentIcon> {
  const icon: AgentIcon = { ...checkAgentIcon(data, declared), updated_at: new Date().toISOString(), updated_by: by };
  if (!vaultUnlocked()) throw new PackError("the key vault is locked: the icon cannot be kept now, try again later", 503);
  const sealed = await asPlatform(() => sealBytes(orgId, Buffer.from(JSON.stringify(icon)), aad(orgId)));
  await (await objectStore()).put(objectKey(orgId), sealed, "application/octet-stream");
  return icon;
}

/** Back to the app's icon. */
export async function resetAgentIcon(orgId: number): Promise<void> {
  await (await objectStore()).remove([objectKey(orgId)]);
}
