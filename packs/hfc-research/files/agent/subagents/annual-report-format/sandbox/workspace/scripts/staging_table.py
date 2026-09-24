#!/usr/bin/env python3
"""Ind AS 109 staging table -> Stage 1 / 2 / 3 gross carrying amount, ECL allowance, net, coverage %, share of gross %.

Two shapes are accepted (file or - for stdin):

  rows are stages                                   columns are stages
  {"fy": "FY26", "basis": "standalone",             {"fy": "FY26", "basis": "standalone", "unit": "crore",
   "unit_header": "(Rs. in lakh)",                   "gross": {"Stage 1": "11,800.00", "Stage 2": "420.00",
   "rows": [                                                   "Stage 3": "180.00", "Total": "12,400.00"},
    {"label": "Stage 1", "gross": "11,80,000.00",    "ecl":   {"Stage 1": "35.40", "Stage 2": "29.40",
     "ecl": "3,540.00"},                                       "Stage 3": "72.00", "Total": "136.80"}}
    {"label": "Stage 2", ...}, {"label": "Stage 3", ...},
    {"label": "Total", ...}]}

Several rows may belong to one stage (housing / non-housing, or DPD buckets inside a stage): they are summed and the
source rows are listed. Restructured-book rows are left out and listed, per the analysts' rule. Purchased or
originated credit-impaired (POCI) assets are kept as their own line.
Coverage % = ECL allowance / gross carrying amount * 100, per stage and in total. Stage 3 coverage is the PCR.
The stage sums are footed against the printed total within --tolerance (in the filing's own unit, default 0.05 per
summed row). A table that does not foot exits 1: re-read the page before using it.
"""
import argparse, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ar_common as C

STAGE_PATTERNS = [
    ("stage_1", [r"\bstage[\s-]*(1|i)\b", r"\b12[\s-]*months? (ecl|expected credit loss)", r"^low credit risk", r"^high grade|^standard grade"]),
    ("stage_2", [r"\bstage[\s-]*(2|ii)\b", r"lifetime (ecl|expected credit loss).*not credit[\s-]*impaired", r"^significant increase in credit risk"]),
    ("stage_3", [r"\bstage[\s-]*(3|iii)\b", r"lifetime (ecl|expected credit loss).*(?<!not )credit[\s-]*impaired", r"^credit[\s-]*impaired", r"^non[\s-]*performing"]),
    ("poci", [r"\bpoci\b", r"purchased or originated credit[\s-]*impaired"]),
]
TOTAL_PATTERNS = [r"^(grand )?total\b", r"^gross carrying amount ?- ?total$"]
RESTRUCTURED = [r"restructur", r"resolution (framework|plan)", r"\botr\b"]


def classify(label):
    """-> stage_1 | stage_2 | stage_3 | poci | total | restructured | None (None = not recognised, never guessed)."""
    t = C.clean(label).lower()
    if any(re.search(p, t) for p in RESTRUCTURED):
        return "restructured"
    if any(re.search(p, t) for p in TOTAL_PATTERNS):
        return "total"
    hits = [k for k, pats in STAGE_PATTERNS if any(re.search(p, t) for p in pats)]
    if "stage_2" in hits and "stage_3" in hits and re.search(r"not credit[\s-]*impaired", t):
        hits.remove("stage_3")
    return hits[0] if len(hits) == 1 else None


def _rows_from_doc(doc):
    if "rows" in doc:
        return [(r.get("label"), r.get("gross"), r.get("ecl")) for r in doc["rows"]]
    gross, ecl = doc.get("gross") or {}, doc.get("ecl") or {}
    labels = list(gross) + [k for k in ecl if k not in gross]
    return [(l, gross.get(l), ecl.get(l)) for l in labels]


