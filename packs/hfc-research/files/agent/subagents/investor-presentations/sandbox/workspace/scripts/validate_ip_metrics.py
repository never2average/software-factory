#!/usr/bin/env python3
"""The gate before dataroom_append_jsonl on ip-metrics.jsonl: schema + the domain rules a schema cannot express.

  python3 /workspace/scripts/validate_ip_metrics.py /workspace/out/ip-metrics.new.jsonl
  python3 /workspace/scripts/validate_ip_metrics.py /workspace/out/ip-metrics.new.jsonl --existing /workspace/in/ip-metrics.jsonl --require-core

Exit 0: no errors (warnings may remain; read them). Exit 1: errors, nothing may be appended. Exit 2: the file cannot be read.
A failing validation is reported to the analyst. It is never bypassed and rows are never edited just to make it pass.

Rules (each error names its rule):
  schema            schemas/ip-metric-row.schema.json
  period            parses as an Indian fiscal period; H1/9M/FY rows say period_basis ytd/full_year and explain in the note
  slide             a slide number on every row that carries a value
  unit              branches/employees in 'count'; amounts in 'crore' (never lakh/million/billion); ratios in 'percent'
  count             counts are non-negative whole numbers
  range             amounts are not negative; mix/LTV percentages lie in 0..100
  conversion        source_value x source_unit -> value, per the analysts' table (lakh /100, million /10, billion x100)
  approximate       a boolean; true rows carry a note saying what was read off the chart
  parent            from_parent rows name the parent document and cite a '_parent-<slug>' file; the reverse also holds
  restructured      no restructured-book metric, by key or by label (the rulebook excludes it)
  duplicate         one row per company/period/metric/basis; a second row with another value is a conflict
  aum_loan_book     AUM equal to the loan book means no off-book loans, so no sell down may be reported (rulebook)
  mix_sum           product-mix and customer-mix percentages on one basis do not add up to more than 100
  carry_forward     (warning) a not_disclosed branches/employees row should offer the previous quarter's IP value
  core              (warning, error with --require-core) every core metric has a row for the period, even if not_disclosed
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, json, tempfile
from finlib import periods, schema, units
from iplib import emit, fail, load_table, load_schema, find_phrases, norm_period

MONEY_UNITS = ("crore", "lakh", "million", "billion", "thousand", "rupee")
PRODUCT_MIX = ("aum_mix_individual_housing", "aum_mix_lap", "aum_mix_construction_finance", "aum_mix_affordable", "aum_mix_other")
BORROWER_MIX = ("aum_mix_salaried", "aum_mix_self_employed")
UNIT_FOR_CLASS = {"count": ("count",), "amount": ("crore",), "percent": ("percent",), "percent_or_amount": ("percent", "crore")}


def validate(rows, problems, table, sch, existing=None, require_core=False):
    """rows: [(line, obj)], problems: unreadable-line messages. -> (errors, warnings)"""
    errors = [{"line": None, "rule": "schema", "message": p} for p in problems]
    warnings = []
    E = lambda n, rule, msg: errors.append({"line": n, "rule": rule, "message": msg})
    W = lambda n, rule, msg: warnings.append({"line": n, "rule": rule, "message": msg})
    # rows stored under the key's older name read as the new key; both keys disagreeing is an error
    normed = []
    for n, r in rows:
        r, kp = schema.normalise_row(r); normed.append((n, r))
        for p in kp: E(n, "schema", p)
    rows = normed
    existing = [(en, schema.normalise_row(er)[0]) for en, er in existing or []]
    excl = table["excluded"]["restructured_book"]["phrases"]
    seen, by_period = {}, {}
    for n, r in rows:
        for p in schema.validate(r, sch):
            E(n, "schema", p)
        metric, value, unit, status = r.get("metric"), r.get("value"), r.get("unit"), r.get("status", "reported")
        if not isinstance(metric, str): continue
        # restructured
        if find_phrases(metric.replace("_", " "), excl) or find_phrases(str(r.get("source_label") or ""), excl):
            E(n, "restructured", f"'{metric}' / label '{r.get('source_label')}' is restructured-book detail; the analysts exclude it. Drop the row."); continue
        # period
        per = periods.normalise(r.get("period")) if isinstance(r.get("period"), str) else None
        if not per:
            E(n, "period", f"period {r.get('period')!r} does not parse as a fiscal period such as Q2FY26")
        else:
            pb = r.get("period_basis")
            if per["kind"] == "cumulative" and pb != "ytd": E(n, "period", f"{per['period']} is a cumulative period; set period_basis to 'ytd' and explain in the note why no discrete quarter was available")
            if per["kind"] == "year" and pb not in ("full_year", "as_at"): E(n, "period", f"{per['period']} is a full year; set period_basis to 'full_year' (or 'as_at' for a year-end balance) and explain in the note")
            if per["kind"] == "quarter" and pb in ("ytd", "full_year"): E(n, "period", f"period_basis '{pb}' contradicts the quarter period {per['period']}; a YTD figure is labelled H1/9M/FY")
            if pb in ("ytd", "full_year", "ttm") and len(str(r.get("note") or "")) < 10: E(n, "period", "a row that is not a discrete quarter needs a note saying so")
        # slide
        if status in ("reported", "nil", "derived") and not isinstance(r.get("slide"), int):
            E(n, "slide", "a row with a value must carry the slide number it was read from")
        if status in ("reported", "derived") and value is None:
            E(n, "slide", "value is null but status is not not_disclosed/no_off_book; say which")
        # unit / count / range
        spec = table["metrics"].get(metric)
        if spec is None:
            W(n, "unit", f"metric '{metric}' is not in references/metric-synonyms.json; hfc-kpi-extraction will not look for it. Known keys: {sorted(table['metrics'])}")
        else:
            allowed = UNIT_FOR_CLASS[spec["class"]]
            if unit not in allowed:
                E(n, "unit", f"'{metric}' is reported in {' or '.join(allowed)}, not '{unit}'" + (" (amounts are always Rs crore: convert, and keep the printed figure in source_value/source_unit)" if "crore" in allowed else ""))
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                if spec["class"] == "count" and (value < 0 or value != int(value)):
                    E(n, "count", f"'{metric}' must be a non-negative whole number, got {value}")
                if unit == "crore" and value < 0: E(n, "range", f"'{metric}' cannot be negative ({value})")
                if unit == "percent" and (metric.startswith("aum_mix_") or metric == "avg_ltv") and not (0 <= value <= 100):
                    E(n, "range", f"'{metric}' is a share and must lie in 0..100, got {value}")
                if unit == "percent" and metric in ("yield", "cost_of_funds", "spread", "nim") and not (-5 <= value <= 40):
                    W(n, "range", f"'{metric}' of {value}% is outside anything plausible; check for basis points or a misplaced decimal")
        # conversion
        sv, su = r.get("source_value"), r.get("source_unit")
        if isinstance(sv, (int, float)) and su in MONEY_UNITS and unit == "crore" and isinstance(value, (int, float)):
            want = units.to_crore(float(sv), su)
            if abs(want - value) > max(0.01, abs(want) * 1e-4):
                E(n, "conversion", f"{sv} {su} is {want:g} crore, but value says {value}")
        if su in ("lakh", "million", "billion", "thousand", "rupee") and unit != "crore":
            E(n, "conversion", f"source_unit '{su}' is a money unit but unit is '{unit}'")
        # approximate
        if r.get("approximate") is True and len(str(r.get("note") or "").strip()) < 10:
            E(n, "approximate", "approximate rows must say in the note what was read and how (e.g. 'read off the bar chart, no data label')")
        # parent
        doc = str(r.get("document") or "")
        if r.get("from_parent") is True:
            if "_parent-" not in doc: E(n, "parent", f"from_parent row must cite the parent's deck, filed as ..._parent-<parent-slug>.pdf; document is '{doc}'")
            if len(str(r.get("parent_document") or "")) < 5: E(n, "parent", "from_parent row must name the parent document in parent_document")
        elif r.get("from_parent") is False and "_parent-" in doc:
            E(n, "parent", f"document '{doc}' is a parent's deck but from_parent is false")
        # carry forward
        if status == "not_disclosed" and metric in ("branches", "employees"):
            if r.get("carried_from_period") is None:
                W(n, "carry_forward", f"'{metric}' is not disclosed this quarter: give the previous quarter's IP value (carried_from_period, carried_value, carried_document, carried_slide), or say in the note that none is on file")
            elif per and per["kind"] == "quarter" and norm_period(r["carried_from_period"]) != periods.previous_quarter(per["period"]):
                W(n, "carry_forward", f"carried_from_period {r['carried_from_period']} is not the quarter just before {per['period']}; say in the note why an older value is offered")
            if r.get("carried_from_period") is not None and r.get("carried_value") is None:
                E(n, "carry_forward", "carried_from_period is given without carried_value")
        if r.get("carried_from_period") is not None and status != "not_disclosed":
            E(n, "carry_forward", "carried_* fields belong only on a not_disclosed row; this quarter's value field never holds a carried value")
        # duplicates
        key = (r.get(schema.ROW_KEY), per["period"] if per else r.get("period"), metric, r.get("basis"), r.get("period_basis"))
        if key in seen:
            pn, pv = seen[key]
            if pv == value: W(n, "duplicate", f"same row as line {pn} ({metric} {key[1]}); keep one")
            else: E(n, "duplicate", f"conflicts with line {pn}: {metric} {key[1]} is {pv} there and {value} here. Decks repeat numbers; cite one slide (deck-layout-variants skill)")
        else:
            seen[key] = (n, value)
        for en, er in existing or []:
            ep = norm_period(er.get("period")) if isinstance(er.get("period"), str) else None
            if (er.get(schema.ROW_KEY), ep, er.get("metric"), er.get("basis"), er.get("period_basis")) == key:
                if er.get("value") == value: E(n, "duplicate", f"already in the data room file (line {en}); appending it again would double the row")
                else: E(n, "duplicate", f"the data room file already has {metric} {key[1]} = {er.get('value')} (line {en}); this row says {value}. Report the difference; do not append a second value silently")
                break
        if per and status in ("reported", "derived", "nil"):
            by_period.setdefault((r.get(schema.ROW_KEY), per["period"]), {}).setdefault(metric, []).append((n, r))
        elif per:
            by_period.setdefault((r.get(schema.ROW_KEY), per["period"]), {}).setdefault(metric, [])

    for (company, period), m in by_period.items():
        val = lambda k: next((r["value"] for _, r in m.get(k, []) if isinstance(r.get("value"), (int, float)) and r.get("unit") == "crore"), None)
        aum, book, off, sd = val("aum"), val("loan_book"), val("off_book_aum"), val("sell_down_volume")
        if aum is not None and book is not None:
            if abs(aum - book) <= 0.5:
                if sd: E(m["sell_down_volume"][0][0], "aum_loan_book", f"{period}: AUM ({aum:g}) equals the loan book ({book:g}), so there are no off-book loans and no sell down is found (rulebook). The sell-down row says {sd:g}: re-read the slides and report the contradiction")
                if off: E(m["off_book_aum"][0][0], "aum_loan_book", f"{period}: AUM equals the loan book, yet off_book_aum is {off:g}")
            elif aum < book - 0.5:
                W(m["aum"][0][0], "aum_loan_book", f"{period}: AUM ({aum:g}) is below the loan book ({book:g}); AUM includes on-book loans. Check whether 'loan book' is gross and AUM net, or the definitions differ, and note it")
            elif off is not None and abs(book + off - aum) > max(1.0, aum * 0.01):
                W(m["off_book_aum"][0][0], "aum_loan_book", f"{period}: loan book {book:g} + off-book {off:g} = {book + off:g}, not AUM {aum:g}; record the company's AUM definition")
        for group, name in ((PRODUCT_MIX, "product mix"), (BORROWER_MIX, "customer mix")):
            sums = {}
            for k in group:
                for n, r in m.get(k, []):
                    if r.get("unit") == "percent" and isinstance(r.get("value"), (int, float)):
                        sums.setdefault(r.get("basis") or "aum", []).append((n, r["value"]))
            for basis, vals in sums.items():
                total = sum(v for _, v in vals)
                if total > 100.5: E(vals[0][0], "mix_sum", f"{period}: {name} shares on basis '{basis}' add up to {total:g}%. Two classifications are being mixed (e.g. affordable is a cut across housing, not a separate product): keep one, or give the other its own basis")
        have = set(m)
        missing = [k for k in table["core_metrics"] if k not in have]
        if missing:
            msg = f"{company} {period}: no row for core metric(s) {missing}. hfc-kpi-extraction needs a row for each, a not_disclosed (or no_off_book) row when the deck does not give it"
            (E if require_core else W)(None, "core", msg)
    if len({r.get(schema.ROW_KEY) for _, r in rows}) > 1:
        W(None, "schema", "rows for more than one company in one file; each company has its own ip-metrics.jsonl")
    return errors, warnings


def _self_test():
    table, sch = load_table("metric-synonyms.json"), load_schema("ip-metric-row.schema.json")
    checks = []
    def ok(name, cond, detail=None):
        checks.append({"check": name, "ok": bool(cond), **({"detail": detail} if not cond else {})})
    DOC = "Companies/example-hfl/filings/presentations/2025-11-04_Q2FY26_investor-presentation.pdf"
    def row(metric, value, unit, slide=5, **kw):
        return {schema.ROW_KEY: "example-hfl", "period": "Q2FY26", "metric": metric, "value": value, "unit": unit, "document": DOC, "slide": slide,
                "approximate": False, "from_parent": False, "note": "", "extracted_at": "2025-11-05T10:00:00Z", **kw}
    def run(objs, **kw):
        e, w = validate(list(enumerate(objs, 1)), [], table, sch, **kw)
        return [x["rule"] for x in e], [x["rule"] for x in w], e, w

    good = [row("branches", 215, "count", 8, basis="branches", source_label="Branches"), row("employees", 3410, "count", 8, basis="on_roll"),
            row("disbursements", 1050.0, "crore", 12, source_value=10500, source_unit="million"), row("aum", 12345.0, "crore", 5), row("loan_book", 10900.0, "crore", 5),
            row("off_book_aum", 1445.0, "crore", 5), row("sell_down_volume", 180.0, "crore", 41), row("buy_out_volume", 0, "crore", 41, status="nil", note="Slide shows 'Nil' for portfolio buyout in Q2 FY26."),
            row("aum_mix_individual_housing", 71, "percent", 14), row("aum_mix_lap", 19, "percent", 14), row("aum_mix_construction_finance", 10, "percent", 14),
            row("yield", 11.6, "percent", 20), row("spread", 3.5, "percent", 20)]
    e, w, ed, wd = run(good, require_core=True)
    ok("a complete, correct batch passes with --require-core", e == [] and w == [], (ed, wd))

    e, _, ed, _ = run([row("disbursements", 10500, "million", 12)])
    ok("amount left in millions -> schema + unit errors", "unit" in e and "schema" in e, ed)
    e, _, ed, _ = run([row("disbursements", 105.0, "crore", 12, source_value=10500, source_unit="million")])
    ok("conversion mismatch (10,500 mn is 1,050 crore, not 105)", e == ["conversion"], ed)
    e, _, ed, _ = run([row("disbursements", 123.45, "crore", 12, source_value=12345, source_unit="lakh")])
    ok("lakh / 100 accepted", e == [], ed)
    e, _, ed, _ = run([row("branches", 215.5, "count"), row("employees", -3, "count"), row("branches", 215, "crore", basis="x")])
    ok("counts: fraction, negative, wrong unit", e.count("count") == 2 and "unit" in e, ed)
    e, _, ed, _ = run([row("aum", 12345.0, "crore", slide=None)])
    ok("missing slide on a value row", "slide" in e, ed)
    e, _, ed, _ = run([row("disbursements", 1000.0, "crore", 12, approximate=True), row("aum", 1.0, "crore", approximate="yes")])
    ok("approximate true without a note; approximate not boolean", "approximate" in e and "schema" in e, ed)
    e, _, ed, _ = run([row("disbursements", 1000.0, "crore", 12, approximate=True, note="Read off the bar chart on slide 12; the bar has no data label.")])
    ok("approximate with a note passes", e == [], ed)

    pdoc = DOC.replace(".pdf", "_parent-example-finance.pdf")
    e, _, ed, _ = run([row("aum", 5000.0, "crore", 30, from_parent=True, document=pdoc, parent_document="Example Finance Ltd investor presentation Q2 FY26", note="Housing finance segment slide of the parent's deck.")])
    ok("from_parent row that names the parent passes", e == [], ed)
    e, _, ed, _ = run([row("aum", 5000.0, "crore", 30, from_parent=True, note="From the parent's deck, segment slide.")])
    ok("from_parent without parent_document / parent file name", "parent" in e and "schema" in e, ed)
    e, _, ed, _ = run([row("aum", 5000.0, "crore", 30, document=pdoc)])
    ok("parent's deck cited but from_parent false", e == ["parent"], ed)

    e, _, ed, _ = run([row("aum", 1.0, "crore", period="H2FY26"), row("aum", 1.0, "crore", period="Q5FY26")])
    ok("unparseable periods", e.count("period") == 2, ed)
    e, _, ed, _ = run([row("disbursements", 2010.0, "crore", 12, period="H1FY26")])
    ok("H1 row without period_basis ytd", "period" in e, ed)
    e, _, ed, _ = run([row("disbursements", 2010.0, "crore", 12, period="H1FY26", period_basis="ytd", note="Deck gives only H1; Q1 deck not on file, so Q2 cannot be derived.")])
    ok("H1 row labelled ytd with a note passes", e == [], ed)
    e, _, ed, _ = run([row("disbursements", 2010.0, "crore", 12, period_basis="ytd", note="This is the half-year figure.")])
    ok("ytd basis on a quarter period is a contradiction", e == ["period"], ed)

    e, _, ed, _ = run([row("restructured_book", 95.0, "crore", 44), row("loan_book", 95.0, "crore", 44, source_label="Restructured loan book (OTR 2.0)")])
    ok("restructured-book rows are refused by key and by label", e.count("restructured") == 2, ed)

    e, w, ed, wd = run([row("aum", 12345.0, "crore", 5), row("aum", 12345.0, "crore", 9), row("aum", 12350.0, "crore", 22)])
    ok("duplicates: same value warns, different value is a conflict", e == ["duplicate"] and "duplicate" in w, (ed, wd))
    e, _, ed, _ = run([row("branches", 215, "count", basis="branches"), row("branches", 480, "count", basis="touchpoints")])
    ok("same metric on different bases is not a duplicate", e == [], ed)
    e, _, ed, _ = run([row("aum", 12345.0, "crore", 5)], existing=[(7, row("aum", 12345.0, "crore", 5, period="Q2 FY26"))])
    ok("--existing: already filed ('Q2 FY26' and 'Q2FY26' are the same period)", e == ["duplicate"], ed)

    e, _, ed, _ = run([row("aum", 10900.0, "crore"), row("loan_book", 10900.0, "crore"), row("sell_down_volume", 180.0, "crore", 41)])
    ok("AUM == loan book but a sell down is reported -> error", e == ["aum_loan_book"], ed)
    e, _, ed, _ = run([row("aum", 10900.0, "crore"), row("loan_book", 10900.0, "crore"),
                       row("sell_down_volume", None, "crore", None, status="no_off_book", note="AUM equals the loan book on slide 5; no off-book loans, so no sell down.")])
    ok("AUM == loan book with a no_off_book row passes", e == [], ed)
    _, w, _, wd = run([row("aum", 12345.0, "crore"), row("loan_book", 10900.0, "crore"), row("off_book_aum", 900.0, "crore")])
    ok("loan book + off-book != AUM -> warning to record the definition", "aum_loan_book" in w, wd)

    e, _, ed, _ = run([row("aum_mix_individual_housing", 71, "percent"), row("aum_mix_lap", 19, "percent"), row("aum_mix_construction_finance", 10, "percent"), row("aum_mix_affordable", 35, "percent")])
    ok("mix shares adding to 135% -> error", e == ["mix_sum"], ed)
    e, _, ed, _ = run([row("aum_mix_individual_housing", 71, "percent"), row("aum_mix_lap", 19, "percent"), row("aum_mix_construction_finance", 10, "percent"),
                       row("aum_mix_affordable", 35, "percent", basis="affordable_cut")])
    ok("the overlapping cut on its own basis passes", e == [], ed)
    e, _, ed, _ = run([row("avg_ltv", 172, "percent")])
    ok("share outside 0..100", e == ["range"], ed)
    _, w, _, wd = run([row("spread", 350, "percent")])
    ok("spread of 350 'percent' (basis points left unconverted) warns", "range" in w, wd)

    _, w, _, wd = run([row("employees", None, "count", None, status="not_disclosed", note="Employee count is not in the Q2 FY26 deck.")])
    ok("not_disclosed employees without a carried value -> warning", "carry_forward" in w, wd)
    e, w, ed, wd = run([row("employees", None, "count", None, status="not_disclosed", note="Not in the Q2 FY26 deck; Q1 FY26 IP value offered for carry-forward.",
                           carried_from_period="Q1FY26", carried_value=3350, carried_document=DOC.replace("Q2", "Q1"), carried_slide=8)])
    ok("not_disclosed with the previous quarter's value passes cleanly", e == [] and "carry_forward" not in w, (ed, wd))
    e, _, ed, _ = run([row("employees", 3350, "count", 8, carried_from_period="Q1FY26", carried_value=3350)])
    ok("a carried value may not sit in this quarter's value field", "carry_forward" in e, ed)
    e, _, ed, _ = run([row("sell_down_volume", 5.0, "crore", 41, status="nil", note="Deck shows nil for the quarter.")])
    ok("nil row must have value 0", "schema" in e, ed)

    e, w, ed, wd = run([row("branches", 215, "count")])
    ok("missing core metrics: warning by default, error with --require-core", "core" in w and "core" in run([row("branches", 215, "count")], require_core=True)[0], (ed, wd))
    _, w, _, wd = run([row("cost_to_income", 38.0, "percent")])
    ok("unknown metric key warns (that ratio belongs to hfc-kpi-extraction)", "unit" in w, wd)

    OLD = schema.LEGACY_ROW_KEYS[0]
    as_old = lambda r: {(OLD if k == schema.ROW_KEY else k): v for k, v in r.items()}
    e, w, ed, wd = run([as_old(r) for r in good], require_core=True)
    ok("rows under the key's older name: the complete batch still passes", e == [] and w == [], (ed, wd))
    e, w, ed, wd = run([as_old(r) for r in good[:6]] + good[6:], require_core=True)
    ok("old and new rows mixed in one file are one company", e == [] and w == [], (ed, wd))
    e, _, ed, _ = run([row("aum", 12345.0, "crore", 5)], existing=[(7, as_old(row("aum", 12345.0, "crore", 5)))])
    ok("--existing rows under the older key still catch a re-filed row", e == ["duplicate"], ed)
    e, _, ed, _ = run([{**row("aum", 12345.0, "crore", 5), OLD: "example-hfl"}])
    ok("a row carrying both keys with the same value passes", e == [], ed)
    e, _, ed, _ = run([{**row("aum", 12345.0, "crore", 5), OLD: "another-hfc"}])
    ok("a row carrying both keys with different values is an error", e == ["schema"] and "disagree" in ed[0]["message"], ed)

    d = tempfile.mkdtemp(); p = os.path.join(d, "m.jsonl")
    with open(p, "w", encoding="utf-8") as f: f.write(json.dumps(good[0]) + "\n{broken\n\n")
    rows, problems = schema.read_jsonl(p)
    e, _, ed, _ = validate(rows, problems, table, sch)[0], None, None, None
    ok("an unreadable line is an error, not a crash", any(x["rule"] == "schema" and "not JSON" in x["message"] for x in e), e)
    return checks


def main():
    ap = argparse.ArgumentParser(description="Validate ip-metrics rows (schema + domain rules) before they are appended to the data room. JSON on stdout; exit 1 on any error.")
    ap.add_argument("file", nargs="?", help="JSONL of the rows about to be appended")
    ap.add_argument("--existing", help="the ip-metrics.jsonl already in the data room (fetched to the sandbox), to catch rows filed before")
    ap.add_argument("--require-core", action="store_true", help="make a missing core metric (branches, employees, disbursements, aum, loan_book, sell down, buy out) an error")
    ap.add_argument("--self-test", action="store_true", help="run built-in cases (no input files) and exit 0 or 1")
    a = ap.parse_args()
    if a.self_test:
        checks = _self_test()
        bad = [c for c in checks if not c["ok"]]
        emit({"script": "validate_ip_metrics.py", "passed": len(checks) - len(bad), "failed": len(bad), "failures": bad})
        sys.exit(1 if bad else 0)
    if not a.file: fail("give the JSONL file to validate, or --self-test")
    try:
        rows, problems = schema.read_jsonl(a.file)
        existing = schema.read_jsonl(a.existing)[0] if a.existing else None
    except OSError as x:
        fail(f"cannot read: {x}")
    if not rows and not problems: fail(f"{a.file} has no rows; nothing to validate, nothing to append")
    errors, warnings = validate(rows, problems, load_table("metric-synonyms.json"), load_schema("ip-metric-row.schema.json"), existing, a.require_core)
    emit({"file": a.file, "rows": len(rows), "valid": not errors, "errors": errors, "warnings": warnings,
          "next": "append with dataroom_append_jsonl" if not errors else "do NOT append. Fix what is wrong in the extraction, or report the failure to the analyst; never edit a row just to pass."})
    if errors:
        sys.stderr.write(f"validate_ip_metrics: {len(errors)} error(s) in {a.file}; nothing may be appended\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
