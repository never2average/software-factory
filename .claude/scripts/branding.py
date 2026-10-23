#!/usr/bin/env python3
"""Branding: apply an application's own theme and logo to a per-app copy of the mold.

  branding.py <app_id> set --name "Acme Ops" [--color #1F6F5C] [--logo path.png|.svg] [--tagline "..."]
                                            the whole brand from three inputs; everything else is derived
  branding.py --product <product_id> set …  the same, onto a product in state/products.json (future stamps)
  branding.py <app_id> show                 this app's brand and the palette it derives
  branding.py <app_id> preview              build/<app_id>/brand-preview.html: sign-in tile and palette, light and dark
  branding.py <app_id> prepare [--force]    build/<app_id>/ = mold copy + brand overlay; prints the path
  branding.py <app_id> check                verify a prepared copy carries the brand, no stale name, and a
                                            complete favicon set of the right sizes, each file under 100 KB
  branding.py --self-test                   the offline checks of the favicon set and of the overlay that writes it

THE FAVICON SET. `prepare` writes, from the brand's mark (its logo file, or the monogram when there is none):
app/favicon.ico (16, 32, 48), app/icon.png (32), app/apple-icon.png (180, opaque), the web manifest's
public/icon-192.png, icon-512.png and icon-maskable-512.png, and app/icon.svg ONLY for a true vector mark. A
raster logo is never wrapped in an SVG as base64 (that was a 171 KB tab icon that Safari did not draw, with
/favicon.ico and /apple-icon.png answering 404). The pictures are made in lib/favicon.py, in standard-library
Python; a JPG, WebP or SVG logo is first turned into a PNG by `sharp` from the mold's own node_modules, and when
that is missing the set is drawn from the initials and `prepare` says so. `preview` shows the tab icon at 16 and
32 px and the home-screen icon.

THE SHORT WAY. A brand is three things a person actually has: a name, one colour, a logo file (PNG, JPG
or SVG). `set` derives the rest — the light and dark palette from the colour, the app icon and sign-in
mark from the logo (or a monogram when there is none), a legible icon foreground, the description from
name and tagline — and writes the complete block into the app's state, so nothing below needs to be
typed by hand. The long fields (tokens, radius, neutral_chroma, icon_bg/icon_fg, icon_svg) still
exist for a designer who wants an exact value; `set` fills them, it does not remove them.

The mold under molds/<mold_id>/codebase is a snapshot and is never edited. `prepare` copies the
source tree (11 MB; node_modules is hard-linked, never written) into build/<app_id>/ and rewrites
the branded surfaces there. provision.py builds and deploys from that copy, which also gives every
app its own build directory instead of sharing one.

The brand lives in the application's own state (`surface.branding`), complete, with the icon inline.
Products carry a `brand` that intake copies in at stamp time; nothing points at a shared file, so an
app is readable on its own and cannot change under it.

What a brand can change: the product name (browser tab, sign-in wordmark and footer, onboarding
copy, every outgoing email), the tagline and description, the app icon and sign-in mark, and the
whole colour palette in light and dark. WHERE each of those lives is a property of the mold, not of
the brand, so molds/<mold_id>/branding/rules.json pins the files and strings — a forked mold ships
its own. Every rule must match or prepare refuses, so a mold refresh that moves this text fails
loudly instead of shipping half-branded.
"""
import base64, json, os, re, shutil, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ST = os.path.join(ROOT, "state")
def load(p): return json.load(open(p))
def esc(s): return json.dumps(s, ensure_ascii=False)      # a JS/TS string literal, em dashes and all
def jsx_text(s): return s.replace("{", "&#123;").replace("}", "&#125;")

# ---------------------------------------------------------------- colour ----
def _hex_to_rgb(h):
    h = h.lstrip("#")
    if len(h) == 3: h = "".join(c * 2 for c in h)
    if len(h) != 6 or not re.fullmatch(r"[0-9a-fA-F]{6}", h): sys.exit(f"not a hex colour: #{h}")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))

def hex_to_oklch(h):
    """sRGB hex -> oklch(L C H) with the same rounding the mold's stylesheet uses."""
    def lin(c): return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(c) for c in _hex_to_rgb(h))
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    import math
    C = math.sqrt(A * A + B * B); H = math.degrees(math.atan2(B, A)) % 360
    return f"oklch({round(L, 3)} {round(C, 3)} {round(H, 1)})"

def _num(x, places):
    """Trim to the stylesheet's own style: 0.19 not 0.190, 0 not 0.0."""
    return f"{round(x, places):g}"

def oklch(L, C, H):
    c = round(C, 3)
    return f"oklch({_num(L, 3)} {_num(c, 3)} {_num(0 if c == 0 else H, 1)})"   # hue is meaningless at zero chroma

def parse_oklch(v):
    m = re.fullmatch(r"oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)", v.strip())
    if not m: sys.exit(f"cannot read the brand colour {v!r}; use #rrggbb or oklch(L C H)")
    return float(m.group(1)), float(m.group(2)), float(m.group(3))

def _oklch_to_srgb(v):
    """oklch(L C H) -> (r, g, b) in 0..1, sRGB gamma-encoded, clipped. Alpha is ignored."""
    L, C, H = parse_oklch(v)
    import math
    a, b = C * math.cos(math.radians(H)), C * math.sin(math.radians(H))
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s3 = l_ ** 3, m_ ** 3, s_ ** 3
    lin = (4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s3,
           -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s3,
           -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s3)
    g = lambda c: 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
    return tuple(min(1.0, max(0.0, g(c))) for c in lin)

def contrast(v1, v2):
    """WCAG 2.1 contrast ratio between two oklch() colours."""
    def lum(rgb):
        lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        r, g, b = (lin(c) for c in rgb); return 0.2126 * r + 0.7152 * g + 0.0722 * b
    a, b = lum(_oklch_to_srgb(v1)), lum(_oklch_to_srgb(v2))
    hi, lo = max(a, b), min(a, b); return (hi + 0.05) / (lo + 0.05)

# Text-on-surface pairs every generated palette must keep at WCAG AA (4.5:1). The overlay REPLACES the
# mold's palette blocks, so a fix made upstream in globals.css is overwritten by this formula on every
# build: on 2026-09-13 the mold had --muted-foreground at 0.52 (fixed after axe found seven serious
# contrast failures on /workspace) while this generator still wrote 0.6, and the deployed app failed
# the accessibility lane on exactly those seven. A palette that fails here is refused before it is
# written, in prepare and in check alike.
CONTRAST_PAIRS = [("muted-foreground", "background"), ("muted-foreground", "card"), ("muted-foreground", "muted"),
                  ("foreground", "background"), ("primary-foreground", "primary"), ("accent-foreground", "accent"),
                  ("secondary-foreground", "secondary")]

def contrast_guard(pal):
    bad = []
    for scheme in ("light", "dark"):
        for fg, bg in CONTRAST_PAIRS:
            a, b = pal[scheme].get(fg), pal[scheme].get(bg)
            if not a or not b or "/" in a or "/" in b: continue     # an alpha token is a blend, not a colour
            r = contrast(a, b)
            if r < 4.5: bad.append(f"{scheme} --{fg} on --{bg}: {r:.2f}:1 (WCAG AA needs 4.5:1)")
    if bad: sys.exit("the generated palette fails contrast; refusing to write it:\n  " + "\n  ".join(bad))

