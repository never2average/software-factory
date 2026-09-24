#!/usr/bin/env python3
"""This quarter's guidance rows vs the previous quarter's -> maintained / raised / lowered / withdrawn / new per topic.

  python3 /workspace/scripts/guidance_diff.py --current /workspace/out/guidance.new.jsonl --previous /workspace/in/guidance.jsonl

--current   the rows you are about to append (one quarter).
--previous  the guidance.jsonl already in the data room (any number of quarters; the script takes the quarter just
            before --current's, or --previous-period). It may be missing or empty: then every topic is 'new' and the
            output says there was no baseline.

Rows are matched on (topic, subtopic). Where both sides carry one figure or one range in the same unit and for the same
horizon, the comparison is numeric:
    same low and high -> maintained;  low and high both >= (one higher) -> raised;  both <= (one lower) -> lowered;
    a range that widened or narrowed around the old one -> not_comparable, with the detail.
'raised' and 'lowered' describe the NUMBER only. For credit cost, cost-to-income or GNPA a raised number is worse news;
the script does not judge that (references/guidance-topics.json 'higher_is' says how to read it).
Anything else (qualitative on either side, different units, different horizon, several statements on one side) is
reported as not_comparable with both statements, for the model to read and decide. Rows recorded as 'withdrawn' last
quarter are not a baseline. The script suggests; it never rewrites the rows.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, json, tempfile
from finlib import periods, schema
from iplib import emit, fail, parse_range, norm_period


def figures(row):
    """(low, high, unit, source) from the row's value fields, else from its statement when it holds exactly one figure."""
    lo, hi, unit = row.get("value_low"), row.get("value_high"), row.get("value_unit")
    if lo is not None or hi is not None:
        lo = hi if lo is None else lo
        hi = lo if hi is None else hi
        return min(lo, hi), max(lo, hi), unit, "value_fields"
    r = parse_range(row.get("statement") or "")
    if r["low"] is not None:
        return r["low"], r["high"], r["unit"], "parsed_from_statement"
    return None, None, None, "several_figures_in_statement" if len(r["matches"]) > 1 else "no_figure"


def brief(row, line=None):
    lo, hi, unit, src = figures(row)
    return {"line": line, "statement": row.get("statement"), "speaker": row.get("speaker"), "page": row.get("page"), "horizon": row.get("horizon"),
            "low": lo, "high": hi, "unit": unit, "figure_source": src}


def compare(cur, prev):
    """-> (suggested_change, basis, detail)"""
    cl, ch, cu, cs = figures(cur)
    pl, ph, pu, ps = figures(prev)
    if cl is None and pl is None:
        return "not_comparable", "qualitative", "neither statement carries a single figure; read both and decide"
    if cl is None or pl is None:
        side = "this quarter's" if cl is None else "the previous quarter's"
        return "not_comparable", "qualitative", f"{side} statement carries no single figure ({cs if cl is None else ps}); read both and decide"
    if cu != pu:
        if (cu, pu) in (("percent", "bps"), ("bps", "percent")):
            f = lambda lo, hi, u: (lo * 100, hi * 100) if u == "percent" else (lo, hi)
            (cl, ch), (pl, ph) = f(cl, ch, cu), f(pl, ph, pu)
        else:
            return "not_comparable", "units_differ", f"units differ ({pu} then, {cu} now)"
    hc, hp = (cur.get("horizon") or "").strip().lower(), (prev.get("horizon") or "").strip().lower()
    if hc and hp and hc != hp:
        return "not_comparable", "horizon_differs", f"the guidance is for a different horizon ('{prev.get('horizon')}' then, '{cur.get('horizon')}' now)"
    eps = 1e-9
    if abs(cl - pl) < eps and abs(ch - ph) < eps:
        return "maintained", "numeric", f"{pl:g}-{ph:g} then, {cl:g}-{ch:g} now"
    if cl >= pl - eps and ch >= ph - eps:
        return "raised", "numeric", f"{pl:g}-{ph:g} then, {cl:g}-{ch:g} now"
    if cl <= pl + eps and ch <= ph + eps:
        return "lowered", "numeric", f"{pl:g}-{ph:g} then, {cl:g}-{ch:g} now"
    shape = "widened" if (cl < pl and ch > ph) else "narrowed"
    return "not_comparable", "range_" + shape, f"the range {shape}: {pl:g}-{ph:g} then, {cl:g}-{ch:g} now"


