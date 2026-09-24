"""A small JSON Schema validator (no third-party dependency) and JSONL helpers.
Supports: type (incl. lists and null), required, properties, additionalProperties:false, enum, const, pattern,
minimum, maximum, minLength, items, and allOf/if/then (for 'when status is X, field Y is required')."""
import json, re

# The key that holds the entity a row is about in every row this pack stores (.jsonl, extracts, maps): here the
# covered company's company_id, the value the agent's tools return.
ROW_KEY = "primary_context_entity"
# The key's older name. Rows written before the rename carry it: readers accept it (normalise_row), writers never emit it.
LEGACY_ROW_KEYS = ("customer_id",)
# A company's data-room folder: the name the agent's tools show, then the stored name (older rows and paths carry it).
COMPANY_FOLDERS = ("Companies", "Customers")

def row_entity(obj):
    """-> the company id a row is about: the current key first, else an older name; None when neither is there."""
    if not isinstance(obj, dict): return None
    if ROW_KEY in obj: return obj[ROW_KEY]
    for k in LEGACY_ROW_KEYS:
        if k in obj: return obj[k]
    return None

def normalise_row(obj):
    """-> (row, problems). The row with its older key renamed to ROW_KEY, in the same position, every other field
    untouched. Both keys with the same value: the older one is dropped. Both with different values: a problem (the
    current key's value is kept). Not a dict: returned as is."""
    if not isinstance(obj, dict) or not any(k in obj for k in LEGACY_ROW_KEYS): return obj, []
    problems, out = [], {}
    for k, v in obj.items():
        if k in LEGACY_ROW_KEYS:
            if ROW_KEY in obj:
                if obj[ROW_KEY] != v: problems.append(f"{ROW_KEY} {obj[ROW_KEY]!r} and its older name {k} {v!r} disagree: keep one")
                continue
            if ROW_KEY in out: continue
            out[ROW_KEY] = v
        else:
            out[k] = v
    return out, problems

def normalise_doc(obj):
    """normalise_row for a document that also carries rows: the top level and every dict in a top-level list."""
    obj, problems = normalise_row(obj)
    if isinstance(obj, dict):
        for k, v in list(obj.items()):
            if isinstance(v, list) and any(isinstance(x, dict) for x in v):
                fixed = []
                for i, x in enumerate(v):
                    x, p = normalise_row(x); fixed.append(x); problems += [f"{k}[{i}]: {q}" for q in p]
                obj[k] = fixed
    return obj, problems

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
    """-> (rows, problems). A line that is not a JSON object is a problem, not a crash. Rows come back normalised
    (normalise_row): a row stored under the key's older name reads as ROW_KEY; a row with both keys disagreeing is a
    problem."""
    rows, problems = [], []
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            if not line.strip(): continue
            try: o = json.loads(line)
            except json.JSONDecodeError as x: problems.append(f"line {n}: not JSON ({x.msg})"); continue
            if not isinstance(o, dict): problems.append(f"line {n}: not a JSON object"); continue
            o, p = normalise_row(o); problems += [f"line {n}: {q}" for q in p]
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
    old = LEGACY_ROW_KEYS[0]
    # a new row is untouched
    new_row = {ROW_KEY: "example-hfl", "kpi": "AUM"}
    assert normalise_row(new_row) == (new_row, [])
    # an old row reads as the new key, in the same position, other fields untouched
    got, p = normalise_row({"a": 1, old: "example-hfl", "kpi": "AUM"})
    assert p == [] and list(got) == ["a", ROW_KEY, "kpi"] and got[ROW_KEY] == "example-hfl", got
    assert row_entity({old: "x"}) == "x" and row_entity({ROW_KEY: "y", old: "x"}) == "y" and row_entity({}) is None
    # a mixed row that agrees drops the older key; one that disagrees is a problem
    assert normalise_row({ROW_KEY: "x", old: "x", "k": 1}) == ({ROW_KEY: "x", "k": 1}, [])
    got, p = normalise_row({old: "a", ROW_KEY: "b"})
    assert got == {ROW_KEY: "b"} and len(p) == 1, (got, p)
    # documents: top level and rows inside lists
    got, p = normalise_doc({old: "x", "data_rows": [{old: "x", "v": 1}, {ROW_KEY: "x"}], "tags": ["a"]})
    assert p == [] and got == {ROW_KEY: "x", "data_rows": [{ROW_KEY: "x", "v": 1}, {ROW_KEY: "x"}], "tags": ["a"]}, got
    # read_jsonl: old, new and mixed rows in one file
    import os, tempfile
    fd, path = tempfile.mkstemp(suffix=".jsonl")
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps({old: "x", "n": 1}) + "\n" + json.dumps({ROW_KEY: "x", "n": 2}) + "\n"
                + json.dumps({ROW_KEY: "x", old: "x", "n": 3}) + "\n" + json.dumps({ROW_KEY: "x", old: "z", "n": 4}) + "\n")
    try: rows, problems = read_jsonl(path)
    finally: os.unlink(path)
    assert [o for _, o in rows] == [{ROW_KEY: "x", "n": i} for i in (1, 2, 3, 4)], rows
    assert len(problems) == 1 and problems[0].startswith("line 4:"), problems
    return 14