def palette(brand_hex, neutral_chroma=0.006):
    """The mold's greyscale palette, tinted toward one brand colour.

    Neutrals keep their lightness and take a trace of the brand hue, so surfaces read as the brand
    family without becoming coloured. `primary`, `accent` and `ring` carry the brand itself. The
    light and dark ramps mirror the mold's own values, so contrast stays where the design put it."""
    L, C, H = parse_oklch(brand_hex if brand_hex.startswith("oklch") else hex_to_oklch(brand_hex))
    n = lambda lightness: oklch(lightness, neutral_chroma, H)          # tinted neutral
    light = {
        "background": n(0.971), "foreground": n(0.16), "card": oklch(1, 0, H), "card-foreground": n(0.16),
        "popover": oklch(1, 0, H), "popover-foreground": n(0.16),
        "primary": oklch(max(0.18, min(L, 0.55)), C, H), "primary-foreground": n(0.985),
        "secondary": n(0.94), "secondary-foreground": n(0.19),
        "muted": n(0.94), "muted-foreground": n(0.52),     # 0.6 measured 3.3-3.9:1 on these surfaces; 0.52 is 4.6-5.5:1
        "accent": oklch(0.94, min(C * 0.35, 0.05), H), "accent-foreground": oklch(max(0.19, min(L, 0.45)), C, H),
        "destructive": "oklch(0.577 0.245 27.325)",
        "border": n(0.916), "input": n(0.916), "ring": oklch(min(max(L, 0.5), 0.75), C * 0.8, H),
    }
    dark = {
        "background": n(0.145), "foreground": n(0.985), "card": n(0.205), "card-foreground": n(0.985),
        "popover": n(0.205), "popover-foreground": n(0.985),
        "primary": oklch(max(0.65, min(L + 0.35, 0.9)), C * 0.9, H), "primary-foreground": n(0.205),
        "secondary": n(0.269), "secondary-foreground": n(0.985),
        "muted": n(0.269), "muted-foreground": n(0.708),
        "accent": oklch(0.32, min(C * 0.4, 0.06), H), "accent-foreground": n(0.985),
        "destructive": "oklch(0.704 0.191 22.216)",
        "border": "oklch(1 0 0 / 10%)", "input": "oklch(1 0 0 / 15%)",
        "ring": oklch(min(max(L + 0.2, 0.5), 0.75), C * 0.7, H),
    }
    pal = {"light": light, "dark": dark}
    contrast_guard(pal)
    return pal

# ----------------------------------------------------------------- brand ----
def resolve(app):
    """This app's brand, which lives in its own state and nowhere else.

    There is deliberately no shared pack to point at: an application must be readable on its own, and
    a brand edited in one place must not silently change every app's next build. Products carry a
    `brand` that intake COPIES in at stamp time; after that the app owns it."""
    return dict(app.get("surface", {}).get("branding") or {})

def mark_inputs(b):
    """(initials, icon background, icon foreground): what the monogram, and any icon that needs an opaque
    background, are drawn with."""
    initials = "".join(w[0] for w in re.findall(r"[A-Za-z]+", b.get("product_name", "App"))[:2]).upper() or "A"
    bg = b.get("icon_bg") or (b["brand_color"] if str(b.get("brand_color", "")).startswith("#") else "#0A0A0A")
    return initials, bg, b.get("icon_fg") or legible_on(bg)

def favicon_lib():
    lib = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib")
    if lib not in sys.path: sys.path.insert(0, lib)
    import favicon
    return favicon

def favicon_set(b, node_cwd):
    """The brand's favicon files and what they were drawn from (lib/favicon.py build_set)."""
    initials, bg, fg = mark_inputs(b)
    return favicon_lib().build_set(b.get("icon_svg") or "", initials, bg, fg, node_cwd=node_cwd)

def read_mark(b):
    """The brand's square mark as (full svg, inner elements). Falls back to a monogram."""
    svg = (b.get("icon_svg") or "").strip()
    if svg:
        if not re.search(r'viewBox="0 0 32 32"', svg):
            sys.exit('branding.icon_svg must use viewBox="0 0 32 32" so it fits every mark slot')
        inner = re.sub(r"^<svg[^>]*>|</svg>\s*$", "", svg, flags=re.S).strip()
        return svg, inner
    initials, bg, fg = mark_inputs(b)
    inner = (f'<rect width="32" height="32" rx="8" fill="{bg}"/>'
             f'<text x="16" y="21" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" '
             f'font-size="14" font-weight="600" fill="{fg}" text-anchor="middle">{initials}</text>')
    return (f'<svg width="32" height="32" viewBox="0 0 32 32" fill="none" '
            f'xmlns="http://www.w3.org/2000/svg">{inner}</svg>'), inner

def legible_on(hex_bg):
    """White or near-black, whichever reads better on this background (WCAG contrast)."""
    bg = hex_to_oklch(hex_bg)
    return "#FAFAFA" if contrast(bg, "oklch(0.985 0 0)") >= contrast(bg, "oklch(0.16 0 0)") else "#0A0A0A"

LOGO_MAX_BYTES = 256 * 1024
def logo_to_icon_svg(path):
    """A logo file -> the 32x32 SVG every mark slot expects. SVG sources are nested as-is (their own
    viewBox scaled to fit); raster sources are embedded as a data URI and scaled by the browser.
    Bounded in size: the icon ships in every page, the org row and the sign-in tile."""
    p = path if os.path.isabs(path) else os.path.join(ROOT, path)
    if not os.path.isfile(p): sys.exit(f"logo not found: {path}")
    raw = open(p, "rb").read()
    if len(raw) > LOGO_MAX_BYTES: sys.exit(f"logo is {len(raw)//1024} KB; keep it under {LOGO_MAX_BYTES//1024} KB (a 256px PNG is plenty)")
    ext = os.path.splitext(p)[1].lower()
    if ext == ".svg":
        txt = raw.decode("utf-8", "replace")
        m = re.search(r"<svg\b[^>]*>", txt, re.S)
        if not m: sys.exit(f"{path} is not an SVG (no <svg> element)")
        head = m.group(0); inner = txt[m.end():txt.rfind("</svg>")]
        vb = re.search(r'viewBox="([^"]+)"', head)
        w = re.search(r'\bwidth="([\d.]+)', head); h = re.search(r'\bheight="([\d.]+)', head)
        viewbox = vb.group(1) if vb else (f"0 0 {w.group(1)} {h.group(1)}" if w and h else "0 0 32 32")
        inner_el = f'<svg x="0" y="0" width="32" height="32" viewBox="{viewbox}" preserveAspectRatio="xMidYMid meet">{inner.strip()}</svg>'
    elif ext in (".png", ".jpg", ".jpeg", ".webp"):
        mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}[ext[1:]]
        inner_el = f'<image href="data:{mime};base64,{base64.b64encode(raw).decode()}" x="0" y="0" width="32" height="32" preserveAspectRatio="xMidYMid meet"/>'
    else:
        sys.exit(f"logo must be .png, .jpg, .webp or .svg, not {ext or 'a file with no extension'}")
    return f'<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">{inner_el}</svg>'

def is_logo_mark(inner):
    """A mark that came from a logo file (raster or nested SVG) is shown as itself; a drawn mark is recoloured."""
    return bool(re.search(r"<image\b|<svg\b", inner))

