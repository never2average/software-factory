"""A small JSON Schema validator (no third-party dependency) and JSONL helpers.
Supports: type (incl. lists and null), required, properties, additionalProperties:false, enum, const, pattern,
minimum, maximum, minLength, items, and allOf/if/then (for 'when status is X, field Y is required')."""
import json, re

_T = {"string": str, "number": (int, float), "integer": int, "boolean": bool, "object": dict, "array": list, "null": type(None)}

def _type_ok(v, t):
    if isinstance(t, list): return any(_type_ok(v, x) for x in t)
    if t in ("number", "integer") and isinstance(v, bool): return False
    return isinstance(v, _T[t])

def validate(obj, schema, where="$"):
    """-> list of 'path: problem' strings; empty means valid."""
    e = []
    if "const" in schema and obj != schema["const"]: e.append(f"{where}: must be {schema['const']!r}")
    if "enum" in schema and obj not in schema["enum"]: e.append(f"{where}: {obj!r} is not one of {schema['enum']}")
    if "type" in schema and not _type_ok(obj, schema["type"]): e.append(f"{where}: expected {schema['type']}, got {type(obj).__name__}"); return e
    if isinstance(obj, str):
        if "pattern" in schema and not re.search(schema["pattern"], obj): e.append(f"{where}: {obj!r} does not match {schema['pattern']}")
        if len(obj) < schema.get("minLength", 0): e.append(f"{where}: shorter than {schema['minLength']}")
    if isinstance(obj, (int, float)) and not isinstance(obj, bool):
        if "minimum" in schema and obj < schema["minimum"]: e.append(f"{where}: {obj} < minimum {schema['minimum']}")
        if "maximum" in schema and obj > schema["maximum"]: e.append(f"{where}: {obj} > maximum {schema['maximum']}")
    if isinstance(obj, dict):
        for k in schema.get("required", []):
            if k not in obj: e.append(f"{where}: missing required '{k}'")
        props = schema.get("properties", {})
        for k, v in obj.items():
            if k in props: e += validate(v, props[k], f"{where}.{k}")
            elif schema.get("additionalProperties") is False: e.append(f"{where}: unexpected field '{k}'")
    if isinstance(obj, list) and "items" in schema:
        for i, v in enumerate(obj): e += validate(v, schema["items"], f"{where}[{i}]")
    for sub in schema.get("allOf", []):
        if "if" in sub:
            if not validate(obj, sub["if"], where): e += validate(obj, sub.get("then", {}), where)
        else: e += validate(obj, sub, where)
    return e

def read_jsonl(path):
    """-> (rows, problems). A line that is not a JSON object is a problem, not a crash."""
    rows, problems = [], []
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            if not line.strip(): continue
            try: o = json.loads(line)
            except json.JSONDecodeError as x: problems.append(f"line {n}: not JSON ({x.msg})"); continue
            if not isinstance(o, dict): problems.append(f"line {n}: not a JSON object"); continue
            rows.append((n, o))
    return rows, problems

def validate_jsonl(path, schema):
    rows, problems = read_jsonl(path)
    for n, o in rows: problems += [f"line {n} {p}" for p in validate(o, schema)]
    return rows, problems

def _self_test():
    s = {"type": "object", "required": ["kpi", "status"], "additionalProperties": False,
         "properties": {"kpi": {"type": "string", "minLength": 1}, "value": {"type": ["number", "null"]},
                        "status": {"enum": ["ok", "not_found"]}, "page": {"type": ["integer", "null"], "minimum": 1}, "footnote": {"type": "string"}},
         "allOf": [{"if": {"properties": {"status": {"const": "ok"}}, "required": ["status"]}, "then": {"required": ["value", "page"]}}]}
    assert validate({"kpi": "AUM", "status": "ok", "value": 1.0, "page": 3}, s) == []
    assert len(validate({"kpi": "AUM", "status": "ok"}, s)) == 2
    assert validate({"kpi": "AUM", "status": "not_found"}, s) == []
    assert len(validate({"kpi": "", "status": "maybe", "x": 1}, s)) == 3
    assert validate({"kpi": "AUM", "status": "not_found", "value": True}, s) != []
    assert validate({"kpi": "AUM", "status": "not_found", "page": 0}, s) != []
    return 6