def compute(doc, tolerance=0.05):
    from finlib import numbers, units, schema
    problems = []
    fy = C.fy_label(doc.get("fy"))
    if not fy:
        problems.append(f"fy {doc.get('fy')!r} is not a financial year (FY26)")
    if doc.get("basis") not in ("standalone", "consolidated"):
        problems.append("basis must be 'standalone' or 'consolidated'")
    unit = doc.get("unit") or units.detect_unit(doc.get("unit_header") or "")
    if unit not in units.FACTOR_TO_CRORE:
        problems.append(f"unit not readable from header {doc.get('unit_header')!r}; give the unit line above the table or \"unit\"")
    rows = _rows_from_doc(doc)
    if not rows:
        problems.append("no rows: give \"rows\" or \"gross\" and \"ecl\"")
    if problems:
        return None, problems

    acc = {k: {"gross": [], "ecl": [], "rows": []} for k in ("stage_1", "stage_2", "stage_3", "poci", "total")}
    excluded, unrecognised, unparseable = [], [], []
    for label, g, e in rows:
        kind = classify(label)
        name = C.clean(label)
        if kind == "restructured":
            excluded.append(name); continue
        if kind is None:
            unrecognised.append(name); continue
        for field, raw in (("gross", g), ("ecl", e)):
            v = numbers.parse_number(raw)
            if v is None and not numbers.is_blank(raw):
                unparseable.append({"label": name, "field": field, "as_printed": raw}); continue
            if v is not None:
                acc[kind][field].append(abs(v) if field == "ecl" else v)      # allowances are often printed in brackets
        acc[kind]["rows"].append(name)

    def crore(v):
        return None if v is None else round(units.to_crore(v, unit), 6)

    def line(k, total_gross):
        g = sum(acc[k]["gross"]) if acc[k]["gross"] else None
        e = sum(acc[k]["ecl"]) if acc[k]["ecl"] else None
        return {"gross_carrying_amount": crore(g), "ecl_allowance": crore(e),
                "net_carrying_amount": crore(g - e) if g is not None and e is not None else None,
                "coverage_pct": round(e / g * 100, 4) if g and e is not None else None,
                "share_of_gross_pct": round(g / total_gross * 100, 4) if g is not None and total_gross else None,
                "source_rows": acc[k]["rows"]}, g, e

    staged = [k for k in ("stage_1", "stage_2", "stage_3", "poci") if acc[k]["rows"]]
    sums = {f: (sum(sum(acc[k][f]) for k in staged) if any(acc[k][f] for k in staged) else None) for f in ("gross", "ecl")}
    printed = {f: (sum(acc["total"][f]) if acc["total"][f] else None) for f in ("gross", "ecl")}
    base = printed["gross"] if printed["gross"] else sums["gross"]
    stages = {}
    for k in ("stage_1", "stage_2", "stage_3", "poci"):
        if k == "poci" and not acc[k]["rows"]:
            continue
        stages[k] = line(k, base)[0]
    if acc["total"]["rows"]:
        total = line("total", base)[0]
    else:
        g, e = sums["gross"], sums["ecl"]
        total = {"gross_carrying_amount": crore(g), "ecl_allowance": crore(e),
                 "net_carrying_amount": crore(g - e) if g is not None and e is not None else None,
                 "coverage_pct": round(e / g * 100, 4) if g and e is not None else None, "share_of_gross_pct": 100.0 if g else None,
                 "source_rows": []}
    n_rows = sum(len(acc[k]["rows"]) for k in staged) or 1
    tol = tolerance * n_rows
    footing = {}
    for f, name in (("gross", "gross_carrying_amount"), ("ecl", "ecl_allowance")):
        if printed[f] is None or sums[f] is None:
            footing[name] = {"checked": False, "foots": None, "sum_of_stages": crore(sums[f]), "printed_total": crore(printed[f]),
                             "difference": None, "tolerance": round(units.to_crore(tol, unit), 6)}
        else:
            diff = sums[f] - printed[f]
            footing[name] = {"checked": True, "foots": abs(diff) <= tol + 1e-9, "sum_of_stages": crore(sums[f]), "printed_total": crore(printed[f]),
                             "difference": crore(diff), "tolerance": round(units.to_crore(tol, unit), 6)}
    notes = []
    missing = [k for k in ("stage_1", "stage_2", "stage_3") if not acc[k]["rows"]]
    if missing:
        notes.append(f"no row recognised for {', '.join(missing)}; the table is incomplete or labelled differently (see unrecognised_rows)")
    if not acc["total"]["rows"]:
        notes.append("the table prints no total row, so the total is the sum of the stages and nothing was footed")
    if excluded:
        notes.append("restructured-book rows were left out per the analysts' rule; if the printed total includes them it will not foot, say so")
    if any(v["foots"] is False for v in footing.values()):
        status = "does_not_foot"
    elif missing or unparseable:
        status = "incomplete"
    else:
        status = "ok"
    return {schema.ROW_KEY: schema.row_entity(doc), "fy": fy, "basis": doc["basis"], "portfolio": doc.get("portfolio"),
            "filing_unit": unit, "unit": "crore", "stages": stages, "total": total, "footing": footing, "status": status,
            "excluded_restructured": excluded, "unrecognised_rows": unrecognised, "unparseable_values": unparseable,
            "printed_page": None if doc.get("printed_page") is None else str(doc.get("printed_page")), "pdf_page": doc.get("pdf_page"),
            "notes": notes}, []


