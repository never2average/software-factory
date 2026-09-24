#!/usr/bin/env python3
"""0001_primary_context_entity: rename the pack's stored row key `customer_id` to `primary_context_entity`.

  python3 packs/hfc-research/migrations/0001_primary_context_entity.py <app_id>            dry run: list what would change
  python3 packs/hfc-research/migrations/0001_primary_context_entity.py <app_id> --apply    rewrite those objects in place
  python3 packs/hfc-research/migrations/0001_primary_context_entity.py --local <dir> [--apply]   the same on a local copy
  python3 packs/hfc-research/migrations/0001_primary_context_entity.py --self-test
  --factory-root <dir>   the factory checkout holding state/ and build/ (default: the one this pack sits in)

What it touches: only the pack's own .jsonl / .json files, under the data-room paths the pack declares
(files/agent/subagents/*/subagent.json "dataroomPaths" and pack.json state.corpus: Customers/{id}/filings/**), in
every workspace of the app's blob store (dataroom/ for the first workspace, dataroom/orgs/<org>/ for the others).
An append part (`<file>.jsonl.appends/<key>.part`) is its own object and is rewritten in place, so the file still
reads back in the same order. Version snapshots (dataroom/_versions/) are history and are never touched.

What it changes, per row (a .jsonl line) or per document (a .json file, its top level and the objects in its
top-level lists, the same places finlib.schema.normalise_doc reads):
  - `"customer_id": v` becomes `"primary_context_entity": v`, in the same place; nothing else in the row moves.
  - a row that carries both keys with the same value loses the older one.
  - a row that carries both keys with DIFFERENT values is a conflict: left as it is and listed (a reader refuses it).
Every rewrite is checked by parsing the result: it must equal the original with only that key renamed, in the same
order, every other value identical. A row whose text cannot be rewritten that way is left alone and listed.
Running it again changes nothing (idempotent). The readers accept both keys, so the app works before and after.

Secrets: the blob token is pulled from the app's Vercel production environment into a private temporary file, read,
and the file is deleted at once; the value goes to the helper through its environment only and is never printed.
"""
import json, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(PACK))
OLD, NEW = "customer_id", "primary_context_entity"
STORE = "dataroom"
# The pack's declared data-room paths, as templates (stored folder names).
TEMPLATES = sorted({t for f in sorted(os.listdir(os.path.join(PACK, "files/agent/subagents")))
                    for t in json.load(open(os.path.join(PACK, "files/agent/subagents", f, "subagent.json"))).get("dataroomPaths", [])}
                   | {c["dataroom_path"] for c in json.load(open(os.path.join(PACK, "pack.json")))["state"]["corpus"]})

def template_re(t):
    """'Customers/{customer_id}/filings/**' -> a regex on a logical path (no store prefix)."""
    out = ""
    for piece in re.split(r"(\{[a-z_]+\}|\*\*|\*)", t):
        if piece == "**": out += ".+"
        elif piece == "*": out += "[^/]+"
        elif piece.startswith("{"): out += "[^/]+"
        else: out += re.escape(piece)
    return out

PATHS = "(?:" + "|".join(template_re(t) for t in TEMPLATES) + ")"
DATA = r"\.(?:jsonl|json)(?:\.appends/[^/]+\.part)?"
# dataroom/<logical>  or  dataroom/orgs/<org>/<logical>; never dataroom/_versions/...
OBJECT_RE = re.compile(rf"^{STORE}/(?:orgs/(?P<org>[^/]+)/)?(?P<path>{PATHS}{DATA})$")
# The annual-report map (.md) embeds the map as JSON; readers normalise it. Counted, not rewritten.
MAP_RE = re.compile(rf"^{STORE}/(?:orgs/(?P<org>[^/]+)/)?(?P<path>{PATHS}_annual-report-map\.md)$")
# Every object worth fetching, without group names (it runs in Python and, in the helper, in JavaScript).
SCAN_RE = f"(?:{OBJECT_RE.pattern})|(?:{MAP_RE.pattern})".replace("(?P<org>", "(?:").replace("(?P<path>", "(?:")

# ---- the rewrite, on text ------------------------------------------------------------------------------------------
def _parse(text):
    """JSON with every object kept as its ordered (key, value) pairs, duplicates included."""
    return json.loads(text, object_pairs_hook=lambda pairs: ("{}", tuple(pairs)))

def _is_obj(v): return isinstance(v, tuple) and len(v) == 2 and v[0] == "{}"

