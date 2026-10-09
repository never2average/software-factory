"""Pre-rename spellings of state keys and values, for applications stamped before a rename.

The repository knows only the current names. An application on this machine that still carries an old one is
listed in state/factory.local.json -> `legacy_names` ({current: old}, never committed; lib/factory_local.py), and
the readers below accept it there. With nothing listed, only the current names are read.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from factory_local import legacy_names

_NAMES = None


def old_name(current):
    """The old spelling of `current` on this machine, or None."""
    global _NAMES
    if _NAMES is None: _NAMES = legacy_names()
    return _NAMES.get(current)


def get(d, key, default=None):
    """d[key], else d[<its old name>], else default. For dicts only (anything else gives default)."""
    if not isinstance(d, dict): return default
    if d.get(key) is not None: return d[key]
    old = old_name(key)
    return d[old] if old and d.get(old) is not None else default


def has_old(d, key):
    """The old spelling of `key` present in d (so a reader can migrate it or a validator can name it)."""
    old = old_name(key)
    return old if isinstance(d, dict) and old and old in d else None


def is_value(v, current):
    """v is `current` or its old spelling on this machine."""
    return v == current or (v is not None and v == old_name(current))


def spellings(current):
    """(current,) or (current, old)."""
    old = old_name(current)
    return (current, old) if old else (current,)


if __name__ == "__main__":
    _NAMES = {"operator_self": "old_self", "live_source_agent": "live_old_agent"}
    assert get({"operator_self": {"email": "a"}}, "operator_self") == {"email": "a"}
    assert get({"old_self": {"email": "b"}}, "operator_self") == {"email": "b"}
    assert get({"operator_self": None, "old_self": {"email": "b"}}, "operator_self") == {"email": "b"}
    assert get({}, "operator_self", {}) == {} and get(None, "operator_self", 1) == 1 and get({"x": 1}, "x") == 1
    assert has_old({"old_self": 1}, "operator_self") == "old_self" and has_old({"operator_self": 1}, "operator_self") is None
    assert is_value("live_old_agent", "live_source_agent") and is_value("live_source_agent", "live_source_agent") and not is_value("none", "live_source_agent")
    assert spellings("operator_self") == ("operator_self", "old_self") and spellings("x") == ("x",)
    _NAMES = {}
    assert get({"old_self": 1}, "operator_self") is None and not is_value("live_old_agent", "live_source_agent")
    print("legacy self-test: ok")