DEFAULT_TAGLINE = "The operations console for forward-deployed teams."
def normalize(b, name=None, color=None, logo=None, tagline=None):
    """The complete brand block from the inputs (name, colour, logo, tagline), with every DERIVED field
    recomputed from them: description, icon colours, neutral tint, the inlined mark. Inputs the caller
    does not name keep their current value. Pinned tokens survive only while the colour is unchanged:
    they were tuned for that colour, and a pin left behind under a new one is how a brand ends up
    with a grey primary in dark mode (seen on the first trial of this command)."""
    b = dict(b or {}); old_color = b.get("brand_color")
    if name: b["product_name"] = name.strip()
    if not b.get("product_name"): sys.exit("a brand needs a name: --name \"Acme Ops\"")
    if color:
        if not re.fullmatch(r"#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}", color): sys.exit(f"--color must be a hex colour like #1F6F5C, not {color!r}")
        b["brand_color"] = color.upper()
    if tagline is not None: b["tagline"] = tagline.strip()
    b.setdefault("tagline", DEFAULT_TAGLINE)
    # derived, always from the inputs as they now stand
    desc = b.get("description") or ""
    if not desc or desc.startswith("TODO") or not desc.startswith(b["product_name"]):
        b["description"] = f"{b['product_name']} — {b['tagline']}".rstrip(" —")
    b.setdefault("radius", "0.625rem")
    if b.get("brand_color") != old_color: b.pop("tokens", None)
    if b.get("brand_color"):
        if color or "neutral_chroma" not in b: b["neutral_chroma"] = 0.006 if b["brand_color"].startswith("#") else 0
        if b["brand_color"].startswith("#") and (color or not b.get("icon_bg")):
            b["icon_bg"] = b["brand_color"]; b["icon_fg"] = legible_on(b["icon_bg"])
    if logo:
        b["logo"] = os.path.relpath(logo if os.path.isabs(logo) else os.path.join(ROOT, logo), ROOT)
        b["icon_svg"] = logo_to_icon_svg(b["logo"])
    elif not b.get("logo") and (color or name or not b.get("icon_svg")):
        b.pop("icon_svg", None); b["icon_svg"] = read_mark(b)[0]     # a fresh monogram in the new colours
    if b.get("brand_color"): palette(b["brand_color"], b.get("neutral_chroma", 0.006))   # contrast guard
    return b

def set_brand(target, args):
    """`set` for an app (state/application/<id>/application.json) or a product (state/products.json)."""
    opt = lambda k: (args[args.index(k) + 1] if k in args and args.index(k) + 1 < len(args) else None)
    kind, ident = target
    if kind == "app":
        p = os.path.join(ST, "application", ident, "application.json"); doc = load(p)
        cur = doc.setdefault("surface", {}).get("branding") or {}
        nb = normalize(cur, opt("--name"), opt("--color"), opt("--logo"), opt("--tagline"))
        why = name_problem(nb["product_name"], doc.get("mold_id"))
        if why: sys.exit(why + ". Nothing was written.")
        doc["surface"]["branding"] = nb
        # the workspace tile follows the mark, unless the source deployment already had one
        org = doc.setdefault("workspace", {}).setdefault("org", {})
        if not org.get("logo_url") or org["logo_url"].startswith("data:image/svg+xml"):
            org["logo_url"] = "data:image/svg+xml;base64," + base64.b64encode(nb["icon_svg"].encode()).decode()
    else:
        p = os.path.join(ST, "products.json"); doc = load(p)
        prods = [x for x in doc["products"] if x["product_id"] == ident]
        if not prods: sys.exit(f"no product {ident!r} in state/products.json")
        prods[0]["brand"] = nb = normalize(prods[0].get("brand") or {}, opt("--name"), opt("--color"), opt("--logo"), opt("--tagline"))
    json.dump(doc, open(p, "w"), indent=2, ensure_ascii=False); open(p, "a").write("\n")
    mark = "logo file " + nb["logo"] if nb.get("logo") else "a monogram"
    print(f"{kind} {ident}: brand set — {nb['product_name']!r}, colour {nb.get('brand_color', 'the mold greyscale')}, mark from {mark}, tagline {nb['tagline']!r}.")
    print(f"  see it: python3 .claude/scripts/branding.py {ident} preview" if kind == "app" else "  stamps of this product from now on carry it; existing apps keep theirs")

def preview(app_id, b, node_cwd=None):
    """One HTML file showing what the brand does to the sign-in tile and the palette, light and dark, and the
    favicon as a browser tab (16 and 32 px) and a phone's home screen show it."""
    pal = palette(b["brand_color"], b.get("neutral_chroma", 0.006)) if b.get("brand_color") else None
    if pal:
        for scheme in ("light", "dark"):
            for tok, val in (b.get("tokens", {}).get(scheme) or {}).items():
                if tok in pal[scheme]: pal[scheme][tok] = val
    svg = b.get("icon_svg") or read_mark(b)[0]
    uri = "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()
    def side(scheme):
        v = (lambda t: pal[scheme][t]) if pal else (lambda t: {"background": "#f7f7f7" if scheme == "light" else "#171717", "foreground": "#262626" if scheme == "light" else "#fafafa", "primary": "#303030" if scheme == "light" else "#ebebeb", "primary-foreground": "#fafafa" if scheme == "light" else "#343434", "muted-foreground": "#777", "border": "#e5e5e5" if scheme == "light" else "#333", "card": "#fff" if scheme == "light" else "#343434", "accent": "#efefef" if scheme == "light" else "#444", "ring": "#b4b4b4"}[t])
        sw = "".join(f'<div style="flex:1;min-width:64px"><div style="height:36px;border-radius:8px;background:{v(t)};border:1px solid {v("border")}"></div><div style="font-size:11px;opacity:.7;margin-top:4px">{t}</div></div>' for t in ("background", "foreground", "primary", "accent", "muted-foreground", "border", "ring"))
        return f'''<section style="flex:1;min-width:300px;background:{v("background")};color:{v("foreground")};padding:28px;border-radius:16px;border:1px solid {v("border")}">
  <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.6;margin-bottom:18px">{scheme}</div>
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px"><img src="{uri}" alt="" style="width:40px;height:40px;border-radius:10px"><div style="font-size:22px;font-weight:600">{b["product_name"]}</div></div>
  <div style="font-size:14px;color:{v("muted-foreground")};margin-bottom:20px">{b.get("tagline","")}</div>
  <button style="background:{v("primary")};color:{v("primary-foreground")};border:0;border-radius:{b.get("radius","0.625rem")};padding:10px 16px;font-size:14px;font-weight:500">Continue with Google</button>
  <div style="margin-top:10px;font-size:12px;color:{v("muted-foreground")};text-decoration:underline">Invited by email? Sign in with a code</div>
  <div style="display:flex;gap:8px;margin-top:24px;flex-wrap:wrap">{sw}</div>
</section>'''
    html = f'''<title>{b["product_name"]} brand preview</title>
<style>body{{margin:0;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#e9e9e9;color:#222}} h1{{font-size:16px;font-weight:600;margin:0 0 16px}}</style>
<h1>{b["product_name"]} — what the sign-in page and palette will look like</h1>
<div style="display:flex;gap:20px;flex-wrap:wrap">{side("light")}{side("dark")}</div>
{favicon_lib().preview_html(favicon_set(b, node_cwd)[1])}
<p style="font-size:12px;opacity:.7;margin-top:16px">Derived from colour {b.get("brand_color","(mold greyscale)")}, mark from {"logo file " + b["logo"] if b.get("logo") else "a monogram"}. Change with: branding.py {app_id} set --name … --color … --logo …</p>'''
    out = os.path.join(ROOT, "build", app_id, "brand-preview.html"); os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "w").write(html); print(f"preview written: {os.path.relpath(out, ROOT)}"); return out

