#!/usr/bin/env python3
"""Branding: apply an application's own theme and logo to a per-app copy of the mold.

  branding.py <app_id> show                 this app's brand and the palette it derives
  branding.py <app_id> prepare [--force]    build/<app_id>/ = mold copy + brand overlay; prints the path
  branding.py <app_id> check                verify a prepared copy carries the brand and no stale name

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
        "muted": n(0.94), "muted-foreground": n(0.6),
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
    return {"light": light, "dark": dark}

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
    bg, fg = b.get("icon_bg", "#0A0A0A"), b.get("icon_fg", "#FAFAFA")
    inner = (f'<rect width="32" height="32" rx="8" fill="{bg}"/>'
             f'<text x="16" y="21" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" '
             f'font-size="14" font-weight="600" fill="{fg}" text-anchor="middle">{initials}</text>')
    return (f'<svg width="32" height="32" viewBox="0 0 32 32" fill="none" '
            f'xmlns="http://www.w3.org/2000/svg">{inner}</svg>'), inner

def auth_mark_jsx(inner):
    """The brand mark as JSX for the sign-in tile.

    The tile already paints a foreground-coloured square, so the mark's own background rect is
    dropped and its strokes and fills are re-pointed at the background colour. SVG attributes are
    hyphenated; JSX wants them camel-cased."""
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

    subs = {"description_literal": esc(b.get("description") or f"{name} — {b.get('tagline', '')}".strip(" —")),
            "tagline": jsx_text(b.get("tagline", "")), "auth_mark_jsx": auth_mark_jsx(inner)}
    for r in rules["replacements"]:
        p = f(r["file"]); s = open(p).read()
        if r["find"] not in s:
            sys.exit(f"branding rule {r['id']} no longer matches {rules['files'][r['file']]}; the mold moved. "
                     f"Update molds/{b.get('_mold','mold_v1')}/branding/rules.json before deploying.")
        s = s.replace(r["find"], r["replace"].format(**subs))
        open(p, "w").write(s); applied.append(r["id"])

    if name != old:
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

def prepare(app_id, app, mold_dir, force=False):
    build_dir = os.path.join(ROOT, "build", app_id)
    b = resolve(app)
    if not b:
        print("no branding on this app; building from the mold as-is"); return mold_dir
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
    rules = load(os.path.join(os.path.dirname(mold_dir), "branding", "rules.json"))
    applied = apply_overlay(build_dir, b, rules)
    print(f"branded build copy: {os.path.relpath(build_dir, ROOT)}  ({b['product_name']}, {len(applied)} rule(s))")
    return build_dir

def check(app_id, app, mold_dir):
    build_dir = os.path.join(ROOT, "build", app_id)
    if not os.path.isdir(build_dir): sys.exit(f"no build copy at build/{app_id}; run prepare first")
    b = resolve(app); rules = load(os.path.join(os.path.dirname(mold_dir), "branding", "rules.json"))
    name = b.get("product_name"); old = rules["product_name_default"]; bad = []
    if name and name != old:
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
    app_id, step = a[0], a[1]
    app = load(os.path.join(ST, "application", app_id, "application.json"))
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