def diff(current, history, previous_period=None):
    """current/history: [(line, row)]"""
    warnings = []
    cur_periods = sorted({norm_period(r.get("period")) for _, r in current if norm_period(r.get("period"))})
    if not current:
        return None, ["--current has no rows"]
    if len(cur_periods) != 1:
        return None, [f"--current must hold one quarter; found {cur_periods or 'no parseable period'}"]
    period = cur_periods[0]
    expected_prev = periods.previous_quarter(period)
    prev_period = norm_period(previous_period) if previous_period else expected_prev
    if previous_period and not prev_period:
        return None, [f"--previous-period {previous_period!r} does not parse"]
    if prev_period != expected_prev:
        warnings.append(f"comparing {period} with {prev_period}, which is not the quarter just before it ({expected_prev}); say so in the reply")
    prev_rows = [(n, r) for n, r in history if norm_period(r.get("period")) == prev_period]
    live_prev = [(n, r) for n, r in prev_rows if r.get("change_vs_previous") != "withdrawn"]
    if not prev_rows:
        warnings.append(f"no guidance is recorded for {prev_period}: every topic below is 'new' only because there is no baseline. Say that in the reply.")
    key = lambda r: (r.get("topic"), r.get("subtopic"))
    groups = {}
    for n, r in current: groups.setdefault(key(r), {"cur": [], "prev": []})["cur"].append((n, r))
    for n, r in live_prev: groups.setdefault(key(r), {"cur": [], "prev": []})["prev"].append((n, r))
    results = []
    for (topic, sub), g in sorted(groups.items(), key=lambda kv: (str(kv[0][0]), str(kv[0][1]))):
        cur, prev = g["cur"], g["prev"]
        base = {"topic": topic, "subtopic": sub}
        if cur and not prev:
            sub_hint = [r.get("subtopic") for _, r in live_prev if r.get("topic") == topic]
            d = "no statement on this topic was recorded for the previous quarter" if prev_rows else "no baseline quarter"
            if sub_hint: d += f"; the previous quarter has this topic under subtopic(s) {sub_hint}: check the subtopic before calling it new"
            for n, r in cur:
                results.append({**base, "suggested_change": "new", "basis": "presence", "detail": d, "current": brief(r, n), "previous": None,
                                "recorded_change": r.get("change_vs_previous")})
        elif prev and cur and all(r.get("change_vs_previous") == "withdrawn" for _, r in cur):
            n, r = cur[0]
            results.append({**base, "suggested_change": "withdrawn", "basis": "presence", "detail": "guided last quarter; this quarter's row records the withdrawal",
                            "current": brief(r, n), "previous": brief(prev[0][1], prev[0][0]), "recorded_change": "withdrawn"})
        elif prev and not cur:
            for n, r in prev:
                results.append({**base, "suggested_change": "withdrawn", "basis": "presence",
                                "detail": "guided last quarter, no row this quarter. Search the transcript for the topic before writing a withdrawn row: "
                                          "quote the words used if management declined, else use the fixed 'No statement on this topic' sentence.",
                                "current": None, "previous": brief(r, n), "recorded_change": None})
        elif len(cur) > 1 or len(prev) > 1:
            results.append({**base, "suggested_change": "not_comparable", "basis": "several_statements",
                            "detail": f"{len(cur)} statement(s) now and {len(prev)} then under one topic/subtopic; give each a subtopic so they can be matched",
                            "current": [brief(r, n) for n, r in cur], "previous": [brief(r, n) for n, r in prev], "recorded_change": [r.get("change_vs_previous") for _, r in cur]})
        else:
            (n, r), (pn, pr) = cur[0], prev[0]
            change, basis, detail = compare(r, pr)
            results.append({**base, "suggested_change": change, "basis": basis, "detail": detail, "current": brief(r, n), "previous": brief(pr, pn),
                            "recorded_change": r.get("change_vs_previous")})
    for x in results:
        rc = x.get("recorded_change")
        x["agrees_with_recorded"] = None if rc is None or isinstance(rc, list) else (rc == x["suggested_change"]) if x["basis"] in ("numeric", "presence") else None
    summary = {}
    for x in results: summary[x["suggested_change"]] = summary.get(x["suggested_change"], 0) + 1
    disagreements = [f"{x['topic']}{'/' + x['subtopic'] if x['subtopic'] else ''}: row says '{x['recorded_change']}', the figures say '{x['suggested_change']}' ({x['detail']})"
                     for x in results if x["agrees_with_recorded"] is False]
    return {"period": period, "previous_period": prev_period, "baseline_rows": len(prev_rows), "results": results, "summary": summary,
            "disagreements": disagreements, "warnings": warnings}, []