def _cases():
    ROWS = {"primary_context_entity": "example-housing-finance", "fy": "FY26", "basis": "standalone", "unit_header": "(₹ in lakh)", "printed_page": "212", "pdf_page": 220,
            "rows": [{"label": "Stage 1", "gross": "11,80,000.00", "ecl": "3,540.00"}, {"label": "Stage 2", "gross": "42,000.00", "ecl": "2,940.00"},
                     {"label": "Stage 3", "gross": "18,000.00", "ecl": "7,200.00"}, {"label": "Total", "gross": "12,40,000.00", "ecl": "13,680.00"}]}

    def rows_are_stages():
        r, p = compute(ROWS)
        assert p == [] and r["status"] == "ok", (p, r)
        s = r["stages"]
        assert s["stage_1"]["gross_carrying_amount"] == 11800.0 and s["stage_1"]["coverage_pct"] == 0.3
        assert s["stage_2"]["coverage_pct"] == 7.0 and s["stage_3"]["coverage_pct"] == 40.0
        assert s["stage_3"]["net_carrying_amount"] == 108.0 and s["stage_3"]["share_of_gross_pct"] == 1.4516
        assert r["total"]["gross_carrying_amount"] == 12400.0 and r["total"]["coverage_pct"] == 1.1032
        assert r["footing"]["gross_carrying_amount"]["foots"] is True and r["footing"]["ecl_allowance"]["difference"] == 0.0

    def columns_are_stages_with_bracketed_ecl():
        r, p = compute({"fy": "As at March 31, 2026", "basis": "consolidated", "unit": "crore",
                        "gross": {"Stage I": "11,800.00", "Stage II": "420.00", "Stage III": "180.00", "Total": "12,400.00"},
                        "ecl": {"Stage I": "(35.40)", "Stage II": "(29.40)", "Stage III": "(72.00)", "Total": "(136.80)"}})
        assert p == [] and r["status"] == "ok" and r["fy"] == "FY26"
        assert r["stages"]["stage_3"]["ecl_allowance"] == 72.0 and r["stages"]["stage_3"]["coverage_pct"] == 40.0

    def several_rows_per_stage_and_wording():
        r, p = compute({"fy": "FY26", "basis": "standalone", "unit": "crore", "rows": [
            {"label": "Housing loans - Stage 1", "gross": "9,000.00", "ecl": "27.00"}, {"label": "Non-housing loans - Stage 1", "gross": "2,800.00", "ecl": "8.40"},
            {"label": "Lifetime ECL - not credit impaired", "gross": "420.00", "ecl": "29.40"}, {"label": "Lifetime ECL - credit impaired", "gross": "180.00", "ecl": "72.00"},
            {"label": "Purchased or originated credit impaired", "gross": "10.00", "ecl": "4.00"}, {"label": "Total", "gross": "12,410.00", "ecl": "140.80"}]})
        assert p == [] and r["status"] == "ok", r
        assert r["stages"]["stage_1"]["gross_carrying_amount"] == 11800.0 and len(r["stages"]["stage_1"]["source_rows"]) == 2
        assert r["stages"]["stage_2"]["gross_carrying_amount"] == 420.0 and r["stages"]["stage_3"]["gross_carrying_amount"] == 180.0
        assert r["stages"]["poci"]["coverage_pct"] == 40.0

    def does_not_foot():
        bad = dict(ROWS, rows=[dict(x) for x in ROWS["rows"]]); bad["rows"][1]["gross"] = "24,000.00"       # digits transposed
        r, _ = compute(bad)
        assert r["status"] == "does_not_foot" and r["footing"]["gross_carrying_amount"]["difference"] == -180.0
        assert r["footing"]["ecl_allowance"]["foots"] is True

    def rounding_within_tolerance():
        r, _ = compute({"fy": "FY26", "basis": "standalone", "unit": "crore", "rows": [
            {"label": "Stage 1", "gross": "100.04", "ecl": "0.30"}, {"label": "Stage 2", "gross": "10.03", "ecl": "0.70"},
            {"label": "Stage 3", "gross": "5.04", "ecl": "2.00"}, {"label": "Total", "gross": "115.10", "ecl": "3.00"}]})
        assert r["status"] == "ok" and r["footing"]["gross_carrying_amount"]["difference"] == 0.01

    def restructured_left_out_and_unknown_rows():
        r, _ = compute({"fy": "FY26", "basis": "standalone", "unit": "crore", "rows": [
            {"label": "Stage 1", "gross": "100.00", "ecl": "0.30"}, {"label": "Stage 2", "gross": "10.00", "ecl": "0.70"},
            {"label": "of which restructured under Resolution Framework 2.0", "gross": "4.00", "ecl": "0.40"},
            {"label": "Stage 3", "gross": "5.00", "ecl": "n/m"}, {"label": "Watch list", "gross": "1.00", "ecl": "0.10"}]})
        assert r["excluded_restructured"] == ["of which restructured under Resolution Framework 2.0"]
        assert r["unrecognised_rows"] == ["Watch list"] and r["unparseable_values"][0]["as_printed"] == "n/m"
        assert r["status"] == "incomplete" and r["footing"]["gross_carrying_amount"]["checked"] is False
        assert r["total"]["gross_carrying_amount"] == 115.0 and r["stages"]["stage_3"]["coverage_pct"] is None

    def missing_stage_and_bad_input():
        r, _ = compute({"fy": "FY26", "basis": "standalone", "unit": "crore", "rows": [{"label": "Stage 1", "gross": "1", "ecl": "0"}]})
        assert r["status"] == "incomplete" and "stage_2, stage_3" in r["notes"][0]
        r, p = compute({"fy": "Q2 FY26", "basis": "both", "unit_header": "Particulars", "rows": []})
        assert r is None and len(p) == 4, p
        assert classify("Stage 1 and Stage 2") is None and classify("Stage 2") == "stage_2" and classify("Stage-III") == "stage_3"

    def output_schema():
        from finlib import schema
        r, _ = compute(ROWS)
        assert schema.validate(r, C.load_schema("staging-table.schema.json")) == []
        # an input under the key's older name gives a table under the new key
        OLD = schema.LEGACY_ROW_KEYS[0]
        r, _ = compute({(OLD if k == schema.ROW_KEY else k): v for k, v in ROWS.items()})
        assert r[schema.ROW_KEY] == "example-housing-finance" and OLD not in r
        assert schema.validate(r, C.load_schema("staging-table.schema.json")) == []

    return [("rows are stages, lakhs", rows_are_stages), ("columns are stages, bracketed allowance", columns_are_stages_with_bracketed_ecl),
            ("several rows per stage, Ind AS wording, POCI", several_rows_per_stage_and_wording), ("a misread digit does not foot", does_not_foot),
            ("rounding stays within tolerance", rounding_within_tolerance), ("restructured rows left out; unknown rows listed", restructured_left_out_and_unknown_rows),
            ("missing stages and bad input", missing_stage_and_bad_input), ("output validates against staging-table.schema.json", output_schema)]


