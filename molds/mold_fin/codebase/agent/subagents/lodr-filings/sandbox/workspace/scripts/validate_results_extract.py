#!/usr/bin/env python3
"""Validate a results extract BEFORE it is written to the data room or handed to hfc-kpi-extraction.

    python3 /workspace/scripts/validate_results_extract.py /workspace/out/extract.json

Schema (schemas/results-extract.schema.json) plus the rules a schema cannot express:
- unit: every amount is in Rs crore and was really converted: raw x factor(unit_reported) must equal value
  (per-share rows and ratios are not converted)
- basis: labelled; a consolidated extract from a filing that has both needs a basis_note saying why, because the
  analysts use standalone when both exist
- periods: every column period parses, its kind agrees, discrete_quarter is true exactly for kind = quarter, the
  discrete_quarter role carries the filing period, there is at most one, and discrete_quarter_status says whether
  one exists. A cumulative column can never be flagged as the quarter.
- page: every line item and every disclosed value cites a page
- items: every item is in the synonym table; duplicates must be resolved before hand-over
- footing, per column, within tolerance (reference/results_line_synonyms.json "footing"):
    total income = revenue from operations + other income            (error)
    total income - total expenses = profit before exceptional items / profit before tax   (error)
    profit before tax - total tax = profit after tax                 (error)
    sum of expense components = total expenses                       (warning: a component may be unmatched)
- disclosures: percentages within 0-100 (CRAR above 100 is a warning), status ok has value and page, status nil
  has value 0 or null, amounts in crore checked against raw when unit_reported is given
- exclusion: nothing about the restructured book, anywhere
- required for a P&L: total_income, total_expenses, profit_before_tax, profit_after_tax present or listed in not_found
Exit 0 when valid, 1 when not. JSON report on stdout.
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, json, re
from finlib import numbers, units, periods, schema

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_PATH = os.path.join(HERE, "..", "schemas", "results-extract.schema.json")
SYN_PATH = os.path.join(HERE, "reference", "results_line_synonyms.json")
CORE = ["total_income", "total_expenses", "profit_before_tax", "profit_after_tax"]
PCT_OVER_100_OK = {"crar_pct", "tier1_pct", "liquidity_coverage_ratio_pct", "loans_transferred_security_coverage_pct",
                   "loans_acquired_security_coverage_pct", "pcr_pct"}


def _close(a, b, abs_tol, rel_pct):
    return abs(a - b) <= max(abs_tol, abs(b) * rel_pct / 100.0)


def validate(doc):
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        sch = json.load(f)
    with open(SYN_PATH, encoding="utf-8") as f:
        syn = json.load(f)
    errors, warnings = list(schema.validate(doc, sch)), []
    if errors and not isinstance(doc, dict):
        return {"valid": False, "errors": errors, "warnings": warnings}
    known = {e["item"]: e for e in syn["items"]}
    foot = syn["footing"]; abs_tol, rel = foot["abs_tolerance_crore"], foot["rel_tolerance_pct"]
    unit_rep = doc.get("unit_reported")
    # basis
    if doc.get("basis") == "consolidated" and doc.get("bases_in_filing") == "both" and not doc.get("basis_note"):
        errors.append("basis is consolidated although the filing gives both; the analysts use standalone. Extract standalone, or add basis_note saying why this extract is consolidated")
    if doc.get("bases_in_filing") == "single_unlabelled" and not doc.get("basis_note"):
        errors.append("bases_in_filing is single_unlabelled: add basis_note saying the statement names neither standalone nor consolidated and how the basis was established")
    # periods and columns
    fp = periods.normalise(doc.get("filing_period") or "")
    if not fp or fp["kind"] != "quarter":
        errors.append(f"filing_period {doc.get('filing_period')!r} is not a quarter")
    cols = [c for c in doc.get("columns") or [] if isinstance(c, dict)]
    col_periods, dq_cols = set(), []
    for c in cols:
        p = periods.normalise(c.get("period") or "")
        where = f"columns[index {c.get('index')}]"
        if not p:
            errors.append(f"{where}: period {c.get('period')!r} does not parse"); continue
        kind = c.get("kind")
        if p["kind"] != kind and not (kind == "cumulative" and p["kind"] == "quarter" and p["quarter"] == 1):
            errors.append(f"{where}: period {c['period']} is a {p['kind']} but kind says {kind}")
        if c.get("discrete_quarter") != (kind == "quarter"):
            errors.append(f"{where}: discrete_quarter must be {kind == 'quarter'} for kind {kind}; a cumulative or full-year column is never the quarter")
        if c.get("role") == "discrete_quarter":
            dq_cols.append(c)
            if kind != "quarter" or (fp and p["period"] != fp["period"]):
                errors.append(f"{where}: role discrete_quarter but the column is {c['period']} ({kind}); the filing period is {doc.get('filing_period')}")
        if c["period"] in col_periods:
            errors.append(f"{where}: period {c['period']} appears in two columns; keep one (say which in basis_note if restated)")
        col_periods.add(c["period"])
    if len(dq_cols) > 1:
        errors.append("more than one column has role discrete_quarter")
    want_status = "present" if dq_cols else "absent"
    if doc.get("discrete_quarter_status") != want_status:
        errors.append(f"discrete_quarter_status is {doc.get('discrete_quarter_status')!r} but the columns say {want_status!r}")
    if not dq_cols:
        warnings.append("no discrete-quarter column: the KPI subagent will have to derive the quarter from cumulative figures and footnote it")
    # line items
    values, seen = {}, set()
    for i, it in enumerate(doc.get("line_items") or []):
        if not isinstance(it, dict): continue
        name, where = it.get("item"), f"line_items[{i}] {it.get('item')}"
        if name not in known:
            errors.append(f"{where}: not an item of the synonym table")
        if it.get("duplicate") or name in seen:
            errors.append(f"{where}: item appears more than once; decide which row is the item (or report both to the analyst) before hand-over")
        seen.add(name)
        if re.search(syn["excluded_label_regex"], it.get("label_reported") or "", re.I):
            errors.append(f"{where}: restructured-book details are excluded by the rulebook")
        per_share = bool(it.get("per_share") or (known.get(name) or {}).get("per_share"))
        for v in it.get("values") or []:
            if not isinstance(v, dict): continue
            vw = f"{where} {v.get('period')}"
            if v.get("period") not in col_periods:
                errors.append(f"{vw}: period is not one of the columns")
            if v.get("status") == "ok":
                if v.get("value") is None:
                    errors.append(f"{vw}: status ok without a value"); continue
                raw = numbers.parse_number(v.get("raw"))
                if raw is None:
                    errors.append(f"{vw}: raw {v.get('raw')!r} does not parse, so the conversion cannot be checked")
                elif unit_rep in units.FACTOR_TO_CRORE:
                    expect = raw if per_share else units.to_crore(raw, unit_rep)
                    if not _close(v["value"], expect, 1e-6, 0.0001):
                        errors.append(f"{vw}: value {v['value']} is not raw {v['raw']} converted from {unit_rep} to crore ({expect:g})")
                values.setdefault(v.get("period"), {})[name] = v["value"]
            elif v.get("value") is not None:
                errors.append(f"{vw}: status {v.get('status')} must have value null")
    for c in CORE:
        if c not in seen and c not in (doc.get("not_found") or []):
            errors.append(f"{c} is neither in line_items nor listed in not_found")
    for nf in doc.get("not_found") or []:
        if nf in seen:
            errors.append(f"not_found lists {nf}, which is also in line_items")
    # footing
    checks = []
    for per, v in values.items():
        def ident(label, lhs, rhs, level):
            ok = _close(lhs, rhs, abs_tol, rel)
            checks.append({"period": per, "check": label, "computed": round(lhs, 4), "reported": round(rhs, 4), "ok": ok})
            if not ok:
                (errors if level == "error" else warnings).append(f"footing {per}: {label}: computed {lhs:.4f} vs reported {rhs:.4f} crore")
        if all(k in v for k in ("total_revenue_from_operations", "other_income", "total_income")):
            ident("revenue from operations + other income = total income", v["total_revenue_from_operations"] + v["other_income"], v["total_income"], "error")
        if "total_income" in v and "total_expenses" in v:
            target = "profit_before_exceptional_items_and_tax" if "profit_before_exceptional_items_and_tax" in v else "profit_before_tax"
            if target in v and not (target == "profit_before_tax" and (v.get("exceptional_items") or v.get("share_of_profit_of_associates"))):
                ident(f"total income - total expenses = {target}", v["total_income"] - v["total_expenses"], v[target], "error")
        if all(k in v for k in ("profit_before_tax", "total_tax_expense", "profit_after_tax")):
            ident("profit before tax - total tax = profit after tax", v["profit_before_tax"] - v["total_tax_expense"], v["profit_after_tax"], "error")
        comps = [v[k] for k in foot["expense_components"] if k in v]
        if "total_expenses" in v and len(comps) >= 3:
            ident("sum of expense components = total expenses", sum(comps), v["total_expenses"], "warning")
    # disclosures
    for i, d in enumerate(doc.get("disclosures") or []):
        if not isinstance(d, dict): continue
        where = f"disclosures[{i}] {d.get('key')} {d.get('period')}"
        if re.search(syn["excluded_label_regex"], f"{d.get('label_reported')} {d.get('note') or ''}", re.I):
            errors.append(f"{where}: restructured-book details are excluded by the rulebook")
        p = periods.normalise(d.get("period") or "")
        if not p:
            errors.append(f"{where}: period does not parse")
        elif d.get("period_kind") == "quarter" and p["kind"] != "quarter":
            errors.append(f"{where}: period_kind quarter but period is {p['kind']}; a year-to-date figure must say ytd")
        elif d.get("period_kind") == "ytd" and p["kind"] == "quarter" and p["quarter"] != 1:
            errors.append(f"{where}: period_kind ytd needs a cumulative period label (H1 / 9M / FY), not {d['period']}")
        st, val = d.get("status"), d.get("value")
        if st == "nil" and val not in (0, 0.0, None):
            errors.append(f"{where}: status nil with a non-zero value")
        if st in ("not_disclosed", "unparseable") and val is not None:
            errors.append(f"{where}: status {st} must have value null")
        if st == "ok" and isinstance(val, (int, float)):
            if d.get("unit") == "percent" and not 0 <= val <= 100:
                (warnings if d.get("key") in PCT_OVER_100_OK and val > 100 else errors).append(f"{where}: {val}% is outside 0-100")
            if d.get("unit") == "crore":
                ur, raw = d.get("unit_reported"), numbers.parse_number(d.get("raw"))
                if not ur or raw is None:
                    errors.append(f"{where}: an amount needs raw and unit_reported so the conversion to crore can be checked")
                elif not _close(val, units.to_crore(raw, ur), 1e-6, 0.0001):
                    errors.append(f"{where}: value {val} is not raw {d['raw']} converted from {ur} ({units.to_crore(raw, ur):g})")
            if d.get("key", "").endswith("_pct") and d.get("unit") != "percent":
                errors.append(f"{where}: a _pct key must have unit percent")
    return {"valid": not errors, "errors": errors, "warnings": warnings, "footing_checks": checks}


def _self_test():
    import copy, extract_results_lines as erl
    n = 0
    out = erl.extract(erl._example_doc())
    base = out["extract"]
    base["disclosures"] = [
        {"key": "gross_stage3", "label_reported": "Gross Stage 3 loans", "period": "Q2 FY26", "period_kind": "as_at", "value": 450.0, "unit": "crore",
         "raw": "45,000.00", "unit_reported": "lakh", "status": "ok", "page": 7},
        {"key": "gnpa_pct", "label_reported": "Gross NPA (%)", "period": "Q2 FY26", "period_kind": "as_at", "value": 1.10, "unit": "percent", "raw": "1.10%", "status": "ok", "page": 11},
        {"key": "loans_transferred_amount", "label_reported": "Aggregate amount of loans transferred through assignment", "period": "H1 FY26", "period_kind": "ytd",
         "value": 620.0, "unit": "crore", "raw": "620.00", "unit_reported": "crore", "status": "ok", "page": 8},
        {"key": "loans_acquired_amount", "label_reported": "Loans acquired", "period": "H1 FY26", "period_kind": "ytd", "value": None, "unit": "crore", "raw": "Nil", "status": "nil", "page": 8},
        {"key": "crar_pct", "label_reported": "CRAR", "period": "Q2 FY26", "period_kind": "as_at", "value": None, "unit": "percent", "raw": None, "status": "not_disclosed", "page": None}]
    r = validate(base); assert r["valid"], r["errors"]; n += 1
    assert len([c for c in r["footing_checks"] if c["ok"]]) == len(r["footing_checks"]) == 24; n += 1     # 4 identities x 6 columns

    def bad(mutate, expect, level="errors"):
        d = copy.deepcopy(base); mutate(d); r = validate(d)
        assert any(expect in x for x in r[level]), (expect, r[level][:4]); assert level == "warnings" or not r["valid"]; return 1
    li = lambda d, item: next(i for i in d["line_items"] if i["item"] == item)
    n += bad(lambda d: li(d, "interest_income")["values"][0].update(value=52340.10), "is not raw 52,340.10 converted from lakh")     # forgot to convert
    n += bad(lambda d: d.update(unit="lakh"), "must be 'crore'")
    n += bad(lambda d: d["columns"][3].update(discrete_quarter=True), "a cumulative or full-year column is never the quarter")
    n += bad(lambda d: d["columns"][3].update(role="discrete_quarter"), "role discrete_quarter but the column is H1 FY26")
    n += bad(lambda d: d["columns"][0].update(role="other_period"), "discrete_quarter_status is 'present'")
    n += bad(lambda d: d["columns"][3].update(kind="quarter", discrete_quarter=True), "is a cumulative but kind says quarter")
    n += bad(lambda d: li(d, "profit_after_tax").pop("page"), "missing required 'page'")
    n += bad(lambda d: li(d, "total_income")["values"][0].update(value=580.0, raw="58,000.00"), "footing Q2 FY26: revenue from operations + other income")
    n += bad(lambda d: li(d, "profit_after_tax")["values"][0].update(value=140.0, raw="14,000.00"), "profit before tax - total tax")
    n += bad(lambda d: li(d, "other_expenses")["values"][0].update(value=20.0, raw="2,000.00"), "sum of expense components", level="warnings")
    n += bad(lambda d: d.update(basis="consolidated"), "the analysts use standalone")
    n += bad(lambda d: d.update(bases_in_filing="single_unlabelled"), "add basis_note")
    n += bad(lambda d: li(d, "total_income").update(item="revenue_total"), "not an item of the synonym table")
    n += bad(lambda d: d["line_items"].append(copy.deepcopy(li(d, "total_income"))), "appears more than once")
    n += bad(lambda d: d["line_items"].remove(li(d, "total_expenses")), "total_expenses is neither in line_items nor listed in not_found")
    n += bad(lambda d: li(d, "total_comprehensive_income")["values"][5].update(value=1.0), "status unparseable must have value null")
    n += bad(lambda d: d["disclosures"][1].update(value=110.0), "110.0% is outside 0-100")
    n += bad(lambda d: d["disclosures"][0].update(value=45000.0), "is not raw 45,000.00 converted from lakh")
    n += bad(lambda d: d["disclosures"][2].update(period="Q2 FY26"), "period_kind ytd needs a cumulative period label")
    n += bad(lambda d: d["disclosures"][2].update(period_kind="quarter"), "a year-to-date figure must say ytd")
    n += bad(lambda d: d["disclosures"][3].update(value=5.0), "status nil with a non-zero value")
    n += bad(lambda d: d["disclosures"][1].update(page=None), "expected integer")
    n += bad(lambda d: d["disclosures"].append({"key": "gross_stage3", "label_reported": "Restructured accounts in Stage 3", "period": "Q2 FY26", "period_kind": "as_at",
                                                "value": None, "unit": "crore", "status": "not_disclosed", "page": None}), "restructured-book details are excluded")
    n += bad(lambda d: d["disclosures"][4].update(value=130.0, status="ok", page=11, raw="130%"), "outside 0-100", level="warnings")
    # rounding inside tolerance passes: lakh figures that sum 0.01 crore off
    d = copy.deepcopy(base); li(d, "total_income")["values"][0].update(value=561.01, raw="56,101.00"); r = validate(d)
    assert not any("revenue from operations + other income" in x for x in r["errors"]); n += 1
    # an extract with no discrete quarter is valid when it says so
    d = copy.deepcopy(base); d["columns"] = [c for c in d["columns"] if c["kind"] != "quarter"]; d["discrete_quarter_status"] = "absent"
    for it in d["line_items"]: it["values"] = [v for v in it["values"] if v["period"] in ("H1 FY26", "H1 FY25", "FY25")]
    r = validate(d); assert r["valid"] and any("derive the quarter" in w for w in r["warnings"]), r["errors"]; n += 1
    assert not validate([])["valid"]; n += 1
    return n


def main():
    ap = argparse.ArgumentParser(description="Validate a results extract (schema, unit conversion, basis, discrete-quarter flags, footing, pages, exclusions).")
    ap.add_argument("file", nargs="?"); ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        try:
            n = _self_test()
        except AssertionError as x:
            print(f"FAIL validate_results_extract: {x}", file=sys.stderr); return 1
        print(json.dumps({"self_test": "ok", "script": "validate_results_extract", "cases": n})); return 0
    if not a.file or not os.path.isfile(a.file):
        print(f"no such file: {a.file}", file=sys.stderr); return 2
    try:
        with open(a.file, encoding="utf-8") as f:
            doc = json.load(f)
    except ValueError as x:
        print(f"{a.file} is not JSON: {x}", file=sys.stderr); return 2
    if isinstance(doc, dict) and "extract" in doc and "line_items" not in doc:
        doc = doc["extract"]      # the raw output of extract_results_lines.py
    rep = validate(doc); rep["file"] = a.file
    print(json.dumps(rep, ensure_ascii=False))
    if not rep["valid"]:
        print(f"results extract INVALID: {len(rep['errors'])} problem(s); do not write or hand it over", file=sys.stderr); return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
