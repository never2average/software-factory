"""A JSON Schema (draft 2020-12) checker for the app-spec schemas (schemas/<mold_id>.app.schema.json), stdlib only.

It covers what those schemas use: type, enum, const, pattern, min/maxLength, minimum/maximum/exclusiveMinimum/
exclusiveMaximum, min/maxItems, uniqueItems, items, prefixItems, contains, properties, required, additionalProperties,
propertyNames, $ref (inside the same document), allOf, anyOf, oneOf, not, if/then/else. Each problem comes back as
(kind, path, sentence), kind being "missing", "not supported" or "wrong value", so the factory can say it in plain words.

Two annotations of the factory's own, which editors ignore:
  x-rule           on an allOf entry: the plain sentence of a completeness rule; problems found inside its `then` say it
  x-not-supported  on a property schema of `false`-like form ({"not": {}}): why this mold has no such setting
"""
import json, re

_PAT = {}
def _pattern(p):
    if p not in _PAT:
        # JSON Schema patterns are ECMAScript; the ones in use differ from Python only in escaped slashes.
        _PAT[p] = re.compile(p.replace("\\/", "/"))
    return _PAT[p]

def _type_ok(t, v):
    ts = t if isinstance(t, list) else [t]
    for x in ts:
        if x == "object" and isinstance(v, dict): return True
        if x == "array" and isinstance(v, list): return True
        if x == "string" and isinstance(v, str): return True
        if x == "boolean" and isinstance(v, bool): return True
        if x == "null" and v is None: return True
        if x == "integer" and isinstance(v, int) and not isinstance(v, bool): return True
        if x == "integer" and isinstance(v, float) and v.is_integer(): return True
        if x == "number" and isinstance(v, (int, float)) and not isinstance(v, bool): return True
    return False

def _label(s):
    return s.get("title") or (s.get("description") or "").split(". ")[0][:160]

def _fmt(path): return path or "(the spec)"

def resolve(root, ref):
    if not ref.startswith("#"): raise ValueError(f"$ref {ref!r} is outside the document")
    n = root
    for k in [x.replace("~1", "/").replace("~0", "~") for x in ref[1:].split("/") if x]:
        n = n[k]
    return n

def check(schema, value, root=None, path=""):
    """[(kind, path, sentence)] for every way `value` fails `schema` ([] when it passes)."""
    return _check(schema, value, root if root is not None else schema, path)

def _closest(alts, path):
    """Of the forms a value fits none of, the one it meant: not one whose type or keys it does not have."""
    def score(errs):
        n = 0
        for kd, p, msg in errs:
            if p == path and " must be a" in msg: n += 1000
            elif p.rsplit(".", 1)[0] == path or (not path and "." not in p): n += 100 if kd in ("missing", "not supported") else 1
            else: n += 1
        return n
    return min(alts, key=score)