def auth_mark_jsx(inner, mark_src="/icon.svg"):
    """The brand mark as JSX for the sign-in tile.

    The tile already paints a foreground-coloured square, so the mark's own background rect is
    dropped and its strokes and fills are re-pointed at the background colour. SVG attributes are
    hyphenated; JSX wants them camel-cased."""
    if is_logo_mark(inner):
        # The same mark is already served as an icon file: /icon.svg for a vector logo, the manifest's 192 px PNG
        # for a raster one (a 32 px tile is 64 to 96 device pixels on a phone). Point at it rather than inlining a
        # base64 copy: inlined, a raster logo was ~72 KB of every page's HTML AND of the JS bundle (upstream #64).
        return f'<img src="{mark_src}" alt="" className="size-8 rounded-md" aria-hidden />'
    body = re.sub(r"<rect\b[^>]*/>", "", inner, count=1).strip()
    body = re.sub(r'\sfill="none"', "", body)
    body = re.sub(r'\sstroke="[^"]*"', ' className="stroke-background"', body)
    body = re.sub(r'\sfill="(?!none)[^"]*"', ' className="fill-background"', body)
    # stroke-width= -> strokeWidth= . The lookahead keeps it to attribute NAMES: a hyphenated
    # Tailwind class inside quotes is followed by a quote, not an equals sign.
    body = re.sub(r"\b([a-z]+)-([a-z])(?=[a-zA-Z-]*=)", lambda m: m.group(1) + m.group(2).upper(), body)
    body = "\n".join("            " + l.strip() for l in body.splitlines() if l.strip())
    return ('<svg viewBox="0 0 32 32" className="size-8" fill="none" aria-hidden>\n'
            f'{body}\n          </svg>')

# --------------------------------------------------------------- overlay ----
def apply_overlay(build_dir, b, rules):
    """Rewrite the branded surfaces in the build copy. Every rule must match."""
    f = lambda key: os.path.join(build_dir, rules["files"][key])
    name = b["product_name"]; old = rules["product_name_default"]
    applied = []

    # The favicon set: favicon.ico, icon.png, apple-icon.png, the manifest's three PNGs, and icon.svg only for a
    # vector mark. The mold's own app/icon.svg is replaced or removed, never left behind.
    svg, inner = read_mark(b)
    fav = favicon_lib(); icons, icon_info = fav.build_set(b.get("icon_svg") or "", *mark_inputs(b), node_cwd=build_dir)
    fav.write_set(build_dir, icons, rules.get("favicon")); icon_v = fav.version(icons)
    applied.append("icons:" + icon_info["kind"]); apply_overlay.icon_info = icon_info
    mark_src = "/icon.svg" if icon_info["svg"] else f"/icon-192.png?v={icon_v}"

    # A mold with a deployment profile (scripts/gen-deployment-profile.mjs) takes its NAME, tagline and description
    # from profiles/*.json, not from literals in source: the brand is written as profiles/90-brand.json (after any
    # pack's profile, so the application's own brand wins) and the generator is re-run. The rules marked
    # "via_profile" and the product-name file list are then skipped — those literals no longer exist upstream
    # (upstream #15). The icon, the sign-in mark and the palette are still source rewrites.
    profiled = os.path.exists(os.path.join(build_dir, "scripts", "gen-deployment-profile.mjs"))
    if profiled:
        prod = {"name": name}
        if b.get("tagline"): prod["tagline"] = b["tagline"]
        if b.get("description"): prod["description"] = b["description"]
        os.makedirs(os.path.join(build_dir, "profiles"), exist_ok=True)
        json.dump({"$comment": "written by the factory's branding step; the application's own brand", "product": prod},
                  open(os.path.join(build_dir, "profiles", "90-brand.json"), "w"), indent=2, ensure_ascii=False)
        r_ = subprocess.run(["node", "scripts/gen-deployment-profile.mjs"], cwd=build_dir, capture_output=True, text=True)
        if r_.returncode: sys.exit("the deployment profile could not be generated with the brand: " + (r_.stdout + r_.stderr).strip()[-400:])
        applied.append("profile:90-brand")

    # A mold whose names come from a profile FILE the codebase reads (rules "profile"; mold_v0's profile.json, which
    # scripts/gen-packs.mjs merges into the generated profile modules): the brand's name and words are written into
    # that file's fields and the mold's own generator is re-run. No source file is rewritten for the name.
    if rules.get("profile"):
        applied += write_profile(build_dir, b, rules["profile"])

    subs = {"description_literal": esc(b.get("description") or f"{name} — {b.get('tagline', '')}".strip(" —")),
            "tagline": jsx_text(b.get("tagline", "")), "auth_mark_jsx": auth_mark_jsx(inner, mark_src),
            "layout_icons": fav.LAYOUT_ICONS_TS, "manifest_icons": fav.manifest_icons_ts(icon_v)}
    if b.get("brand_color"): subs["brand_color"] = b["brand_color"]
    for r in rules["replacements"]:
        if profiled and r.get("via_profile"): continue
        if r.get("needs") and not b.get(r["needs"]): continue        # e.g. a theme colour only when the brand has a colour
        if r.get("needs") == "brand_color" and not re.fullmatch(r"#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}", str(b["brand_color"])):
            sys.exit(f"branding rule {r['id']}: the brand colour {b['brand_color']!r} is not a hex colour like #1F6F5C; set it with branding.py <app> set --color")
        p = f(r["file"]); s = open(p).read()
        if r["find"] not in s:
            sys.exit(f"branding rule {r['id']} no longer matches {rules['files'][r['file']]}; the mold moved. "
                     f"Update molds/{b.get('_mold','mold_v1')}/branding/rules.json before deploying.")
        s = s.replace(r["find"], r["replace"].format(**subs))
        open(p, "w").write(s); applied.append(r["id"])

    if name != old and not profiled:
        for key in rules["product_name_files"]:
            p = f(key); s = open(p).read()
            if old not in s: sys.exit(f"expected the product name {old!r} in {rules['files'][key]}; the mold moved")
            open(p, "w").write(s.replace(old, name)); applied.append(f"name:{key}")

    if b.get("brand_color"):
        pal = palette(b["brand_color"], b.get("neutral_chroma", 0.006))
        # A pack may pin any token outright — the derivation is a good default, not a straitjacket.
        for scheme in ("light", "dark"):
            for tok, val in (b.get("tokens", {}).get(scheme) or {}).items():
                if tok not in pal[scheme]: sys.exit(f"unknown token --{tok} in tokens.{scheme}")
                pal[scheme][tok] = val
        p = f("globals"); s = open(p).read()
        for blk in rules["palette_blocks"]:
            i = s.find(blk["anchor"])
            if i < 0: sys.exit(f"palette block {blk['id']} not found in {rules['files']['globals']}; the mold moved")
            end = s.index("}", i + len(blk["anchor"]))
            seg = s[i:end]
            only = rules.get("palette_tokens")          # a mold that takes only the brand-carrying tokens keeps its own neutrals
            for tok, val in pal[blk["scheme"]].items():
                if only and tok not in only: continue
                # count the substitution, not the text change: a token whose brand value equals the
                # mold's (destructive red) is still correctly set.
                seg, n = re.subn(rf"(--{re.escape(tok)}:\s*)[^;]+;", lambda m: m.group(1) + val + ";", seg, count=1)
                if n != 1 and f"--{tok}:" in seg: sys.exit(f"could not set --{tok} in {blk['id']}")
            if b.get("radius") and (not only or "radius" in only): seg = re.sub(r"(--radius:\s*)[^;]+;", lambda m: m.group(1) + b["radius"] + ";", seg, count=1)
            s = s[:i] + seg + s[end:]
        open(p, "w").write(s); applied.append("palette")
    return applied