def main():
    ap = argparse.ArgumentParser(description="Ind AS 109 staging table -> stage-wise gross, ECL, coverage %, with the totals footed.",
                                 epilog="Example: staging_table.py /workspace/out/staging.rows.json --tolerance 0.05")
    ap.add_argument("table", nargs="?", help="JSON file (see the docstring for the two shapes), or - for stdin")
    ap.add_argument("--tolerance", type=float, default=0.05, help="allowed rounding difference per summed row, in the filing's unit (default 0.05)")
    ap.add_argument("--self-test", action="store_true", help="run the built-in cases and exit 0 or 1")
    args = ap.parse_args()
    if args.self_test:
        C.run_self_test(_cases())
    if not args.table:
        C.die("give the table JSON file, or - for stdin")
    doc = C.read_json_arg(args.table)
    if not isinstance(doc, dict):
        C.die("input must be a JSON object")
    result, problems = compute(doc, args.tolerance)
    if result is None:
        C.die("; ".join(problems))
    C.emit(result)
    if result["status"] == "does_not_foot":
        C.die("the stage rows do not add up to the printed total: re-read the page (a misread digit, a missed row, or a total that "
              "includes restructured or POCI rows) before using these figures", C.EXIT_CHECK_FAILED)


if __name__ == "__main__":
    main()