def _check(s, v, root, path):
    if s is True: return []
    if s is False: return [("not supported", path, f"{_fmt(path)} is not supported here")]
    if not isinstance(s, dict): return []
    out = []
    if "$ref" in s:
        out += _check(resolve(root, s["$ref"]), v, root, path)
    if "x-not-supported" in s:
        return [("not supported", path, f"{_fmt(path)} is not supported: {s['x-not-supported']}")]
    if "not" in s and not _check(s["not"], v, root, path):
        return out + [("not supported", path, f"{_fmt(path)}: {s.get('description') or 'not allowed'}")]
    if "type" in s and not _type_ok(s["type"], v):
        want = s["type"] if isinstance(s["type"], str) else " or ".join(s["type"])
        return out + [("wrong value", path, f"{_fmt(path)} must be {'an' if want[0] in 'aeiou' else 'a'} {want} (got {json.dumps(v)[:60]})")]
    if "const" in s and v != s["const"]:
        out.append(("wrong value", path, f"{_fmt(path)} must be {json.dumps(s['const'])} (got {json.dumps(v)[:60]})"))
    if "enum" in s and v not in s["enum"]:
        out.append(("wrong value", path, f"{_fmt(path)} must be one of {', '.join(json.dumps(x) for x in s['enum'])} (got {json.dumps(v)[:60]})"))
    if isinstance(v, str):
        if "minLength" in s and len(v) < s["minLength"]: out.append(("wrong value", path, f"{_fmt(path)} needs at least {s['minLength']} character(s)"))
        if "maxLength" in s and len(v) > s["maxLength"]: out.append(("wrong value", path, f"{_fmt(path)} is longer than {s['maxLength']} characters"))
        if "pattern" in s and not _pattern(s["pattern"]).search(v):
            hint = s.get("x-hint") or f"it does not match {s['pattern']}"
            out.append(("wrong value", path, f"{_fmt(path)} {json.dumps(v)[:60]} is not right: {hint}"))
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if "minimum" in s and v < s["minimum"]: out.append(("wrong value", path, f"{_fmt(path)} must be at least {s['minimum']} (got {v})"))
        if "maximum" in s and v > s["maximum"]: out.append(("wrong value", path, f"{_fmt(path)} must be at most {s['maximum']} (got {v})"))
        if "exclusiveMinimum" in s and v <= s["exclusiveMinimum"]: out.append(("wrong value", path, f"{_fmt(path)} must be above {s['exclusiveMinimum']} (got {v})"))
        if "exclusiveMaximum" in s and v >= s["exclusiveMaximum"]: out.append(("wrong value", path, f"{_fmt(path)} must be below {s['exclusiveMaximum']} (got {v})"))
    if isinstance(v, list):
        if "minItems" in s and len(v) < s["minItems"]: out.append(("missing", path, f"{_fmt(path)} needs at least {s['minItems']} item(s)" + (f": {_label(s)}" if _label(s) else "")))
        if "maxItems" in s and len(v) > s["maxItems"]: out.append(("wrong value", path, f"{_fmt(path)} has more than {s['maxItems']} items"))
        if s.get("uniqueItems") and len({json.dumps(x, sort_keys=True) for x in v}) != len(v): out.append(("wrong value", path, f"{_fmt(path)} names something twice"))
        pre = s.get("prefixItems") or []
        for i, x in enumerate(v):
            if i < len(pre): out += _check(pre[i], x, root, f"{path}[{i}]")
            elif "items" in s: out += _check(s["items"], x, root, f"{path}[{i}]")
        if "contains" in s and not any(not _check(s["contains"], x, root, path) for x in v):
            out.append(("missing", path, f"{_fmt(path)} has nothing that is {_label(s['contains']) or 'required'}"))
    if isinstance(v, dict):
        if "minProperties" in s and len(v) < s["minProperties"]: out.append(("missing", path, f"{_fmt(path)} is empty: fill it in or leave it out"))
        props = s.get("properties") or {}
        for r in s.get("required") or []:
            if r not in v:
                sub = props.get(r) or {}
                what = _label(sub) if isinstance(sub, dict) else ""
                out.append(("missing", f"{path}.{r}" if path else r, f"{path + '.' if path else ''}{r} is missing" + (f": {what}" if what else "")))
        for k, x in v.items():
            here = f"{path}.{k}" if path else k
            if k in props: out += _check(props[k], x, root, here)
            elif "additionalProperties" in s:
                ap = s["additionalProperties"]
                if ap is False:
                    known = ", ".join(p for p in props if not p.startswith("$"))
                    out.append(("not supported", here, f"{here} is not supported here" + (f" (supported: {known})" if known else "")))
                else: out += _check(ap, x, root, here)
            if "propertyNames" in s:
                out += [(kd, here, f"the name {k!r} at {_fmt(path)} is not right: {msg.split(': ', 1)[-1]}") for kd, _, msg in _check(s["propertyNames"], k, root, here)]
    for sub in s.get("allOf") or []:
        got = _check(sub, v, root, path)
        if got and isinstance(sub, dict) and sub.get("x-rule"):
            got = [(kd, p, f"{msg} (because {sub['x-rule']})") for kd, p, msg in got]
        out += got
    if "anyOf" in s:
        alts = [_check(a, v, root, path) for a in s["anyOf"]]
        if all(alts): out += _closest(alts, path)
    if "oneOf" in s:
        alts = [_check(a, v, root, path) for a in s["oneOf"]]
        ok = [a for a in alts if not a]
        if not ok: out += _closest(alts, path)
        elif len(ok) > 1: out.append(("wrong value", path, f"{_fmt(path)} fits {len(ok)} of its forms; exactly one is allowed"))
    if "if" in s:
        if not _check(s["if"], v, root, path):
            if "then" in s: out += _check(s["then"], v, root, path)
        elif "else" in s: out += _check(s["else"], v, root, path)
    # one sentence per place and problem
    seen, uniq = set(), []
    for e in out:
        if e not in seen: seen.add(e); uniq.append(e)
    return uniq
