#!/usr/bin/env python3
"""A mold's private paths: files of its source that this public repository does not carry (mold_v0-200).

  mold_private.py --self-test     offline: the list, the states, filling in, regenerating, the leftover refusal

WHAT THEY ARE. molds/<mold_id>/mold.json "private_paths" lists files of the mold's source, relative to its codebase,
that hold this factory's organisation names and cannot be made neutral at the source: for mold_v1, migration history
already applied to live databases (drizzle/0000, 0014 and 0023, their drizzle/meta snapshots, and the one-off
.migrate-*.mjs scripts), whose SQL carries the old names as data. Every such path is git-ignored under
molds/<mold_id>/codebase (.gitignore), so:

  - on a machine with the source (this factory's own), mold.py fetch / refresh still put the ORIGINALS on disk, and a
    deploy runs the history exactly as the live databases applied it;
  - the public repository carries, for each one, a NEUTRAL REPLACEMENT under molds/<mold_id>/public/<same path>: the
    same file with the organisation's values replaced by the mold's own placeholders (org #1's built-in id and domain,
    lib/default-org.ts). Applied to a new database, the replacement history builds the same schema as the original,
    with the placeholder org and the placeholder spelling of the one column the history later renames. A public user
    puts them in place with `mold.py public <mold_id>` (they are never written over an original);
  - mold.py check compares every other path with the source, and each private path on disk with either the source's
    file (the original) or its replacement; an absent one is reported, never a difference.

REGENERATING (`mold.py public <mold_id> --regenerate`, on a machine with the originals): each replacement is the
original with this machine's org #1 values (state/factory.local.json "org_one": id, domain, and the id's slug in any
case) replaced by the placeholders; a replacement that would still hold any of this machine's private values
(leakcheck.py's denylist) is refused and nothing is written. Standard library only.
"""
import json, os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path: sys.path.insert(0, HERE)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
PUBLIC = "public"


class Problem(Exception):
    pass


def manifest(root, mold_id):
    p = os.path.join(root, "molds", str(mold_id), "mold.json")
    if not os.path.isfile(p): return {}
    try: man = json.load(open(p))
    except ValueError as e: raise Problem(f"molds/{mold_id}/mold.json is not valid JSON ({e})")
    return man if isinstance(man, dict) else {}


def private_paths(root, mold_id):
    """The mold's private paths, relative to its codebase ([] for a mold without any)."""
    ps = manifest(root, mold_id).get("private_paths") or []
    bad = [p for p in ps if not isinstance(p, str) or not p or p.startswith(("/", "../")) or "/../" in p or "*" in p]
    if bad: raise Problem(f"molds/{mold_id}/mold.json private_paths: {bad[:3]} are not plain paths inside the codebase")
    return list(ps)


def codebase(root, mold_id): return os.path.join(root, "molds", str(mold_id), "codebase")
def replacement(root, mold_id, p): return os.path.join(root, "molds", str(mold_id), PUBLIC, p)


def _same(a, b):
    try:
        with open(a, "rb") as x, open(b, "rb") as y: return x.read() == y.read()
    except OSError: return False


def states(root, mold_id, dest=None, source=None):
    """[(path, state)] for each private path on disk in dest (the codebase by default). state is one of
    original (same as the source's file; only said when a source checkout is given), public (the neutral replacement),
    absent, or differs (neither: a difference). Without a source, a present file that is not the replacement is
    `present`."""
    dest = dest or codebase(root, mold_id); out = []
    for p in private_paths(root, mold_id):
        d = os.path.join(dest, p)
        if not os.path.isfile(d): out.append((p, "absent")); continue
        if source is not None and _same(d, os.path.join(source, p)): out.append((p, "original")); continue
        if _same(d, replacement(root, mold_id, p)): out.append((p, "public")); continue
        out.append((p, "differs" if source is not None else "present"))
    return out


def fill(root, mold_id, dest=None):
    """Put the neutral replacement in place for each private path that is absent. Never writes over a file.
    -> (written, missing a replacement)."""
    dest = dest or codebase(root, mold_id); written, missing = [], []
    for p in private_paths(root, mold_id):
        d = os.path.join(dest, p)
        if os.path.lexists(d): continue
        r = replacement(root, mold_id, p)
        if not os.path.isfile(r): missing.append(p); continue
        os.makedirs(os.path.dirname(d), exist_ok=True); shutil.copyfile(r, d); written.append(p)
    return written, missing