def _rows(objs): return list(enumerate(objs, 1))


def _self_test():
    checks = []
    def ok(name, cond, detail=None):
        checks.append({"check": name, "ok": bool(cond), **({"detail": detail} if not cond else {})})
    def row(period, topic, statement, **kw):
        return {schema.ROW_KEY: "example-hfl", "period": period, "topic": topic, "statement": statement, "speaker": "Asha Rao", "page": 4,
                "change_vs_previous": kw.pop("change", "new"), "extracted_at": "2025-11-05", **kw}

    prev = [row("Q1 FY26", "aum_growth", "We expect AUM growth of 18% to 20% for FY26.", value_low=18, value_high=20, value_unit="percent", horizon="FY26"),
            row("Q1FY26", "credit_cost", "Credit cost should be around 40 basis points."),
            row("Q1 FY26", "spread_nim", "Spreads will stay in the 3.2-3.4% band.", subtopic="spread"),
            row("Q1 FY26", "branch_additions", "We will add 25 branches this year."),
            row("Q1 FY26", "capital_raise", "We will look at a capital raise at an appropriate time."),
            row("Q1 FY26", "opex_cost_to_income", "Cost to income will trend down.", ),
            row("Q1 FY26", "borrowing_mix", "No statement on this topic in the Q1 FY26 call.", change="withdrawn", speaker=None, page=None),
            row("Q1 FY26", "asset_quality", "GNPA should be below 1.5% by March.", subtopic="gnpa", horizon="FY26"),
            row("Q4 FY25", "disbursement_growth", "Disbursement growth of 25% next year.")]
    cur = [row("Q2 FY26", "aum_growth", "We now expect AUM growth of 20% to 22% for FY26.", value_low=20, value_high=22, value_unit="percent", horizon="FY26", change="raised"),
           row("Q2 FY26", "credit_cost", "Credit cost should be 0.3% for the year.", change="maintained"),
           row("Q2 FY26", "spread_nim", "We hold the spread band of 3.2% to 3.4%.", subtopic="spread", change="maintained"),
           row("Q2 FY26", "branch_additions", "We will add 20 to 30 branches this year.", change="maintained"),
           row("Q2 FY26", "opex_cost_to_income", "Cost to income should be 38% by year end.", change="lowered"),
           row("Q2 FY26", "borrowing_mix", "NHB refinance will rise to 15% of borrowings.", change="new"),
           row("Q2 FY26", "asset_quality", "GNPA should be below 1.5% next year.", subtopic="gnpa", horizon="FY27", change="maintained"),
           row("Q2 FY26", "disbursement_growth", "Disbursement growth of 20% this year.", change="lowered")]
    out, errs = diff(_rows(cur), _rows(prev))
    by = {(x["topic"], x["subtopic"]): x for x in out["results"]}
    ok("runs; previous period derived as Q1 FY26 ('Q1FY26' rows included)", not errs and out["previous_period"] == "Q1 FY26" and out["baseline_rows"] == 8, out and out["baseline_rows"])
    ok("raised: 18-20 -> 20-22 from value fields", by[("aum_growth", None)]["suggested_change"] == "raised" and by[("aum_growth", None)]["agrees_with_recorded"] is True, by[("aum_growth", None)])
    x = by[("credit_cost", None)]
    ok("bps vs percent are put on one scale: 40 bps -> 0.3% is lowered, and the row's 'maintained' is contradicted", x["suggested_change"] == "lowered" and x["agrees_with_recorded"] is False and out["disagreements"], x)
    ok("maintained: same band written two ways, parsed from the statements", by[("spread_nim", "spread")]["suggested_change"] == "maintained", by[("spread_nim", "spread")])
    x = by[("branch_additions", None)]
    ok("25 -> 20-30 is a widened range: not_comparable, not guessed", x["suggested_change"] == "not_comparable" and x["basis"] == "range_widened", x)
    x = by[("opex_cost_to_income", None)]
    ok("qualitative then, figure now: not_comparable with both statements", x["suggested_change"] == "not_comparable" and x["previous"]["statement"] and x["agrees_with_recorded"] is None, x)
    ok("withdrawn: guided last quarter, silent now", by[("capital_raise", None)]["suggested_change"] == "withdrawn" and by[("capital_raise", None)]["current"] is None)
    ok("a row that was 'withdrawn' last quarter is not a baseline: the topic is new again", by[("borrowing_mix", None)]["suggested_change"] == "new", by[("borrowing_mix", None)])
    ok("different horizon (FY26 vs FY27): not_comparable", by[("asset_quality", "gnpa")]["basis"] == "horizon_differs", by[("asset_quality", "gnpa")])
    ok("older quarters in the history are ignored: disbursement guidance from Q4 FY25 is no baseline", by[("disbursement_growth", None)]["suggested_change"] == "new")
    out2, _ = diff(_rows(cur + [row("Q2 FY26", "capital_raise", "No statement on this topic in the Q2 FY26 call.", change="withdrawn", speaker=None, page=None)]), _rows(prev))
    x = [y for y in out2["results"] if y["topic"] == "capital_raise"][0]
    ok("a withdrawn marker row this quarter is the withdrawal, not a new statement", x["suggested_change"] == "withdrawn" and x["agrees_with_recorded"] is True, x)
    out3, _ = diff(_rows([row("Q2 FY26", "capital_raise", "No statement on this topic in the Q2 FY26 call.", change="withdrawn")]), _rows(prev[:1]))
    ok("a withdrawn row with nothing to withdraw is contradicted", out3["results"][0]["agrees_with_recorded"] is False or len(out3["disagreements"]) >= 1, out3["results"])
    ok("summary counts", out["summary"] == {"raised": 1, "lowered": 1, "maintained": 1, "not_comparable": 3, "withdrawn": 1, "new": 2}, out["summary"])

    out, errs = diff(_rows(cur[:1]), [])
    ok("no history at all: new, with the no-baseline warning", out["results"][0]["suggested_change"] == "new" and any("no baseline" in w or "no guidance is recorded" in w for w in out["warnings"]), out)
    out, errs = diff(_rows(cur[:1] + [row("Q1 FY26", "aum_growth", "x" * 30)]), _rows(prev))
    ok("two quarters in --current is refused", out is None and "one quarter" in errs[0], errs)
    out, errs = diff(_rows(cur[:1]), _rows(prev), previous_period="Q4FY25")
    ok("--previous-period that is not the adjacent quarter is allowed but warned", out and any("not the quarter just before" in w for w in out["warnings"]), out and out["warnings"])
    two = [row("Q2 FY26", "spread_nim", "Spread of 3.2% to 3.4%."), row("Q2 FY26", "spread_nim", "NIM of 4% to 4.2% for the year.")]
    out, errs = diff(_rows(two), _rows([row("Q1 FY26", "spread_nim", "Spread of 3.2% to 3.4% is what we guide.")]))
    ok("several statements under one key: not_comparable, asks for subtopics", out["results"][0]["basis"] == "several_statements", out["results"])
    out, errs = diff(_rows([row("Q2 FY26", "spread_nim", "NIM of 4% for the year, we think.", subtopic="nim")]), _rows([row("Q1 FY26", "spread_nim", "Spread of 3.2% to 3.4% guided.", subtopic="spread")]))
    ok("same topic under another subtopic: 'new' carries a hint, and the old subtopic shows as withdrawn", any("check the subtopic" in x["detail"] for x in out["results"]) and
       {x["suggested_change"] for x in out["results"]} == {"new", "withdrawn"}, out["results"])
    r = row("Q2 FY26", "aum_growth", "Growth of 20% with credit cost of 30 bps.")
    ok("a statement with two figures yields no figure", figures(r)[0] is None and figures(r)[3] == "several_figures_in_statement", figures(r))

    d = tempfile.mkdtemp(); p = os.path.join(d, "g.jsonl")
    with open(p, "w", encoding="utf-8") as f: f.write(json.dumps(cur[0]) + "\nnot json\n[1]\n")
    rows, problems = schema.read_jsonl(p)
    ok("a broken history line is a reported problem, not a crash", len(rows) == 1 and len(problems) == 2, problems)
    OLD = schema.LEGACY_ROW_KEYS[0]
    with open(p, "w", encoding="utf-8") as f:
        f.write("\n".join(json.dumps({(OLD if k == schema.ROW_KEY else k): v for k, v in r.items()}) for r in prev) + "\n")
    hist_old, problems = schema.read_jsonl(p)
    out, errs = diff(_rows(cur), hist_old)
    ok("a history stored under the key's older name reads as the new key and diffs the same",
       not problems and all(schema.ROW_KEY in r and OLD not in r for _, r in hist_old) and out["summary"] == {"raised": 1, "lowered": 1, "maintained": 1, "not_comparable": 3, "withdrawn": 1, "new": 2}, (problems, out and out["summary"]))
    return checks


