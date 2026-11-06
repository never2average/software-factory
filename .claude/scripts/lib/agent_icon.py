#!/usr/bin/env python3
"""agent_icon.py: the workspace agent's own icon in an app's brand (mold_v0-252), in standard-library Python.

  agent_icon.py --self-test       the offline checks (no network, no build/, no state/)

branding.py calls `entry` from `set` (--agent-icon <file>, --agent-icon-name <name>, --agent-icon-dark <file>) and
`write` / `problems` from `prepare` and `check`.

WHAT AN APP MAY BRING, and what is kept in its brand (state/application/<app>/application.json surface.branding
`agent_icon`, complete, so the app is readable on its own and the file need not stay on this machine):
  a name      one icon of the console's own icon set (Tabler's outline icons, the set every console icon comes from;
              5000-odd names, read from the mold's installed @tabler/icons): an SVG drawn in currentColor.
  an SVG      sanitised (an allowlist of drawing elements and attributes: no script, no event handler, no
              foreignObject, no style sheet, no link or reference to anything outside the file, no DOCTYPE or entity),
              then, when it is drawn in one colour (or none), that colour becomes currentColor: it follows the theme's
              text colour in light and dark. An SVG of several colours keeps them.
  a picture   a PNG, JPG or WebP: trimmed of its transparent margin and FITTED (never stretched) inside 64 x 64 px,
              three times the 20 px the console draws it at, then kept as a PNG. Never wrapped in an SVG as base64
              (branding.py's favicon rule): `prepare` writes it as a .png file of its own.
Each at most 256 KB as given. A dark variant (--agent-icon-dark) is the same kinds; without one the light icon serves
both themes (an icon in currentColor needs none).

WHAT `prepare` WRITES into the build copy (the mold's branding/rules.json `agent_icon`):
  web/public/agent-icon/light.svg|png and dark.svg|png  the icon for each theme (dark = light when none of its own)
  profile.json `agent_icon`  {"light": "/agent-icon/light.svg?v=<hash>", "dark": "...", "mask": true|false}: the
             console draws a currentColor icon as a mask filled with the text colour (mask: true), any other as an
             image. The mold's generator (scripts/gen-packs.mjs) checks it and the files, and writes it into the
             console's profile module only (never the API's), so an app without one builds exactly what it built before.
"""
import base64, hashlib, json, os, re, sys, xml.etree.ElementTree as ET

MAX_INPUT_BYTES = 256 * 1024
MAX_SVG_BYTES = 64 * 1024
RASTER_PX = 64
NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"

# The allowlist (the server's src/agent-icon.ts keeps the same one for a workspace's own upload).
ELEMENTS = {"svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "defs", "lineargradient",
            "radialgradient", "stop", "clippath", "mask", "use", "symbol"}
CASE = {"lineargradient": "linearGradient", "radialgradient": "radialGradient", "clippath": "clipPath"}
ATTRS = {"viewbox", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "fr", "d", "points", "width",
         "height", "transform", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap",
         "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "opacity",
         "clip-rule", "clip-path", "mask", "id", "offset", "stop-color", "stop-opacity", "gradientunits",
         "gradienttransform", "spreadmethod", "maskunits", "maskcontentunits", "clippathunits", "preserveaspectratio",
         "vector-effect", "color", "display", "href"}
ATTR_CASE = {"viewbox": "viewBox", "gradientunits": "gradientUnits", "gradienttransform": "gradientTransform",
             "spreadmethod": "spreadMethod", "maskunits": "maskUnits", "maskcontentunits": "maskContentUnits",
             "clippathunits": "clipPathUnits", "preserveaspectratio": "preserveAspectRatio"}
STYLE_PROPS = {"fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
               "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "opacity", "clip-rule",
               "stop-color", "stop-opacity", "color", "display", "vector-effect"}
PAINT = ("fill", "stroke", "stop-color", "color")
BAD_VALUE = re.compile(r"javascript:|vbscript:|data:|expression\s*\(|@import|[<>\\`]", re.I)
URL_REF = re.compile(r"^url\(\s*#[A-Za-z][\w.-]{0,63}\s*\)$")
NAMED = {"black": "#000000", "white": "#ffffff"}

def _local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""

def _norm_colour(v):
    v = v.strip().lower()
    if re.fullmatch(r"#[0-9a-f]{3}", v): v = "#" + "".join(c * 2 for c in v[1:])
    return NAMED.get(v, v)