def _fix_obj(o):
    """-> (expected object, action). action: None (nothing to do), 'renamed', 'dropped' (same value twice) or 'conflict'."""
    pairs = o[1]; keys = [k for k, _ in pairs]
    if OLD not in keys: return o, None
    if keys.count(OLD) > 1 or keys.count(NEW) > 1: return o, "conflict"
    if NEW in keys:
        if dict(pairs)[OLD] != dict(pairs)[NEW]: return o, "conflict"
        return ("{}", tuple((k, v) for k, v in pairs if k != OLD)), "dropped"
    return ("{}", tuple((NEW if k == OLD else k, v) for k, v in pairs)), "renamed"

def _targets(doc, whole_doc):
    """The objects a reader normalises: a row; for a .json document also the objects in its top-level lists."""
    exp, acts = doc, []
    if not _is_obj(doc): return doc, acts
    exp, a = _fix_obj(doc); acts.append(a)
    if whole_doc and _is_obj(exp):
        pairs = []
        for k, v in exp[1]:
            if isinstance(v, list):
                nv = []
                for x in v:
                    if _is_obj(x): x, a = _fix_obj(x); acts.append(a)
                    nv.append(x)
                v = nv
            pairs.append((k, v))
        exp = ("{}", tuple(pairs))
    return exp, [a for a in acts if a]

KEY_AT = re.compile(r'(?<![\\\w])"' + re.escape(OLD) + r'"(?=\s*:)')

def rewrite_unit(text, whole_doc=False):
    """One row (or one .json document) -> (new text, [actions], problem). The text changes only where the key does."""
    try: doc = _parse(text)
    except ValueError: return text, [], None                      # not JSON: not ours to judge, left as is
    expected, acts = _targets(doc, whole_doc)
    if not acts: return text, [], None
    if "conflict" in acts: return text, acts, "both keys with different values (or a key twice): left as is; a reader refuses this row"
    if expected == doc: return text, [], None
    candidates = []
    if all(a == "renamed" for a in acts):
        candidates.append(KEY_AT.sub('"' + NEW + '"', text))                   # every occurrence is a row key
        for m in KEY_AT.finditer(text):                                        # or only one of them is (nested ones stay)
            candidates.append(text[:m.start()] + '"' + NEW + '"' + text[m.end():])
    else:
        # drop the older key where both carry the same value: cut `"customer_id": <value>` and one comma next to it
        for m in KEY_AT.finditer(text):
            colon = re.match(r"\s*:\s*", text[m.end():])
            try: _, stop = json.JSONDecoder().raw_decode(text, m.end() + colon.end())
            except ValueError: continue
            after, before = re.match(r"\s*,\s*", text[stop:]), re.search(r",\s*$", text[:m.start()])
            cuts = ([text[:m.start()] + text[stop + after.end():]] if after else []) + ([text[:before.start()] + text[stop:]] if before else [])
            for cut in cuts:
                candidates.append(KEY_AT.sub('"' + NEW + '"', cut) if "renamed" in acts else cut)
    for c in candidates:
        try:
            if _parse(c) == expected: return c, acts, None
        except ValueError: pass
    return text, acts, "the key could not be renamed without touching other text: left as is"

def rewrite_bytes(data, is_jsonl):
    """-> (new bytes, counts, problems). Line endings and every byte outside the renamed keys are kept."""
    counts = {"rows": 0, "renamed": 0, "dropped": 0, "conflict": 0, "already_new": 0, "manual": 0}
    problems = []
    try: text = data.decode("utf-8")
    except UnicodeDecodeError: return data, counts, ["not UTF-8: left as is"]
    if not is_jsonl:
        new, acts, prob = rewrite_unit(text, whole_doc=True)
        counts["rows"] = 1
        for a in acts: counts[a] += 1
        if prob:
            problems.append(prob)
            if "could not" in prob: counts["manual"] += 1
        elif not acts and ('"' + NEW + '"') in text: counts["already_new"] += 1
        return new.encode("utf-8"), counts, problems
    out = []
    for n, line in enumerate(text.splitlines(keepends=True), 1):
        body = line.rstrip("\r\n"); end = line[len(body):]
        if not body.strip(): out.append(line); continue
        counts["rows"] += 1
        new, acts, prob = rewrite_unit(body)
        for a in acts: counts[a] += 1
        if prob:
            problems.append(f"line {n}: {prob}")
            if "could not" in prob: counts["manual"] += 1
        elif not acts and ('"' + NEW + '"') in body: counts["already_new"] += 1
        out.append(new + end)
    return "".join(out).encode("utf-8"), counts, problems

