#!/usr/bin/env python3
"""favicon.py: the favicon set a brand needs, from its mark, in standard-library Python.

  favicon.py --self-test          the offline checks (no network, no build/, no state/)

branding.py calls `build_set` from `prepare`, `check_set` from `check` and `preview_html` from `preview`.

WHAT A BROWSER ACTUALLY ASKS FOR, and what one 32x32 SVG could not give it:
  app/favicon.ico              16, 32 and 48 px in one ICO. Safari, Slack/Teams link cards, RSS readers, and every
                               client that requests /favicon.ico without reading the page.
  app/icon.png                 32x32 PNG: the tab icon where SVG favicons are not drawn.
  app/apple-icon.png           180x180, OPAQUE: the iPhone/iPad home-screen icon (iOS paints transparency black).
  app/icon.svg                 only for a true vector mark (a drawn mark, a vector logo, the monogram). A raster logo
                               wrapped in an SVG as base64 is the 171 KB tab icon this file exists to stop: it is
                               never written, and a stale one is removed.
  public/icon-192.png, public/icon-512.png, public/icon-maskable-512.png
                               the web manifest's icons; the maskable one keeps the mark inside the safe zone (a
                               circle of 80% of the width) and bleeds its background to the edge.

THREE KINDS OF MARK, and how each is turned into pixels:
  monogram   no logo: one or two initials on the brand's icon background. Drawn here, from a small stroke font,
             so it is the same on every machine (no system font, no node).
  logo       a logo file. A PNG is decoded here (every colour type and bit depth, interlaced or not). A JPG, a
             WebP or an SVG is first turned into a PNG by `sharp` from the mold's own node_modules (Next.js ships
             it); the resize and everything after are still done here.
  drawn      a designer's 32x32 SVG with its own background rect (the mold's default check mark). Rendered by
             sharp without the rect, then composed on that rect's colour, so the apple and maskable icons can
             bleed the background to the edge.
When sharp is needed and is not there, the set is still written, from the monogram, and the caller is told so in
plain words: a browser tab with initials is better than a 404.

A logo is FITTED, never stretched: its transparent (or uniform) margin is trimmed, it is scaled by area-average to
fit the square, and the rest is padding. Where a format needs opacity the padding is the brand's icon background,
unless the logo brings its own (an opaque logo's own background colour, a rounded-square tile's own fill) or the
logo would vanish on it (then white or near-black, whichever it reads on).
"""
import base64, hashlib, math, os, re, struct, subprocess, sys, tempfile, zlib

MAX_ICON_BYTES = 100 * 1024
ICO_SIZES = (16, 32, 48)
APPLE = 180
SAFE_RADIUS = 0.40            # maskable: the mark stays inside a circle of this radius (W3C: 40% of the width)
PNG_SIG = b"\x89PNG\r\n\x1a\n"

# The files of the set, relative to the build copy. icon.svg is the conditional one.
ICO, ICON_PNG, APPLE_PNG, ICON_SVG = "app/favicon.ico", "app/icon.png", "app/apple-icon.png", "app/icon.svg"
M192, M512, MASK512 = "public/icon-192.png", "public/icon-512.png", "public/icon-maskable-512.png"
PNG_DIMS = {ICON_PNG: 32, APPLE_PNG: APPLE, M192: 192, M512: 512, MASK512: 512}

# ------------------------------------------------------------------------------------------------ PNG ----
class Img:
    """w x h, RGBA, 8 bits a channel, straight (not premultiplied) alpha, rows top to bottom."""
    __slots__ = ("w", "h", "px")
    def __init__(self, w, h, px=None):
        self.w, self.h = w, h; self.px = px if px is not None else bytearray(4 * w * h)
    def at(self, x, y): i = 4 * (y * self.w + x); return tuple(self.px[i:i + 4])

def _hex(c):
    c = c.lstrip("#")
    if len(c) == 3: c = "".join(ch * 2 for ch in c)
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))

def _unfilter(raw, pos, rowbytes, bpp, prev):
    """One scanline: undo the PNG filter. Returns (line, position after it)."""
    ft = raw[pos]; line = bytearray(raw[pos + 1:pos + 1 + rowbytes]); pos += 1 + rowbytes
    if len(line) != rowbytes: raise ValueError("PNG ends before its last row")
    if ft == 1:
        for i in range(bpp, rowbytes): line[i] = (line[i] + line[i - bpp]) & 255
    elif ft == 2:
        if prev: line = bytearray((a + b) & 255 for a, b in zip(line, prev))
    elif ft == 3:
        for i in range(rowbytes):
            line[i] = (line[i] + (((line[i - bpp] if i >= bpp else 0) + (prev[i] if prev else 0)) >> 1)) & 255
    elif ft == 4:
        for i in range(rowbytes):
            a = line[i - bpp] if i >= bpp else 0; b = prev[i] if prev else 0; c = prev[i - bpp] if prev and i >= bpp else 0
            p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
            line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
    elif ft != 0: raise ValueError(f"PNG filter type {ft} is not defined")
    return line, pos

def _samples(line, n, depth):
    """A scanline's first n samples as integers, whatever the bit depth."""
    if depth == 8: return line[:n]
    if depth == 16: return [(line[2 * i] << 8) | line[2 * i + 1] for i in range(n)]
    out = []; mask = (1 << depth) - 1
    for byte in line:
        for shift in range(8 - depth, -1, -depth): out.append((byte >> shift) & mask)
    return out[:n]

def _row_rgba(line, w, ctype, depth, plte, trns):
    """One unfiltered scanline -> w RGBA8 pixels."""
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]; s = _samples(line, w * ch, depth)
    out = bytearray(4 * w)
    if ctype == 3:
        for x in range(w):
            i = s[x]
            if 3 * i + 2 >= len(plte): raise ValueError("PNG palette index out of range")
            out[4 * x:4 * x + 3] = plte[3 * i:3 * i + 3]; out[4 * x + 3] = trns[i] if trns and i < len(trns) else 255
        return out
    to8 = (lambda v: v) if depth == 8 else (lambda v: v >> 8) if depth == 16 else (lambda v, m=(1 << depth) - 1: v * 255 // m)
    if ctype == 0:
        key = struct.unpack(">H", trns[:2])[0] if trns and len(trns) >= 2 else None
        for x in range(w):
            g = to8(s[x]); out[4 * x:4 * x + 4] = bytes((g, g, g, 0 if s[x] == key else 255))
    elif ctype == 2:
        key = struct.unpack(">HHH", trns[:6]) if trns and len(trns) >= 6 else None
        for x in range(w):
            r, g, b = s[3 * x:3 * x + 3]
            out[4 * x:4 * x + 4] = bytes((to8(r), to8(g), to8(b), 0 if key == (r, g, b) else 255))
    elif ctype == 4:
        for x in range(w):
            g = to8(s[2 * x]); out[4 * x:4 * x + 4] = bytes((g, g, g, to8(s[2 * x + 1])))
    else:
        if depth == 8: return bytearray(line[:4 * w])
        for i in range(4 * w): out[i] = s[i] >> 8
    return out

ADAM7 = ((0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2))

def png_decode(data):
    """PNG bytes -> Img. Every colour type and bit depth, tRNS, Adam7. Raises ValueError on anything else."""
    if data[:8] != PNG_SIG: raise ValueError("not a PNG file")
    pos = 8; ihdr = None; plte = b""; trns = None; idat = []
    while pos + 8 <= len(data):
        n, kind = struct.unpack(">I4s", data[pos:pos + 8]); body = data[pos + 8:pos + 8 + n]; pos += 12 + n
        if kind == b"IHDR": ihdr = struct.unpack(">IIBBBBB", body)
        elif kind == b"PLTE": plte = body
        elif kind == b"tRNS": trns = body
        elif kind == b"IDAT": idat.append(body)
        elif kind == b"IEND": break
    if not ihdr: raise ValueError("PNG has no header")
    w, h, depth, ctype, _c, _f, interlace = ihdr
    if ctype not in (0, 2, 3, 4, 6) or depth not in (1, 2, 4, 8, 16) or not w or not h: raise ValueError("PNG header is not valid")
    if w * h > 4096 * 4096: raise ValueError(f"PNG is {w}x{h}; a logo that large is not a logo")
    raw = zlib.decompress(b"".join(idat))
    bits = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype] * depth; bpp = max(1, bits // 8)
    img = Img(w, h); p = 0
    if not interlace:
        prev = None
        for y in range(h):
            prev, p = _unfilter(raw, p, (w * bits + 7) // 8, bpp, prev)
            img.px[4 * y * w:4 * (y + 1) * w] = _row_rgba(prev, w, ctype, depth, plte, trns)
        return img
    for x0, y0, dx, dy in ADAM7:
        pw, ph = (w - x0 + dx - 1) // dx, (h - y0 + dy - 1) // dy
        if pw <= 0 or ph <= 0: continue
        prev = None
        for j in range(ph):
            prev, p = _unfilter(raw, p, (pw * bits + 7) // 8, bpp, prev)
            row = _row_rgba(prev, pw, ctype, depth, plte, trns); base = 4 * (y0 + j * dy) * w
            for i in range(pw):
                o = base + 4 * (x0 + i * dx); img.px[o:o + 4] = row[4 * i:4 * i + 4]
    return img

def _chunk(kind, body): return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

_COST = bytes(min(v, 256 - v) for v in range(256))       # how far a filtered byte is from zero

def _bytes_sub(a, b):
    """a - b, byte by byte, modulo 256, for two equal-length byte strings: one big-integer subtraction that keeps
    each byte's borrow to itself (so a 512 px image is filtered in C, not in a Python loop)."""
    n = len(a); hi = int.from_bytes(b"\x80" * n, "big"); x = int.from_bytes(a, "big"); y = int.from_bytes(b, "big")
    return ((((x | hi) - (y & ~hi)) ^ (((x ^ y) & hi) ^ hi))).to_bytes(n, "big")

def _png_raw(img, opaque, bits=8):
    """Encode, picking per row the cheapest of the None / Sub / Up filters. `bits` < 8 drops colour precision."""
    ch = 3 if opaque else 4; w = img.w; h = img.h; px = img.px
    if bits < 8:
        m = (0xFF << (8 - bits)) & 0xFF; t = bytes(((v & m) | ((v & m) >> bits)) & 0xFF for v in range(256))
        px = bytearray(px.translate(t)); px[3::4] = img.px[3::4]
    if opaque:
        rgb = bytearray(3 * w * h); rgb[0::3] = px[0::4]; rgb[1::3] = px[1::4]; rgb[2::3] = px[2::4]; px = rgb
    px = bytes(px); n = ch * w
    left = b"".join(bytes(ch) + px[y * n:(y + 1) * n - ch] for y in range(h))
    sub = _bytes_sub(px, left); up = _bytes_sub(px, bytes(n) + px[:-n]) if h > 1 else px
    out = bytearray()
    for y in range(h):
        cands = [(0, px[y * n:(y + 1) * n]), (1, sub[y * n:(y + 1) * n])] + ([(2, up[y * n:(y + 1) * n])] if y else [])
        ft, best = min(cands, key=lambda c: sum(c[1].translate(_COST)))
        out.append(ft); out += best
    return (PNG_SIG + _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2 if opaque else 6, 0, 0, 0))
            + _chunk(b"IDAT", zlib.compress(bytes(out), 9)) + _chunk(b"IEND", b""))

def png_encode(img, opaque=False, cap=MAX_ICON_BYTES):
    """Img -> PNG bytes, RGB when opaque (no alpha channel at all: nothing can paint it black), RGBA otherwise.
    Kept under `cap`: a photographic logo at 512 px is re-encoded with fewer colour bits until it fits."""
    for bits in (8, 6, 5, 4, 3):
        out = _png_raw(img, opaque, bits)
        if not cap or len(out) <= cap: return out
    return out

def png_info(data):
    """(width, height, has an alpha channel or transparency) from a PNG's header, without decoding it."""
    if data[:8] != PNG_SIG or data[12:16] != b"IHDR": raise ValueError("not a PNG file")
    w, h, _d, ctype = struct.unpack(">IIBB", data[16:26])
    return w, h, ctype in (4, 6) or b"tRNS" in data[:data.find(b"IDAT")]

# ------------------------------------------------------------------------------------------------ ICO ----
def ico_encode(pngs):
    """[(size, PNG bytes)] -> one ICO. PNG entries (every browser since IE 11 and every OS since Vista reads them)."""
    head = struct.pack("<HHH", 0, 1, len(pngs)); off = 6 + 16 * len(pngs); dirs = b""; body = b""
    for size, data in pngs:
        dirs += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), off); off += len(data); body += data
    return head + dirs + body

