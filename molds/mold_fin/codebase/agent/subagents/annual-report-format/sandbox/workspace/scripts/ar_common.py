#!/usr/bin/env python3
"""Shared helpers for the annual-report-format scripts: reference/schema loading, text cleaning, roman numerals,
printed page labels, JSON output and the self-test runner. Standard library only.

Run directly it checks the workspace itself: the JSON references parse, every regex in them compiles, and the
copies kept beside the skills are identical to the ones the scripts read."""
import argparse, hashlib, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
REF_DIR = os.path.normpath(os.path.join(HERE, "..", "references"))
SCHEMA_DIR = os.path.normpath(os.path.join(HERE, "..", "schemas"))

# The references the scripts read, and the skill that carries a copy for the model to read.
REFERENCE_COPIES = {
    "section-headings.json": "build-the-section-map",
    "statement-labels.json": "financial-statements-division-iii",
}

EXIT_OK, EXIT_CHECK_FAILED, EXIT_BAD_INPUT = 0, 1, 2


def load_reference(name):
    with open(os.path.join(REF_DIR, name), encoding="utf-8") as f:
        return json.load(f)


def load_schema(name):
    with open(os.path.join(SCHEMA_DIR, name), encoding="utf-8") as f:
        return json.load(f)


def read_json_arg(path):
    """JSON from a file path, or from stdin when the path is '-'."""
    try:
        if path == "-":
            return json.load(sys.stdin)
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        die(f"no such file: {path}")
    except json.JSONDecodeError as x:
        die(f"{path}: not valid JSON ({x.msg} at line {x.lineno})")


def emit(obj):
    json.dump(obj, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def die(message, code=EXIT_BAD_INPUT):
    print(message, file=sys.stderr)
    sys.exit(code)


_TRANS = {0x2018: "'", 0x2019: "'", 0x201C: '"', 0x201D: '"', 0x2013: "-", 0x2014: "-", 0x2212: "-", 0x00A0: " ",
          0x2009: " ", 0x202F: " ", 0x00AD: ""}


def clean(text):
    """Straight quotes, plain hyphens, single spaces. Annual reports mix curly apostrophes and en dashes freely."""
    if text is None:
        return ""
    return " ".join(str(text).translate(_TRANS).split())


_ROMAN = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"), (10, "x"),
          (9, "ix"), (5, "v"), (4, "iv"), (1, "i")]


def int_to_roman(n):
    if not isinstance(n, int) or n < 1 or n > 3999:
        raise ValueError(f"cannot write {n!r} as a roman numeral")
    out = []
    for v, s in _ROMAN:
        while n >= v:
            out.append(s); n -= v
    return "".join(out)


def roman_to_int(text):
    """Strict: 'iv' -> 4, 'IIII' -> None, 'mild' -> None. Round-trips through int_to_roman so malformed numerals fail."""
    s = (text or "").strip().lower()
    if not s or not re.fullmatch(r"[ivxlcdm]+", s):
        return None
    vals = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100, "d": 500, "m": 1000}
    total = 0
    for i, ch in enumerate(s):
        v = vals[ch]
        total += -v if i + 1 < len(s) and vals[s[i + 1]] > v else v
    if total < 1 or total > 3999 or int_to_roman(total) != s:
        return None
    return total


MAX_ROMAN_PAGE = 100   # front matter never runs past this; rejects words such as 'mix' (1009) and 'di' (501)


def parse_page_label(label):
    """A printed page label -> {'style': 'arabic'|'roman', 'value': int}, or None when it is not a page number
    ('cover', '', 'A-12'). Integers are accepted as arabic."""
    if isinstance(label, bool) or label is None:
        return None
    if isinstance(label, int):
        return {"style": "arabic", "value": label} if label >= 1 else None
    s = clean(label)
    if re.fullmatch(r"\d{1,4}", s):
        return {"style": "arabic", "value": int(s)} if int(s) >= 1 else None
    r = roman_to_int(s)
    if r is not None and r <= MAX_ROMAN_PAGE:
        return {"style": "roman", "value": r}
    return None


def format_page_label(style, value):
    return int_to_roman(value) if style == "roman" else str(value)


def fy_label(text):
    """'FY26', 'FY 2025-26', 'Year ended March 31, 2026', 'As at 31 March 2026', '2025-26' -> 'FY26'; else None.
    finlib.periods reads the first two forms; balance-sheet dates ('As at ...') and bare '2025-26' are read here.
    A date that is not 31 March is not a financial-year end and returns None."""
    from finlib import periods
    t = clean(text)
    if not t:
        return None
    p = periods.normalise(t)
    if p:
        return p["period"] if p["kind"] == "year" else None
    m = re.fullmatch(r"(?:f\.?y\.? ?)?(20\d{2}) ?[-/] ?(?:20)?(\d{2})", t, re.I)
    if m and (int(m.group(1)) + 1) % 100 == int(m.group(2)):
        return f"FY{int(m.group(2)):02d}"
    if re.search(r"\bas (at|on|of)\b|\bended\b|\bbalance\b", t, re.I) or re.fullmatch(r"[\w ,./-]+", t):
        end = periods._end_date(t)
        if end and end[1] == 3:
            return f"FY{periods.fy_of(*end):02d}"
    return None


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def skill_copy_paths(ref_name):
    """Places a skill's copy of a reference can be: the repo layout, and the two places eve materialises skills."""
    skill = REFERENCE_COPIES[ref_name]
    rel = os.path.join(skill, "references", ref_name)
    roots = [os.path.normpath(os.path.join(HERE, "..", "..", "..", "skills"))]
    if os.environ.get("HOME"):
        roots.append(os.path.join(os.environ["HOME"], ".agents", "skills"))
    roots.append("/workspace/skills")
    return [os.path.join(r, rel) for r in roots]