# ---- stores ---------------------------------------------------------------------------------------------------------
class LocalStore:
    """A directory holding the store's objects as files (dataroom/... relative paths)."""
    def __init__(self, root): self.root = os.path.abspath(root)
    def scan(self):
        objs, listed = [], 0
        for d, _, files in os.walk(os.path.join(self.root, STORE)):
            for f in files:
                p = os.path.relpath(os.path.join(d, f), self.root).replace(os.sep, "/"); listed += 1
                if re.search(SCAN_RE, p): objs.append({"pathname": p, "body": open(os.path.join(d, f), "rb").read()})
        return listed, sorted(objs, key=lambda o: o["pathname"])
    def put(self, items):
        for it in items:
            p = os.path.join(self.root, it["pathname"]); tmp = p + ".migrating"
            with open(tmp, "wb") as f: f.write(it["body"])
            os.replace(tmp, p)
        return [it["pathname"] for it in items], []

class BlobStore:
    """The app's Vercel Blob store, through lib/blobio.mjs with the app's build for @vercel/blob."""
    def __init__(self, app_id, root=ROOT):
        st = os.path.join(root, "state", "application", app_id)
        if not os.path.isdir(st): sys.exit(f"{app_id}: no state/application/{app_id}/")
        infra = json.load(open(os.path.join(st, "infrastructure.json")))
        self.mold = os.path.join(root, "build", app_id)
        if not os.path.isdir(os.path.join(self.mold, "node_modules", "@vercel", "blob")):
            sys.exit(f"{app_id}: build/{app_id}/node_modules has no @vercel/blob; build the app first (packs.py apply {app_id})")
        proj = (infra.get("vercel") or {}).get("project")
        if not proj: sys.exit(f"{app_id}: infrastructure.json names no Vercel project")
        self.token, self.project = None, None
        for name in (proj, proj + "-api", proj + "-workflow"):
            tok = self._pull_token(name)
            if tok and self._reachable(tok): self.token, self.project = tok, name; break
        if not self.token: sys.exit(f"{app_id}: no project of {proj} has a blob token the store accepts")
        print(f"blob store reached through the {self.project} project's token (value not shown)")
    def _pull_token(self, project):
        d = tempfile.mkdtemp(prefix="migr-env-"); f = os.path.join(d, "env")
        try:
            subprocess.run(["vercel", "env", "pull", "--yes", "--environment=production", "--project", project, f],
                           cwd=self.mold, capture_output=True)
            if not os.path.exists(f): return None
            for l in open(f):
                if l.startswith("BLOB_READ_WRITE_TOKEN="):
                    v = l.split("=", 1)[1].strip().strip('"')
                    return v if v and v != "[SENSITIVE]" else None
            return None
        finally: shutil.rmtree(d, ignore_errors=True)
    def _node(self, cmd, env_extra, stdin=None, token=None):
        env = dict(os.environ, MOLD_DIR=self.mold, BLOB_READ_WRITE_TOKEN=token or self.token, **env_extra)
        r = subprocess.run(["node", os.path.join(HERE, "lib", "blobio.mjs"), cmd], cwd=self.mold, env=env, input=stdin,
                           capture_output=True, text=True)
        if r.returncode: sys.exit(f"blobio {cmd} failed: {(r.stderr or r.stdout).strip()[-600:]}")
        return json.loads(r.stdout)
    def _reachable(self, tok):
        env = dict(os.environ, MOLD_DIR=self.mold, BLOB_READ_WRITE_TOKEN=tok)
        r = subprocess.run(["node", os.path.join(HERE, "lib", "blobio.mjs"), "check"], cwd=self.mold, env=env, capture_output=True, text=True)
        return r.returncode == 0
    def scan(self):
        import base64
        out = self._node("scan", {"MATCH": SCAN_RE, "PREFIX": STORE + "/"})
        objs = [dict(o, body=base64.b64decode(o.pop("b64"))) for o in out["objects"]]
        return out["listed"], sorted(objs, key=lambda o: o["pathname"])
    def put(self, items):
        import base64
        payload = [{"pathname": it["pathname"], "b64": base64.b64encode(it["body"]).decode(), "contentType": it.get("contentType"),
                    "size": it["size"], "uploadedAt": it["uploadedAt"]} for it in items]
        out = self._node("put", {}, stdin=json.dumps(payload))
        return out["written"], out["skipped"]

# ---- the run --------------------------------------------------------------------------------------------------------
def workspace_of(m): return m.group("org") or "(first workspace: dataroom/ root)"