def not_ignored(root, mold_id):
    """The private paths git would track under molds/<mold_id>/codebase (they must all be ignored)."""
    rels = [f"molds/{mold_id}/codebase/{p}" for p in private_paths(root, mold_id)]
    if not rels: return []
    r = subprocess.run(["git", "-C", root, "check-ignore", "--no-index", "--stdin"], input="\n".join(rels) + "\n", capture_output=True, text=True)
    ignored = set(r.stdout.split())
    return [x for x in rels if x not in ignored]


def tracked(root, mold_id):
    """The private paths git still tracks (a commit must remove them from the index)."""
    rels = [f"molds/{mold_id}/codebase/{p}" for p in private_paths(root, mold_id)]
    if not rels: return []
    r = subprocess.run(["git", "-C", root, "ls-files", "--", *rels], capture_output=True, text=True)
    return [x for x in r.stdout.split() if x]


def placeholders(cb):
    """(org #1's built-in id, its built-in domain) from the mold's lib/default-org.ts."""
    try: src = open(os.path.join(cb, "lib", "default-org.ts")).read()
    except OSError: raise Problem("the codebase has no lib/default-org.ts, so it names no placeholder org to write instead")
    org = re.search(r'export const BUILT_IN_ORG = "([^"]+)"', src); dom = re.search(r'export const BUILT_IN_DOMAIN = "([^"]+)"', src)
    if not (org and dom): raise Problem("lib/default-org.ts has no BUILT_IN_ORG / BUILT_IN_DOMAIN")
    return org.group(1), dom.group(1)


def neutral(text, org_one, ph):
    """text with org #1's values (org_one: {"id", "domain"}) replaced by the placeholders ph = (id, domain)."""
    oid, dom = (org_one.get("id") or "").strip(), (org_one.get("domain") or "").strip()
    if not oid.startswith("org-") or not dom: raise Problem('state/factory.local.json "org_one" needs "id" (org-...) and "domain"')
    pid, pdom = ph; slug, pslug = oid[4:], pid[4:] if pid.startswith("org-") else pid
    text = re.sub(re.escape(oid), pid, text, flags=re.I)
    text = re.sub(re.escape(dom), pdom, text, flags=re.I)
    # the slug alone, in whatever case it was written: all lower stays lower, anything else becomes a capitalised word
    return re.sub(re.escape(slug), lambda m: pslug if m.group(0) == m.group(0).lower() else pslug[:1].upper() + pslug[1:], text, flags=re.I)


def regenerate(root, mold_id, terms=None, org_one=None, dest=None):
    """Write molds/<mold_id>/public/<p> for every private path from the original on disk. Refuses (Problem, nothing
    written) when an original is missing or a replacement would still hold a private value. -> the paths written."""
    cb = dest or codebase(root, mold_id)
    if org_one is None:
        from factory_local import load_factory
        org_one = load_factory(os.path.join(root, "state")).get("org_one") or {}
    if os.path.dirname(HERE) not in sys.path: sys.path.insert(0, os.path.dirname(HERE))
    import leakcheck as L
    if terms is None: terms = L.load_terms(root)
    M = L.Matcher(terms); ph = placeholders(cb); out = {}
    for p in private_paths(root, mold_id):
        src = os.path.join(cb, p)
        if not os.path.isfile(src): raise Problem(f"{p} is not on disk here, so its replacement cannot be made (mold.py fetch {mold_id} first)")
        new = neutral(open(src, encoding="utf-8").read(), org_one, ph)
        left = M.find(new) + [(0, n) for _, n in M.find(p)]
        if left: raise Problem(f"{p}: the replacement would still hold local value(s) #{', #'.join(sorted({str(n) for _, n in left}))}; nothing was written")
        r = replacement(root, mold_id, p)
        out[p] = None if os.path.isfile(r) and open(r, encoding="utf-8").read() == new else new
    for p, new in out.items():
        if new is None: continue
        r = replacement(root, mold_id, p); os.makedirs(os.path.dirname(r), exist_ok=True)
        with open(r, "w", encoding="utf-8") as f: f.write(new)
    return [p for p, new in out.items() if new is not None]