def slug_for(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:63] or "app"

def profile_values(b, spec):
    """{field: value} the brand writes into the mold's profile file. The tagline-derived fields only when the brand has a
    tagline of its own (not mold_v1's default, which is another mold's words)."""
    name = b["product_name"]; tag = b.get("tagline") or ""
    own_tag = bool(tag) and tag != DEFAULT_TAGLINE
    vals = {"name": name, "slug": slug_for(name), "tagline": tag if own_tag else "",
            "description": (b.get("description") or "") if own_tag else ""}
    if spec.get("refuse") and re.search(spec["refuse"], name): sys.exit(name_refused(name, spec))
    out = {}
    for field, tmpl in spec["fields"].items():
        keys = re.findall(r"\{(\w+)\}", tmpl)
        if any(k not in vals for k in keys): sys.exit(f"branding rules: profile field {field} uses an unknown value ({tmpl})")
        if any(not vals[k] for k in keys):
            if field in (spec.get("neutral") or {}): out[field] = spec["neutral"][field]   # never the codebase product's words
            continue
        out[field] = tmpl.format(**vals)
    return out

def name_refused(name, spec):
    return f"the brand name {name!r} has a character this mold's profile cannot carry (any of < > \" or a line break); choose another name"

def name_problem(name, mold_id):
    """A sentence when this mold's profile cannot carry the name (molds/<mold>/branding/rules.json profile.refuse), else ''."""
    p = os.path.join(ROOT, "molds", str(mold_id or ""), "branding", "rules.json")
    try: spec = (load(p).get("profile") or {}) if os.path.isfile(p) else {}
    except ValueError: return ""
    return name_refused(name, spec) if spec.get("refuse") and name and re.search(spec["refuse"], name) else ""

def write_profile(build_dir, b, spec):
    """Write the brand into the mold's profile file (fields only; every other field kept) and run its generator."""
    p = os.path.join(build_dir, spec["file"])
    doc = load(p) if os.path.isfile(p) else {}
    vals = profile_values(b, spec)
    doc.update(vals)
    doc["$comment"] = "Written by the factory's branding step (branding.py): this application's own brand over the mold's profile."
    if os.path.lexists(p): os.remove(p)                       # never write through a hard link into the mold
    with open(p, "w") as fh: fh.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    r = subprocess.run(spec["generator"], cwd=build_dir, capture_output=True, text=True)
    if r.returncode: sys.exit("the profile could not be generated with the brand: " + (r.stdout + r.stderr).strip()[-400:])
    return ["profile:" + ",".join(sorted(vals))]

def copy_rules(mold_dir):
    """molds/<mold>/mold.json "build_copy": the extra paths a build copy leaves out and the node_modules folders it links.
    None for a mold without one (mold_v1): the copy is made exactly as it always was."""
    p = os.path.join(os.path.dirname(os.path.abspath(mold_dir)), "mold.json")
    try: return load(p).get("build_copy") if os.path.isfile(p) else None
    except ValueError: return None

def build_copy(app_id, mold_dir, force=False, root=None):
    """build/<app_id>/: the per-application copy of the mold that brand and packs are applied to. The mold itself
    is never edited; this is the only place an application's own code exists."""
    build_dir = os.path.join(root or ROOT, "build", app_id)
    if os.path.exists(build_dir) and not force: shutil.rmtree(build_dir)
    os.makedirs(build_dir, exist_ok=True)
    cr = copy_rules(mold_dir)
    # Source tree only. node_modules is hard-linked (never written, so the mold cannot be touched)
    # and the build artefact directories stay per-app.
    subprocess.run(["rsync", "-a", "--delete", "--exclude", "node_modules", "--exclude", ".next",
                    "--exclude", ".vercel", "--exclude", ".eve", "--exclude", ".env.local",
                    *[x for e in ((cr or {}).get("exclude") or []) for x in ("--exclude", e)],
                    mold_dir + "/", build_dir + "/"], check=True)
    if cr is None:
        nm = os.path.join(build_dir, "node_modules")
        if not os.path.exists(nm):
            subprocess.run(["cp", "-al", os.path.join(mold_dir, "node_modules"), nm], check=True)
        return build_dir
    # A mold that names its node_modules folders (mold_v0: the API's and the console's) has each linked when the mold
    # has it installed; one that is not installed is left out (the image and Vercel builds install their own).
    for d in cr.get("node_modules") or []:
        src, nm = os.path.join(mold_dir, d), os.path.join(build_dir, d)
        if os.path.isdir(src) and not os.path.exists(nm):
            os.makedirs(os.path.dirname(nm), exist_ok=True)
            subprocess.run(["cp", "-al", src, nm], check=True)
    return build_dir

def prepare(app_id, app, mold_dir, force=False):
    b = resolve(app)
    if not b:
        print("no branding on this app; building from the mold as-is"); return mold_dir
    # The app's own profile settings (application.json `profile`, mold_v0-090; lib/app_profile.py), refused BEFORE the copy
    # is made; written into its profile file before the overlay, whose generator run then compiles them with the brand.
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
    import app_profile
    perrs = app_profile.problems(app.get("profile"), app.get("mold_id"), ROOT)
    if perrs: sys.exit(f"{app_id}: the app's profile settings were refused, so nothing was built: " + "; ".join(perrs))
    build_dir = build_copy(app_id, mold_dir, force)
    # The starter library state asks for goes in BEFORE the overlay, which regenerates the deployment profile with
    # the brand: library.install "all" names the mold's account-delivery library in profiles/, "none" leaves it out.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import library
    library.apply(build_dir, app, mold_dir)
    rules = load(os.path.join(os.path.dirname(mold_dir), "branding", "rules.json"))
    app_profile.write(build_dir, app, ROOT)     # checked above; packs.py apply writes them again
    applied = apply_overlay(build_dir, b, rules)
    info = getattr(apply_overlay, "icon_info", None)
    if info:
        print(f"favicon set drawn from {info['source']}: favicon.ico (16, 32, 48), icon.png, apple-icon.png, manifest icons 192 and 512 + maskable"
              + (", icon.svg" if info["svg"] else "; no icon.svg (the mark is not a vector)"))
        for n in info["notes"]: print("  note: " + n)
    # last, on its own line: provision.py and vm_remote.py show the operator the final line of this step
    print(f"branded build copy: {os.path.relpath(build_dir, ROOT)}  ({b['product_name']}, {len(applied)} rule(s))")
    return build_dir

