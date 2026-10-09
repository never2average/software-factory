"""state/factory.json with this machine's own values merged over it.

The repository's state/factory.json carries neutral placeholders (operator email, notification domain, Vercel team,
the factory machine's address). The real ones live in state/factory.local.json on the factory machine, which is never
committed (.gitignore). Readers that need real values load through `load_factory`; a missing local file is fine.

The local file also carries what the repository never names:
  mold_sources   {mold_id: git URL}: where each mold's codebase is fetched from (mold.py fetch / refresh).
  live_projects  {"web": .., "api": .., "workflow": ..}: the live source deployment's Vercel projects, which the
                 factory only ever reads (clone.py) and refuses to deploy over (provision.py) or probe (the lanes).
  legacy_names   {current: old}: the pre-rename spelling of a state key or value that an application on this
                 machine still carries; readers accept the old one through `legacy` (lib/legacy.py).
"""
import json, os, re

ROOT_STATE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))), "state")


def _merge(base, over):
    if not isinstance(base, dict) or not isinstance(over, dict):
        return over
    out = dict(base)
    for k, v in over.items():
        if k.startswith("_"):
            continue
        out[k] = _merge(base.get(k), v) if isinstance(v, dict) else v
    return out


def load_factory(state_dir):
    with open(os.path.join(state_dir, "factory.json")) as f:
        data = json.load(f)
    local = os.path.join(state_dir, "factory.local.json")
    if os.path.exists(local):
        with open(local) as f:
            data = _merge(data, json.load(f))
    return data


def mold_source(mold_id, state_dir=ROOT_STATE):
    """The git URL a mold's codebase is fetched from, or None when this machine names none."""
    url = (load_factory(state_dir).get("mold_sources") or {}).get(mold_id)
    return url.strip() if isinstance(url, str) and url.strip() else None


def repo_slug(url):
    """host/owner/name from any git URL (https, ssh, scp-like, with or without .git): what `gh -R` and a manifest
    print. None for a local path."""
    if not url: return None
    u = re.sub(r"\.git/?$", "", url.strip().rstrip("/"))
    m = re.match(r"^(?:[a-z+]+://)?(?:[^@/]+@)?([^/:]+)[:/](.+)$", u)
    if not m or os.path.isabs(url) or url.startswith("file:"): return None
    return f"{m.group(1)}/{m.group(2).lstrip('/')}"


def live_projects(state_dir=ROOT_STATE):
    """{"web", "api", "workflow"} -> the live source deployment's Vercel project names; {} when none is configured."""
    lp = load_factory(state_dir).get("live_projects") or {}
    return {k: v for k, v in lp.items() if isinstance(v, str) and v}


def legacy_names(state_dir=ROOT_STATE):
    """{current: old} spellings still read on this machine; {} when none."""
    ln = load_factory(state_dir).get("legacy_names") or {}
    return {k: v for k, v in ln.items() if isinstance(v, str) and v and v != k}


if __name__ == "__main__":
    import sys, tempfile
    with tempfile.TemporaryDirectory() as d:
        json.dump({"defaults": {"operator_email": "operator@example.com", "vm": {"provider": "x", "host": "203.0.113.10"}}, "molds": [1]}, open(os.path.join(d, "factory.json"), "w"))
        assert load_factory(d)["defaults"]["operator_email"] == "operator@example.com"
        json.dump({"_comment": "c", "defaults": {"operator_email": "me@real.test", "vm": {"host": "192.0.2.5"}}}, open(os.path.join(d, "factory.local.json"), "w"))
        m = load_factory(d)
        assert m["defaults"]["operator_email"] == "me@real.test" and m["defaults"]["vm"] == {"provider": "x", "host": "192.0.2.5"} and m["molds"] == [1] and "_comment" not in m
        assert mold_source("mold_v1", d) is None and live_projects(d) == {} and legacy_names(d) == {}
        json.dump({"mold_sources": {"mold_v1": " https://git.example.com/acme/base.git "}, "live_projects": {"web": "w", "api": ""},
                   "legacy_names": {"operator_self": "old_self", "same": "same"}}, open(os.path.join(d, "factory.local.json"), "w"))
        assert mold_source("mold_v1", d) == "https://git.example.com/acme/base.git" and mold_source("mold_v2", d) is None
        assert live_projects(d) == {"web": "w"} and legacy_names(d) == {"operator_self": "old_self"}
    for u, want in (("https://git.example.com/acme/base.git", "git.example.com/acme/base"), ("git@host-alias:acme/base.git", "host-alias/acme/base"),
                    ("ssh://git@git.example.com/acme/base", "git.example.com/acme/base"), ("/tmp/x.git", None), ("file:///tmp/x.git", None), (None, None)):
        assert repo_slug(u) == want, (u, repo_slug(u))
    print("factory_local self-test: ok")