def run(store, apply_it, quiet=False):
    say = (lambda *a: None) if quiet else print
    listed, objs = store.scan()
    total = {"objects_listed": listed, "pack_objects": 0, "objects_to_change": 0, "rows": 0, "renamed": 0, "dropped": 0,
             "conflict": 0, "manual": 0, "already_new": 0, "maps_with_old_key": 0, "by_workspace": {}}
    changes, problems = [], []
    for o in objs:
        m = OBJECT_RE.match(o["pathname"])
        if not m:
            mm = MAP_RE.match(o["pathname"])
            if mm and re.search(rb'"' + OLD.encode() + rb'"\s*:', o["body"]):
                total["maps_with_old_key"] += 1
                say(f"  map (not rewritten; the renderer reads both keys)  {o['pathname']}")
            continue
        total["pack_objects"] += 1
        is_jsonl = ".jsonl" in o["pathname"]
        new, c, probs = rewrite_bytes(o["body"], is_jsonl)
        for k in ("rows", "renamed", "dropped", "conflict", "manual", "already_new"): total[k] += c[k]
        ws = total["by_workspace"].setdefault(workspace_of(m), {"objects_to_change": 0, "rows_to_change": 0, "conflict": 0})
        ws["conflict"] += c["conflict"]
        problems += [f"{o['pathname']}: {p}" for p in probs]
        if new != o["body"]:
            total["objects_to_change"] += 1; ws["objects_to_change"] += 1; ws["rows_to_change"] += c["renamed"] + c["dropped"]
            changes.append(dict(o, body=new))
            say(f"  {'rewrite' if apply_it else 'would rewrite'}  {o['pathname']}  ({c['renamed']} renamed, {c['dropped']} older key dropped, of {c['rows']} rows)")
    for p in problems: say(f"  left as is: {p}")
    written, skipped = ([], [])
    if apply_it and changes:
        written, skipped = store.put(changes)
        for s in skipped: say(f"  skipped: {s['pathname']}: {s['why']}")
    total.update(applied=apply_it, written=len(written), skipped=len(skipped))
    return total

