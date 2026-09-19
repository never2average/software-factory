#!/usr/bin/env python3
"""Branding: apply an application's own theme and logo to a per-app copy of the mold.

  branding.py <app_id> set --name "Acme Ops" [--color #1F6F5C] [--logo path.png|.svg] [--tagline "..."]
                                            the whole brand from three inputs; everything else is derived
  branding.py --product <product_id> set …  the same, onto a product in state/products.json (future stamps)
  branding.py <app_id> show                 this app's brand and the palette it derives
  branding.py <app_id> preview              build/<app_id>/brand-preview.html: sign-in tile and palette, light and dark
  branding.py <app_id> prepare [--force]    build/<app_id>/ = mold copy + brand overlay; prints the path
  branding.py <app_id> check                verify a prepared copy carries the brand and no stale name

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

def read_mark(b):
    """The brand's square mark as (full svg, inner elements). Falls back to a monogram."""
    svg = (b.get("icon_svg") or "").strip()
    if svg:
        if not re.search(r'viewBox="0 0 32 32"', svg):
            sys.exit('branding.icon_svg must use viewBox="0 0 32 32" so it fits every mark slot')
        inner = re.sub(r"^<svg[^>]*>|</svg>\s*$", "", svg, flags=re.S).strip()
        return svg, inner
    initials = "".join(w[0] for w in re.findall(r"[A-Za-z]+", b.get("product_name", "App"))[:2]).upper() or "A"
    bg = b.get("icon_bg") or (b["brand_color"] if str(b.get("brand_color", "")).startswith("#") else "#0A0A0A")
    fg = b.get("icon_fg") or legible_on(bg)
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

def preview(app_id, b):
    """One HTML file showing what the brand does to the sign-in tile and the palette, light and dark."""
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
<p style="font-size:12px;opacity:.7;margin-top:16px">Derived from colour {b.get("brand_color","(mold greyscale)")}, mark from {"logo file " + b["logo"] if b.get("logo") else "a monogram"}. Change with: branding.py {app_id} set --name … --color … --logo …</p>'''
    out = os.path.join(ROOT, "build", app_id, "brand-preview.html"); os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "w").write(html); print(f"preview written: {os.path.relpath(out, ROOT)}"); return out

def auth_mark_jsx(inner):
    """The brand mark as JSX for the sign-in tile.

    The tile already paints a foreground-coloured square, so the mark's own background rect is
    dropped and its strokes and fills are re-pointed at the background colour. SVG attributes are
    hyphenated; JSX wants them camel-cased."""
    if is_logo_mark(inner):
        svg = f'<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">{inner}</svg>'
        uri = "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()
        return f'<img src="{uri}" alt="" className="size-8 rounded-md" aria-hidden />'
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

    svg, inner = read_mark(b)
    open(f("icon"), "w").write(svg + "\n"); applied.append("icon")

    # A mold with a deployment profile (scripts/gen-deployment-profile.mjs) takes its NAME, tagline and description
    # from profiles/*.json, not from literals in source: the brand is written as profiles/90-brand.json (after any
    # pack's profile, so the application's own brand wins) and the generator is re-run. The rules marked
    # "via_profile" and the product-name file list are then skipped — those literals no longer exist upstream
    # (fde-agent #15). The icon, the sign-in mark and the palette are still source rewrites.
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

    subs = {"description_literal": esc(b.get("description") or f"{name} — {b.get('tagline', '')}".strip(" —")),
            "tagline": jsx_text(b.get("tagline", "")), "auth_mark_jsx": auth_mark_jsx(inner)}
    for r in rules["replacements"]:
        if profiled and r.get("via_profile"): continue
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
            for tok, val in pal[blk["scheme"]].items():
                # count the substitution, not the text change: a token whose brand value equals the
                # mold's (destructive red) is still correctly set.
                seg, n = re.subn(rf"(--{re.escape(tok)}:\s*)[^;]+;", lambda m: m.group(1) + val + ";", seg, count=1)
                if n != 1 and f"--{tok}:" in seg: sys.exit(f"could not set --{tok} in {blk['id']}")
            if b.get("radius"): seg = re.sub(r"(--radius:\s*)[^;]+;", lambda m: m.group(1) + b["radius"] + ";", seg, count=1)
            s = s[:i] + seg + s[end:]
        open(p, "w").write(s); applied.append("palette")
    return applied

def build_copy(app_id, mold_dir, force=False):
    """build/<app_id>/: the per-application copy of the mold that brand and packs are applied to. The mold itself
    is never edited; this is the only place an application's own code exists."""
    build_dir = os.path.join(ROOT, "build", app_id)
    if os.path.exists(build_dir) and not force: shutil.rmtree(build_dir)
    os.makedirs(build_dir, exist_ok=True)
    # Source tree only. node_modules is hard-linked (never written, so the mold cannot be touched)
    # and the build artefact directories stay per-app.
    subprocess.run(["rsync", "-a", "--delete", "--exclude", "node_modules", "--exclude", ".next",
                    "--exclude", ".vercel", "--exclude", ".eve", "--exclude", ".env.local",
                    mold_dir + "/", build_dir + "/"], check=True)
    nm = os.path.join(build_dir, "node_modules")
    if not os.path.exists(nm):
        subprocess.run(["cp", "-al", os.path.join(mold_dir, "node_modules"), nm], check=True)
    return build_dir

def prepare(app_id, app, mold_dir, force=False):
    b = resolve(app)
    if not b:
        print("no branding on this app; building from the mold as-is"); return mold_dir
    build_dir = build_copy(app_id, mold_dir, force)
    rules = load(os.path.join(os.path.dirname(mold_dir), "branding", "rules.json"))
    applied = apply_overlay(build_dir, b, rules)
    print(f"branded build copy: {os.path.relpath(build_dir, ROOT)}  ({b['product_name']}, {len(applied)} rule(s))")
    return build_dir

def check(app_id, app, mold_dir):
    build_dir = os.path.join(ROOT, "build", app_id)
    if not os.path.isdir(build_dir): sys.exit(f"no build copy at build/{app_id}; run prepare first")
    b = resolve(app); rules = load(os.path.join(os.path.dirname(mold_dir), "branding", "rules.json"))
    name = b.get("product_name"); old = rules["product_name_default"]; bad = []
    gen = os.path.join(build_dir, "lib", "deployment-profile.generated.ts")
    if name and name != old and os.path.exists(gen):
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
        missing = [f"--{t}" for t in ("background", "primary", "ring") if f"--{t}: {pal['light'][t]};" not in css]
        if missing: bad.append("the light palette does not carry " + ", ".join(missing))
        if f"--primary: {pal['dark']['primary']};" not in css: bad.append("the dark palette does not carry --primary")
    for e in bad: print("  " + e)
    print("branding ok" if not bad else f"{len(bad)} problem(s)")
    sys.exit(1 if bad else 0)

def main(a):
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
        return preview(app_id, b)
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