def ico_entries(data):
    """An ICO's images as [(directory width, directory height, payload bytes)]. Raises ValueError when it is not one."""
    if len(data) < 6: raise ValueError("too short to be an ICO")
    reserved, kind, n = struct.unpack("<HHH", data[:6])
    if reserved != 0 or kind != 1 or not n: raise ValueError("not an ICO (wrong header)")
    out = []
    for i in range(n):
        e = data[6 + 16 * i:22 + 16 * i]
        if len(e) != 16: raise ValueError("ICO directory is cut short")
        w, h, _c, _r, _planes, _bpp, size, off = struct.unpack("<BBBBHHII", e)
        if off + size > len(data): raise ValueError("ICO entry points past the end of the file")
        out.append((w or 256, h or 256, data[off:off + size]))
    return out

# --------------------------------------------------------------------------------------------- resize ----
def _taps(n_src, n_dst):
    """For each output sample, the run of input samples it averages: (lo, hi, first weight, last weight, middle
    weight), weights summing to 1 over lo..hi-1.
    Shrinking: the exact area each input covers (a box filter, so thin strokes dim rather than vanish).
    Enlarging: linear interpolation between the two nearest."""
    out = []; s = n_src / n_dst
    for i in range(n_dst):
        if n_dst >= n_src:
            c = (i + 0.5) * s - 0.5; j = math.floor(c); t = c - j
            a, b = min(max(j, 0), n_src - 1), min(max(j + 1, 0), n_src - 1)
            out.append((a, a + 1, 1.0, 0.0, 0.0) if a == b or t < 1e-9 else (a, b + 1, 1 - t, t, 0.0))
        else:
            lo, hi = i * s, (i + 1) * s; a = int(math.floor(lo + 1e-9)); b = min(n_src, int(math.ceil(hi - 1e-9)))
            if b - a <= 1: out.append((a, a + 1, 1.0, 0.0, 0.0))
            else: out.append((a, b, (a + 1 - lo) / s, (hi - (b - 1)) / s, 1 / s))
    return out

def _mix(c, taps):
    """One row (or column) of samples through the taps."""
    return [c[lo] if hi - lo == 1 else c[lo] * wf + c[hi - 1] * wl + (sum(c[lo + 1:hi - 1]) * wm if hi - lo > 2 else 0.0)
            for lo, hi, wf, wl, wm in taps]

def resize(img, nw, nh):
    """Scale to exactly nw x nh (the caller keeps the aspect ratio). Alpha-premultiplied, so a transparent
    pixel's colour never bleeds into the edge of the mark."""
    nw, nh = max(1, int(nw)), max(1, int(nh))
    if (nw, nh) == (img.w, img.h): return Img(img.w, img.h, bytearray(img.px))
    w, h = img.w, img.h; tx, ty = _taps(w, nw), _taps(h, nh)
    mid = [[] for _ in range(4)]                         # per channel: h rows, nw wide, premultiplied floats
    for y in range(h):
        row = img.px[4 * y * w:4 * (y + 1) * w]; a = row[3::4]
        for k in range(3): mid[k].append(_mix([c * al for c, al in zip(row[k::4], a)], tx))
        mid[3].append(_mix(list(a), tx))
    out = Img(nw, nh); px = out.px
    for y in range(nh):
        lo, hi, wf, wl, wm = ty[y]; acc = []
        for k in range(4):
            rows = mid[k]
            if hi - lo == 1: acc.append(rows[lo]); continue
            a = [p * wf + q * wl for p, q in zip(rows[lo], rows[hi - 1])]
            for j in range(lo + 1, hi - 1): a = [p + q * wm for p, q in zip(a, rows[j])]
            acc.append(a)
        al = acc[3]; base = 4 * y * nw
        px[base + 3:base + 4 * nw:4] = bytes([int(v + 0.5) for v in al])
        inv = [1 / v if v > 0.5 else 0.0 for v in al]
        for k in range(3):
            px[base + k:base + 4 * nw:4] = bytes([int(c * i + 0.5) for c, i in zip(acc[k], inv)])
    return out

def crop(img, x0, y0, x1, y1):
    out = Img(x1 - x0, y1 - y0)
    for y in range(y0, y1): out.px[4 * (y - y0) * out.w:4 * (y - y0 + 1) * out.w] = img.px[4 * (y * img.w + x0):4 * (y * img.w + x1)]
    return out

def paste(canvas, img, ox, oy):
    """Alpha-composite img onto canvas at (ox, oy). Either may be transparent."""
    for y in range(max(0, -oy), min(img.h, canvas.h - oy)):
        for x in range(max(0, -ox), min(img.w, canvas.w - ox)):
            i = 4 * (y * img.w + x); sa = img.px[i + 3]
            if not sa: continue
            o = 4 * ((y + oy) * canvas.w + x + ox); da = canvas.px[o + 3]
            if sa == 255 or not da: canvas.px[o:o + 4] = img.px[i:i + 4]; continue
            oa = sa + da * (255 - sa) / 255
            for k in range(3):
                canvas.px[o + k] = int((img.px[i + k] * sa + canvas.px[o + k] * da * (255 - sa) / 255) / oa + 0.5)
            canvas.px[o + 3] = int(oa + 0.5)
    return canvas

def solid(size, rgb=None):
    """A size x size canvas: one opaque colour, or fully transparent."""
    return Img(size, size, bytearray(bytes(rgb) + b"\xff") * (size * size)) if rgb else Img(size, size)