def check_build(build_dir, b, rules):
    """What is wrong with a prepared copy's brand, as plain sentences ([] when it is right)."""
    name = b.get("product_name"); old = rules["product_name_default"]; bad = []
    gen = os.path.join(build_dir, "lib", "deployment-profile.generated.ts")
    if name and rules.get("profile"):
        # a profile-file mold (mold_v0): the profile file and every module generated from it carry the brand's values
        spec = rules["profile"]; want = profile_values(b, spec)
        p = os.path.join(build_dir, spec["file"])
        have = load(p) if os.path.isfile(p) else {}
        for k, v in want.items():
            if have.get(k) != v: bad.append(f"{spec['file']} says {k} is {have.get(k)!r}, not {v!r}")
        for g in spec.get("generated") or []:
            gp = os.path.join(build_dir, g); txt = open(gp).read() if os.path.isfile(gp) else ""
            for k, v in want.items():
                if f"{json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}" not in txt: bad.append(f"{g} does not carry {k} {v!r} (the generator was not re-run)")
    elif name and name != old and os.path.exists(gen):
        # profiled mold: the name lives in the generated profile, and nowhere in source
        if f'"name": {json.dumps(name, ensure_ascii=False)}' not in open(gen).read(): bad.append(f"the generated deployment profile does not carry the product name {name!r}")
    elif name and name != old:
        for key in rules["product_name_files"]:
            s = open(os.path.join(build_dir, rules["files"][key])).read()
            if old in s: bad.append(f"{rules['files'][key]} still says {old!r}")
            if name not in s: bad.append(f"{rules['files'][key]} does not carry {name!r}")
    if b.get("brand_color"):
        # Compare against the values this brand actually derives, not a re-derived hue string: at zero
        # chroma the hue is dropped, so a hue check would fail on a deliberately greyscale brand.
        css = open(os.path.join(build_dir, rules["files"]["globals"])).read()
        pal = palette(b["brand_color"], b.get("neutral_chroma", 0.006))
        for scheme in ("light", "dark"):
            for tok, val in (b.get("tokens", {}).get(scheme) or {}).items():
                if tok in pal[scheme]: pal[scheme][tok] = val
        only = rules.get("palette_tokens")
        missing = [f"--{t}" for t in ("background", "primary", "ring") if (not only or t in only) and f"--{t}: {pal['light'][t]};" not in css]
        if missing: bad.append("the light palette does not carry " + ", ".join(missing))
        if f"--primary: {pal['dark']['primary']};" not in css: bad.append("the dark palette does not carry --primary")
    bad += check_icons(build_dir, b, rules)
    return bad

def check_icons(build_dir, b, rules):
    """The favicon set: every file there, the right size, under 100 KB, no base64-wrapped raster, and the pages
    pointing at files that exist."""
    fav = favicon_lib()
    kind = fav.read_mark(b.get("icon_svg") or "", *mark_inputs(b))["kind"]
    # a raster logo must ship no icon.svg; whether a vector one does depends on sharp having read it, so either is right
    dirs = rules.get("favicon")
    bad = fav.check_set(build_dir, expect_svg=False if kind == "raster" else None, **({"dirs": dirs} if dirs else {}))
    has_svg = os.path.isfile(os.path.join(build_dir, fav.placed(fav.ICON_SVG, dirs)))
    def text(key):
        p = os.path.join(build_dir, rules["files"].get(key, ""))
        return open(p).read() if key in rules["files"] and os.path.isfile(p) else None
    layout = text("layout")
    if layout is not None and re.search(r'\bicons:\s*\{[^}]*icon\.svg', layout):
        bad.append(f"{rules['files']['layout']} still links every icon to /icon.svg; with that block in place Next ignores favicon.ico's siblings (icon.png, apple-icon.png)")
    man = text("manifest")
    if man is not None:
        for want in ("/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"):
            if want not in man: bad.append(f"{rules['files']['manifest']} does not list {want}")
        if "icon.svg" in man: bad.append(f"{rules['files']['manifest']} still lists /icon.svg, which a home-screen icon cannot be")
        if '"maskable"' not in man: bad.append(f"{rules['files']['manifest']} has no maskable icon")
    gate = text("auth_gate")
    if gate is not None and 'src="/icon.svg"' in gate and not has_svg:
        bad.append(f"{rules['files']['auth_gate']} shows /icon.svg on the sign-in page, but this build has no icon.svg")
    return bad

def check(app_id, app, mold_dir):
    build_dir = os.path.join(ROOT, "build", app_id)
    if not os.path.isdir(build_dir): sys.exit(f"no build copy at build/{app_id}; run prepare first")
    b = resolve(app); rules = load(os.path.join(os.path.dirname(mold_dir), "branding", "rules.json"))
    bad = check_build(build_dir, b, rules)
    for e in bad: print("  " + e)
    print("branding ok" if not bad else f"{len(bad)} problem(s)")
    sys.exit(1 if bad else 0)