def run_self_test(cases):
    """cases: [(name, callable)]. A callable passes by returning without raising. Prints JSON, exits 0 or 1."""
    failures = []
    for name, fn in cases:
        try:
            fn()
        except AssertionError as x:
            failures.append({"case": name, "problem": f"assertion failed: {x}"})
        except Exception as x:   # a crash in a self-test is a failure, never a pass
            failures.append({"case": name, "problem": f"{type(x).__name__}: {x}"})
    emit({"self_test": "ok" if not failures else "failed", "cases": len(cases), "failed": failures})
    if failures:
        print(f"{len(failures)} of {len(cases)} self-test cases failed", file=sys.stderr)
        sys.exit(EXIT_CHECK_FAILED)
    sys.exit(EXIT_OK)


def check_references():
    """-> (report, problems). Every reference parses, every regex compiles, skill copies match byte for byte."""
    report, problems = {"references": {}, "copies": []}, []
    for name in REFERENCE_COPIES:
        try:
            ref = load_reference(name)
        except Exception as x:
            problems.append(f"{name}: cannot load ({x})"); continue
        n = 0
        for entry in ref.get("sections", []) + ref.get("labels", []):
            for field in ("patterns", "patterns_unlabelled", "exclude"):
                for p in entry.get(field, []):
                    n += 1
                    try:
                        re.compile(p, re.I)
                    except re.error as x:
                        problems.append(f"{name}: {entry.get('key') or entry.get('normalised')}: bad regex {p!r} ({x})")
        loose = ref.get("protected_phrases", []) + ref.get("group_headers", []) + ref.get("contents_headers", [])
        loose += ref.get("restructured_patterns", []) + [x for v in ref.get("side_headers", {}).values() for x in v]
        for p in loose:
            n += 1
            try:
                re.compile(p, re.I)
            except re.error as x:
                problems.append(f"{name}: bad regex {p!r} ({x})")
        report["references"][name] = {"regexes": n}
        want = sha256_file(os.path.join(REF_DIR, name))
        for path in skill_copy_paths(name):
            if os.path.exists(path):
                same = sha256_file(path) == want
                report["copies"].append({"path": path, "identical": same})
                if not same:
                    problems.append(f"{path} differs from sandbox/workspace/references/{name}; copy the workspace file over it")
    return report, problems


def _cases():
    def roman():
        assert roman_to_int("iv") == 4 and roman_to_int("XIV") == 14 and roman_to_int("xl") == 40
        assert roman_to_int("iiii") is None and roman_to_int("mild") is None and roman_to_int("") is None
        assert roman_to_int("vx") is None and roman_to_int("12") is None
        assert all(roman_to_int(int_to_roman(n)) == n for n in range(1, 400))

    def labels():
        assert parse_page_label("45") == {"style": "arabic", "value": 45}
        assert parse_page_label(" 045 ") == {"style": "arabic", "value": 45}
        assert parse_page_label("xii") == {"style": "roman", "value": 12}
        assert parse_page_label("XII") == {"style": "roman", "value": 12}
        assert parse_page_label(7) == {"style": "arabic", "value": 7}
        for bad in ("cover", "", None, "0", "mix", "di", "A-12", "4.5", True, "12345"):
            assert parse_page_label(bad) is None, bad
        assert format_page_label("roman", 9) == "ix" and format_page_label("arabic", 9) == "9"

    def financial_years():
        for text, want in (("FY26", "FY26"), ("FY 2025-26", "FY26"), ("2025-26", "FY26"), ("As at March 31, 2026", "FY26"),
                           ("As at 31.03.2025", "FY25"), ("Year ended 31 March 2026", "FY26"), ("31 March 2026", "FY26"),
                           ("Q2 FY26", None), ("As at September 30, 2025", None), ("2025-27", None), ("Current year", None), ("", None)):
            assert fy_label(text) == want, (text, fy_label(text))

    def cleaning():
        assert clean("Board’s  Report – FY 2025–26") == "Board's Report - FY 2025-26"
        assert clean(None) == ""

    def references():
        report, problems = check_references()
        assert not problems, problems
        assert set(report["references"]) == set(REFERENCE_COPIES)

    def schemas():
        for name in ("section-map.schema.json", "annual-report-data-row.schema.json", "staging-table.schema.json"):
            s = load_schema(name)
            assert s.get("type") == "object" and s.get("required"), name

    return [("roman numerals", roman), ("financial year labels", financial_years), ("page labels", labels), ("text cleaning", cleaning),
            ("references load, regexes compile, skill copies identical", references), ("schemas load", schemas)]


def main():
    ap = argparse.ArgumentParser(description="Check the annual-report-format workspace references (regexes compile, "
                                             "skill copies identical). The other scripts import this module.")
    ap.add_argument("--self-test", action="store_true", help="run the built-in cases and exit 0 or 1")
    args = ap.parse_args()
    if args.self_test:
        run_self_test(_cases())
    report, problems = check_references()
    report["problems"] = problems
    emit(report)
    if problems:
        die("; ".join(problems), EXIT_CHECK_FAILED)


if __name__ == "__main__":
    main()
