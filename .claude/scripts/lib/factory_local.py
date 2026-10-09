"""state/factory.json with this machine's own values merged over it.

The repository's state/factory.json carries neutral placeholders (operator email, notification domain, Vercel team,
the factory machine's address). The real ones live in state/factory.local.json on the factory machine, which is never
committed (.gitignore). Readers that need real values load through `load_factory`; a missing local file is fine.
"""
import json, os


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


if __name__ == "__main__":
    import sys, tempfile
    with tempfile.TemporaryDirectory() as d:
        json.dump({"defaults": {"operator_email": "operator@example.com", "vm": {"provider": "x", "host": "203.0.113.10"}}, "molds": [1]}, open(os.path.join(d, "factory.json"), "w"))
        assert load_factory(d)["defaults"]["operator_email"] == "operator@example.com"
        json.dump({"_comment": "c", "defaults": {"operator_email": "me@real.test", "vm": {"host": "192.0.2.5"}}}, open(os.path.join(d, "factory.local.json"), "w"))
        m = load_factory(d)
        assert m["defaults"]["operator_email"] == "me@real.test" and m["defaults"]["vm"] == {"provider": "x", "host": "192.0.2.5"} and m["molds"] == [1] and "_comment" not in m
    print("factory_local self-test: ok")
