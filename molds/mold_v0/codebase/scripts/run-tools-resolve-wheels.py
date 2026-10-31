# Resolve a hash-locked requirements file (uv pip compile --generate-hashes) to one wheel per package per arch for
# CPython 3.12 on glibc Linux, from PyPI's JSON API; every chosen file's sha256 must be one of the lock's hashes.
import json, re, sys, urllib.request
lock, out = sys.argv[1], sys.argv[2]
text = open(lock).read().replace("\\\n", " ")
reqs = []
for line in text.splitlines():
    line = line.split("#", 1)[0].strip()
    if not line or line.startswith("-"): continue
    m = re.match(r"([A-Za-z0-9_.-]+)==([^ ;]+)\s*(?:;\s*([^-]+?))?\s*((?:--hash=sha256:[0-9a-f]{64}\s*)+)$", line)
    if not m: sys.exit(f"unparsed: {line[:120]}")
    name, ver, marker, hashes = m.groups()
    reqs.append((name, ver, (marker or "").strip(), set(re.findall(r"[0-9a-f]{64}", hashes))))
def marker_ok(marker):
    if not marker: return True
    env = {"python_full_version": "3.12.15", "python_version": "3.12", "sys_platform": "linux", "platform_python_implementation": "CPython", "implementation_name": "cpython"}
    expr = marker
    for k, v in env.items(): expr = expr.replace(k, repr(v))
    expr = re.sub(r"'([0-9.]+)'\s*(<|>=|<=|>|==)\s*'([0-9.]+)'", lambda m: str(eval(f"{tuple(map(int,m.group(1).split('.')))}{m.group(2)}{tuple(map(int,m.group(3).split('.')))}")), expr)
    return eval(expr)
ARCH = {"x64": "x86_64", "arm64": "aarch64"}
def score(fn, arch):
    if not fn.endswith(".whl"): return None
    tags = fn[:-4].split("-")[-3:]
    py, abi, plat = tags
    pys, abis, plats = py.split("."), abi.split("."), plat.split(".")
    if plat == "any" and abi == "none" and any(p in ("py3", "py2.py3") or p.startswith("py3") for p in pys): return 1
    okplat = any(re.match(rf"(manylinux_2_(\d+)|manylinux2014|manylinux1|manylinux2010)_{ARCH[arch]}$", p) and (not p.startswith("manylinux_2_") or int(p.split("_")[2]) <= 28) for p in plats)
    if not okplat: return None
    if "cp312" in pys and "cp312" in abis: return 3
    if "abi3" in abis and any(re.match(r"cp3(\d+)$", p) and int(p[3:]) <= 12 for p in pys): return 2
    return None
res = {"x64": [], "arm64": []}
for name, ver, marker, hashes in reqs:
    if not marker_ok(marker): continue
    j = json.load(urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{ver}/json"))
    for arch in res:
        best = None
        for f in j["urls"]:
            s = score(f["filename"], arch)
            if s is None: continue
            if best is None or s > best[0]: best = (s, f)
        if not best: sys.exit(f"no wheel for {name}=={ver} on {arch}")
        f = best[1]
        if f["digests"]["sha256"] not in hashes: sys.exit(f"{f['filename']}: sha256 not in the lock")
        res[arch].append({"url": f["url"], "sha256": f["digests"]["sha256"], "bytes": f["size"]})
json.dump(res, open(out, "w"), indent=1)
print({a: (len(v), sum(x["bytes"] for x in v)) for a, v in res.items()})