def _self_test():
    ok = 0
    # rows: old, new, mixed, conflict, not JSON, spacing kept, CRLF kept
    new, acts, prob = rewrite_unit('{"customer_id": "x", "kpi": "AUM", "v": 1.50}')
    assert new == '{"primary_context_entity": "x", "kpi": "AUM", "v": 1.50}' and acts == ["renamed"] and not prob; ok += 1
    assert rewrite_unit('{"primary_context_entity": "x"}') == ('{"primary_context_entity": "x"}', [], None); ok += 1
    new, acts, _ = rewrite_unit('{"primary_context_entity": "x", "customer_id": "x", "k": 1}')
    assert new == '{"primary_context_entity": "x", "k": 1}' and acts == ["dropped"], new; ok += 1
    new, acts, _ = rewrite_unit('{"k": 1, "primary_context_entity": "x", "customer_id": "x"}')
    assert new == '{"k": 1, "primary_context_entity": "x"}', new; ok += 1
    new, acts, prob = rewrite_unit('{"customer_id": "a", "primary_context_entity": "b"}')
    assert new == '{"customer_id": "a", "primary_context_entity": "b"}' and acts == ["conflict"] and prob; ok += 1
    # the key's name inside a value, or in a nested object, is not a key of the row
    t = '{"customer_id":"x","note":"the \\"customer_id\\": field","meta":{"customer_id":"y"}}'
    new, acts, prob = rewrite_unit(t)
    assert new == '{"primary_context_entity":"x","note":"the \\"customer_id\\": field","meta":{"customer_id":"y"}}' and not prob, (new, prob); ok += 1
    data = b'{"customer_id": "x", "a": 1}\r\n\n{"primary_context_entity": "x", "a": 2}\n{broken\n{"customer_id": "x", "primary_context_entity": "z"}\n'
    out, c, probs = rewrite_bytes(data, True)
    assert out == b'{"primary_context_entity": "x", "a": 1}\r\n\n{"primary_context_entity": "x", "a": 2}\n{broken\n{"customer_id": "x", "primary_context_entity": "z"}\n', out
    assert (c["rows"], c["renamed"], c["already_new"], c["conflict"]) == (4, 1, 1, 1) and len(probs) == 1, (c, probs); ok += 1
    assert rewrite_bytes(out, True)[0] == out; ok += 1                                      # idempotent
    doc = b'{\n  "customer_id": "x",\n  "data_rows": [{"customer_id": "x", "v": 1}],\n  "tags": ["a"]\n}\n'
    out, c, _ = rewrite_bytes(doc, False)
    assert out == b'{\n  "primary_context_entity": "x",\n  "data_rows": [{"primary_context_entity": "x", "v": 1}],\n  "tags": ["a"]\n}\n', out; ok += 1
    # paths: only the pack's declared folders, data files, append parts; never versions or other domains
    good = ["dataroom/Customers/hfl/filings/kpis.jsonl", "dataroom/orgs/icici-hfc/Customers/hfl/filings/presentations/ip-metrics.jsonl",
            "dataroom/Customers/hfl/filings/filing-log.jsonl.appends/00001758700000000-000000-ab12cd34.part",
            "dataroom/Customers/hfl/filings/lodr/extracts/2025-10-24_reg33_results_q2.results-extract.json"]
    bad = ["dataroom/_versions/onfinance-ai/1758700000000-Customers/hfl/filings/kpis.jsonl", "dataroom/Customers/hfl/notes.jsonl",
           "dataroom/Platform/v1/x.jsonl", "dataroom/Customers/hfl/filings/lodr/2025-10-24_reg33_results_q2.pdf", "other/Customers/hfl/filings/k.jsonl"]
    assert all(OBJECT_RE.match(p) for p in good) and not any(OBJECT_RE.match(p) for p in bad), [p for p in good + bad if bool(OBJECT_RE.match(p)) != (p in good)]; ok += 1
    assert OBJECT_RE.match(good[1]).group("org") == "icici-hfc" and OBJECT_RE.match(good[0]).group("org") is None; ok += 1
    # a whole run on a local store: dry run changes nothing, apply rewrites, a second apply changes nothing
    d = tempfile.mkdtemp()
    try:
        files = {good[0]: b'{"customer_id": "hfl", "kpi": "aum"}\n{"primary_context_entity": "hfl", "kpi": "gnpa"}\n',
                 good[2]: b'{"customer_id": "hfl", "tag": "reg30_event"}\n',
                 good[3]: b'{"customer_id": "hfl", "line_items": []}',
                 bad[0]: b'{"customer_id": "hfl"}\n', bad[1]: b'{"customer_id": "hfl"}\n',
                 "dataroom/Customers/hfl/filings/lodr/FY26_annual-report-map.md": b'x\n```json\n{"customer_id": "hfl"}\n```\n'}
        for p, b in files.items():
            os.makedirs(os.path.dirname(os.path.join(d, p)), exist_ok=True); open(os.path.join(d, p), "wb").write(b)
        s = LocalStore(d)
        t = run(s, False, quiet=True)
        assert (t["pack_objects"], t["objects_to_change"], t["renamed"], t["already_new"], t["maps_with_old_key"]) == (3, 3, 3, 1, 1), t
        assert all(open(os.path.join(d, p), "rb").read() == b for p, b in files.items()); ok += 1   # dry run wrote nothing
        t = run(s, True, quiet=True); assert t["written"] == 3, t
        assert open(os.path.join(d, good[0]), "rb").read() == b'{"primary_context_entity": "hfl", "kpi": "aum"}\n{"primary_context_entity": "hfl", "kpi": "gnpa"}\n'
        assert open(os.path.join(d, bad[0]), "rb").read() == files[bad[0]] and open(os.path.join(d, bad[1]), "rb").read() == files[bad[1]]; ok += 1
        t = run(s, True, quiet=True); assert t["objects_to_change"] == 0 and t["written"] == 0, t; ok += 1   # idempotent
    finally: shutil.rmtree(d, ignore_errors=True)
    # the declared templates are the ones this migration reads
    assert TEMPLATES and all(t.startswith("Customers/{customer_id}/filings/") for t in TEMPLATES), TEMPLATES; ok += 1
    return ok

def main(a):
    if "--self-test" in a:
        n = _self_test(); print(json.dumps({"self_test": "ok", "script": "0001_primary_context_entity", "cases": n})); return 0
    apply_it = "--apply" in a; as_json = "--json" in a
    root = a[a.index("--factory-root") + 1] if "--factory-root" in a else ROOT
    rest = [x for i, x in enumerate(a) if not x.startswith("--") and (i == 0 or a[i - 1] not in ("--factory-root", "--local"))]
    if "--local" in a:
        store = LocalStore(a[a.index("--local") + 1]); label = a[a.index("--local") + 1]
    elif rest:
        store = BlobStore(rest[0], os.path.abspath(root)); label = rest[0]
    else:
        print(__doc__); return 2
    print(f"0001_primary_context_entity on {label}: {'APPLY' if apply_it else 'dry run (nothing is written; add --apply to rewrite)'}")
    print("  pack paths: " + ", ".join(TEMPLATES))
    t = run(store, apply_it, quiet=as_json)
    print(json.dumps(t, indent=1))
    return 1 if t.get("skipped") else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