def place(size, img, bg=None):
    """img centred on a new size x size canvas (img no larger than it): over `bg`, opaque, or on transparency."""
    out = solid(size, bg); ox, oy = (size - img.w) // 2, (size - img.h) // 2; w = img.w
    for y in range(img.h):
        row = img.px[4 * y * w:4 * (y + 1) * w]; o = 4 * ((y + oy) * size + ox)
        if bg:
            a = row[3::4]
            for k in range(3):
                row[k::4] = bytes((c * al + bg[k] * (255 - al) + 127) // 255 for c, al in zip(row[k::4], a))
            row[3::4] = b"\xff" * w
        out.px[o:o + 4 * w] = row
    return out

def is_opaque(img): return min(img.px[3::4]) == 255

# ------------------------------------------------------------------------------------- reading a logo ----
def _near(a, b, tol=14): return all(abs(x - y) <= tol for x, y in zip(a[:3], b[:3]))

def own_background(img):
    """An opaque logo's own background colour: the colour its four corners share, or None when they differ."""
    if not is_opaque(img): return None
    c = [img.at(0, 0), img.at(img.w - 1, 0), img.at(0, img.h - 1), img.at(img.w - 1, img.h - 1)]
    return c[0][:3] if all(_near(x, c[0]) for x in c) else None

def key_out(img, bg, tol=30):
    """An opaque logo drawn on one colour -> the same logo on transparency, or None when nothing is left.
    Only the background that is CONNECTED TO THE BORDER is removed (a flood fill), so white inside the mark stays
    white. The pixels along the cut are un-mixed from the background (alpha from how far each is from it, colour
    from the strongest neighbour), so the edge is smooth and carries no halo of the old background."""
    w, h = img.w, img.h; px = img.px
    near = lambda i: abs(px[i] - bg[0]) <= tol and abs(px[i + 1] - bg[1]) <= tol and abs(px[i + 2] - bg[2]) <= tol
    gone = bytearray(w * h); todo = []
    for x in range(w): todo += [x, (h - 1) * w + x]
    for y in range(h): todo += [y * w, y * w + w - 1]
    while todo:
        p = todo.pop()
        if gone[p] or not near(4 * p): continue
        gone[p] = 1; x = p % w
        if x: todo.append(p - 1)
        if x < w - 1: todo.append(p + 1)
        if p >= w: todo.append(p - w)
        if p < w * (h - 1): todo.append(p + w)
    left = w * h - sum(gone)
    if left < 0.01 * w * h: return None
    out = Img(w, h, bytearray(px)); dist = lambda i: max(abs(px[i] - bg[0]), abs(px[i + 1] - bg[1]), abs(px[i + 2] - bg[2]))
    for p in range(w * h):
        if gone[p]: out.px[4 * p:4 * p + 4] = b"\0\0\0\0"; continue
        x, y = p % w, p // w
        if not any(gone[yy * w + xx] for yy in range(max(0, y - 2), min(h, y + 3)) for xx in range(max(0, x - 2), min(w, x + 3))): continue
        # on the cut: the strongest colour within 3 px is what this pixel is a blend of, with the background
        best = max((yy * w + xx for yy in range(max(0, y - 3), min(h, y + 4)) for xx in range(max(0, x - 3), min(w, x + 4)) if not gone[yy * w + xx]),
                   key=lambda q: dist(4 * q))
        full = dist(4 * best); a = min(1.0, dist(4 * p) / full) if full else 1.0
        if a < 0.98: out.px[4 * p:4 * p + 3] = px[4 * best:4 * best + 3]; out.px[4 * p + 3] = int(a * 255 + 0.5)
    return out

def trim(img):
    """The mark without its transparent margin: cut to the box of what can be seen."""
    w, h = img.w, img.h
    if is_opaque(img): return img
    a = img.px[3::4]
    rows = [y for y in range(h) if max(a[y * w:(y + 1) * w]) > 16]
    if not rows: return img
    y0, y1 = rows[0], rows[-1] + 1
    cols = [x for x in range(w) if max(a[y0 * w + x:y1 * w:w]) > 16]
    return crop(img, cols[0], y0, cols[-1] + 1, y1)

def tile_fill(img):
    """A logo that is already an app tile (a rounded square that fills its box) -> the tile's own edge colour;
    None for any other shape. Such a logo bleeds to the edge of the apple icon instead of sitting on a second tile."""
    if is_opaque(img) or abs(img.w - img.h) > max(2, img.w // 50): return None
    a = img.px[3::4]
    if sum(1 for v in a if v > 200) < 0.88 * img.w * img.h: return None       # a disc covers 78.5% of its box
    mids = [img.at(img.w // 2, 1), img.at(img.w // 2, img.h - 2), img.at(1, img.h // 2), img.at(img.w - 2, img.h // 2)]
    if any(m[3] < 250 for m in mids): return None
    return tuple(sum(m[k] for m in mids) // 4 for k in range(3))

SMALL = 48                    # up to this size the icon is a tab icon, and a badge's inner mark is enlarged
def badge_zoom(img):
    """A BADGE (one flat fill with a small mark inside it: a disc with an arrow) -> (the square region around the
    inner mark, on the badge's fill, as an opaque Img; how much larger the mark becomes). None for any other logo.
    At 16 px a mark that is under two thirds of its badge is a smudge; shown at 70% of the badge it can be read. The
    badge keeps its outline: the caller masks the enlarged inside with the whole logo's own shape."""
    w, h = img.w, img.h
    if is_opaque(img) or abs(w - h) > 0.04 * max(w, h): return None
    px = img.px; seen = [p for p in range(w * h) if px[4 * p + 3] > 200]
    if len(seen) < 64: return None
    buckets = {}
    for p in seen:
        k = (px[4 * p] >> 4, px[4 * p + 1] >> 4, px[4 * p + 2] >> 4); buckets[k] = buckets.get(k, 0) + 1
    top = max(buckets, key=buckets.get)
    fam = [p for p in seen if all(abs((px[4 * p + c] >> 4) - top[c]) <= 1 for c in range(3))]
    if len(fam) < 0.45 * len(seen): return None                       # no single fill: not a badge
    dom = tuple(sum(px[4 * p + c] for p in fam) // len(fam) for c in range(3))
    far = [p for p in seen if max(abs(px[4 * p + c] - dom[c]) for c in range(3)) > 48]
    if len(far) < 0.01 * len(seen): return None                       # nothing inside it
    # the box of the inner mark, ignoring stray rows and columns (a JPEG's speckle along the rim)
    need = max(2, w // 100); rows = [0] * h; cols = [0] * w
    for p in far: rows[p // w] += 1; cols[p % w] += 1
    ys = [y for y in range(h) if rows[y] >= need]; xs = [x for x in range(w) if cols[x] >= need]
    if not ys or not xs: return None
    x0, x1, y0, y1 = xs[0], xs[-1] + 1, ys[0], ys[-1] + 1; side = max(x1 - x0, y1 - y0)
    edge = 0.06 * w
    if side > 0.56 * max(w, h) or min(x0, y0, w - x1, h - y1) < edge: return None    # already large, or it touches the rim
    k = 0.70 * max(w, h) / side; view = max(w, h) / k                 # the square window that becomes the whole icon
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2; n = int(round(view)); ox, oy = int(round(cx - view / 2)), int(round(cy - view / 2))
    flat = place(max(w, h), img, dom)
    ox = min(max(ox, 0), flat.w - n); oy = min(max(oy, 0), flat.h - n)
    return crop(flat, ox, oy, ox + n, oy + n), k

def fit_badge(img, inside, size):
    """The badge at `size`: its own outline (fit, no padding), with the enlarged inside painted within it."""
    out = fit(img, size); big = resize(inside, size, size)
    for k in range(3): out.px[k::4] = big.px[k::4]
    return out

def _lum(rgb):
    f = lambda c: c / 3294.6 if c <= 10.31475 else ((c / 255 + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])

def _contrast(a, b):
    la, lb = _lum(a), _lum(b); return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)

def mean_colour(img):
    """The alpha-weighted average colour of what can be seen."""
    a = img.px[3::4]; tot = sum(a) or 1
    return tuple(int(sum(c * al for c, al in zip(img.px[k::4], a)) / tot) for k in range(3))

def backdrop(img, icon_bg):
    """The opaque colour a see-through logo sits on: the brand's icon background, unless the logo would vanish
    on it (contrast under 1.25:1 against the logo's average colour), then white or near-black, whichever it reads on.
    Returns (rgb, a note for the operator or None)."""
    bg = _hex(icon_bg); m = mean_colour(img)
    if _contrast(m, bg) >= 1.25: return bg, None
    alt = max(((250, 250, 250), (10, 10, 10)), key=lambda c: _contrast(m, c))
    return alt, (f"the logo is close to the icon background {icon_bg} and would not show on it; the home-screen icon uses "
                 f"{'white' if alt[0] > 128 else 'near-black'} instead (set branding.icon_bg to choose another)")

def fit(img, size, bg=None, pad=0.0, safe=None):
    """The logo, whole, centred on a size x size canvas: scaled to fit inside the padding (`pad`, a fraction of the
    size on each side) or inside the maskable safe circle (`safe`, its radius as a fraction of the size). The aspect
    ratio is kept; what the logo does not cover is `bg` (opaque) or transparent."""
    if safe: k = 2 * safe * size / math.hypot(img.w, img.h)       # the logo's corners touch the circle
    else: k = size * (1 - 2 * pad) / max(img.w, img.h)
    nw, nh = max(1, round(img.w * k)), max(1, round(img.h * k))
    return place(size, resize(img, min(size, nw), min(size, nh)), bg)

# -------------------------------------------------------------------------------------- the monogram ----
def _arc(cx, cy, rx, ry, a0, a1, n=None):
    n = n or max(4, int(abs(a1 - a0) / 15))
    return [(cx + rx * math.cos(math.radians(a0 + (a1 - a0) * i / n)), cy + ry * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]

# A geometric sans in strokes: letter -> (advance width, [polyline, ...]) in units of the cap height, y down,
# (0,0) the top left of the letter. Drawn with round caps and joins, so it is legible from 16 px to 512 px
# and identical on every machine.
GLYPHS = {
    "A": (.80, [[(0, 1), (.40, 0), (.80, 1)], [(.14, .64), (.66, .64)]]),
    "B": (.68, [[(0, 0), (0, 1)], [(0, 0), (.40, 0)] + _arc(.40, .24, .25, .24, -90, 90) + [(0, .48)], [(0, .48), (.41, .48)] + _arc(.41, .74, .27, .26, -90, 90) + [(0, 1)]]),
    "C": (.82, [_arc(.47, .5, .47, .5, 312, 48)]),
    "D": (.80, [[(0, 1), (0, 0), (.30, 0)] + _arc(.30, .5, .50, .5, -90, 90) + [(0, 1)]]),
    "E": (.64, [[(.64, 0), (0, 0), (0, 1), (.64, 1)], [(0, .48), (.54, .48)]]),
    "F": (.62, [[(.62, 0), (0, 0), (0, 1)], [(0, .50), (.50, .50)]]),
    "G": (.88, [_arc(.47, .5, .47, .5, 312, 0) + [(.94, .54), (.52, .54)]]),
    "H": (.76, [[(0, 0), (0, 1)], [(.76, 0), (.76, 1)], [(0, .5), (.76, .5)]]),
    "I": (.0, [[(0, 0), (0, 1)]]),
    "J": (.50, [[(.50, 0), (.50, .72)] + _arc(.25, .72, .25, .28, 0, 165)]),
    "K": (.70, [[(0, 0), (0, 1)], [(.68, 0), (0, .60)], [(.24, .40), (.70, 1)]]),
    "L": (.60, [[(0, 0), (0, 1), (.60, 1)]]),
    "M": (.94, [[(0, 1), (0, 0), (.47, .72), (.94, 0), (.94, 1)]]),
    "N": (.78, [[(0, 1), (0, 0), (.78, 1), (.78, 0)]]),
    "O": (.94, [_arc(.47, .5, .47, .5, 0, 360)]),
    "P": (.67, [[(0, 1), (0, 0), (.40, 0)] + _arc(.40, .27, .27, .27, -90, 90) + [(0, .54)]]),
    "Q": (.94, [_arc(.47, .5, .47, .5, 0, 360), [(.56, .70), (.92, 1.04)]]),
    "R": (.69, [[(0, 1), (0, 0), (.40, 0)] + _arc(.40, .27, .27, .27, -90, 90) + [(0, .54)], [(.32, .54), (.69, 1)]]),
    "S": (.64, [_arc(.32, .26, .30, .26, 325, 90) + _arc(.32, .76, .32, .24, -90, 150)[1:]]),
    "T": (.76, [[(0, 0), (.76, 0)], [(.38, 0), (.38, 1)]]),
    "U": (.76, [[(0, 0), (0, .62)] + _arc(.38, .62, .38, .38, 180, 0) + [(.76, 0)]]),
    "V": (.80, [[(0, 0), (.40, 1), (.80, 0)]]),
    "W": (1.10, [[(0, 0), (.27, 1), (.55, .22), (.83, 1), (1.10, 0)]]),
    "X": (.74, [[(0, 0), (.74, 1)], [(.74, 0), (0, 1)]]),
    "Y": (.76, [[(0, 0), (.38, .52), (.76, 0)], [(.38, .52), (.38, 1)]]),
    "Z": (.70, [[(0, 0), (.70, 0), (0, 1), (.70, 1)]]),
}

def monogram_strokes(initials, scale=1.0):
    """The initials as ([polyline, ...], stroke width), in a unit square (the icon), centred. `scale` shrinks the
    lettering about the centre (the maskable icon's safe zone)."""
    letters = [GLYPHS[c] for c in initials.upper() if c in GLYPHS][:2] or [GLYPHS["A"]]
    cap = 0.46 if len(letters) == 1 else 0.38
    stroke = cap * 0.17; gap = cap * 0.30
    width = sum(g[0] for g in letters) * cap + gap * (len(letters) - 1)
    k = min(1.0, (0.70 - stroke) / width) if width > 0 else 1.0       # two wide letters (MW) are scaled to fit
    cap, gap, width, stroke = cap * k, gap * k, width * k, stroke * (0.5 + 0.5 * k)
    x = 0.5 - width / 2; y = 0.5 - cap / 2; out = []
    for adv, lines in letters:
        for line in lines: out.append([(0.5 + (x + px * cap - 0.5) * scale, 0.5 + (y + py * cap - 0.5) * scale) for px, py in line])
        x += adv * cap + gap
    return out, stroke * scale

def _stroke_alpha(size, lines, width):
    """Coverage (0..255, as bytes) of round-capped polylines on a size x size grid, anti-aliased from the exact distance."""
    r = max(width * size / 2, 0.62); big = 1e9; dist = [big] * (size * size)     # a stroke never thinner than 1.24 px
    for line in lines:
        pts = [(x * size, y * size) for x, y in line]
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            dx, dy = bx - ax, by - ay; ll = dx * dx + dy * dy
            for y in range(max(0, int(min(ay, by) - r - 1)), min(size, int(max(ay, by) + r + 2))):
                cy = y + 0.5; row = y * size
                for x in range(max(0, int(min(ax, bx) - r - 1)), min(size, int(max(ax, bx) + r + 2))):
                    cx = x + 0.5
                    t = 0.0 if ll == 0 else min(1.0, max(0.0, ((cx - ax) * dx + (cy - ay) * dy) / ll))
                    ex, ey = cx - ax - t * dx, cy - ay - t * dy; d = ex * ex + ey * ey
                    if d < dist[row + x]: dist[row + x] = d
    return bytes(0 if d >= big else int(min(1.0, max(0.0, r - math.sqrt(d) + 0.5)) * 255 + 0.5) for d in dist)

def _tile_alpha(size, rx):
    """Coverage (0..255) of a rounded square that fills the canvas (rx as a fraction of the size); None when rx is 0."""
    if not rx: return None
    r = rx * size; h = size / 2; n = int(math.ceil(r)) + 1; out = bytearray(b"\xff" * (size * size))
    for y in list(range(min(n, size))) + list(range(max(n, size - n), size)):
        qy = max(abs(y + 0.5 - h) - (h - r), 0.0)
        for x in list(range(min(n, size))) + list(range(max(n, size - n), size)):
            qx = max(abs(x + 0.5 - h) - (h - r), 0.0)
            out[y * size + x] = int(min(1.0, max(0.0, r - math.hypot(qx, qy) + 0.5)) * 255 + 0.5)
    return out

def _compose_tile(size, bg, layer, rx):
    """A tile: the background colour, a layer on it, and the rounded-square outline (rx 0: the background bleeds
    to the edge and the image is opaque). The layer is (coverage 0..255 as bytes, one colour) or an RGBA Img."""
    if isinstance(layer, Img): out = place(size, layer, bg)
    else:
        cover, fg = layer; out = Img(size, size)
        for k in range(3):
            out.px[k::4] = cover.translate(bytes(int(bg[k] + (fg[k] - bg[k]) * a / 255 + 0.5) for a in range(256)))
    mask = _tile_alpha(size, rx)
    out.px[3::4] = mask if mask is not None else b"\xff" * (size * size)
    return out

def monogram_image(size, initials, bg, fg, rx=0.25, scale=1.0):
    lines, width = monogram_strokes(initials, scale)
    return _compose_tile(size, _hex(bg), (_stroke_alpha(size, lines, width), _hex(fg)), rx)

def monogram_svg(initials, bg, fg):
    """The same monogram as a vector: a rect and one stroked path, no font, about 1 KB."""
    lines, width = monogram_strokes(initials)
    n = lambda v: f"{v * 32:.2f}".rstrip("0").rstrip(".")
    d = "".join("M" + "L".join(f"{n(x)} {n(y)}" for x, y in line) for line in lines)
    return ('<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">'
            f'<rect width="32" height="32" rx="8" fill="{bg}"/>'
            f'<path d="{d}" stroke="{fg}" stroke-width="{n(width)}" stroke-linecap="round" stroke-linejoin="round"/></svg>')

# ------------------------------------------------------------------------------------------- sharp ----
SHARP_JS = r"""
const [inp, out, density] = process.argv.slice(-3);
let sharp;
try { sharp = require("sharp"); } catch (e) { console.error("NO_SHARP " + e.message); process.exit(3); }
const opts = Number(density) > 0 ? { density: Number(density) } : {};
sharp(inp, opts).resize(512, 512, { fit: "inside", withoutEnlargement: Number(density) <= 0 }).ensureAlpha().png()
  .toFile(out).then(() => process.exit(0), (e) => { console.error(String(e && e.message || e)); process.exit(1); });
"""

def sharp_png(raw, ext, node_cwd):
    """A JPG, WebP or SVG -> (PNG bytes at most 512 px on its long side, None), by sharp from node_cwd's node_modules.
    (None, why) when it cannot be done: no node, no sharp there, or a file sharp will not read. Never raises."""
    # a mold whose console is its own package (mold_v0: web/) has sharp there, not at the root
    if node_cwd and not os.path.isdir(os.path.join(node_cwd, "node_modules", "sharp")) and os.path.isdir(os.path.join(node_cwd, "web", "node_modules", "sharp")):
        node_cwd = os.path.join(node_cwd, "web")
    if not node_cwd or not os.path.isdir(os.path.join(node_cwd, "node_modules", "sharp")):
        return None, "the image library `sharp` is not installed in the mold's node_modules (run `npm ci` in the mold's codebase)"
    with tempfile.TemporaryDirectory() as t:
        inp, out = os.path.join(t, "in" + ext), os.path.join(t, "out.png"); open(inp, "wb").write(raw)
        density = "0"
        if ext == ".svg":
            # librsvg draws an SVG at 72 dpi of its own width; ask for the density that makes its long side 512 px
            head = re.search(rb"<svg\b[^>]*>", raw, re.S); side = 32.0
            if head:
                vb = re.search(rb'viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)', head.group(0))
                wh = [re.search(rb'\b%s="([\d.]+)' % k, head.group(0)) for k in (b"width", b"height")]
                if all(wh): side = max(float(wh[0].group(1)), float(wh[1].group(1)))
                elif vb: side = max(float(vb.group(1)), float(vb.group(2)))
            density = str(int(min(2400, max(72, 72 * 512 / max(side, 1) + 1))))
        try:
            r = subprocess.run(["node", "-e", SHARP_JS, inp, out, density], cwd=node_cwd, capture_output=True, text=True, timeout=120)
        except FileNotFoundError: return None, "node is not installed on this machine"
        except subprocess.TimeoutExpired: return None, "sharp did not finish in two minutes"
        if r.returncode or not os.path.isfile(out):
            why = (r.stderr or r.stdout).strip().splitlines()[-1:] or ["no output"]
            return None, ("the image library `sharp` could not be loaded" if "NO_SHARP" in r.stderr else "sharp could not read the logo") + f" ({why[0][:160]})"
        return open(out, "rb").read(), None

# --------------------------------------------------------------------------------------- the mark ----
MONOGRAM_RE = re.compile(r'^<svg[^>]*>\s*<rect width="32" height="32" rx="8" fill="(#[0-9A-Fa-f]{3,6})"/>\s*'
                         r'<text\b[^>]*\bfill="(#[0-9A-Fa-f]{3,6})"[^>]*>([A-Za-z]{1,2})</text>\s*</svg>\s*$', re.S)
DATA_IMAGE_RE = re.compile(r'<image\b[^>]*?href="data:(image/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)"', re.S)
BG_RECT_RE = re.compile(r'<rect\b(?=[^>]*\bwidth="32")(?=[^>]*\bheight="32")[^>]*/>', re.S)

def read_mark(icon_svg, initials, icon_bg, icon_fg):
    """What kind of mark a brand has, from the SVG its state carries (state is self-contained: the logo's bytes are
    inside icon_svg, so the logo FILE need not exist on this machine).
      {"kind": "monogram", initials, bg, fg}
      {"kind": "raster", raw, ext}             a logo file that is pixels, embedded as a data URI
      {"kind": "drawn", svg, glyph_svg, bg, rx} a 32x32 drawing on its own background rect of one colour
      {"kind": "vector", svg}                  any other SVG: a nested vector logo, a drawing with no background"""
    svg = (icon_svg or "").strip()
    m = MONOGRAM_RE.match(svg)
    if not svg or m:
        return {"kind": "monogram", "initials": (m.group(3) if m else initials) or "A", "bg": m.group(1) if m else icon_bg, "fg": m.group(2) if m else icon_fg}
    m = DATA_IMAGE_RE.search(svg)
    if m and "<svg" not in svg[svg.find(">") + 1:m.start()]:
        ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/svg+xml": ".svg"}.get(m.group(1), ".bin")
        return {"kind": "raster", "raw": base64.b64decode(m.group(2)), "ext": ext}
    body = svg[svg.find(">") + 1:]
    m = BG_RECT_RE.match(body.lstrip())
    if m and "<svg" not in body and "<image" not in body:
        fill = re.search(r'\bfill="(#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?)"', m.group(0)); rx = re.search(r'\brx="([\d.]+)"', m.group(0))
        if fill:
            return {"kind": "drawn", "svg": svg, "glyph_svg": svg.replace(m.group(0), "", 1), "bg": fill.group(1),
                    "rx": min(0.5, float(rx.group(1)) / 32) if rx else 0.0}
    return {"kind": "vector", "svg": svg}

def svg_is_small_vector(svg):
    """True for an SVG that may ship as the tab icon: no embedded raster, no base64, under the size cap."""
    return bool(svg) and "<image" not in svg and "base64" not in svg and len(svg.encode()) <= MAX_ICON_BYTES

def _layer(img, size, scale=1.0):
    """A 512-px transparent layer drawn in the icon's own box -> the same at `size`, shrunk about the centre."""
    n = min(size, max(1, round(size * scale)))
    return place(size, resize(img, n, n))

def build_set(icon_svg, initials="A", icon_bg="#0A0A0A", icon_fg="#FAFAFA", node_cwd=None):
    """The whole favicon set for one brand: ({relative path: bytes}, info).
    info = {"kind", "source", "notes": [plain sentences for the operator], "svg": bool, "frames": {16|32|48|180: PNG}}.
    Never raises on a logo it cannot read: it falls back to the monogram and says so in notes."""
    mark = read_mark(icon_svg, initials, icon_bg, icon_fg); notes = []; src = None
    mono = {"kind": "monogram", "initials": initials or "A", "bg": icon_bg, "fg": icon_fg}

    def via_sharp(raw, ext, what):
        png, why = sharp_png(raw, ext, node_cwd)
        if png:
            try: return png_decode(png)
            except (ValueError, zlib.error) as e: why = f"sharp's output could not be read ({e})"
        notes.append(f"{what} could not be turned into pixels: {why}. The favicon set was drawn from the initials instead.")
        return None

    if mark["kind"] == "raster":
        if mark["ext"] == ".png":
            try: src = png_decode(mark["raw"])
            except (ValueError, zlib.error, struct.error, IndexError) as e:
                src = via_sharp(mark["raw"], ".png", f"the PNG logo ({e})")
        else: src = via_sharp(mark["raw"], mark["ext"], f"the {mark['ext'][1:].upper()} logo")
        if src is None: mark = mono
    elif mark["kind"] == "vector":
        src = via_sharp(mark["svg"].encode(), ".svg", "the SVG logo")
        if src is None: mark = dict(mono, keep_svg=mark["svg"])
    elif mark["kind"] == "drawn":
        src = via_sharp(mark["glyph_svg"].encode(), ".svg", "the drawn mark")
        if src is None: mark = dict(mono, keep_svg=mark["svg"])

    kind = mark["kind"]; svg_out = None
    if kind == "monogram":
        ini, bg, fg = mark["initials"], mark["bg"], mark["fg"]
        small = lambda s: monogram_image(s, ini, bg, fg)
        apple = monogram_image(APPLE, ini, bg, fg, rx=0)
        mask = monogram_image(512, ini, bg, fg, rx=0, scale=0.86)
        svg_out = mark.get("keep_svg") or monogram_svg(ini, bg, fg)
    elif kind == "drawn":
        bg = _hex(mark["bg"])
        def tile(s, rx, scale=1.0):
            return _compose_tile(s, bg, _layer(src, s, scale), rx)
        small = lambda s: tile(s, mark["rx"])
        apple = tile(APPLE, 0)
        # the drawing was made for a rounded tile, so most of it is inside the safe circle already; shrink the rest in
        box = trim(src); reach = math.hypot(box.w, box.h) / 2 / 512
        mask = tile(512, 0, min(1.0, SAFE_RADIUS / reach) if reach else 1.0)
        svg_out = mark["svg"]
    else:
        own = own_background(src); keyed = key_out(src, own) if own else None
        box = trim(keyed or src); fill = tile_fill(box)
        if is_opaque(box):                               # nothing to cut it out of: shown whole, never cropped
            back = own or _hex(icon_bg)
            if not own: notes.append("the logo has no transparency and no single background colour, so it is shown whole, edge to edge")
            small = lambda s: fit(box, s, own); apple = fit(box, APPLE, back); mask = fit(box, 512, back)
        else:
            if keyed: notes.append("the logo file has no transparency; its background (#%02X%02X%02X, the colour of its corners) was removed "
                                   "so the tab icon is the mark itself, not a box" % own)
            if fill: back, pad = fill, 0.0               # already a tile: its fill bleeds to the edge
            else:
                back, note = backdrop(box, icon_bg); pad = 0.12
                if note: notes.append(note)
            zoom = badge_zoom(box)
            if zoom:
                notes.append(f"the logo is a badge with a small mark inside it; in the tab icon (48 px and under) the mark is shown "
                             f"{zoom[1]:.1f}x larger inside the same outline so it can be read at 16 px. The larger icons show the logo as it is.")
            small = lambda s: fit_badge(box, zoom[0], s) if zoom and s <= SMALL else fit(box, s)
            apple = fit(box, APPLE, back, pad); mask = fit(box, 512, back, safe=SAFE_RADIUS)
        if box.w > 1.6 * box.h or box.h > 1.6 * box.w:
            notes.append(f"the logo is {box.w}x{box.h} once its margin is trimmed: it is fitted whole with padding, so at 16 px it is a thin "
                         f"strip. A square mark (the symbol without the wordmark) reads better in a browser tab.")
        if max(box.w, box.h) < 180:
            notes.append(f"the logo is only {box.w}x{box.h} px once trimmed; the 192 and 512 px icons are enlarged from it and will look soft")
        if kind == "vector" and svg_is_small_vector(mark["svg"]): svg_out = mark["svg"]

    frames = {s: png_encode(small(s)) for s in ICO_SIZES}
    frames[APPLE] = png_encode(apple, opaque=True)
    files = {ICO: ico_encode([(s, frames[s]) for s in ICO_SIZES]), ICON_PNG: frames[32], APPLE_PNG: frames[APPLE],
             M192: png_encode(small(192)), M512: png_encode(small(512)), MASK512: png_encode(mask, opaque=True)}
    if svg_out and svg_is_small_vector(svg_out): files[ICON_SVG] = (svg_out.strip() + "\n").encode()
    info = {"kind": kind, "notes": notes, "svg": ICON_SVG in files, "frames": frames,
            "source": {"monogram": "the initials", "drawn": "the drawn mark", "raster": "the logo file", "vector": "the vector logo"}[kind]}
    return files, info

def version(files):
    """A short fingerprint of the set, for ?v= on the addresses a browser would otherwise cache for ever."""
    h = hashlib.sha256()
    for k in sorted(files): h.update(k.encode()); h.update(files[k])
    return h.hexdigest()[:8]

def placed(rel, dirs=None):
    """Where a file of the set lives in a mold whose web app is not at its root: dirs maps the set's top folders ("app",
    "public") to the mold's (mold_v0: web/src/app, web/public; molds/<mold>/branding/rules.json "favicon"). None: as named."""
    if not dirs: return rel
    top, _, rest = rel.partition("/")
    return f"{dirs[top].rstrip('/')}/{rest}" if top in dirs else rel

def write_set(build_dir, files, dirs=None):
    """Write the set into a build copy. A stale app/icon.svg (the base64-wrapped raster of an earlier build) is removed."""
    for rel, data in files.items():
        p = os.path.join(build_dir, placed(rel, dirs)); os.makedirs(os.path.dirname(p), exist_ok=True)
        if os.path.lexists(p): os.remove(p)           # never write through a hard link into the mold
        open(p, "wb").write(data)
    stale = os.path.join(build_dir, placed(ICON_SVG, dirs))
    if ICON_SVG not in files and os.path.lexists(stale): os.remove(stale)
    return sorted(files)

def check_set(build_dir, expect_svg=None, dirs=None):
    """Problems with the favicon set in a build copy, as plain sentences ([] when it is right).
    expect_svg: True/False when the caller knows whether this brand ships a vector icon; None to accept either.
    dirs: as placed(); the sentences then name the mold's own paths."""
    bad = []
    ICO_, PNG_DIMS_, ICON_SVG_ = placed(ICO, dirs), {placed(k, dirs): v for k, v in PNG_DIMS.items()}, placed(ICON_SVG, dirs)
    APPLE_PNG_, MASK512_ = placed(APPLE_PNG, dirs), placed(MASK512, dirs)
    def read(rel):
        p = os.path.join(build_dir, rel)
        if not os.path.isfile(p): bad.append(f"{rel} is missing"); return None
        data = open(p, "rb").read()
        if len(data) > MAX_ICON_BYTES: bad.append(f"{rel} is {len(data) // 1024} KB; an icon must stay under {MAX_ICON_BYTES // 1024} KB")
        return data
    data = read(ICO_)
    if data:
        try:
            got = {}
            for w, h, body in ico_entries(data):
                if body[:8] == PNG_SIG:
                    pw, ph, _ = png_info(body)
                    if (pw, ph) != (w, h): bad.append(f"{ICO_}: the {w}x{h} entry holds a {pw}x{ph} image")
                got[w] = h
            miss = [s for s in ICO_SIZES if got.get(s) != s]
            if miss: bad.append(f"{ICO_} has no {', '.join(f'{s}x{s}' for s in miss)} image (it holds {', '.join(f'{w}x{h}' for w, h in sorted(got.items())) or 'none'})")
        except (ValueError, struct.error) as e: bad.append(f"{ICO_} is not a valid ICO: {e}")
    for rel, size in PNG_DIMS_.items():
        data = read(rel)
        if not data: continue
        try: w, h, alpha = png_info(data)
        except (ValueError, struct.error): bad.append(f"{rel} is not a PNG"); continue
        if (w, h) != (size, size): bad.append(f"{rel} is {w}x{h}, not {size}x{size}")
        if rel in (APPLE_PNG_, MASK512_) and alpha:
            try: solid_ = is_opaque(png_decode(data))
            except (ValueError, zlib.error): solid_ = False
            if not solid_: bad.append(f"{rel} has transparent pixels; {'iOS paints them black' if rel == APPLE_PNG_ else 'a maskable icon must fill its square'}")
    p = os.path.join(build_dir, ICON_SVG_)
    if os.path.isfile(p):
        svg = open(p, encoding="utf-8", errors="replace").read()
        if "<image" in svg or "base64" in svg: bad.append(f"{ICON_SVG_} wraps a raster image as base64; a raster logo ships as PNG and ICO only")
        if len(svg.encode()) > MAX_ICON_BYTES: bad.append(f"{ICON_SVG_} is {len(svg.encode()) // 1024} KB; an icon must stay under {MAX_ICON_BYTES // 1024} KB")
        if expect_svg is False: bad.append(f"{ICON_SVG_} exists, but this brand's mark is not a vector: it must not ship")
    elif expect_svg: bad.append(f"{ICON_SVG_} is missing (this brand's mark is a vector)")
    return bad

def manifest_icons_ts(v):
    """The web manifest's `icons` line for the mold's app/manifest.ts."""
    return ('icons: [\n'
            f'      {{ src: "/icon-192.png?v={v}", sizes: "192x192", type: "image/png", purpose: "any" }},\n'
            f'      {{ src: "/icon-512.png?v={v}", sizes: "512x512", type: "image/png", purpose: "any" }},\n'
            f'      {{ src: "/icon-maskable-512.png?v={v}", sizes: "512x512", type: "image/png", purpose: "maskable" }},\n'
            '    ],')

LAYOUT_ICONS_TS = ("  // Icons are files, linked by Next's file conventions: app/favicon.ico (16, 32, 48), app/icon.png (32),\n"
                   "  // app/apple-icon.png (180) and, for a vector mark only, app/icon.svg. Written by the factory's branding step.\n")

def preview_html(info):
    """The favicon as a browser shows it: a tab at 16 px and 32 px (light and dark), enlarged so the pixels can be
    judged, and the home-screen icon."""
    uri = lambda s: "data:image/png;base64," + base64.b64encode(info["frames"][s]).decode()
    tab = lambda bg, fg, s: (f'<div style="display:inline-flex;align-items:center;gap:8px;background:{bg};color:{fg};padding:8px 14px;border-radius:10px 10px 0 0;'
                             f'font-size:12px;margin-right:10px"><img src="{uri(s)}" width="{s}" height="{s}" alt="">{s} px</div>')
    zoom = lambda s, k: f'<img src="{uri(s)}" width="{s * k}" height="{s * k}" alt="" style="image-rendering:pixelated;border:1px solid #bbb;background:#fff;margin-right:12px">'
    notes = "".join(f"<li>{n}</li>" for n in info["notes"])
    return f'''<h1 style="margin-top:28px">Favicon — drawn from {info["source"]}</h1>
<div style="background:#fff;border:1px solid #d5d5d5;border-radius:16px;padding:20px">
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.6;margin-bottom:10px">browser tab, actual size</div>
  <div style="background:#dee1e6;padding:8px 8px 0;border-radius:8px;margin-bottom:8px">{tab("#ffffff", "#222", 16)}{tab("#ffffff", "#222", 32)}</div>
  <div style="background:#202124;padding:8px 8px 0;border-radius:8px">{tab("#35363a", "#eee", 16)}{tab("#35363a", "#eee", 32)}</div>
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.6;margin:18px 0 10px">the same pixels, enlarged (16 px x8, 32 px x4)</div>
  <div>{zoom(16, 8)}{zoom(32, 4)}</div>
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.6;margin:18px 0 10px">iPhone home screen (180 px, corners rounded by iOS)</div>
  <div style="display:flex;gap:16px;align-items:flex-end"><img src="{uri(APPLE)}" width="180" height="180" alt="" style="border-radius:22.5%"><img src="{uri(APPLE)}" width="60" height="60" alt="" style="border-radius:22.5%"></div>
  <div style="font-size:12px;opacity:.7;margin-top:14px">Files: favicon.ico (16, 32, 48), icon.png, apple-icon.png, manifest icons 192 and 512 plus a maskable 512{", icon.svg" if info["svg"] else "; no icon.svg (the logo is not a vector)"}.</div>
  {f'<ul style="font-size:12px;margin:10px 0 0;padding-left:18px">{notes}</ul>' if notes else ""}
</div>'''

# -------------------------------------------------------------------------------------- self-test ----
def _wrap(raw, mime="image/png"):
    return ('<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">'
            f'<image href="data:{mime};base64,{base64.b64encode(raw).decode()}" x="0" y="0" width="32" height="32" preserveAspectRatio="xMidYMid meet"/></svg>')

def _disc(size, rgb, margin=0):
    """A test logo: a filled disc on transparency, with an optional transparent margin."""
    img = Img(size, size); c = size / 2; r = c - margin
    for y in range(size):
        for x in range(size):
            a = min(1.0, max(0.0, r - math.hypot(x + .5 - c, y + .5 - c) + .5))
            img.px[4 * (y * size + x):4 * (y * size + x) + 4] = bytes(rgb) + bytes([int(a * 255)])
    return img

def _png_variant(img, ctype, depth, interlace=False, ftypes=(0, 1, 2, 3, 4)):
    """Encode img as another PNG flavour (for the decoder's own test): any colour type, 8 or 16 bit, all five filters."""
    def pack(px4):
        r, g, b, a = px4; hi = (lambda v: bytes([v, v])) if depth == 16 else (lambda v: bytes([v]))
        return {0: hi(r), 2: hi(r) + hi(g) + hi(b), 4: hi(r) + hi(a), 6: hi(r) + hi(g) + hi(b) + hi(a)}[ctype]
    bpp = len(pack((0, 0, 0, 0)))
    def scan(pixels, n):
        prev = bytes(len(pixels[0]) * bpp) if pixels else b""; out = b""
        for j, row in enumerate(pixels):
            line = b"".join(pack(p) for p in row); ft = ftypes[(j + n) % len(ftypes)]; f = bytearray(line)
            for i in range(len(line)):
                a = line[i - bpp] if i >= bpp else 0; b = prev[i]; c = prev[i - bpp] if i >= bpp else 0
                if ft == 1: f[i] = (line[i] - a) & 255
                elif ft == 2: f[i] = (line[i] - b) & 255
                elif ft == 3: f[i] = (line[i] - ((a + b) >> 1)) & 255
                elif ft == 4:
                    p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                    f[i] = (line[i] - (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
            out += bytes([ft]) + bytes(f); prev = line
        return out
    grid = [[img.at(x, y) for x in range(img.w)] for y in range(img.h)]
    if interlace:
        raw = b""
        for n, (x0, y0, dx, dy) in enumerate(ADAM7):
            rows = [r[x0::dx] for r in grid[y0::dy]]
            if rows and rows[0]: raw += scan(rows, n)
    else: raw = scan(grid, 0)
    return (PNG_SIG + _chunk(b"IHDR", struct.pack(">IIBBBBB", img.w, img.h, depth, ctype, 0, 0, 1 if interlace else 0))
            + _chunk(b"IDAT", zlib.compress(raw)) + _chunk(b"IEND", b""))

def self_test():
    checks = []
    def ok(c, what):
        checks.append(what)
        if not c: raise AssertionError(what)
    teal = "#0F5C55"

    # --- the PNG codec: what goes in comes out, in every flavour a logo file arrives in
    src = _disc(24, (200, 40, 90), 2)
    ok(png_decode(png_encode(src)).px == src.px, "PNG: an RGBA image survives encode and decode exactly")
    for ctype, depth, il in ((6, 8, False), (6, 16, False), (6, 8, True), (2, 8, False), (4, 8, True), (0, 16, False)):
        got = png_decode(_png_variant(src, ctype, depth, il))
        want = bytearray(src.px)
        if ctype in (0, 4): want[1::4] = want[0::4]; want[2::4] = want[0::4]
        if ctype in (0, 2): want[3::4] = b"\xff" * (src.w * src.h)
        ok(got.px == want, f"PNG decode: colour type {ctype}, {depth} bit{', interlaced' if il else ''}, all five row filters")
    pal = PNG_SIG + _chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 1, 2, 3, 0, 0, 0)) + _chunk(b"PLTE", bytes((255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9))) \
        + _chunk(b"tRNS", bytes((255, 128, 0))) + _chunk(b"IDAT", zlib.compress(bytes((0, 0b00011011)))) + _chunk(b"IEND", b"")
    ok(list(png_decode(pal).px) == [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 9, 9, 9, 255], "PNG decode: a 2-bit palette with a transparency table")
    try: png_decode(b"GIF89a" + bytes(40)); ok(False, "a file that is not a PNG is refused")
    except ValueError: ok(True, "a file that is not a PNG is refused")

    # --- resize: area average down, never a stretch
    half = Img(4, 2, bytearray(bytes((255, 255, 255, 255)) * 2 + bytes((0, 0, 0, 255)) * 2) * 2)
    ok(list(resize(half, 2, 1).px) == [255, 255, 255, 255, 0, 0, 0, 255] and list(resize(half, 1, 1).px[:3]) == [128, 128, 128],
       "resize: shrinking averages the area each pixel covers")
    edge = Img(2, 1, bytearray((255, 0, 0, 255, 0, 255, 0, 0)))
    ok(tuple(resize(edge, 1, 1).px) == (255, 0, 0, 128), "resize: a transparent pixel's colour does not bleed into the edge")
    ok(resize(_disc(8, (9, 9, 9)), 32, 32).at(16, 16) == (9, 9, 9, 255), "resize: a small logo is enlarged, not left in a corner")

    # --- a raster logo: the whole set, right sizes, a real ICO, an opaque apple icon, and NO base64 SVG
    logo = png_encode(_disc(96, (30, 30, 30), 10))
    files, info = build_set(_wrap(logo), "CO", teal, "#FAFAFA")
    ok(info["kind"] == "raster" and not info["svg"] and ICON_SVG not in files, "raster logo: no icon.svg is produced (never a base64-wrapped raster)")
    ok(set(files) == {ICO, ICON_PNG, APPLE_PNG, M192, M512, MASK512}, "raster logo: favicon.ico, icon.png, apple-icon.png and the three manifest icons")
    ok(all(png_info(files[rel])[:2] == (s, s) for rel, s in PNG_DIMS.items()), "sizes: icon.png 32, apple-icon.png 180, manifest 192 and 512, maskable 512")
    ico = files[ICO]; ents = ico_entries(ico)
    ok(struct.unpack("<HHH", ico[:6]) == (0, 1, 3) and [(w, h) for w, h, _ in ents] == [(16, 16), (32, 32), (48, 48)], "ICO: type 1, three images: 16, 32 and 48")
    ok(all(b[:8] == PNG_SIG and png_info(b)[:2] == (w, h) for w, h, b in ents), "ICO: each directory entry holds a PNG of exactly its size")
    off = [struct.unpack("<II", ico[6 + 16 * i + 8:6 + 16 * i + 16]) for i in range(3)]
    ok(off[0][1] == 6 + 48 and all(off[i][1] + off[i][0] == (off[i + 1][1] if i < 2 else len(ico)) for i in range(3)), "ICO: offsets and lengths tile the file with no gap")
    apple = png_decode(files[APPLE_PNG])
    ok(png_info(files[APPLE_PNG])[2] is False and is_opaque(apple), "apple icon: opaque, with no alpha channel at all")
    ok(apple.at(2, 2)[:3] == _hex(teal) and apple.at(90, 90)[:3] == (30, 30, 30), "apple icon: the transparent logo sits on the brand's icon background")
    f16 = png_decode(ents[0][2])
    ok(f16.at(0, 0)[3] == 0 and f16.at(8, 8) == (30, 30, 30, 255) and f16.at(8, 0)[3] > 90, "16 px: transparent corners, and the margin is trimmed so the mark fills the square")
    mask = png_decode(files[MASK512])
    ok(is_opaque(mask) and mask.at(256, 256)[:3] == (30, 30, 30) and mask.at(256, 40)[:3] == _hex(teal) and mask.at(256, 256 - 130)[:3] == (30, 30, 30) and mask.at(256, 256 - 160)[:3] == _hex(teal),
       "maskable icon: opaque, the mark inside the safe circle, the background to the edge")
    ok(all(len(v) <= MAX_ICON_BYTES for v in files.values()), "no icon file is over 100 KB")
    ok(len(files[ICO]) < 8 * 1024, f"favicon.ico is small ({len(files[ICO])} bytes), not the logo re-wrapped")

    # --- a badge: the small mark inside it is enlarged in the tab icon only
    badge = _disc(120, (40, 44, 46)); paste(badge, Img(24, 24, bytearray(bytes((240, 60, 80, 255)) * 576)), 48, 48)
    bf, binfo = build_set(_wrap(png_encode(badge)), "B", teal, "#FAFAFA")
    b16 = png_decode(ico_entries(bf[ICO])[0][2]); red16 = [x for x in range(16) if b16.at(x, 8)[0] > 150]
    ok(len(red16) >= 10 and any("badge" in n for n in binfo["notes"]), f"badge at 16 px: the inner mark is {len(red16)} px wide, not the 3 px a plain shrink gives")
    ok(b16.at(0, 0)[3] == 0 and b16.at(8, 0)[3] > 90 and b16.at(1, 8)[:3] == (40, 44, 46), "badge at 16 px: the outline is still the disc, filled with its own colour")
    b192 = png_decode(bf[M192]); red192 = [x for x in range(192) if b192.at(x, 96)[0] > 150]
    ok(36 <= len(red192) <= 41, "badge at 192 px: the logo exactly as drawn")
    ok(not any("badge" in n for n in info["notes"]) and badge_zoom(_disc(64, (1, 2, 3))) is None, "a plain mark is not treated as a badge")

    # --- a wide logo: fitted with padding, never stretched
    wide = Img(120, 30, bytearray(bytes((200, 0, 0, 255)) * (120 * 30)))
    frame = Img(140, 50); paste(frame, wide, 10, 10)
    wf, winfo = build_set(_wrap(png_encode(frame)), "W", teal, "#FAFAFA")
    w32 = png_decode(wf[ICON_PNG]); rows = [y for y in range(32) if w32.at(16, y)[3] > 128]
    ok(w32.at(0, 16)[3] == 255 and w32.at(31, 16)[3] == 255 and len(rows) == 8 and rows[0] == 12, "non-square logo: full width, a quarter of the height, centred (4:1 kept)")
    ok(w32.at(16, 2)[3] == 0 and w32.at(16, 29)[3] == 0, "non-square logo: the rest is padding, not a stretched logo")
    wa = png_decode(wf[APPLE_PNG]); red = [y for y in range(180) if wa.at(90, y)[:3] == (200, 0, 0)]; redx = [x for x in range(180) if wa.at(x, 90)[:3] == (200, 0, 0)]
    ok(abs(len(redx) / len(red) - 4) < 0.25 and wa.at(90, 10)[:3] == _hex(teal) and is_opaque(wa), "non-square logo on the apple icon: 4:1 kept, padded with the icon background")
    ok(any("thin strip" in n for n in winfo["notes"]), "non-square logo: the operator is told a square mark reads better at 16 px")

    # --- logos that bring their own background
    white = solid(60, (255, 255, 255)); paste(white, _disc(30, (0, 0, 200)), 15, 15); paste(white, Img(18, 18, bytearray(bytes((255, 255, 255, 255)) * 324)), 21, 21)
    of, oinfo = build_set(_wrap(png_encode(white, opaque=True)), "O", teal, "#FAFAFA")
    o32 = png_decode(of[ICON_PNG]); oa = png_decode(of[APPLE_PNG])
    ok(o32.at(0, 0)[3] == 0 and o32.at(16, 3)[:3] == (0, 0, 200) and o32.at(16, 3)[3] == 255 and any("was removed" in n for n in oinfo["notes"]),
       "opaque logo on one colour: the background is removed, so the tab icon is the mark and not a white box")
    ok(o32.at(16, 16) == (255, 255, 255, 255), "opaque logo: white INSIDE the mark is kept (only background joined to the border goes)")
    edge = [o32.at(x, 16) for x in range(32) if 0 < o32.at(x, 16)[3] < 255]
    ok(all(p[2] > 150 and p[0] < 60 for p in edge), "opaque logo: the cut edge carries the mark's colour, no halo of the old background")
    ok(oa.at(3, 3)[:3] == _hex(teal) and oa.at(90, 30)[:3] == (0, 0, 200) and is_opaque(oa), "opaque logo: on the apple icon the mark sits on the brand's icon background")
    photo = Img(40, 40, bytearray(b"".join(bytes((x * 6, y * 6, 90, 255)) for y in range(40) for x in range(40))))
    pf, pinfo = build_set(_wrap(png_encode(photo, opaque=True)), "P", teal, "#FAFAFA")
    ok(is_opaque(png_decode(pf[ICON_PNG])) and any("shown whole" in n for n in pinfo["notes"]), "opaque logo with no single background: shown whole, edge to edge")
    tile = _compose_tile(64, (20, 90, 200), (bytes(4096), (0, 0, 0)), 0.2)
    tf, _ = build_set(_wrap(png_encode(tile)), "T", teal, "#FAFAFA")
    ok(png_decode(tf[APPLE_PNG]).at(1, 1)[:3] == (20, 90, 200), "rounded-square logo: its own fill bleeds to the edge of the apple icon")
    same = png_encode(_disc(64, _hex(teal)))
    sf, sinfo = build_set(_wrap(same), "S", teal, "#FAFAFA")
    ok(png_decode(sf[APPLE_PNG]).at(2, 2)[:3] == (250, 250, 250) and any("would not show" in n for n in sinfo["notes"]), "a logo the colour of the icon background gets a background it reads on, and a note")

    # --- the monogram: drawn here, no font, no node
    mf, minfo = build_set("", "CO", teal, "#FAFAFA")
    ok(minfo["kind"] == "monogram" and minfo["svg"], "monogram: used when there is no logo")
    svg = mf[ICON_SVG].decode()
    ok("<text" not in svg and "<image" not in svg and "base64" not in svg and len(svg) < 3000 and f'fill="{teal}"' in svg, f"monogram icon.svg: a rect and a stroked path, {len(svg)} bytes, no font and no raster")
    m32 = png_decode(mf[ICON_PNG])
    ok(m32.at(0, 0)[3] == 0 and m32.at(16, 3) == _hex(teal) + (255,), "monogram 32 px: a rounded tile in the icon background")
    lit = [(x, y) for y in range(32) for x in range(32) if m32.at(x, y)[0] > 200]
    ok(len(lit) > 30 and min(x for x, _ in lit) < 14 and max(x for x, _ in lit) > 18 and 6 <= min(y for _, y in lit) and max(y for _, y in lit) <= 26, "monogram 32 px: two letters in the foreground colour, centred")
    ma = png_decode(mf[APPLE_PNG])
    ok(is_opaque(ma) and ma.at(0, 0)[:3] == _hex(teal) and png_info(mf[APPLE_PNG])[:2] == (180, 180), "monogram apple icon: 180 px, opaque, background to the corners")
    mm = png_decode(mf[MASK512]); far = [(x, y) for y in range(0, 512, 4) for x in range(0, 512, 4) if mm.at(x, y)[0] > 200 and math.hypot(x - 256, y - 256) > 0.4 * 512]
    ok(is_opaque(mm) and not far, "monogram maskable icon: every letter pixel inside the safe circle")
    old = ('<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="8" fill="#112233"/>'
           '<text x="16" y="21" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="14" font-weight="600" fill="#FAFAFA" text-anchor="middle">AO</text></svg>')
    xf, xinfo = build_set(old, "ZZ", teal, "#000000")
    ok(xinfo["kind"] == "monogram" and png_decode(xf[ICON_PNG]).at(16, 3)[:3] == (0x11, 0x22, 0x33), "a monogram already in state is recognised and keeps its own colours")
    ok(all(c in GLYPHS for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ") and len({png_encode(monogram_image(32, c, "#000", "#fff")) for c in GLYPHS}) == 26, "monogram: all 26 letters, each a different drawing")
    wm = monogram_image(64, "MW", "#000000", "#FFFFFF"); litx = [x for y in range(64) for x in range(64) if wm.at(x, y)[0] > 128]
    ok(min(litx) >= 6 and max(litx) <= 57, "monogram: two wide letters are scaled to stay inside the tile")

    # --- no sharp: a logo that needs it falls back to the initials and says so; nothing raises
    jf, jinfo = build_set(_wrap(b"\xff\xd8\xff\xe0 not really a jpeg", "image/jpeg"), "JP", teal, "#FAFAFA", node_cwd=None)
    ok(jinfo["kind"] == "monogram" and any("sharp" in n and "initials" in n for n in jinfo["notes"]) and not check_set_files(jf), "JPG logo without sharp: the set is drawn from the initials, with the reason")
    drawn = '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">\n  <rect width="32" height="32" rx="8" fill="#0A0A0A"/>\n  <path d="M9 16.5L14 21.5L23.5 11" stroke="#FAFAFA" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>\n</svg>'
    ok(read_mark(drawn, "D", teal, "#fff")["kind"] == "drawn" and read_mark(drawn, "D", teal, "#fff")["bg"] == "#0A0A0A" and "<rect" not in read_mark(drawn, "D", teal, "#fff")["glyph_svg"],
       "a drawn mark: its background rect is read as the tile colour and lifted off the drawing")
    df, dinfo = build_set(drawn, "D", teal, "#FAFAFA", node_cwd=None)
    ok(dinfo["kind"] == "monogram" and df[ICON_SVG].decode().strip() == drawn and not check_set_files(df), "a drawn mark without sharp: rasters from the initials, the drawing itself kept as icon.svg")
    nested = '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><svg x="0" y="0" width="32" height="32" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#C00"/></svg></svg>'
    ok(read_mark(nested, "N", teal, "#fff")["kind"] == "vector", "a nested SVG logo is a vector mark")
    heavy = nested.replace("<circle", '<image href="data:image/png;base64,AAAA"/><circle')
    ok(not svg_is_small_vector(heavy) and svg_is_small_vector(nested), "an SVG logo that embeds a raster is not shipped as icon.svg")

    # --- sharp, when the mold has it: the vector and drawn paths for real
    mold = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), "molds", "mold_v1", "codebase")
    if os.path.isdir(os.path.join(mold, "node_modules", "sharp")) and subprocess.run(["node", "-v"], capture_output=True).returncode == 0:
        vf, vinfo = build_set(nested, "N", teal, "#FAFAFA", node_cwd=mold)
        ok(vinfo["kind"] == "vector" and vinfo["svg"] and vf[ICON_SVG].decode().strip() == nested and not vinfo["notes"], "sharp: a vector logo keeps its SVG as icon.svg")
        v32 = png_decode(vf[ICON_PNG]); va = png_decode(vf[APPLE_PNG])
        ok(v32.at(16, 16)[0] > 190 and v32.at(16, 16)[1] < 20 and v32.at(0, 0)[3] == 0 and va.at(3, 3)[:3] == _hex(teal) and not check_set_files(vf), "sharp: the vector logo is rasterised for the ICO, PNG and apple icon")
        df, dinfo = build_set(drawn, "D", teal, "#FAFAFA", node_cwd=mold)
        d32 = png_decode(df[ICON_PNG]); da = png_decode(df[APPLE_PNG])
        ok(dinfo["kind"] == "drawn" and dinfo["svg"] and d32.at(0, 0)[3] == 0 and d32.at(16, 3)[:3] == (10, 10, 10) and d32.at(14, 21)[0] > 200,
           "sharp: the drawn mark keeps its rounded tile and its drawing at 32 px")
        ok(is_opaque(da) and da.at(0, 0)[:3] == (10, 10, 10) and not check_set_files(df), "sharp: the drawn mark's own background fills the apple icon to the corners")
        import io
        jpg, why = sharp_png(png_encode(_disc(64, (10, 200, 10))), ".png", mold)
        ok(jpg and png_info(jpg)[:2] == (64, 64) and why is None, "sharp: a raster is passed through without being enlarged")
    else:
        print("  (sharp is not in molds/mold_v1/codebase/node_modules here: the vector and drawn-mark checks were skipped)")

    # --- check_set: says what is wrong, in each way it can be wrong
    with tempfile.TemporaryDirectory() as t:
        write_set(t, files)
        ok(check_set(t, expect_svg=False) == [], "check: a freshly written set passes")
        open(os.path.join(t, ICON_SVG), "w").write(_wrap(logo))
        bad = check_set(t, expect_svg=False)
        ok(any("base64" in b for b in bad) and any("must not ship" in b for b in bad), "check: a base64-wrapped raster icon.svg is refused")
        write_set(t, files)
        ok(not os.path.exists(os.path.join(t, ICON_SVG)), "write: a stale icon.svg is removed when the mark is a raster")
        os.remove(os.path.join(t, ICO)); ok(any("favicon.ico is missing" in b for b in check_set(t)), "check: a missing favicon.ico is named")
        open(os.path.join(t, ICO), "wb").write(ico_encode([(16, files[ICON_PNG]), (32, files[ICON_PNG])]))
        bad = check_set(t); ok(any("holds a 32x32" in b for b in bad) and any("no 48x48" in b for b in bad), "check: an ICO with a mislabelled entry and a missing size is named")
        open(os.path.join(t, ICO), "wb").write(b"<!doctype html><title>404</title>"); ok(any("not a valid ICO" in b for b in check_set(t)), "check: a 404 page saved as favicon.ico is named")
        write_set(t, files); open(os.path.join(t, APPLE_PNG), "wb").write(files[M192])
        bad = check_set(t); ok(any("192x192, not 180x180" in b for b in bad), "check: an apple icon of the wrong size is named")
        open(os.path.join(t, APPLE_PNG), "wb").write(png_encode(fit(_disc(40, (1, 2, 3)), 180)))
        ok(any("iOS paints them black" in b for b in check_set(t)), "check: a transparent apple icon is named")
        write_set(t, files); noise = Img(512, 512, bytearray(os.urandom(4 * 512 * 512)))
        open(os.path.join(t, M512), "wb").write(png_encode(noise, cap=0))
        ok(any("must stay under 100 KB" in b for b in check_set(t)), "check: an icon over 100 KB is named")
        ok(len(png_encode(noise, opaque=True)) < len(png_encode(noise, opaque=True, cap=0)), "encode: an image that will not fit is re-encoded with fewer colour bits")
        link = os.path.join(t, "mold-icon.svg"); open(link, "w").write("MOLD"); os.remove(os.path.join(t, ICON_PNG)); os.link(link, os.path.join(t, ICON_PNG))
        write_set(t, files); ok(open(link).read() == "MOLD", "write: a hard link into the mold is replaced, never written through")
    ok(len(version(files)) == 8 and version(files) != version(mf) and f"?v={version(files)}" in manifest_icons_ts(version(files)) and manifest_icons_ts("x").count("purpose") == 3,
       "manifest: 192 and 512 'any' plus a maskable 512, each address carrying the set's fingerprint")
    html = preview_html(info)
    ok(html.count('width="16" height="16"') == 2 and html.count('width="32" height="32"') == 2 and 'width="180" height="180"' in html, "preview: the favicon at 16 and 32 px, light and dark, and the apple icon")
    print(f"favicon: {len(checks)} checks passed")
    return 0

def check_set_files(files):
    """check_set for a set still in memory (used by the self-test)."""
    with tempfile.TemporaryDirectory() as t:
        write_set(t, files); return check_set(t, expect_svg=ICON_SVG in files)

if __name__ == "__main__":
    if "--self-test" in sys.argv: sys.exit(self_test())
    sys.exit(__doc__)
