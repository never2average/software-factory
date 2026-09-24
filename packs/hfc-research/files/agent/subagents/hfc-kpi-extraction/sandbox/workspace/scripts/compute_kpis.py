#!/usr/bin/env python3
"""Compute every derived KPI of the analysts' rulebook from extracted inputs, exactly as the rulebook states the
formulas (NOT the textbook versions):

  Spread %                    = Yield % - Cost of Funds %          (only when the filing does not disclose a spread)
  Cost to Income %            = Operating Expenses / Net Interest Income x 100
  Opex / Loan Book %          = Operating Expenses / Loan Book x 100
  Opex / AUM %                = Operating Expenses / AUM x 100
  ROA %                       = Quarterly PAT x 4 / AUM x 100      (on closing AUM, not on average assets)
  ROE %                       = Quarterly PAT x 4 / Networth x 100 (closing networth)
  Disbursement per Branch     = Disbursement / Number of Branches
  Disbursement per Employee   = Disbursement / Number of Employees
  Expense per Employee        = (Operating Expenses + Employee Cost) / Number of Employees   (applied as written; see footnote)
  Employee Cost per Employee  = Employee Cost / Number of Employees

As written, only ROA and ROE are annualised (x 4); the efficiency ratios use the quarter's expenses un-annualised.

  python3 /workspace/scripts/compute_kpis.py --inputs inputs.json            # schema: ../schemas/kpi-inputs.schema.json
  cat inputs.json | python3 /workspace/scripts/compute_kpis.py --stdin --rows # also emit kpis.jsonl-ready rows
  python3 /workspace/scripts/compute_kpis.py --self-test

A missing input makes that KPI not_found with the reason; nothing is estimated. A carried-forward or needs_review input
passes its status and footnote on to every KPI computed from it.

Sell-down verdict: the rulebook says "If AUM equals the Loan Book, there are no off-book loans: Sell Down Volume is not
found". AUM and loan book are compared after rounding both to 2 decimals of Rs crore (exact match). --sd-tolerance-pct
(or sell_down_tolerance_pct in the inputs; default 0, maximum 5) widens that to |AUM - loan book| / AUM x 100 <= tolerance,
for the case where the presentation rounds AUM to the nearest crore while the balance sheet is in lakhs. When the inputs
carry loan_book_gross (loans before the impairment allowance, from the loans note) the verdict uses it, because AUM is a
gross figure and the balance sheet loan line is net of the allowance; the verdict says which figure it used.
Exit 0 = computed (individual KPIs may be not_found); 1 = the inputs are invalid; 2 = bad usage.
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, datetime, json
from finlib import numbers, periods, schema, units
import kpi_catalog as cat
import convert_units

SCHEMA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "schemas", "kpi-inputs.schema.json")
AMOUNTS = ["aum", "loan_book", "loan_book_gross", "disbursements", "networth", "borrowings", "opex", "employee_cost", "nii", "pat_quarter"]
FLOWS = {"disbursements", "opex", "employee_cost", "nii", "pat_quarter"}
COUNTS = ["branches", "employees"]
PCTS = ["yield_pct", "cost_of_funds_pct", "spread_pct_disclosed"]
_LABEL = {"aum": "AUM", "loan_book": "Loan Book", "loan_book_gross": "gross loans", "disbursements": "Disbursements", "networth": "Networth",
          "opex": "Operating Expenses", "employee_cost": "Employee Cost", "nii": "Net Interest Income", "pat_quarter": "Quarterly PAT",
          "branches": "Number of Branches", "employees": "Number of Employees", "yield_pct": "Yield %", "cost_of_funds_pct": "Cost of Funds %"}


def _read_input(name, raw):
    """-> dict(value, status, footnote, document, page_or_slide, problem)"""
    o = {"value": None, "status": "ok", "footnote": "", "document": None, "page_or_slide": None, "problem": None, "period": None}
    if raw is None: o["problem"] = "not provided"; return o
    if isinstance(raw, dict):
        o.update({k: raw[k] for k in ("status", "footnote", "document", "page_or_slide", "period") if raw.get(k) is not None})
        v, u = raw.get("value"), raw.get("unit")
        if o["status"] == "not_found": o["problem"] = "marked not_found by the extractor"; return o
    else: v, u = raw, None
    n, problem = convert_units.parse_printed(v)
    if n is None: o["problem"] = "blank in the filing" if numbers.is_blank(v) else problem; return o
    if name in AMOUNTS:
        if u in ("%", "x", "count"): o["problem"] = f"an amount cannot carry the unit {u!r}"; return o
        n = units.to_crore(n, u or "crore")
    elif u in units.FACTOR_TO_CRORE: o["problem"] = f"{name} cannot carry the currency unit {u!r}"; return o
    if name in COUNTS and n != int(n): o["problem"] = f"a count must be a whole number, got {v!r}"; return o
    o["value"] = n
    return o


def compute(inp, sd_tolerance_pct=None):
    inp, problems = schema.normalise_row(inp)       # inputs under the key's older name read as the new key
    with open(SCHEMA, encoding="utf-8") as f: problems += schema.validate(inp, json.load(f))
    if problems: return {"ok": False, "problems": problems}
    period = periods.normalise(inp["period"])["period"]
    vals = {n: _read_input(n, inp.get(n)) for n in AMOUNTS + COUNTS + PCTS}
    for n, o in vals.items():
        if o["status"] == "carried_forward":
            vp = periods.normalise(o["period"]) if o["period"] else None
            if vp is None: problems.append(f"{n}: a carried_forward input must say which period its value belongs to (`period`, e.g. 'Q1 FY26')")
            elif vp["fy"] * 10 + vp["quarter"] >= int(period[-2:]) * 10 + int(period[1]): problems.append(f"{n}: carried forward from {vp['period']}, which is not earlier than {period}")
            elif n in FLOWS: problems.append(f"{n}: a flow is never carried forward; a previous quarter's flow is not this quarter's flow")
            else: o["period"] = vp["period"]
    if problems: return {"ok": False, "problems": problems}
    discrete = inp["flows_are_discrete_quarter"] is True
    published = inp.get("published") or {}
    unknown_pub = [k for k in published if k not in cat.BY_KEY]
    if unknown_pub: return {"ok": False, "problems": [f"published: unknown kpi key(s) {unknown_pub}"]}

    def need(names):
        """-> (values dict | None, reason | None)"""
        missing = []
        for n in names:
            if vals[n]["value"] is None: missing.append(f"{_LABEL.get(n, n)} ({vals[n]['problem']})")
            elif n in FLOWS and not discrete: missing.append(f"{_LABEL.get(n, n)} (flows_are_discrete_quarter is false: a cumulative figure is never used as a quarter; derive it with derive_quarter.py first)")
        return (None, "missing input: " + "; ".join(missing)) if missing else ({n: vals[n]["value"] for n in names}, None)

    def zero(name, v):
        return f"{_LABEL.get(name, name)} is zero; the ratio is undefined" if v == 0 else None

    formulas = {
        "cost_to_income_pct": (["opex", "nii"], "nii", lambda v: v["opex"] / v["nii"] * 100),
        "opex_to_loan_book_pct": (["opex", "loan_book"], "loan_book", lambda v: v["opex"] / v["loan_book"] * 100),
        "opex_to_aum_pct": (["opex", "aum"], "aum", lambda v: v["opex"] / v["aum"] * 100),
        "roa_pct": (["pat_quarter", "aum"], "aum", lambda v: v["pat_quarter"] * 4 / v["aum"] * 100),
        "roe_pct": (["pat_quarter", "networth"], "networth", lambda v: v["pat_quarter"] * 4 / v["networth"] * 100),
        "disbursement_per_branch": (["disbursements", "branches"], "branches", lambda v: v["disbursements"] / v["branches"]),
        "disbursement_per_employee": (["disbursements", "employees"], "employees", lambda v: v["disbursements"] / v["employees"]),
        "expense_per_employee": (["opex", "employee_cost", "employees"], "employees", lambda v: (v["opex"] + v["employee_cost"]) / v["employees"]),
        "employee_cost_per_employee": (["employee_cost", "employees"], "employees", lambda v: v["employee_cost"] / v["employees"]),
    }
    opex_def = inp.get("opex_definition")
    inc = inp.get("opex_includes_employee_cost")
    kpis = []

    def emit(key, names, value, reason, extra_notes=()):
        e = cat.BY_KEY[key]
        k = {"kpi": key, "label": e["label"], "category": e["category"], "unit": e["unit"], "formula": e["formula"], "value": None,
             "status": "not_found", "reason": reason, "inputs_used": {}, "footnote": "", "company_published": published.get(key), "value_period": None}
        notes = list(extra_notes)
        if value is not None:
            k["value"], k["status"], k["reason"] = round(value, e["decimals"]), "ok", None
            k["inputs_used"] = {n: round(vals[n]["value"], 4) for n in names}
            for n in names:
                st = vals[n]["status"]
                if st in ("carried_forward", "needs_review"):
                    if k["status"] != "needs_review": k["status"] = st
                    asof = f" (as of {vals[n]['period']})" if st == "carried_forward" else ""
                    notes.append(f"Input {_LABEL.get(n, n)} is {st.replace('_', ' ')}{asof}" + (f": {vals[n]['footnote']}" if vals[n]["footnote"] else "."))
                    if st == "carried_forward":
                        older = k["value_period"] is None or _pk(vals[n]["period"]) < _pk(k["value_period"])
                        if older: k["value_period"] = vals[n]["period"]
            if "opex" in names:
                notes.append(f"Operating expenses = {opex_def}." if opex_def else "The filing's definition of operating expenses was not recorded.")
            pub = published.get(key)
            if pub is not None and round(pub, e["decimals"]) != k["value"]:
                notes.append(f"Company publishes {_show(pub, e)}; the workspace formula {e['formula']} gives {_show(k['value'], e)}.")
        else:
            notes.insert(0, f"Not computed: {reason}.")
            if published.get(key) is not None: notes.append(f"Company publishes {_show(published[key], e)} (its own definition; not used).")
        k["footnote"] = " ".join(notes)
        kpis.append(k)

    # Spread: disclosed wins; the fallback is the rulebook's subtraction.
    if vals["spread_pct_disclosed"]["value"] is not None:
        spread_note = {"kpi": "spread_pct", "disclosed": True, "value": round(vals["spread_pct_disclosed"]["value"], 2),
                       "advice": "the filing discloses a spread: report it as disclosed (source QR/IP), not the computed one"}
        chk, _ = need(["yield_pct", "cost_of_funds_pct"])
        if chk is not None:
            implied = round(chk["yield_pct"] - chk["cost_of_funds_pct"], 2)
            spread_note["yield_minus_cost_of_funds"] = implied
            if abs(implied - spread_note["value"]) > 0.05:
                spread_note["advice"] += f"; note in the footnote that yield - cost of funds = {implied:.2f}% differs from the disclosed {spread_note['value']:.2f}% (the company defines spread on a different base)"
    else:
        spread_note = {"kpi": "spread_pct", "disclosed": False}
        v, reason = need(["yield_pct", "cost_of_funds_pct"])
        emit("spread_pct", ["yield_pct", "cost_of_funds_pct"], None if v is None else v["yield_pct"] - v["cost_of_funds_pct"], reason,
             ["Spread is not disclosed; computed as Yield − Cost of Funds."] if v is not None else [])

    for key in [k for k in cat.KEYS if k in formulas]:
        names, denom, fn = formulas[key]
        v, reason = need(names)
        if v is not None: reason = zero(denom, v[denom])
        extra = []
        if v is not None and reason is None and key == "cost_to_income_pct" and v["nii"] < 0:
            reason = "Net Interest Income is negative; a cost-to-income ratio on a negative base is meaningless"
        if key == "expense_per_employee" and v is not None and reason is None:
            if inc is True: extra.append("The rulebook formula adds Employee Cost to Operating Expenses; this filing's operating expenses ALREADY include employee cost, so employee cost is counted twice (formula applied as written).")
            elif inc is False: extra.append("The rulebook formula adds Employee Cost to Operating Expenses; this filing's operating expenses exclude employee cost, so nothing is double counted.")
            else: extra.append("The rulebook formula adds Employee Cost to Operating Expenses; whether this filing's operating expenses already include employee cost was not determined.")
        emit(key, names, fn(v) if v is not None and reason is None else None, reason, extra)

    out = {"ok": True, schema.ROW_KEY: inp[schema.ROW_KEY], "period": period, "basis": inp["basis"], "kpis": kpis, "spread": spread_note,
           "sell_down_verdict": sell_down_verdict(vals, inp.get("sell_down_tolerance_pct") if sd_tolerance_pct is None else sd_tolerance_pct),
           "warnings": []}
    if not discrete: out["warnings"].append("flows_are_discrete_quarter is false: no flow-based KPI was computed")
    a, l = vals["aum"]["value"], vals["loan_book"]["value"]
    if a is not None and l is not None and round(l, 2) > round(a * 1.01, 2):
        out["warnings"].append(f"Loan Book ({l:,.2f}) is larger than AUM ({a:,.2f}) by more than 1%: AUM includes the on-book loans, so one of the two is on a different basis, unit or date. Mark both needs_review.")
    return out


def sell_down_verdict(vals, tol_pct):
    tol = 0.0 if tol_pct is None else float(tol_pct)
    a = vals["aum"]["value"]
    use = "loan_book_gross" if vals["loan_book_gross"]["value"] is not None else "loan_book"
    l = vals[use]["value"]
    v = {"rule": "If AUM equals the Loan Book there are no off-book loans: record Sell Down Volume as not found and do not search further.",
         "compared": f"aum vs {use}", "tolerance_pct": tol, "aum": None if a is None else round(a, 2), "loan_book_used": None if l is None else round(l, 2),
         "aum_equals_loan_book": None, "off_book": None, "action": None, "footnote": None}
    if a is None or l is None:
        v["action"] = "search"; v["reason"] = "AUM or Loan Book is missing, so the rule cannot be applied: look for the sell-down disclosure as usual"; return v
    if a == 0: v["action"] = "search"; v["reason"] = "AUM is zero"; return v
    diff_pct = abs(a - l) / abs(a) * 100
    equal = round(a, 2) == round(l, 2) or (tol > 0 and round(diff_pct, 6) <= tol)
    v.update(aum_equals_loan_book=equal, off_book=round(a - l, 2), diff_pct=round(diff_pct, 4))
    if equal:
        v["action"] = "record_not_found"
        v["footnote"] = (f"AUM (₹{a:,.2f} crore) equals the loan book (₹{l:,.2f} crore{', gross of impairment allowance' if use == 'loan_book_gross' else ''})"
                         + (f" within {tol:g}%" if round(a, 2) != round(l, 2) else "") + ": no off-book loans, so no sell down volume (rulebook rule).")
    else:
        v["action"] = "search"
        v["reason"] = (f"AUM exceeds the loan book by ₹{a - l:,.2f} crore ({diff_pct:.2f}%): off-book loans exist, look for the transfer-of-loan-exposures disclosure"
                       if a > l else f"the loan book exceeds AUM by ₹{l - a:,.2f} crore: check basis, unit and date before anything else")
        if use == "loan_book" and a > l and diff_pct <= 3:
            v["hint"] = ("the difference is small and the balance sheet loan line is net of the impairment allowance while AUM is gross; if the loans note gives gross loans, "
                         "pass it as loan_book_gross and re-run before searching")
    return v


def _pk(p):
    n = periods.normalise(p); return n["fy"] * 10 + n["quarter"]


def _show(v, e):
    return {"%": f"{v:.2f}%", "x": f"{v:.2f}x", "count": f"{v:,.0f}", "₹ crore": f"₹{v:,.{e['decimals']}f} crore"}[e["unit"]]


def to_rows(result, inp, extracted_at=None):
    ts = extracted_at or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = []
    for k in result["kpis"]:
        names = list(k["inputs_used"])
        cites = [(n, inp[n]) for n in names if isinstance(inp.get(n), dict)]
        docs = []
        for _, c in cites:
            if c.get("document") and c["document"] not in docs: docs.append(c["document"])
        pages = "; ".join(f"{n}: {c['page_or_slide']}" for n, c in cites if c.get("page_or_slide") is not None)
        row = {schema.ROW_KEY: result[schema.ROW_KEY], "extracted_at": ts, "kpi": k["kpi"], "category": k["category"], "value": k["value"], "unit": k["unit"],
               "period": result["period"], "basis": result["basis"], "source": "computed", "document": " | ".join(docs) or None, "page_or_slide": pages or None,
               "status": k["status"], "footnote": k["footnote"]}
        if k["value"] is not None: row["inputs"] = k["inputs_used"]
        if k["company_published"] is not None: row["company_published"] = k["company_published"]
        if k["value_period"] and k["status"] in ("carried_forward", "needs_review"): row["value_period"] = k["value_period"]
        if result["basis"] == "consolidated" and "consolidated" not in row["footnote"].lower():
            row["footnote"] = (row["footnote"] + " Computed from consolidated figures; the filing gives no standalone figures.").strip()
        rows.append(row)
    return rows


EXAMPLE = {
    "primary_context_entity": "example-hfl", "period": "Q2 FY26", "basis": "standalone", "flows_are_discrete_quarter": True,
    "aum": {"value": 10000, "document": "Companies/example-hfl/filings/presentations/q2fy26-ip.pdf", "page_or_slide": "slide 5"},
    "loan_book": {"value": "8,20,000", "unit": "lakh", "document": "Companies/example-hfl/filings/lodr/q2fy26-results.pdf", "page_or_slide": 5},
    "disbursements": {"value": 1900, "document": "Companies/example-hfl/filings/presentations/q2fy26-ip.pdf", "page_or_slide": "slide 9"},
    "networth": {"value": 2400, "document": "Companies/example-hfl/filings/lodr/q2fy26-results.pdf", "page_or_slide": 5},
    "opex": {"value": 60, "document": "Companies/example-hfl/filings/lodr/q2fy26-results.pdf", "page_or_slide": 3},
    "employee_cost": {"value": 36, "document": "Companies/example-hfl/filings/lodr/q2fy26-results.pdf", "page_or_slide": 3},
    "nii": {"value": 150, "document": "Companies/example-hfl/filings/lodr/q2fy26-results.pdf", "page_or_slide": 3},
    "pat_quarter": {"value": 75, "document": "Companies/example-hfl/filings/lodr/q2fy26-results.pdf", "page_or_slide": 3},
    "branches": {"value": 200, "document": "Companies/example-hfl/filings/presentations/q2fy26-ip.pdf", "page_or_slide": "slide 4"},
    "employees": {"value": 2500, "document": "Companies/example-hfl/filings/presentations/q2fy26-ip.pdf", "page_or_slide": "slide 4"},
    "yield_pct": 11.4, "cost_of_funds_pct": 8.1,
    "opex_definition": "employee benefits expense + depreciation + other expenses", "opex_includes_employee_cost": True,
    "published": {"roa_pct": 3.4, "cost_to_income_pct": 33.5},
}


def _self_test():
    fails = []
    def eq(name, got, want):
        if got != want: fails.append(f"{name}: got {got!r}, want {want!r}")
    r = compute(EXAMPLE); eq("example valid", r["ok"], True)
    got = {k["kpi"]: k["value"] for k in r["kpis"]}
    want = {"spread_pct": 3.3, "cost_to_income_pct": 40.0, "opex_to_loan_book_pct": 0.73, "opex_to_aum_pct": 0.6, "roa_pct": 3.0, "roe_pct": 12.5,
            "disbursement_per_branch": 9.5, "disbursement_per_employee": 0.76, "expense_per_employee": 0.0384, "employee_cost_per_employee": 0.0144}
    eq("all ten formulas", got, want)
    by = {k["kpi"]: k for k in r["kpis"]}
    eq("ROA is on AUM x4 (not average assets)", by["roa_pct"]["inputs_used"], {"pat_quarter": 75.0, "aum": 10000.0})
    eq("published ROA footnoted", "Company publishes 3.40%" in by["roa_pct"]["footnote"], True)
    eq("double count said", "counted twice" in by["expense_per_employee"]["footnote"], True)
    eq("opex definition footnoted", "employee benefits expense + depreciation + other expenses" in by["cost_to_income_pct"]["footnote"], True)
    eq("verdict: off-book exists", (r["sell_down_verdict"]["action"], r["sell_down_verdict"]["off_book"]), ("search", 1800.0))
    rows = to_rows(r, EXAMPLE, "2026-09-18T10:00:00Z")
    eq("rows cite inputs", (rows[1]["source"], rows[1]["page_or_slide"], rows[1]["document"]),
       ("computed", "opex: 3; nii: 3", "Companies/example-hfl/filings/lodr/q2fy26-results.pdf"))
    with open(os.path.join(os.path.dirname(SCHEMA), "kpi-row.schema.json"), encoding="utf-8") as f: row_schema = json.load(f)
    eq("rows pass kpi-row schema", [p for row in rows[1:] for p in schema.validate(row, row_schema)], [])
    # missing inputs -> not_found with the reason, others still computed
    m = dict(EXAMPLE); m.pop("branches"); m["employees"] = {"value": "-"}
    r = compute(m); by = {k["kpi"]: k for k in r["kpis"]}
    eq("missing branches", (by["disbursement_per_branch"]["status"], "Number of Branches (not provided)" in by["disbursement_per_branch"]["reason"]), ("not_found", True))
    eq("blank employees", (by["expense_per_employee"]["value"], "blank in the filing" in by["expense_per_employee"]["reason"]), (None, True))
    eq("unaffected KPI still computed", by["roe_pct"]["value"], 12.5)
    # carried-forward input propagates
    c = dict(EXAMPLE, branches={"value": 198, "status": "carried_forward", "period": "Q1 FY26", "footnote": "Not published for Q2 FY26 (previous quarter's IP used).",
                                "document": "Companies/example-hfl/filings/presentations/q1fy26-ip.pdf", "page_or_slide": "slide 4"})
    by = {k["kpi"]: k for k in compute(c)["kpis"]}
    eq("carried_forward propagates", (by["disbursement_per_branch"]["status"], "Q1 FY26" in by["disbursement_per_branch"]["footnote"], by["roe_pct"]["status"]), ("carried_forward", True, "ok"))
    cf_rows = [x for x in to_rows(compute(c), c, "2026-09-18T10:00:00Z") if x["kpi"] == "disbursement_per_branch"]
    eq("carried-forward row is schema-valid with value_period", (cf_rows[0].get("value_period"), schema.validate(cf_rows[0], row_schema)), ("Q1 FY26", []))
    eq("carried_forward input without period refused", compute(dict(EXAMPLE, branches={"value": 198, "status": "carried_forward"}))["ok"], False)
    eq("carried_forward from a later period refused", compute(dict(EXAMPLE, branches={"value": 198, "status": "carried_forward", "period": "Q3 FY26"}))["ok"], False)
    eq("carried-forward flow refused", compute(dict(EXAMPLE, disbursements={"value": 1800, "status": "carried_forward", "period": "Q1 FY26"}))["ok"], False)
    c = dict(c, disbursements={"value": 1900, "status": "needs_review", "footnote": "QR and IP differ by 7%."})
    by = {k["kpi"]: k for k in compute(c)["kpis"]}
    eq("needs_review wins over carried_forward", by["disbursement_per_branch"]["status"], "needs_review")
    # cumulative flows refused
    r = compute(dict(EXAMPLE, flows_are_discrete_quarter=False)); by = {k["kpi"]: k for k in r["kpis"]}
    eq("cumulative flows: nothing flow-based computed", [k for k, v in by.items() if v["value"] is not None], ["spread_pct"])
    # zero / negative bases
    by = {k["kpi"]: k for k in compute(dict(EXAMPLE, nii=0))["kpis"]}
    eq("zero NII", (by["cost_to_income_pct"]["status"], "zero" in by["cost_to_income_pct"]["reason"]), ("not_found", True))
    by = {k["kpi"]: k for k in compute(dict(EXAMPLE, nii=-5))["kpis"]}
    eq("negative NII", by["cost_to_income_pct"]["status"], "not_found")
    by = {k["kpi"]: k for k in compute(dict(EXAMPLE, pat_quarter=-20))["kpis"]}
    eq("loss quarter gives negative ROA", (by["roa_pct"]["value"], by["roe_pct"]["value"]), (-0.8, -3.33))
    # spread disclosed
    r = compute(dict(EXAMPLE, spread_pct_disclosed=2.9))
    eq("disclosed spread not recomputed", ("spread_pct" in {k["kpi"] for k in r["kpis"]}, r["spread"]["disclosed"], r["spread"]["yield_minus_cost_of_funds"]), (False, True, 3.3))
    by = {k["kpi"]: k for k in compute({k: v for k, v in EXAMPLE.items() if k != "cost_of_funds_pct"})["kpis"]}
    eq("spread fallback needs both", by["spread_pct"]["status"], "not_found")
    # sell-down rule
    sd = lambda **kw: compute(dict(EXAMPLE, **kw))["sell_down_verdict"]
    v = sd(aum=8200, loan_book=8200.004)
    eq("AUM == loan book after 2dp", (v["aum_equals_loan_book"], v["action"], "no off-book loans" in v["footnote"]), (True, "record_not_found", True))
    v = sd(aum=8200, loan_book=8199.4)
    eq("0.6 crore apart is NOT equal by default", (v["aum_equals_loan_book"], v["action"]), (False, "search"))
    v = sd(aum=8200, loan_book=8199.4, sell_down_tolerance_pct=0.05)
    eq("equal within explicit tolerance", (v["aum_equals_loan_book"], "within 0.05%" in v["footnote"]), (True, True))
    v = sd(aum=8200, loan_book=8120, loan_book_gross=8200)
    eq("gross loans used when given", (v["compared"], v["aum_equals_loan_book"]), ("aum vs loan_book_gross", True))
    v = sd(aum=8200, loan_book=8120)
    eq("net-of-provision hint", (v["action"], "hint" in v), ("search", True))
    v = sd(aum=None)
    eq("verdict without AUM", (v["aum_equals_loan_book"], v["action"]), (None, "search"))
    r = compute(dict(EXAMPLE, aum=8000, loan_book=8200))
    eq("loan book > AUM warned", any("larger than AUM" in w for w in r["warnings"]), True)
    # invalid inputs
    eq("bad period", compute(dict(EXAMPLE, period="H1 FY26"))["ok"], False)
    eq("unknown field", compute(dict(EXAMPLE, restructured_book=120))["ok"], False)
    eq("tolerance capped", compute(dict(EXAMPLE, sell_down_tolerance_pct=20))["ok"], False)
    eq("unknown published key", compute(dict(EXAMPLE, published={"rota": 1}))["ok"], False)
    by = {k["kpi"]: k for k in compute(dict(EXAMPLE, employees=2500.5))["kpis"]}
    eq("fractional employees refused", by["disbursement_per_employee"]["status"], "not_found")
    by = {k["kpi"]: k for k in compute(dict(EXAMPLE, opex={"value": "6,000", "unit": "lakh"}, nii={"value": "1.5", "unit": "billion"}))["kpis"]}
    eq("mixed units converted", by["cost_to_income_pct"]["value"], 40.0)
    # inputs under the key's older name: same KPIs, rows written under the new key; both keys disagreeing is refused
    OLD = schema.LEGACY_ROW_KEYS[0]
    old_inp = {(OLD if k == schema.ROW_KEY else k): v for k, v in EXAMPLE.items()}
    r = compute(old_inp)
    eq("older key: same KPIs", (r["ok"], r.get(schema.ROW_KEY), {k["kpi"]: k["value"] for k in r["kpis"]}), (True, "example-hfl", want))
    eq("older key: rows carry only the new key", all(x[schema.ROW_KEY] == "example-hfl" and OLD not in x for x in to_rows(r, old_inp, "2026-09-18T10:00:00Z")), True)
    eq("both keys, same value", compute(dict(EXAMPLE, **{OLD: "example-hfl"}))["ok"], True)
    r = compute(dict(EXAMPLE, **{OLD: "another-hfc"}))
    eq("both keys, different values", (r["ok"], any("disagree" in p for p in r.get("problems", []))), (False, True))
    return fails, 41


def main():
    ap = argparse.ArgumentParser(description="Inputs JSON -> every derived KPI by the rulebook's formulas, with the inputs used, plus the AUM == loan book sell-down verdict.")
    ap.add_argument("--inputs", help="path of a JSON file matching schemas/kpi-inputs.schema.json")
    ap.add_argument("--stdin", action="store_true", help="read the inputs JSON from stdin")
    ap.add_argument("--rows", action="store_true", help="also emit `rows`: kpis.jsonl-ready objects for the computed KPIs (source 'computed', citations from the inputs)")
    ap.add_argument("--sd-tolerance-pct", type=float, help="tolerance for 'AUM equals Loan Book', in percent of AUM; default 0 = exact match after rounding to 2 decimals; max 5")
    ap.add_argument("--example", action="store_true", help="print a synthetic inputs document (Example Housing Finance Ltd) and exit")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        fails, n = _self_test()
        print(json.dumps({"script": "compute_kpis", "cases": n, "failed": fails, "ok": not fails}, ensure_ascii=False, indent=1)); return 1 if fails else 0
    if a.example: print(json.dumps(EXAMPLE, ensure_ascii=False, indent=1)); return 0
    if a.sd_tolerance_pct is not None and not 0 <= a.sd_tolerance_pct <= 5: print("--sd-tolerance-pct must be between 0 and 5", file=sys.stderr); return 2
    try:
        if a.stdin: inp = json.load(sys.stdin)
        elif a.inputs:
            with open(a.inputs, encoding="utf-8") as f: inp = json.load(f)
        else: ap.print_help(sys.stderr); return 2
    except (OSError, json.JSONDecodeError) as x: print(f"cannot read the inputs: {x}", file=sys.stderr); return 2
    r = compute(inp, a.sd_tolerance_pct)
    if r["ok"] and a.rows: r["rows"] = to_rows(r, inp)
    print(json.dumps(r, ensure_ascii=False, indent=1))
    if not r["ok"]: print("invalid inputs: " + "; ".join(r["problems"]), file=sys.stderr); return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