def _clean_value(name, v):
    """The attribute's value when it is safe, else None."""
    v = v.strip()
    if not v or len(v) > 20000 or BAD_VALUE.search(v): return None
    if name == "href": return v if re.fullmatch(r"#[A-Za-z][\w.-]{0,63}", v) else None
    if "url(" in v.lower(): return v if URL_REF.match(v) else None
    if name == "id": return v if re.fullmatch(r"[A-Za-z][\w.-]{0,63}", v) else None
    return v

def sanitise_svg(raw):
    """SVG bytes -> (clean SVG text, follows currentColor). Raises ValueError with a plain sentence when it cannot be an icon."""
    if len(raw) > MAX_INPUT_BYTES: raise ValueError(f"the SVG is {len(raw) // 1024} KB; an icon is at most {MAX_INPUT_BYTES // 1024} KB")
    try: text = raw.decode("utf-8")
    except UnicodeDecodeError: raise ValueError("the SVG is not UTF-8 text")
    if re.search(r"<!DOCTYPE|<!ENTITY", text, re.I): raise ValueError("an SVG with a DOCTYPE or entities is refused (they can reach outside the file)")
    try: root = ET.fromstring(text)
    except ET.ParseError as e: raise ValueError(f"the SVG does not read as XML ({e})")
    if _local(root.tag) != "svg": raise ValueError("the file's root element is not <svg>")
    colours, gradients, fills = set(), [False], [False]

    def attrs_of(el, is_root):
        out = {}
        style = el.attrib.get("style") or ""
        for decl in style.split(";"):
            if ":" not in decl: continue
            k, v = decl.split(":", 1); k = k.strip().lower()
            if k in STYLE_PROPS:
                cv = _clean_value(k, v)
                if cv is not None: out[k] = cv
        for k, v in el.attrib.items():
            ns_uri = k[1:].split("}", 1)[0] if k.startswith("{") else ""
            name = _local(k).lower()
            if ns_uri and ns_uri != XLINK_NS: continue
            if ns_uri == XLINK_NS and name != "href": continue
            if name not in ATTRS or name.startswith("on"): continue
            if is_root and name in ("width", "height"): continue
            cv = _clean_value(name, v)
            if cv is not None: out[name] = cv
        if "fill" in out: fills[0] = True
        for p in PAINT:
            if p in out:
                c = _norm_colour(out[p])
                if c not in ("none", "transparent", "currentcolor", "inherit") and not c.startswith("url("): colours.add(c)
        return out

    def walk(el, is_root=False):
        name = _local(el.tag).lower()
        if name not in ELEMENTS: return None
        if name in ("lineargradient", "radialgradient"): gradients[0] = True
        a = attrs_of(el, is_root)
        kids = [k for k in (walk(c) for c in el) if k is not None]
        return (CASE.get(name, name), a, kids)

    tree = walk(root, True)
    vb = tree[1].get("viewbox")
    if not vb:
        w, h = root.attrib.get("width", ""), root.attrib.get("height", "")
        if re.fullmatch(r"[\d.]+(px)?", w) and re.fullmatch(r"[\d.]+(px)?", h): vb = f"0 0 {w.rstrip('px')} {h.rstrip('px')}"
    nums = re.findall(r"-?[\d.]+", vb or "")
    if len(nums) != 4 or float(nums[2]) <= 0 or float(nums[3]) <= 0: raise ValueError("the SVG has no viewBox (or width and height) to size it by")
    tree[1]["viewbox"] = " ".join(nums)
    follows = not gradients[0] and len(colours) <= 1
    if follows:
        def recolour(node):
            tag, a, kids = node
            for p in PAINT:
                if p in a and _norm_colour(a[p]) in colours: a[p] = "currentColor"
            for k in kids: recolour(k)
        recolour(tree)
        if not colours and not fills[0]: tree[1]["fill"] = "currentColor"
    if not any(True for _ in _drawn(tree)): raise ValueError("nothing is left to draw once the SVG is cleaned")
    esc = lambda s: s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")
    def emit(node, root_=False):
        tag, a, kids = node
        parts = [f' xmlns="{SVG_NS}"'] if root_ else []
        if root_:
            w, h = (float(x) for x in tree[1]["viewbox"].split()[2:])
            parts.append(f' width="{w:g}" height="{h:g}"')
        parts += [f' {ATTR_CASE.get(k, k)}="{esc(v)}"' for k, v in a.items()]
        inner = "".join(emit(k) for k in kids)
        return f"<{tag}{''.join(parts)}>{inner}</{tag}>" if inner else f"<{tag}{''.join(parts)}/>"
    out = emit(tree, True)
    if len(out.encode()) > MAX_SVG_BYTES: raise ValueError(f"the SVG is still {len(out.encode()) // 1024} KB once cleaned; an icon is at most {MAX_SVG_BYTES // 1024} KB")
    return out, follows