def self_test():
    """The favicon set's own checks (lib/favicon.py), then the overlay that writes it, run against a scratch copy of
    the mold's own branded files with the mold's own rules. Nothing here touches build/, state/ or the mold."""
    import tempfile
    fav = favicon_lib(); rc = fav.self_test()
    if rc: return rc
    checks = []
    def ok(c, what):
        checks.append(what)
        if not c: raise AssertionError(what)
    if subprocess.run(["node", "-v"], capture_output=True).returncode:
        print("branding: node is not on this machine; the overlay checks were skipped"); return 0
    v0 = self_test_v0(ok)
    mold = os.path.join(ROOT, "molds", "mold_v1"); code = os.path.join(mold, "codebase")
    if not os.path.isfile(os.path.join(code, "app", "layout.tsx")):
        print(f"branding: {len(checks)} checks passed ({v0} of them: mold_v0's rules); mold_v1 is not on this machine (mold.py fetch mold_v1), so its overlay checks were skipped"); return 0
    rules = load(os.path.join(mold, "branding", "rules.json"))
    logo = fav.png_encode(fav._disc(96, (30, 30, 30), 8))
    def stamp(t, b):
        for rel in set(rules["files"].values()):
            os.makedirs(os.path.dirname(os.path.join(t, rel)), exist_ok=True); shutil.copy(os.path.join(code, rel), os.path.join(t, rel))
        os.makedirs(os.path.join(t, "scripts")); open(os.path.join(t, "scripts", "gen-deployment-profile.mjs"), "w").write("// stand-in: the profile generator is the mold's own business\n")
        applied = apply_overlay(t, b, rules)
        os.makedirs(os.path.join(t, "lib"), exist_ok=True)               # what the real generator writes from profiles/90-brand.json
        prod = load(os.path.join(t, "profiles", "90-brand.json"))["product"]
        open(os.path.join(t, "lib", "deployment-profile.generated.ts"), "w").write(f'export const P = {{ "name": {json.dumps(prod["name"])} }};\n')
        return applied
    before = {rel: open(os.path.join(code, rel), "rb").read() for rel in set(rules["files"].values())}
    with tempfile.TemporaryDirectory() as t:
        with open(os.path.join(t, "logo.png"), "wb") as fh: fh.write(logo)
        b = normalize({}, name="Acme Ops", color="#1F6F5C", logo=os.path.join(t, "logo.png"))
        ok("base64" in b["icon_svg"], "set: a raster logo is still carried inside the app's state (state stays self-contained)")
        build = os.path.join(t, "raster"); os.makedirs(build); applied = stamp(build, b)
        ok("icons:raster" in applied and "layout_icons" in applied and "manifest_icons" in applied, "overlay: the icon set, the layout rule and the manifest rule all applied")
        ok(not os.path.exists(os.path.join(build, "app", "icon.svg")), "raster logo: the mold's app/icon.svg is removed, and no base64 SVG takes its place")
        for rel, size in (("app/icon.png", 32), ("app/apple-icon.png", 180), ("public/icon-192.png", 192), ("public/icon-512.png", 512), ("public/icon-maskable-512.png", 512)):
            ok(fav.png_info(open(os.path.join(build, rel), "rb").read())[:2] == (size, size), f"overlay: {rel} is {size}x{size}")
        ok([e[:2] for e in fav.ico_entries(open(os.path.join(build, "app", "favicon.ico"), "rb").read())] == [(16, 16), (32, 32), (48, 48)], "overlay: app/favicon.ico holds 16, 32 and 48")
        layout = open(os.path.join(build, "app", "layout.tsx")).read(); man = open(os.path.join(build, "app", "manifest.ts")).read(); gate = open(os.path.join(build, "app", "_components", "auth-gate.tsx")).read()
        ok("icon.svg" not in layout.replace(fav.LAYOUT_ICONS_TS, "") and "icons: {" not in layout, "layout: the block linking icon, shortcut and apple-touch to /icon.svg is gone, so Next links the files")
        ok("icon.svg" not in man and man.count("/icon-") == 3 and 'purpose: "maskable"' in man and 'sizes: "192x192"' in man, "manifest: 192, 512 and a maskable 512, no SVG")
        ok(re.search(r'<img src="/icon-192\.png\?v=[0-9a-f]{8}"', gate) and "/icon.svg" not in gate, "sign-in page: a raster logo is shown from the 192 px PNG, not from a missing /icon.svg")
        bad = check_build(build, b, rules)
        ok(bad == [], "check: the freshly branded copy passes" + "".join(" | " + x for x in bad))
        shutil.copy(os.path.join(code, "app", "layout.tsx"), os.path.join(build, "app", "layout.tsx"))
        open(os.path.join(build, "app", "icon.svg"), "w").write(b["icon_svg"]); os.remove(os.path.join(build, "app", "apple-icon.png"))
        bad = check_build(build, b, rules)
        ok(any("apple-icon.png is missing" in x for x in bad) and any("base64" in x for x in bad) and any("still links every icon" in x for x in bad),
           "check: yesterday's build (one base64 SVG, no apple icon, three links to /icon.svg) fails on each count")
        mono = normalize({}, name="Acme Ops", color="#1F6F5C")
        build = os.path.join(t, "mono"); os.makedirs(build); applied = stamp(build, mono)
        svg = open(os.path.join(build, "app", "icon.svg")).read()
        ok("icons:monogram" in applied and "<text" not in svg and "base64" not in svg and len(svg) < 3000 and check_build(build, mono, rules) == [], "monogram: a small font-free icon.svg beside the ICO and PNGs, and check passes")
        ok(fav.png_decode(open(os.path.join(build, "app", "apple-icon.png"), "rb").read()).at(0, 0)[:3] == (0x1F, 0x6F, 0x5C), "monogram: the apple icon is the brand colour to its corners")
        html = fav.preview_html(favicon_set(b, None)[1])
        ok('width="16" height="16"' in html and 'width="180" height="180"' in html, "preview: the tab icon at 16 and 32 px and the apple icon")
    ok(all(open(os.path.join(code, rel), "rb").read() == v for rel, v in before.items()), "the mold's own files are untouched")
    print(f"branding: {len(checks)} checks passed ({v0} of them: mold_v0's rules, mold_v0-024)")
    return 0

