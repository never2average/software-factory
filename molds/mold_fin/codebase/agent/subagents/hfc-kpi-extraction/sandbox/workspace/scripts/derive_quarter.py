#!/usr/bin/env python3
"""Discrete quarter from cumulative figures, and column classification for results tables.

Mode 1 - derive (FLOWS ONLY: income, expenses, PAT, disbursements, sell-down / buy-out volumes):
  python3 /workspace/scripts/derive_quarter.py --kind flow --metric disbursements \
      --through "9M FY26" --through-value 5400 --before "H1 FY26" --before-value 3500
    -> Q3 FY26 = 1900, with the footnote text to put on the row.
  Q2 = H1 - Q1, Q3 = 9M - H1, Q4 = FY - 9M. Q1's cumulative IS the quarter.
  --kind balance (AUM, loan book, networth, borrowings, branches, employees) and --kind ratio (GNPA %, yield, CRAR...)
  are REFUSED: a balance is a point-in-time figure and a ratio cannot be subtracted.
  --metric <kpi key or input name> lets the script look the kind up in kpi_catalog and refuse a mismatch.

Mode 2 - classify the period columns of a table and say which one to use:
  python3 /workspace/scripts/derive_quarter.py --columns "Quarter ended 30.09.2025" "Quarter ended 30.06.2025" \
      "Quarter ended 30.09.2024" "Half year ended 30.09.2025" "Half year ended 30.09.2024" "Year ended 31.03.2025" --target "Q2 FY26"

  python3 /workspace/scripts/derive_quarter.py --self-test
Exit 0 = result produced; 1 = refused / cannot be derived; 2 = bad usage.
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, json
from finlib import numbers, periods, units
import kpi_catalog, convert_units

_NON_NEGATIVE = {"disbursements", "sell_down_volume", "buy_out_volume", "opex", "employee_cost"}


def kind_of(metric):
    if metric in kpi_catalog.BY_KEY:
        k = kpi_catalog.BY_KEY[metric]["kind"]; return "balance" if k == "count" else k
    if metric in kpi_catalog.INPUT_LINES: return kpi_catalog.INPUT_LINES[metric]["kind"]
    return None


def derive(kind, through_label, through_value, before_label, before_value, metric=None, unit=None, before_unit=None,
           before_restated=False, decimals=2):
    out = {"ok": False, "metric": metric, "kind": kind, "period": None, "value": None, "problem": None, "warnings": [], "footnote": None}
    if metric:
        known = kind_of(metric)
        if known is None: out["problem"] = f"unknown metric {metric!r}; use a kpi_catalog key or one of {sorted(kpi_catalog.INPUT_LINES)}"; return out
        if known != kind:
            out["problem"] = f"{metric} is a {known}, not a {kind}; pass --kind {known}"; out["kind"] = known
            if known != "flow": out["problem"] += ". " + _refusal(known)
            return out
    if kind != "flow": out["problem"] = _refusal(kind); return out
    t = periods.normalise(through_label)
    if t is None: out["problem"] = f"cannot read the period of --through {through_label!r}"; return out
    tv, why = convert_units.parse_printed(through_value)
    if tv is None: out["problem"] = f"--through-value: {why}"; return out
    if t["kind"] == "quarter":
        out["problem"] = f"{t['period']} is already a discrete quarter: use it as printed, nothing to derive"; return out
    q, fy = t["quarter"], t["fy"]
    out["period"] = f"Q{q} FY{fy:02d}"
    want_before = f"{periods.cumulative_label(q - 1)} FY{fy:02d}"
    b = periods.normalise(before_label) if before_label else None
    if b is None: out["problem"] = f"cannot read the period of --before {before_label!r}; {out['period']} needs {want_before}"; return out
    if b["period"] != want_before:
        out["problem"] = (f"{out['period']} = {t['period']} minus {want_before}, but --before is {b['period']}. "
                          "Subtracting any other period does not give the quarter."); return out
    bv, why = convert_units.parse_printed(before_value)
    if bv is None: out["problem"] = f"--before-value: {why}; the quarter cannot be derived"; return out
    for name, u in (("--unit", unit), ("--before-unit", before_unit)):
        if u is not None and u not in units.FACTOR_TO_CRORE: out["problem"] = f"{name} {u!r} unknown; use {sorted(units.FACTOR_TO_CRORE)}"; return out
    if unit or before_unit:
        if not unit: out["problem"] = "--before-unit given without --unit"; return out
        tv, bv = units.to_crore(tv, unit), units.to_crore(bv, before_unit or unit)
        out["unit"] = "crore"
    value = periods.derive_quarter(q, tv, bv)
    out.update(ok=True, value=round(value, decimals), through={"period": t["period"], "value": round(tv, decimals)},
               before={"period": b["period"], "value": round(bv, decimals), "restated": bool(before_restated)})
    if value < 0 and (metric in _NON_NEGATIVE or metric is None):
        out["warnings"].append("derived quarter is negative: a cumulative figure smaller than the earlier one usually means the earlier figure was "
                               "restated or the two figures are on different bases/units. Mark the row needs_review.")
        out["suggested_status"] = "needs_review"
    if tv != 0 and abs(value) > abs(tv): out["warnings"].append("derived quarter is larger than the cumulative figure it came from; check signs and units")
    src = ("the comparative restated in the current filing" if before_restated else "the figure published in the earlier filing")
    out["footnote"] = (f"{out['period']} derived as {t['period']} ({_fmt(tv, decimals)}) minus {b['period']} ({_fmt(bv, decimals)}); "
                       f"the filing gives no discrete quarter figure. {b['period']} is {src}.")
    return out


def _refusal(kind):
    if kind == "balance":
        return ("refused: a balance (AUM, loan book, networth, borrowings, branches, employees) is a point-in-time figure. The figure at the "
                "quarter-end date IS the quarter's value whatever the column is called; never subtract balances.")
    if kind == "ratio":
        return ("refused: a ratio cannot be derived by subtraction. Use the ratio printed for the quarter; if only a cumulative-period ratio is "
                "printed, report it with a footnote naming its period, or compute it from discrete-quarter inputs with compute_kpis.py.")
    return f"refused: unknown kind {kind!r}"


def _fmt(v, d): return f"{v:,.{d}f}"


def classify_columns(labels, target):
    tgt = periods.normalise(target)
    if tgt is None or tgt["kind"] != "quarter": return {"ok": False, "problem": f"--target {target!r} is not a quarter such as 'Q2 FY26'"}
    cols = []
    for i, lab in enumerate(labels):
        p = periods.normalise(lab)
        cols.append({"index": i, "label": lab, "period": p["period"] if p else None, "kind": p["kind"] if p else "unreadable"})
    q, fy = tgt["quarter"], tgt["fy"]
    exact = [c for c in cols if c["period"] == tgt["period"]]
    cum_label = f"{periods.cumulative_label(q)} FY{fy:02d}"
    cum = [c for c in cols if c["period"] == cum_label and q > 1]
    out = {"ok": True, "target": tgt["period"], "columns": cols, "use_for_flows": None, "use_for_balances": None, "advice": None}
    if len(exact) > 1:
        out.update(ok=False, advice=f"{len(exact)} columns read as {tgt['period']}: they are probably standalone and consolidated, or audited and unaudited, side by side; "
                                    "read the table's super-header and pick the standalone one")
        out["candidates"] = [c["index"] for c in exact]; return out
    if exact:
        out["use_for_flows"] = out["use_for_balances"] = exact[0]["index"]
        out["advice"] = f"column {exact[0]['index']} is the discrete quarter; it takes precedence over the {cum_label} column" if cum else f"column {exact[0]['index']} is the discrete quarter"
        return out
    if cum:
        if len(cum) > 1:
            out.update(ok=False, advice=f"{len(cum)} columns read as {cum_label}; pick the standalone one from the super-header"); out["candidates"] = [c["index"] for c in cum]; return out
        prev = f"{periods.cumulative_label(q - 1)} FY{fy:02d}"
        out["use_for_balances"] = cum[0]["index"]
        out["needs_derivation"] = {"through_column": cum[0]["index"], "through": cum_label, "before": prev}
        out["advice"] = (f"no discrete {tgt['period']} column. Balances: column {cum[0]['index']} (the closing date is the same). Flows: derive with "
                         f"--kind flow --through '{cum_label}' --before '{prev}'; {prev} comes from the earlier filing unless this table also prints it")
        return out
    out.update(ok=False, advice=f"no column for {tgt['period']} or {cum_label}; this table does not cover the requested quarter")
    return out


def _self_test():
    fails = []
    def eq(name, got, want):
        if got != want: fails.append(f"{name}: got {got!r}, want {want!r}")
    r = derive("flow", "H1 FY26", "3,500", "Q1 FY26", "1,600", metric="disbursements")
    eq("Q2 = H1 - Q1", (r["ok"], r["period"], r["value"]), (True, "Q2 FY26", 1900.0))
    eq("footnote names both periods", "H1 FY26 (3,500.00) minus Q1 FY26 (1,600.00)" in r["footnote"], True)
    r = derive("flow", "Nine months ended 31.12.2025", 5400, "Half year ended 30.09.2025", 3500, metric="disbursements")
    eq("Q3 = 9M - H1 from date labels", (r["ok"], r["period"], r["value"]), (True, "Q3 FY26", 1900.0))
    r = derive("flow", "FY26", "412.60", "9M FY26", "301.15", metric="pat_quarter")
    eq("Q4 = FY - 9M", (r["ok"], r["period"], r["value"]), (True, "Q4 FY26", 111.45))
    r = derive("flow", "Year ended 31 March 2026", "41,260", "9MFY26", "30,115", metric="pat_quarter", unit="lakh")
    eq("Q4 in lakhs -> crore", (r["ok"], r["value"], r.get("unit")), (True, 111.45, "crore"))
    r = derive("flow", "FY26", "41,260", "9M FY26", "301.15", metric="pat_quarter", unit="lakh", before_unit="crore")
    eq("mixed units (FY from QR in lakh, 9M from IP in crore)", (r["ok"], r["value"]), (True, 111.45))
    r = derive("balance", "H1 FY26", 9000, "Q1 FY26", 8600, metric="aum")
    eq("balance refused", (r["ok"], "point-in-time" in r["problem"]), (False, True))
    r = derive("flow", "H1 FY26", 9000, "Q1 FY26", 8600, metric="loan_book")
    eq("balance passed off as flow refused", (r["ok"], r["kind"], "never subtract" in r["problem"]), (False, "balance", True))
    r = derive("flow", "H1 FY26", 180, "Q1 FY26", 175, metric="employees")
    eq("count refused", r["ok"], False)
    r = derive("ratio", "H1 FY26", 8.4, "Q1 FY26", 8.2, metric="nim_pct")
    eq("ratio refused", (r["ok"], "cannot be derived by subtraction" in r["problem"]), (False, True))
    r = derive("flow", "FY26", 1000, "H1 FY26", 400, metric="disbursements")
    eq("FY - H1 is not a quarter", (r["ok"], "9M FY26" in r["problem"]), (False, True))
    r = derive("flow", "9M FY26", 1000, "H1 FY25", 400, metric="disbursements")
    eq("different fiscal year refused", r["ok"], False)
    r = derive("flow", "Q2 FY26", 1000, "Q1 FY26", 400, metric="disbursements")
    eq("already a quarter", (r["ok"], "already a discrete quarter" in r["problem"]), (False, True))
    r = derive("flow", "H1 FY26", "-", "Q1 FY26", 400, metric="disbursements")
    eq("blank cumulative", (r["ok"], "blank" in r["problem"]), (False, True))
    r = derive("flow", "H1 FY26", 1000, "Q1 FY26", "NA", metric="disbursements")
    eq("blank earlier figure", r["ok"], False)
    r = derive("flow", "H2 FY26", 1000, "H1 FY26", 400, metric="disbursements")
    eq("H2 unreadable", r["ok"], False)
    r = derive("flow", "H1 FY26", 900, "Q1 FY26", 1000, metric="disbursements")
    eq("negative disbursement flagged", (r["ok"], r.get("suggested_status")), (True, "needs_review"))
    r = derive("flow", "H1 FY26", -20, "Q1 FY26", 15, metric="pat_quarter")
    eq("loss quarter allowed", (r["ok"], r["value"], r.get("suggested_status")), (True, -35.0, None))
    r = derive("flow", "H1 FY26", 3500, "Q1 FY26", 1580, metric="disbursements", before_restated=True)
    eq("restated wording", "restated in the current filing" in r["footnote"], True)
    r = derive("flow", "H1 FY26", 1, "Q1 FY26", 1, metric="gold")
    eq("unknown metric", r["ok"], False)
    q2 = ["Quarter ended 30.09.2025", "Quarter ended 30.06.2025", "Quarter ended 30.09.2024", "Half year ended 30.09.2025", "Half year ended 30.09.2024", "Year ended 31.03.2025"]
    c = classify_columns(q2, "Q2 FY26")
    eq("quarter column wins over H1", (c["ok"], c["use_for_flows"], [x["period"] for x in c["columns"]]),
       (True, 0, ["Q2 FY26", "Q1 FY26", "Q2 FY25", "H1 FY26", "H1 FY25", "FY25"]))
    c = classify_columns(["9M FY26", "9M FY25", "FY25"], "Q3 FY26")
    eq("cumulative only", (c["ok"], c["use_for_flows"], c["use_for_balances"], c["needs_derivation"]["before"]), (True, None, 0, "H1 FY26"))
    c = classify_columns(["Quarter ended 30.09.2025", "Quarter ended 30.09.2025", "Half year ended 30.09.2025"], "Q2 FY26")
    eq("two identical quarter columns", (c["ok"], c.get("candidates")), (False, [0, 1]))
    c = classify_columns(["Q1 FY26", "FY25", "Particulars"], "Q2 FY26")
    eq("quarter absent", (c["ok"], c["columns"][2]["kind"]), (False, "unreadable"))
    c = classify_columns(["Q1 FY26", "Q1 FY25", "FY25"], "Q1 FY26")
    eq("Q1 direct", (c["ok"], c["use_for_flows"]), (True, 0))
    eq("bad target", classify_columns(["Q1 FY26"], "H1 FY26")["ok"], False)
    return fails, 26


def main():
    ap = argparse.ArgumentParser(description="Derive a discrete quarter from cumulative figures (flows only; balances and ratios are refused), or classify a table's period columns.")
    ap.add_argument("--kind", choices=["flow", "balance", "ratio"], help="what the metric is; only flow can be derived")
    ap.add_argument("--metric", help="kpi_catalog key or input name (opex, employee_cost, nii, pat_quarter); checked against --kind")
    ap.add_argument("--through", help="label of the cumulative period ending at the target quarter, e.g. 'H1 FY26' or 'Nine months ended 31.12.2025'")
    ap.add_argument("--through-value", help="the cumulative figure as printed")
    ap.add_argument("--before", help="label of the cumulative period ending one quarter earlier, e.g. 'Q1 FY26'")
    ap.add_argument("--before-value", help="the earlier cumulative figure as printed")
    ap.add_argument("--unit", help="unit of --through-value (crore|lakh|million|billion|thousand|rupee); when given, the result is in Rs crore")
    ap.add_argument("--before-unit", help="unit of --before-value when it differs from --unit")
    ap.add_argument("--before-restated", action="store_true", help="the earlier figure was taken from the comparative restated in the current filing, not from the earlier filing")
    ap.add_argument("--decimals", type=int, default=2)
    ap.add_argument("--columns", nargs="+", help="period header labels of a table, left to right")
    ap.add_argument("--target", help="with --columns: the quarter wanted, e.g. 'Q2 FY26'")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        fails, n = _self_test()
        print(json.dumps({"script": "derive_quarter", "cases": n, "failed": fails, "ok": not fails}, ensure_ascii=False, indent=1)); return 1 if fails else 0
    if a.columns:
        if not a.target: print("--columns needs --target", file=sys.stderr); return 2
        r = classify_columns(a.columns, a.target)
    else:
        if not a.kind or a.through is None or a.through_value is None:
            print("need --kind, --through, --through-value, --before, --before-value (or --columns/--target, or --self-test)", file=sys.stderr); return 2
        r = derive(a.kind, a.through, a.through_value, a.before, a.before_value, a.metric, a.unit, a.before_unit, a.before_restated, a.decimals)
    print(json.dumps(r, ensure_ascii=False, indent=1))
    if not r["ok"]: print(r.get("problem") or r.get("advice"), file=sys.stderr); return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