def _drawn(node):
    tag, _a, kids = node
    if tag in ("path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "use"): yield tag
    for k in kids: yield from _drawn(k)

# ------------------------------------------------------------------------------------------- the icon set ----
def set_dirs(mold_codebase):
    return [os.path.join(mold_codebase, d, "node_modules", "@tabler", "icons") for d in ("web", ".")]

def from_set(name, mold_codebase):
    """One icon of the console's icon set (Tabler's outline icons, from the mold's installed @tabler/icons) -> SVG text."""
    if not NAME_RE.match(name or "") or len(name) > 60: raise ValueError(f"{name!r} is not an icon name (lower-case words joined by -, like robot or message-chatbot)")
    for d in set_dirs(mold_codebase):
        p = os.path.join(d, "icons", "outline", name + ".svg")
        if os.path.isfile(p): return open(p, "rb").read()
        nodes = os.path.join(d, "tabler-nodes-outline.json")
        if os.path.isfile(nodes):
            n = json.load(open(nodes)).get(name)
            if n is None: break
            body = "".join(f"<{t} " + " ".join(f'{k}="{v}"' for k, v in a.items() if k != "key") + "/>" for t, a in n)
            return (f'<svg xmlns="{SVG_NS}" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
                    f'stroke-linecap="round" stroke-linejoin="round">{body}</svg>').encode()
    if not any(os.path.isdir(d) for d in set_dirs(mold_codebase)):
        raise ValueError("the icon set (@tabler/icons) is not installed in the mold's codebase: run `npm ci` in its web/, or give a file with --agent-icon")
    raise ValueError(f"the icon set has no icon named {name!r}; see https://tabler.io/icons for the names")

# ------------------------------------------------------------------------------------------- pictures ----
def _favicon():
    lib = os.path.dirname(os.path.abspath(__file__))
    if lib not in sys.path: sys.path.insert(0, lib)
    import favicon
    return favicon

def raster_png(raw, ext, node_cwd):
    """A PNG, JPG or WebP -> (PNG bytes fitted inside RASTER_PX, width, height). A PNG is decoded here; a JPG or WebP by sharp."""
    fav = _favicon()
    if ext == ".png":
        try: img = fav.png_decode(raw)
        except Exception as e: raise ValueError(f"the PNG could not be read ({e})")
    else:
        png, why = fav.sharp_png(raw, ext, node_cwd)
        if not png: raise ValueError(f"the {ext[1:].upper()} could not be turned into pixels: {why}")
        img = fav.png_decode(png)
    img = fav.trim(img)
    k = min(1.0, RASTER_PX / max(img.w, img.h))
    img = fav.resize(img, max(1, round(img.w * k)), max(1, round(img.h * k)))
    return fav.png_encode(img, cap=MAX_SVG_BYTES), img.w, img.h

def entry_from_file(path, node_cwd):
    """A file -> what the brand keeps for one theme: {"type": "svg", "svg", "follows_color"} or {"type": "png", "png", "width", "height"}."""
    if not os.path.isfile(path) or os.path.islink(path): raise ValueError(f"agent icon not found (or a link): {path}")
    raw = open(path, "rb").read()
    if len(raw) > MAX_INPUT_BYTES: raise ValueError(f"the agent icon is {len(raw) // 1024} KB; keep it under {MAX_INPUT_BYTES // 1024} KB")
    ext = os.path.splitext(path)[1].lower()
    if ext == ".jpeg": ext = ".jpg"
    if ext == ".svg":
        svg, follows = sanitise_svg(raw)
        return {"type": "svg", "svg": svg, "follows_color": follows}
    if ext in (".png", ".jpg", ".webp"):
        png, w, h = raster_png(raw, ext, node_cwd)
        return {"type": "png", "png": base64.b64encode(png).decode(), "width": w, "height": h}
    raise ValueError(f"the agent icon must be .svg, .png, .jpg or .webp, not {ext or 'a file with no extension'}")

def entry_from_name(name, mold_codebase):
    svg, follows = sanitise_svg(from_set(name, mold_codebase))
    return {"type": "svg", "svg": svg, "follows_color": follows}

def problem(block):
    """A sentence when a brand's agent_icon block is not one this module wrote, else ''."""
    if not isinstance(block, dict) or not isinstance(block.get("source"), str): return "branding.agent_icon must be set with branding.py <app_id> set --agent-icon <file> or --agent-icon-name <name>"
    for theme in ("light", "dark"):
        e = block.get(theme)
        if e is None and theme == "dark": continue
        if not isinstance(e, dict): return f"branding.agent_icon.{theme} is missing"
        if e.get("type") == "svg":
            try: again, _f = sanitise_svg(str(e.get("svg", "")).encode())
            except ValueError as x: return f"branding.agent_icon.{theme}: {x}"
            if again != e.get("svg"): return f"branding.agent_icon.{theme} is not a cleaned SVG: set it again with branding.py"
        elif e.get("type") == "png":
            try: data = base64.b64decode(str(e.get("png", "")), validate=True)
            except ValueError: return f"branding.agent_icon.{theme}.png is not base64"
            if data[:8] != b"\x89PNG\r\n\x1a\n" or len(data) > MAX_SVG_BYTES: return f"branding.agent_icon.{theme} is not a small PNG"
            w, h = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
            if max(w, h) > RASTER_PX: return f"branding.agent_icon.{theme} is {w}x{h}; it is kept at most {RASTER_PX} px"
        else: return f"branding.agent_icon.{theme}: an svg or a png"
    return ""

def files_of(block):
    """{"light": (file name, bytes), "dark": (...)} and whether the console draws it as a mask (both themes currentColor)."""
    out = {}
    for theme in ("light", "dark"):
        e = block.get(theme) or block["light"]
        if e["type"] == "svg": out[theme] = (f"{theme}.svg", e["svg"].encode())
        else: out[theme] = (f"{theme}.png", base64.b64decode(e["png"]))
    mask = all((block.get(t) or block["light"]).get("type") == "svg" and (block.get(t) or block["light"]).get("follows_color") for t in ("light", "dark"))
    return out, mask

def profile_value(block, url_dir):
    files, mask = files_of(block)
    v = lambda data: hashlib.sha256(data).hexdigest()[:12]
    return {"light": f"{url_dir}/{files['light'][0]}?v={v(files['light'][1])}", "dark": f"{url_dir}/{files['dark'][0]}?v={v(files['dark'][1])}", "mask": mask}

def write(build_dir, block, spec):
    """Write the icon's files into the build copy (spec: rules.json agent_icon {dir, url}) -> the profile value."""
    why = problem(block)
    if why: raise ValueError(why)
    d = os.path.join(build_dir, spec["dir"])
    if os.path.isdir(d):
        for f in os.listdir(d): os.remove(os.path.join(d, f))
    os.makedirs(d, exist_ok=True)
    files, _mask = files_of(block)
    for name, data in files.values():
        p = os.path.join(d, name)
        if os.path.lexists(p): os.remove(p)
        open(p, "wb").write(data)
    return profile_value(block, spec["url"])

def problems(build_dir, block, spec):
    """What is wrong with a prepared copy's agent icon ([] when the brand has none, or the copy carries it)."""
    if not block: return []
    why = problem(block)
    if why: return [why]
    want = profile_value(block, spec["url"]); bad = []
    files, _m = files_of(block)
    for name, data in files.values():
        p = os.path.join(build_dir, spec["dir"], name)
        if not os.path.isfile(p) or open(p, "rb").read() != data: bad.append(f"{spec['dir']}/{name} is not the brand's agent icon (run prepare)")
    prof = os.path.join(build_dir, "profile.json")
    have = json.load(open(prof)).get("agent_icon") if os.path.isfile(prof) else None
    if have != want: bad.append(f"profile.json agent_icon is {have!r}, not the brand's {want!r}")
    gen = os.path.join(build_dir, "web", "src", "config", "profile.generated.ts")
    if os.path.isfile(gen) and want["light"] not in open(gen).read(): bad.append("web/src/config/profile.generated.ts does not carry the agent icon (the generator was not re-run)")
    return bad

# ------------------------------------------------------------------------------------------- self-test ----
EVIL = b'''<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="32" height="32" onload="alert(1)">
  <script>alert(2)</script>
  <style>path{fill:url(https://evil.example/x)}</style>
  <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>
  <a xlink:href="javascript:alert(3)"><path d="M0 0h4v4z"/></a>
  <image href="https://evil.example/p.png" width="4" height="4"/>
  <use xlink:href="https://evil.example/s.svg#x"/>
  <path d="M2 2h28v28H2z" fill="#112233" onclick="alert(4)" style="stroke:#112233;fill:url(https://evil.example/y)"/>
  <circle cx="16" cy="16" r="6" fill="#123"/>
</svg>'''

def self_test():
    import tempfile
    n = [0]
    def ok(c, what):
        if not c: raise AssertionError(what)
        n[0] += 1
    svg, follows = sanitise_svg(EVIL)
    low = svg.lower()
    ok(all(x not in low for x in ("script", "onload", "onclick", "foreignobject", "javascript", "evil.example", "<image", "<a ", "<style", "alert")),
       f"a malicious SVG loses its script, handlers, foreignObject, style sheet, outside links and pictures: {svg}")
    ok("<path" in svg and "<circle" in svg and 'viewBox="0 0 32 32"' in svg and 'width="32"' in svg, f"its drawing stays, sized by its viewBox: {svg}")
    ok(follows and svg.count("currentColor") >= 2 and "#112233" not in svg, f"one colour becomes currentColor: {svg}")
    two, f2 = sanitise_svg(b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="4" height="4" fill="#f00"/><rect x="4" width="4" height="4" fill="#00f"/></svg>')
    ok(not f2 and "#f00" in two and "currentColor" not in two, "an SVG of two colours keeps them and is drawn as a picture")
    plain, f3 = sanitise_svg(b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="4" height="4"/></svg>')
    ok(f3 and 'fill="currentColor"' in plain, "an SVG with no colour (black by default) is drawn in currentColor")
    for bad, why in ((b'<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="4" height="4"/></svg>', "DOCTYPE"),
                     (b'<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>', "viewBox"),
                     (b'<html><body/></html>', "not <svg>"), (b'<svg', "XML"), (b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><script>x()</script></svg>', "nothing is left"),
                     (b" " * (MAX_INPUT_BYTES + 1), "at most 256 KB")):
        try: sanitise_svg(bad); ok(False, f"refused: {why}")
        except ValueError as e: ok(why in str(e), f"refused ({why}): {e}")
    ok(sanitise_svg(svg.encode())[0] == svg, "cleaning is stable: a cleaned SVG cleans to itself")
    fav = _favicon()
    with tempfile.TemporaryDirectory() as t:
        big = fav.png_encode(fav.fit(fav._disc(300, (200, 30, 30), 40), 400), cap=0)
        open(os.path.join(t, "a.png"), "wb").write(big)
        e = entry_from_file(os.path.join(t, "a.png"), None)
        data = base64.b64decode(e["png"])
        ok(e["type"] == "png" and data[:8] == b"\x89PNG\r\n\x1a\n" and max(e["width"], e["height"]) == RASTER_PX and "svg" not in e,
           f"a picture is fitted inside {RASTER_PX} px and kept as a PNG, never an SVG around base64: {e['width']}x{e['height']}")
        open(os.path.join(t, "huge.png"), "wb").write(b"\x89PNG\r\n\x1a\n" + b"\0" * MAX_INPUT_BYTES)
        try: entry_from_file(os.path.join(t, "huge.png"), None); ok(False, "an oversized picture")
        except ValueError as x: ok("keep it under 256 KB" in str(x), "a picture over 256 KB is refused")
        open(os.path.join(t, "a.gif"), "wb").write(b"GIF89a")
        try: entry_from_file(os.path.join(t, "a.gif"), None); ok(False, "a GIF")
        except ValueError as x: ok(".svg, .png, .jpg or .webp" in str(x), "another format is refused")
        block = {"source": "file:a.png", "light": e}
        spec = {"dir": "web/public/agent-icon", "url": "/agent-icon"}
        pv = write(t, block, spec)
        ok(open(os.path.join(t, spec["dir"], "light.png"), "rb").read() == data and open(os.path.join(t, spec["dir"], "dark.png"), "rb").read() == data
           and not pv["mask"] and pv["light"].startswith("/agent-icon/light.png?v="), f"both themes written, the dark one the light one's: {pv}")
        json.dump({"agent_icon": pv}, open(os.path.join(t, "profile.json"), "w"))
        ok(problems(t, block, spec) == [], f"check passes on the written copy: {problems(t, block, spec)}")
        vec = {"source": "name:robot", "light": {"type": "svg", "svg": plain, "follows_color": True}}
        ok(any("not the brand's agent icon" in x for x in problems(t, vec, spec)), "check finds a copy with another icon")
        pv2 = write(t, vec, spec)
        ok(pv2["mask"] and sorted(os.listdir(os.path.join(t, spec["dir"]))) == ["dark.svg", "light.svg"], f"a currentColor SVG is a mask; a stale picture is removed: {pv2}")
        ok(problem({"source": "x", "light": {"type": "svg", "svg": EVIL.decode()}}) != "", "a brand block holding an uncleaned SVG is refused")
    print(f"agent_icon: {n[0]} checks passed")
    return 0

if __name__ == "__main__":
    if "--self-test" in sys.argv: sys.exit(self_test())
    sys.exit(__doc__)