def self_test_v0(ok):
    """mold_v0's rules (molds/mold_v0/branding/rules.json) on a scratch copy of its codebase: the brand reaches the profile
    and the modules generated from it, the favicon set lands in the console's web/, the brand colour in its theme's
    brand tokens only, and NOTHING ELSE changes (no source file is rewritten). Then `prepare` and `check` through the
    command line, for a throwaway app under a temp factory root. Nothing under the real build/, state/ or the mold."""
    import tempfile, hashlib
    seen = []
    def ok_(c, what): seen.append(what); ok(c, what)
    mold = os.path.join(ROOT, "molds", "mold_v0"); code = os.path.join(mold, "codebase"); rules = load(os.path.join(mold, "branding", "rules.json"))
    def tree(d):
        out = {}
        for dp, dn, fn in os.walk(d):
            dn[:] = [x for x in dn if x != "node_modules"]
            for f in fn: p = os.path.join(dp, f); out[os.path.relpath(p, d)] = hashlib.sha256(open(p, "rb").read()).hexdigest()
        return out
    before = tree(code)
    with tempfile.TemporaryDirectory() as t:
        b = os.path.join(t, "copy"); subprocess.run(["rsync", "-a", "--exclude", "node_modules", code + "/", b + "/"], check=True)
        brand = normalize({}, name="Acme Ops", color="#1F6F5C", tagline="Tools for small teams.")
        applied = apply_overlay(b, brand, rules)
        ok_(any(x.startswith("profile:") for x in applied) and "manifest_icons" in applied and "manifest_theme_color" in applied and "palette" in applied, f"mold_v0: the profile, the manifest and the palette rules applied: {applied}")
        prof = load(os.path.join(b, "profile.json"))
        ok_(prof["name"] == prof["console_title"] == prof["email_sender_name"] == "Acme Ops" and prof["mcp_server_name"] == "acme-ops"
            and prof["short_description"] == "Tools for small teams." and prof["console_description"].startswith("Acme Ops") and prof.get("email_from_address") == load(os.path.join(code, "profile.json")).get("email_from_address"),
            f"mold_v0: the brand's name and words are in profile.json, every other field kept: {prof}")
        for g in rules["profile"]["generated"]:
            ok_('"name": "Acme Ops"' in open(os.path.join(b, g)).read(), f"mold_v0: {g} is regenerated with the brand")
        changed = {k for k, v in tree(b).items() if before.get(k) != v}
        allowed = {"profile.json", *rules["profile"]["generated"], rules["files"]["manifest"], rules["files"]["globals"]} | {fav for fav in (
            "web/src/app/favicon.ico", "web/src/app/icon.png", "web/src/app/apple-icon.png", "web/src/app/icon.svg",
            "web/public/icon-192.png", "web/public/icon-512.png", "web/public/icon-maskable-512.png")}
        ok_(changed <= allowed and {"profile.json", "web/public/icon-192.png", "web/src/app/favicon.ico", rules["files"]["globals"]} <= changed,
            f"mold_v0: the overlay changes the profile, its generated modules, the manifest, the theme and the icons, and nothing else: {sorted(changed - allowed)}")
        css = open(os.path.join(b, rules["files"]["globals"])).read(); css0 = open(os.path.join(code, rules["files"]["globals"])).read()
        pal = palette(brand["brand_color"], brand["neutral_chroma"])
        ok_(f"--primary: {pal['light']['primary']};" in css and f"--primary: {pal['dark']['primary']};" in css and "--background: oklch(0.9911 0 0);" in css
            and len(css.splitlines()) == len(css0.splitlines()), "mold_v0: the theme takes the brand's primary and ring; its neutrals are the mold's")
        ok_(check_build(b, brand, rules) == [], f"mold_v0: check passes on the branded copy: {check_build(b, brand, rules)}")
        shutil.copy(os.path.join(code, "profile.json"), os.path.join(b, "profile.json"))
        ok_(any("profile.json says name" in x for x in check_build(b, brand, rules)), "mold_v0: check finds a profile without the brand")
        shutil.copy(os.path.join(code, rules["profile"]["generated"][0]), os.path.join(b, rules["profile"]["generated"][0]))
        ok_(any("the generator was not re-run" in x for x in check_build(b, brand, rules)), "mold_v0: check finds a generated profile that was not regenerated")
        nb = normalize({}, name="Plain")
        ok_(profile_values(nb, rules["profile"]) == {"name": "Plain", "console_title": "Plain", "email_sender_name": "Plain", "mcp_server_name": "plain",
                                                      **rules["profile"]["neutral"]},
            "mold_v0: with no tagline of its own the descriptions are the shell's neutral words: never mold_v1's default tagline, never the codebase product's")
        try: profile_values(normalize({}, name='Acme "Ops"'), rules["profile"]); ok_(False, "a name the generator refuses")
        except SystemExit as e: ok_("cannot carry" in str(e) and name_problem('Acme "Ops"', "mold_v0") and not name_problem('Acme "Ops"', "mold_v1"),
                                    "mold_v0: a name its profile cannot carry is refused up front (set, intake); mold_v1 unchanged")
        only_theme = dict(rules, profile=None, palette_blocks=[], replacements=[r for r in rules["replacements"] if r.get("needs") == "brand_color"])
        try: apply_overlay(os.path.join(t, "copy"), dict(brand, brand_color="#1F6F5C', x: 1, y: '"), only_theme); ok_(False, "a bad colour")
        except SystemExit as e: ok_("not a hex colour" in str(e), "mold_v0: a brand colour that is not hex is never written into the manifest's code")
        # the command line, for a throwaway app under a temp factory root (the scripts and the mold linked, read-only)
        f = os.path.join(t, "factory"); os.makedirs(os.path.join(f, ".claude")); os.makedirs(os.path.join(f, "molds")); os.makedirs(os.path.join(f, "state", "application", "zz_brand"))
        os.symlink(os.path.dirname(os.path.abspath(__file__)), os.path.join(f, ".claude", "scripts")); os.symlink(mold, os.path.join(f, "molds", "mold_v0"))
        lim = {"limits": {"runs": {"budget_usd_max": 40, "kind_month_budget_usd": 500}}}     # mold_v0-090: the app's own profile settings
        json.dump({"app_id": "zz_brand", "mold_id": "mold_v0", "status": "planned", "surface": {"branding": brand}, "profile": lim}, open(os.path.join(f, "state", "application", "zz_brand", "application.json"), "w"))
        me = os.path.join(f, ".claude", "scripts", "branding.py")
        r1 = subprocess.run([sys.executable, me, "zz_brand", "prepare"], capture_output=True, text=True)
        r2 = subprocess.run([sys.executable, me, "zz_brand", "check"], capture_output=True, text=True)
        ok_(r1.returncode == 0 and "branded build copy: build/zz_brand" in r1.stdout and r2.returncode == 0 and "branding ok" in r2.stdout,
            f"mold_v0: branding.py <app> prepare, then check, for an app under a temp factory root: {(r1.stdout + r1.stderr)[-300:]} {(r2.stdout + r2.stderr)[-300:]}")
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib")); import app_profile
        zb = os.path.join(f, "build", "zz_brand"); zp = load(os.path.join(zb, "profile.json")) if os.path.isfile(os.path.join(zb, "profile.json")) else {}
        ok_(zp.get("limits") == lim["limits"] and zp.get("name") == "Acme Ops" and app_profile.check(zb, {"mold_id": "mold_v0", "profile": lim}, f) == []
            and "budget_usd_max" not in open(os.path.join(code, "src", "profile.generated.ts")).read(),
            f"mold_v0-090: prepare writes the app's profile settings into the copy's profile.json with the brand, and the generator compiles them (the mold untouched): {zp.get('limits')}")
        ok_(app_profile.check(zb, {"mold_id": "mold_v0"}, f) and app_profile.check(zb, {"mold_id": "mold_v0", "profile": {"limits": {"runs": {"budget_usd_max": 30}}}}, f),
            "mold_v0-090: verify's check finds a copy carrying limits the app does not set, or other values than the app's")
        hb = os.path.join(t, "hostcopy"); os.makedirs(os.path.join(hb, "packs", "hp"))
        json.dump({"host_packs": ["hp"]}, open(os.path.join(hb, "profile.json"), "w")); json.dump({"host": {"profile": {"limits": {"mcp": {"per_key_per_minute": 5}}}}}, open(os.path.join(hb, "packs", "hp", "pack.json"), "w"))
        try: app_profile.write(hb, {"mold_id": "mold_v0", "profile": lim}, f); ok_(False, "a host pack's own limits")
        except ValueError as e: ok_("host pack hp brings its own limits" in str(e) and "limits" not in load(os.path.join(hb, "profile.json")),
                                    "mold_v0-090: an app's limits never silently replace a host pack's own (the shell merges them at the top level): refused")
        for bad, why in (({"host_packs": ["x"]}, "host_packs"), ({"limits": {"runs": {"budget_usd_max": -1}}}, "positive"), ({"name": "Other"}, "the brand writes it"),
                         ({"limits": {"runs": {"budget_usd": 40}}}, "is not a limit"), ({"billing": {"enabled": True}}, "money")):
            json.dump({"app_id": "zz_bad", "mold_id": "mold_v0", "status": "planned", "surface": {"branding": brand}, "profile": bad},
                      open(os.path.join(f, "state", "application", "zz_brand", "application.json"), "w"))
            r3 = subprocess.run([sys.executable, me, "zz_brand", "prepare"], capture_output=True, text=True)
            ok_(r3.returncode != 0 and why in r3.stdout + r3.stderr and "refused" in r3.stdout + r3.stderr, f"mold_v0-090: prepare refuses a profile setting the app may not make ({why}): {(r3.stdout + r3.stderr)[-300:]}")
    ok_(tree(code) == before, "mold_v0: the mold's own files are untouched")
    return len(seen)

def main(a):
    if "--self-test" in a: sys.exit(self_test())
    if len(a) < 2: sys.exit(__doc__)
    if a[0] == "--product":
        if len(a) < 3 or a[2] != "set": sys.exit(__doc__)
        return set_brand(("product", a[1]), a[3:])
    app_id, step = a[0], a[1]
    if step == "set": return set_brand(("app", app_id), a[2:])
    app = load(os.path.join(ST, "application", app_id, "application.json"))
    if step == "preview":
        b = resolve(app)
        if not b: sys.exit("no branding on this app; set one first: branding.py <app_id> set --name …")
        build_dir = os.path.join(ROOT, "build", app_id)       # sharp, for a JPG or SVG logo, comes from either copy's node_modules
        return preview(app_id, b, build_dir if os.path.isdir(os.path.join(build_dir, "node_modules", "sharp")) else os.path.join(ROOT, "molds", app["mold_id"], "codebase"))
    mold_dir = os.path.join(ROOT, "molds", app["mold_id"], "codebase")
    if step == "show":
        b = resolve(app)
        if not b: return print("no branding on this app")
        print(json.dumps({k: (v[:60] + "…" if k == "icon_svg" and len(v) > 60 else v) for k, v in b.items()}, indent=2))
        if b.get("brand_color"):
            pal = palette(b["brand_color"], b.get("neutral_chroma", 0.006))
            for scheme in ("light", "dark"):
                print(f"  {scheme}: " + " ".join(f"{k}={v}" for k, v in list(pal[scheme].items())[:4]))
    elif step == "prepare": prepare(app_id, app, mold_dir, force="--force" in a)
    elif step == "check": check(app_id, app, mold_dir)
    else: sys.exit(__doc__)

if __name__ == "__main__": main(sys.argv[1:])