def self_test():
    import tempfile
    fails = []
    def ok(name, cond, detail=""):
        print(("ok   " if cond else "FAIL ") + name + ("" if cond or not detail else f"  {detail}"))
        if not cond: fails.append(name)
    with tempfile.TemporaryDirectory() as t:
        subprocess.run(["git", "init", "-q", t], check=True)
        mold = os.path.join(t, "molds", "m"); cb = os.path.join(mold, "codebase")
        os.makedirs(os.path.join(cb, "drizzle")); os.makedirs(os.path.join(cb, "lib"))
        open(os.path.join(cb, "lib", "default-org.ts"), "w").write('export const BUILT_IN_ORG = "org-placeco";\nexport const BUILT_IN_DOMAIN = "placeco.example";\n')
        open(os.path.join(cb, "drizzle", "0000_a.sql"), "w").write('CREATE TABLE t ("zorbix_owner" text, org_id text DEFAULT \'org-zorbix\');\n-- Zorbix at zorbix.test\n')
        open(os.path.join(cb, "keep.ts"), "w").write("x\n")
        ok("no mold.json: no private paths", private_paths(t, "m") == [] and fill(t, "m") == ([], []))
        json.dump({"mold_id": "m", "private_paths": ["drizzle/0000_a.sql"]}, open(os.path.join(mold, "mold.json"), "w"))
        open(os.path.join(t, ".gitignore"), "w").write("/molds/m/codebase/drizzle/0000_a.sql\n")
        ok("the list is read from mold.json", private_paths(t, "m") == ["drizzle/0000_a.sql"])
        ok("  ...and git ignores each one", not_ignored(t, "m") == [])
        terms = [{"n": 1, "term": "zorbix", "source": "test"}, {"n": 2, "term": "zorbix.test", "source": "test"}]
        org1 = {"id": "org-zorbix", "domain": "zorbix.test"}
        ok("regenerate writes a neutral replacement", regenerate(t, "m", terms, org1) == ["drizzle/0000_a.sql"])
        rep = open(replacement(t, "m", "drizzle/0000_a.sql")).read()
        ok("  ...with the placeholders, case kept for the slug",
           rep == 'CREATE TABLE t ("placeco_owner" text, org_id text DEFAULT \'org-placeco\');\n-- Placeco at placeco.example\n', rep)
        ok("  ...and again: nothing to write", regenerate(t, "m", terms, org1) == [])
        ok("states: the original on disk is `present` without a source, `original` with one",
           states(t, "m") == [("drizzle/0000_a.sql", "present")] and states(t, "m", source=cb) == [("drizzle/0000_a.sql", "original")])
        os.remove(os.path.join(cb, "drizzle", "0000_a.sql"))
        ok("  ...absent once removed", states(t, "m") == [("drizzle/0000_a.sql", "absent")])
        ok("fill puts the replacement in place", fill(t, "m") == (["drizzle/0000_a.sql"], []) and states(t, "m") == [("drizzle/0000_a.sql", "public")])
        open(os.path.join(cb, "drizzle", "0000_a.sql"), "w").write("edited\n")
        ok("  ...never over a file that is there", fill(t, "m") == ([], []) and open(os.path.join(cb, "drizzle", "0000_a.sql")).read() == "edited\n")
        ok("  ...and a file that is neither differs from the source", states(t, "m", source=os.path.join(t, "nowhere")) == [("drizzle/0000_a.sql", "differs")])
        open(os.path.join(cb, "drizzle", "0000_a.sql"), "w").write("zorbix and the secret word quuxly\n")
        try: regenerate(t, "m", terms + [{"n": 3, "term": "quuxly", "source": "test"}], org1); ok("a leftover value is refused", False)
        except Problem as e: ok("a leftover value is refused, naming its number only", "#3" in str(e) and "quuxly" not in str(e), str(e))
        ok("  ...and nothing was written", open(replacement(t, "m", "drizzle/0000_a.sql")).read() == rep)
        open(os.path.join(t, ".gitignore"), "w").write("")
        ok("a private path git would track is named", not_ignored(t, "m") == ["molds/m/codebase/drizzle/0000_a.sql"])
        json.dump({"private_paths": ["../x"]}, open(os.path.join(mold, "mold.json"), "w"))
        try: private_paths(t, "m"); ok("a path outside the codebase is refused", False)
        except Problem: ok("a path outside the codebase is refused", True)
    print(f"mold_private self-test: {'all passed' if not fails else str(len(fails)) + ' failed'}")
    return 1 if fails else 0


if __name__ == "__main__":
    if "--self-test" in sys.argv[1:]: sys.exit(self_test())
    print(__doc__); sys.exit(2)