def main():
    ap = argparse.ArgumentParser(description="Compare this quarter's guidance rows with the previous quarter's. JSON on stdout.")
    ap.add_argument("--current", help="JSONL of the rows about to be appended (one quarter)")
    ap.add_argument("--previous", help="the guidance.jsonl fetched from the data room (all quarters); omit when there is none")
    ap.add_argument("--previous-period", help="compare against this quarter instead of the one just before --current's")
    ap.add_argument("--self-test", action="store_true", help="run built-in cases (no input files) and exit 0 or 1")
    a = ap.parse_args()
    if a.self_test:
        checks = _self_test()
        bad = [c for c in checks if not c["ok"]]
        emit({"script": "guidance_diff.py", "passed": len(checks) - len(bad), "failed": len(bad), "failures": bad})
        sys.exit(1 if bad else 0)
    if not a.current: fail("give --current <rows.jsonl>, or --self-test")
    try:
        current, p1 = schema.read_jsonl(a.current)
        history, p2 = schema.read_jsonl(a.previous) if a.previous else ([], [])
    except OSError as x:
        fail(f"cannot read: {x}")
    if p1: fail("--current has unreadable lines; fix them first:\n  " + "\n  ".join(p1))
    out, errs = diff(current, history, a.previous_period)
    if errs: fail("\n".join(errs))
    if p2: out["warnings"].append("unreadable lines in --previous were skipped: " + "; ".join(p2))
    if not a.previous: out["warnings"].append("no --previous file given: there is no baseline")
    emit(out)


if __name__ == "__main__":
    main()
