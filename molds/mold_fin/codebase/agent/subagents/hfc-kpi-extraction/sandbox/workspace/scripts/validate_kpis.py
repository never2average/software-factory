#!/usr/bin/env python3
"""Validate KPI rows BEFORE anything is written to the data room or published.

  python3 /workspace/scripts/validate_kpis.py /workspace/out/kpis.jsonl
  python3 /workspace/scripts/validate_kpis.py /workspace/out/kpis.jsonl --expect-complete --existing /workspace/in/kpis.jsonl
  python3 /workspace/scripts/validate_kpis.py --self-test

ERRORS (exit 1; the batch must not be appended or published)
  E-SCHEMA      row does not match schemas/kpi-row.schema.json (includes: ok / needs_review / carried_forward rows need value,
                document and page_or_slide; carried_forward and needs_review rows need a footnote; carried_forward needs value_period;
                consolidated basis needs a footnote; a chart reading must be needs_review; not_found rows have value null)
  E-CATALOG     category or unit is not the one kpi_catalog gives for that KPI (amounts are Rs crore)
  E-PERIOD      period is not a canonical quarter per finlib.periods ('Q2 FY26'); value_period unreadable
  E-CARRY       carried_forward row whose value_period is not earlier than its period, or whose footnote does not name that period
  E-COUNT       branches / employees not a non-negative whole number
  E-BOUNDS      impossible value: negative amount where none can be, percentage outside its hard bounds
  E-NNPA        NNPA % greater than GNPA % for the same company and quarter
  E-LOANBOOK    Loan Book greater than AUM by more than --loan-book-tolerance-pct (default 1%)
  E-SELLDOWN    AUM equals Loan Book (2 dp) but a Sell Down Volume is reported
  E-RESTRUCT    restructured-book content in kpi / label / definition (the rulebook excludes it)
  E-SOURCE      computed KPI not marked source 'computed', or a disclosed KPI marked 'computed' (spread_pct may be either)
  E-ARITH       a computed row whose value does not follow from the rows it is computed from (spread, disbursement per branch / employee)
  E-DUP         the same (customer_id, period, kpi) twice with the same extracted_at
FLAGS (exit 0; reported to the analyst, never silently dropped)
  F-RANGE       a percentage outside its usual range (e.g. GNPA % > 25), or a percentage that looks like a fraction (0.0182 for 1.82%)
  F-DUP         the same (customer_id, period, kpi) with different extracted_at: a re-extraction; the workbook uses the latest
  F-FOOTNOTE    not_found without a footnote saying where it was looked for; restructuring mentioned in a footnote
  F-MISSING     with --expect-complete: a catalog KPI has no row for a company and quarter
  F-DERIVED     derived_from_cumulative on a KPI that is not a flow
  F-BASIS       standalone and consolidated rows mixed for one company and quarter (each consolidated row is footnoted, by schema)
  F-CARRY       branches / employees carried forward from something other than the previous quarter's investor presentation
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, json, tempfile
from finlib import periods, schema
import kpi_catalog as cat

SCHEMA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "schemas", "kpi-row.schema.json")

# key: (hard_min, hard_max, usual_min, usual_max). Hard bounds reject; usual bounds flag.
BOUNDS = {
    "gnpa_pct": (0, 100, 0, 25), "nnpa_pct": (0, 100, 0, 15), "pcr_stage3_pct": (0, 100, 5, 90),
    "yield_pct": (0, 100, 6, 30), "cost_of_funds_pct": (0, 100, 4, 16), "spread_pct": (-50, 100, 0, 15), "nim_pct": (-50, 100, 1, 20),
    "crar_pct": (-100, 1000, 12, 100), "debt_equity": (0, 1000, 0.2, 15), "cost_to_income_pct": (0, 100000, 5, 150),
    "opex_to_loan_book_pct": (0, 100000, 0.05, 5), "opex_to_aum_pct": (0, 100000, 0.05, 5), "roa_pct": (-1000, 1000, -5, 10), "roe_pct": (-100000, 100000, -30, 40),
}
_FRACTION_SUSPECTS = {"gnpa_pct": 0.05, "nnpa_pct": 0.02, "yield_pct": 0.5, "cost_of_funds_pct": 0.5, "nim_pct": 0.2, "crar_pct": 1.0, "pcr_stage3_pct": 1.0}


def _pkey(p):
    n = periods.normalise(p)
    return None if n is None else n["fy"] * 10 + n["quarter"]   # FY26 Q2 -> 262; cumulative/year use their closing quarter


def validate_rows(rows, problems=None, loan_book_tol_pct=1.0, expect_complete=False, existing=None):
    """rows: [(line_no, obj)] -> report dict"""
    with open(SCHEMA, encoding="utf-8") as f: sch = json.load(f)
    errors = [{"code": "E-SCHEMA", "line": None, "message": p} for p in (problems or [])]
    flags = []
    E = lambda code, n, msg: errors.append({"code": code, "line": n, "message": msg})
    F = lambda code, n, msg: flags.append({"code": code, "line": n, "message": msg})
    good = []
    for n, o in rows:
        sp = schema.validate(o, sch)
        for p in sp: E("E-SCHEMA", n, p)
        if any(("kpi" in p and "not one of" in p) or "missing required" in p or "expected" in p for p in sp): continue
        e = cat.BY_KEY.get(o.get("kpi"))
        if e is None: continue
        who = f"{o.get('customer_id')} {o.get('period')} {o['kpi']}"
        if o.get("category") != e["category"]: E("E-CATALOG", n, f"{who}: category {o.get('category')!r}, catalog says {e['category']!r}")
        if o.get("unit") != e["unit"]:
            E("E-CATALOG", n, f"{who}: unit {o.get('unit')!r}, catalog says {e['unit']!r}" + (" (every amount is reported in ₹ crore; convert with convert_units.py)" if e["unit"] == cat.UNIT_CRORE else ""))
        p = periods.normalise(o.get("period"))
        if p is None or p["kind"] != "quarter" or p["period"] != o.get("period"):
            E("E-PERIOD", n, f"{who}: period {o.get('period')!r} is not a canonical quarter" + (f" (write {p['period']!r})" if p and p["kind"] == "quarter" else ""))
        if "value_period" in o:
            vp = periods.normalise(o["value_period"])
            if vp is None or vp["period"] != o["value_period"]: E("E-PERIOD", n, f"{who}: value_period {o['value_period']!r} cannot be read by finlib.periods")
            elif o.get("status") == "carried_forward" and p is not None:
                if _pkey(o["value_period"]) >= _pkey(o["period"]): E("E-CARRY", n, f"{who}: carried_forward from {o['value_period']}, which is not earlier than {o['period']}")
                if o["value_period"] not in o.get("footnote", ""): E("E-CARRY", n, f"{who}: the footnote must state the period the value belongs to ({o['value_period']})")
                if o["kpi"] in ("branches", "employees") and p["kind"] == "quarter" and o["value_period"] != periods.previous_quarter(o["period"]):
                    F("F-CARRY", n, f"{who}: carried forward from {o['value_period']}, not the previous quarter ({periods.previous_quarter(o['period'])}); the rulebook names the previous quarter's IP")
                if o["kpi"] in ("branches", "employees") and o.get("source") not in ("IP", "parent IP"):
                    F("F-CARRY", n, f"{who}: carried-forward branches/employees should cite the previous quarter's investor presentation (source IP)")
        for fld in ("kpi", "label", "definition"):
            if cat.is_restructured(o.get(fld)): E("E-RESTRUCT", n, f"{who}: {fld} {o.get(fld)!r} is restructured-book content, which the rulebook excludes")
        if cat.is_restructured(o.get("footnote")): F("F-FOOTNOTE", n, f"{who}: the footnote mentions restructuring; the rulebook excludes restructured-book details from the report")
        src_computed = o.get("source") == "computed"
        if e["source_pref"] == "computed" and not src_computed:
            E("E-SOURCE", n, f"{who}: this KPI is always computed with the workspace formula ({e['formula']}); the company's own figure goes in the footnote / company_published")
        if e["source_pref"] != "computed" and src_computed and o["kpi"] != "spread_pct":
            E("E-SOURCE", n, f"{who}: this KPI is taken as disclosed, never computed")
        if o.get("derived_from_cumulative") and e["kind"] != "flow":
            F("F-DERIVED", n, f"{who}: derived_from_cumulative on a {e['kind']}; only flows are derived by subtraction")
        if o.get("status") == "not_found" and len(o.get("footnote", "")) < 8:
            F("F-FOOTNOTE", n, f"{who}: not_found without a footnote saying where it was looked for")
        v = o.get("value")
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            if e["unit"] == cat.UNIT_COUNT and (v < 0 or v != int(v)): E("E-COUNT", n, f"{who}: {v} is not a non-negative whole number")
            if e["unit"] == cat.UNIT_CRORE and v < 0: E("E-BOUNDS", n, f"{who}: negative amount {v}")
            if o["kpi"] in BOUNDS:
                lo, hi, ulo, uhi = BOUNDS[o["kpi"]]
                if v < lo or v > hi: E("E-BOUNDS", n, f"{who}: {v} is outside the possible range [{lo}, {hi}]")
                elif o["kpi"] in _FRACTION_SUSPECTS and 0 < v < _FRACTION_SUSPECTS[o["kpi"]]:
                    F("F-RANGE", n, f"{who}: {v} looks like a fraction rather than a percentage (write 1.82, not 0.0182); confirm against the filing")
                elif v < ulo or v > uhi: F("F-RANGE", n, f"{who}: {v}{e['unit'] if e['unit'] != cat.UNIT_CRORE else ''} is outside the usual range [{ulo}, {uhi}]; confirm against the filing")
        good.append((n, o))

    # duplicates, then keep the latest per cell for the cross-row rules
    cells = {}
    for n, o in good:
        key = (o["customer_id"], o["period"], o["kpi"])
        if key in cells:
            pn, po = cells[key]
            if po["extracted_at"] == o["extracted_at"]: E("E-DUP", n, f"{' '.join(key)}: duplicate of line {pn} with the same extracted_at")
            else: F("F-DUP", n, f"{' '.join(key)}: also on line {pn} with a different extracted_at (re-extraction); the workbook uses the latest")
            if o["extracted_at"] < po["extracted_at"]: continue
        cells[key] = (n, o)
    if existing:
        seen = {(o.get("customer_id"), o.get("period"), o.get("kpi")) for _, o in existing}
        for key, (n, _) in cells.items():
            if key in seen: F("F-DUP", n, f"{' '.join(key)}: already present in the data room's kpis.jsonl; appending supersedes it (the workbook uses the latest extracted_at)")

    groups = {}
    for (cid, per, kpi), (n, o) in cells.items(): groups.setdefault((cid, per), {})[kpi] = (n, o)
    val = lambda g, k: g[k][1]["value"] if k in g and isinstance(g[k][1].get("value"), (int, float)) else None
    for (cid, per), g in sorted(groups.items()):
        who = f"{cid} {per}"
        gn, nn = val(g, "gnpa_pct"), val(g, "nnpa_pct")
        if gn is not None and nn is not None and nn > gn: E("E-NNPA", g["nnpa_pct"][0], f"{who}: NNPA {nn}% is greater than GNPA {gn}%")
        aum, lb = val(g, "aum"), val(g, "loan_book")
        same_asof = aum is not None and lb is not None and g["aum"][1].get("value_period") == g["loan_book"][1].get("value_period")
        if same_asof and lb > aum * (1 + loan_book_tol_pct / 100.0):
            E("E-LOANBOOK", g["loan_book"][0], f"{who}: Loan Book {lb} is greater than AUM {aum} by more than {loan_book_tol_pct:g}%; AUM includes the on-book loans, so check basis, unit and date")
        sd = val(g, "sell_down_volume")
        if same_asof and sd is not None and sd > 0 and round(aum, 2) == round(lb, 2):
            E("E-SELLDOWN", g["sell_down_volume"][0], f"{who}: AUM equals the Loan Book ({aum}), so by the rulebook there is no sell down volume, but {sd} is reported")
        y, c, s = val(g, "yield_pct"), val(g, "cost_of_funds_pct"), val(g, "spread_pct")
        if s is not None and g["spread_pct"][1].get("source") == "computed":
            if y is None or c is None: E("E-ARITH", g["spread_pct"][0], f"{who}: computed spread without both yield and cost of funds rows")
            elif abs((y - c) - s) > 0.011: E("E-ARITH", g["spread_pct"][0], f"{who}: computed spread {s} is not yield {y} − cost of funds {c} = {round(y - c, 2)}")
        d = val(g, "disbursements")
        for key, denom in (("disbursement_per_branch", "branches"), ("disbursement_per_employee", "employees")):
            got, dv = val(g, key), val(g, denom)
            if got is not None and d is not None and dv:
                if abs(d / dv - got) > 0.00006 + abs(got) * 1e-4: E("E-ARITH", g[key][0], f"{who}: {key} {got} is not disbursements {d} ÷ {denom} {dv} = {round(d / dv, 4)}")
        bases = {o["basis"] for _, o in g.values() if o.get("status") != "not_found"}
        if len(bases) > 1:
            F("F-BASIS", None, f"{who}: standalone and consolidated rows are mixed; every consolidated row must be footnoted (schema enforces) and the summary must say so")
        if expect_complete:
            missing = [k for k in cat.KEYS if k not in g]
            if missing: F("F-MISSING", None, f"{who}: no row for {', '.join(missing)} (a KPI that was looked for and not found still gets a not_found row)")
    by_status = {}
    for _, o in good: by_status[o.get("status")] = by_status.get(o.get("status"), 0) + 1
    return {"valid": not errors, "rows": len(rows), "companies": sorted({c for c, _ in groups}), "periods": sorted({p for _, p in groups}, key=_pkey),
            "by_status": by_status, "errors": errors, "flags": flags,
            "review_cells": [{"customer_id": o["customer_id"], "period": o["period"], "kpi": o["kpi"], "status": o["status"], "footnote": o.get("footnote", "")}
                             for _, o in sorted(cells.values(), key=lambda x: x[0]) if o.get("status") in ("needs_review", "carried_forward")]}


def _self_test():
    fails = []
    DOC_QR, DOC_IP = "Customers/example-hfl/filings/lodr/q2fy26-results.pdf", "Customers/example-hfl/filings/presentations/q2fy26-ip.pdf"
    def row(kpi, value, **kw):
        e = cat.BY_KEY[kpi]
        r = {"customer_id": "example-hfl", "extracted_at": "2026-09-18T10:00:00Z", "kpi": kpi, "category": e["category"], "value": value, "unit": e["unit"],
             "period": "Q2 FY26", "basis": "standalone", "source": "computed" if e["source_pref"] == "computed" else e["source_pref"],
             "document": DOC_IP if e["source_pref"] == "IP" else DOC_QR, "page_or_slide": 4, "status": "ok", "footnote": ""}
        r.update(kw); return r
    clean = [row("aum", 10000.0), row("loan_book", 8200.0), row("disbursements", 1900.0), row("networth", 2400.0), row("borrowings", 7100.0),
             row("branches", 200), row("employees", 2500), row("sell_down_volume", 310.0), row("gnpa_pct", 1.82), row("nnpa_pct", 1.21),
             row("pcr_stage3_pct", 33.9), row("yield_pct", 11.4, source="IP", document=DOC_IP), row("cost_of_funds_pct", 8.1, source="IP", document=DOC_IP),
             row("spread_pct", 3.3, footnote="Spread is not disclosed; computed as Yield − Cost of Funds."), row("crar_pct", 38.2), row("debt_equity", 2.96),
             row("roa_pct", 3.0), row("disbursement_per_branch", 9.5), row("disbursement_per_employee", 0.76),
             row("buy_out_volume", None, status="not_found", document=None, page_or_slide=None, footnote="No loans acquired are disclosed in the QR notes or the IP appendix.")]
    clean[13]["source"] = "computed"
    def run(rows, **kw): return validate_rows(list(enumerate(rows, 1)), **kw)
    def codes(rep, kind="errors"): return sorted({x["code"] for x in rep[kind]})
    def expect(name, rows, want_errors, want_flags=None, **kw):
        rep = run(rows, **kw)
        if codes(rep) != sorted(want_errors): fails.append(f"{name}: errors {codes(rep)} {[x['message'] for x in rep['errors']][:3]}, want {want_errors}")
        if want_flags is not None and codes(rep, "flags") != sorted(want_flags): fails.append(f"{name}: flags {codes(rep, 'flags')} {[x['message'] for x in rep['flags']][:3]}, want {want_flags}")
        return rep
    def swap(kpi, **kw): return [dict(r, **kw) if r["kpi"] == kpi else r for r in clean]
    rep = expect("clean batch", clean, [], [])
    if not rep["valid"] or rep["by_status"] != {"ok": 19, "not_found": 1}: fails.append(f"clean summary {rep['by_status']}")
    expect("ok row without document", swap("aum", document=None), ["E-SCHEMA"])
    expect("ok row without page", swap("aum", page_or_slide=None), ["E-SCHEMA"])
    expect("ok row without value", swap("aum", value=None), ["E-SCHEMA"])
    expect("needs_review without footnote", swap("gnpa_pct", status="needs_review"), ["E-SCHEMA"])
    expect("carried_forward without footnote/value_period", swap("branches", status="carried_forward"), ["E-SCHEMA"])
    cf = dict(status="carried_forward", value_period="Q1 FY26", footnote="Branches as of Q1 FY26, from the previous quarter's investor presentation.")
    rep = expect("carried_forward done right", swap("branches", **cf), [], [])
    if [c["kpi"] for c in rep["review_cells"]] != ["branches"]: fails.append("review_cells should list the carried-forward cell")
    expect("carried_forward footnote omits the period", swap("branches", **dict(cf, footnote="Taken from the previous quarter's IP.")), ["E-CARRY"])
    expect("carried forward from a later period", swap("branches", **dict(cf, value_period="Q3 FY26", footnote="Branches as of Q3 FY26.")), ["E-CARRY"])
    expect("carried forward two quarters flagged", swap("employees", status="carried_forward", value_period="Q4 FY25", footnote="Employees as of Q4 FY25 (annual report)."), [], ["F-CARRY"])
    expect("amount in lakhs", swap("aum", unit="%"), ["E-CATALOG"])
    expect("unit outside the allowed set", swap("aum", unit="₹ lakh"), ["E-CATALOG", "E-SCHEMA"])
    expect("wrong category", swap("gnpa_pct", category="Scale"), ["E-CATALOG"])
    expect("period not canonical", swap("aum", period="Q2FY26"), ["E-PERIOD", "E-SCHEMA"])
    expect("cumulative period as a quarter", swap("disbursements", period="H1 FY26"), ["E-PERIOD", "E-SCHEMA"])
    expect("GNPA 31% flagged not rejected", swap("gnpa_pct", value=31.0), [], ["F-RANGE"])
    expect("GNPA 131% rejected", swap("gnpa_pct", value=131.0), ["E-BOUNDS"])
    expect("GNPA as a fraction flagged", [r for r in swap("gnpa_pct", value=0.0182) if r["kpi"] != "nnpa_pct"], [], ["F-RANGE"])
    expect("NNPA > GNPA", swap("nnpa_pct", value=2.4), ["E-NNPA"])
    expect("loan book > AUM", swap("loan_book", value=10250.0), ["E-LOANBOOK"])
    expect("loan book within tolerance of AUM", [r for r in swap("loan_book", value=10050.0) if r["kpi"] != "sell_down_volume"], [])
    expect("sell down reported though AUM == loan book", swap("loan_book", value=10000.0), ["E-SELLDOWN"])
    expect("consolidated without footnote", swap("networth", basis="consolidated"), ["E-SCHEMA"])
    expect("consolidated with footnote", swap("networth", basis="consolidated", footnote="The filing gives consolidated figures only; no standalone balance sheet."), [], ["F-BASIS"])
    restr = dict(row("aum", 120.0), label="Restructured book (OTR 2.0)")
    expect("restructured-book row", clean + [dict(restr, period="Q1 FY26")], ["E-RESTRUCT"])
    expect("restructuring in a footnote flagged", swap("gnpa_pct", footnote="GNPA includes restructured accounts of ₹40 crore."), [], ["F-FOOTNOTE"])
    expect("unknown kpi key", clean + [dict(row("aum", 1.0), kpi="restructured_book")], ["E-SCHEMA"])
    expect("company's own ROA passed off as the KPI", swap("roa_pct", source="IP"), ["E-SOURCE"])
    expect("disclosed KPI marked computed", swap("crar_pct", source="computed"), ["E-SOURCE"])
    expect("computed spread wrong", swap("spread_pct", value=3.9), ["E-ARITH"])
    expect("disbursement per branch wrong", swap("disbursement_per_branch", value=8.0), ["E-ARITH"])
    expect("fractional employees", swap("employees", value=2500.5), ["E-ARITH", "E-COUNT"])
    expect("negative amount", swap("networth", value=-5.0), ["E-BOUNDS"])
    expect("duplicate cell, same timestamp", clean + [row("aum", 10000.0)], ["E-DUP"])
    expect("re-extraction flagged", clean + [row("aum", 10010.0, extracted_at="2026-09-19T10:00:00Z")], [], ["F-DUP"])
    expect("already in the data room", clean, [], ["F-DUP"], existing=[(1, row("aum", 9990.0))])
    expect("chart reading must be needs_review", swap("yield_pct", read_from_chart=True), ["E-SCHEMA"])
    expect("derived flag on a balance", swap("aum", derived_from_cumulative=True, footnote="Derived as H1 FY26 minus Q1 FY26."), [], ["F-DERIVED"])
    expect("not_found with a value", swap("buy_out_volume", value=0.0), ["E-SCHEMA"])
    expect("not_found without footnote flagged", swap("buy_out_volume", footnote=""), [], ["F-FOOTNOTE"])
    expect("extra field", swap("aum", confidence=0.9), ["E-SCHEMA"])
    expect("completeness", clean, [], ["F-MISSING"], expect_complete=True)
    # file path: bad JSON line is a problem, not a crash
    d = tempfile.mkdtemp(); p = os.path.join(d, "k.jsonl")
    with open(p, "w", encoding="utf-8") as f: f.write(json.dumps(clean[0], ensure_ascii=False) + "\n{not json\n[1,2]\n\n")
    rows, problems = schema.read_jsonl(p); rep = validate_rows(rows, problems)
    if rep["valid"] or len(rep["errors"]) != 2: fails.append(f"bad lines: {rep['errors']}")
    return fails, 43


def main():
    ap = argparse.ArgumentParser(description="Schema + domain-rule validation of KPI rows. Run it on the batch before dataroom_append_jsonl / publish_artifact; exit 1 means do not write.")
    ap.add_argument("path", nargs="?", help="kpis.jsonl (the batch about to be appended, or the whole data-room file)")
    ap.add_argument("--existing", help="the data room's current kpis.jsonl fetched into the sandbox; cells already present are flagged F-DUP")
    ap.add_argument("--expect-complete", action="store_true", help="flag every catalog KPI that has no row for a company and quarter")
    ap.add_argument("--loan-book-tolerance-pct", type=float, default=1.0, help="Loan Book may exceed AUM by this much (rounding, different sources) before it is an error; default 1")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        fails, n = _self_test()
        print(json.dumps({"script": "validate_kpis", "cases": n, "failed": fails, "ok": not fails}, ensure_ascii=False, indent=1)); return 1 if fails else 0
    if not a.path: ap.print_help(sys.stderr); return 2
    try:
        rows, problems = schema.read_jsonl(a.path)
        existing = schema.read_jsonl(a.existing)[0] if a.existing else None
    except OSError as x: print(f"cannot read: {x}", file=sys.stderr); return 2
    if not rows and not problems: problems = ["the file has no rows"]
    rep = validate_rows(rows, problems, a.loan_book_tolerance_pct, a.expect_complete, existing)
    print(json.dumps(rep, ensure_ascii=False, indent=1))
    if not rep["valid"]:
        print(f"INVALID: {len(rep['errors'])} error(s). Do not append or publish; fix the rows or report the failure to the analyst.", file=sys.stderr); return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
