#!/usr/bin/env python3
"""Slide text -> (label, value, unit, period) candidates. Candidates only: the model confirms each one against the slide.

  python3 /workspace/scripts/extract_labelled_numbers.py --index /workspace/out/slide-index.json --slide 12 --period Q2FY26
  python3 /workspace/scripts/extract_labelled_numbers.py --text-file slide12.txt --unit million
  python3 /workspace/scripts/extract_labelled_numbers.py --index ... --slide 9 --from-chart

What it does, line by line:
  * finds the unit: a suffix on the number (%, bps, x, Cr, mn, bn) beats a unit named on the line, which beats the
    slide's unit (or --unit). Amounts are converted to Rs crore with finlib.units; the printed value is kept as
    source_value/source_unit. A slide that names two units and a number with no suffix -> unit null (unit_unresolved).
  * finds the period: a header line of period tokens ('Q2 FY25  Q1 FY26  Q2 FY26  H1 FY26') maps onto a row with the
    same number of figures; else a period on the same line; else the slide's only period; else null (period_ambiguous).
  * reads the label on the same line (left of the number, or right of it on 'number-first' KPI tiles), else from an
    adjacent line (label_source says which).
  * marks growth rates ('18% YoY', 'up 12% QoQ') so they are not mistaken for the metric.
  * ignores USD convenience translations, and drops restructured-book lines into 'excluded'.
  * --from-chart: numbers on a chart. Evenly spaced label-less runs are axis ticks (never values). Any number the text
    does not tie to a label on its own line is approximate: true. Nothing read from a chart is presented as exact unless
    it is a printed data label.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, json, re
from finlib import units
from iplib import emit, fail, load_table, find_phrases, phrase_regex, find_periods, find_units, find_numbers, mask_spans, norm_period

_GROWTH_AFTER = re.compile(r"^\s*(?:\)|,)?\s*(yoy|y-o-y|y/y|y\.o\.y|qoq|q-o-q|q/q|q\.o\.q|cagr)\b", re.I)
_GROWTH_BEFORE = re.compile(r"(?:\bup\b|\bdown\b|growth\s+of|\bgrew\b(?:\s+by)?|increase\s+of|decline\s+of|increased\s+by|declined\s+by|[↑↓▲▼+])\s*(?:by\s*)?$", re.I)
_GROWTH_COL = re.compile(r"(?<![A-Za-z])(?:yoy|y-o-y|y/y|qoq|q-o-q|q/q|growth|change|cagr)(?![A-Za-z])(?:\s*\(?%\)?)?", re.I)
_GROWTH_LABEL = re.compile(r"\b(?:yoy|y-o-y|qoq|q-o-q|growth|cagr|change)\b", re.I)
_LABEL_STRIP = re.compile(r"^[\s:•·\-–—|*#>]+|[\s:•·\-–—|(\[₹]+$")
# digits that belong to a LABEL, not a value: 'Stage 3', 'Tier 1', '30+ DPD', 'RF 2.0', 'Top 10 lenders', 'PMAY 2.0'
_LABEL_DIGITS = re.compile(r"stage[\s\-]*[123](?![\d.,])|tier[\s\-]*[12](?![\d.,])|\d+\s*\+\s*(?:dpd|days)|dpd\s*\d+(?:\s*[-–]\s*\d+)?|(?:rf|otr|pmay)[\s\-]*\d(?:\.\d)?|top[\s\-]*\d+(?=\s+[A-Za-z])", re.I)
_UNIT_BANNER = re.compile(r"[\(\[]\s*(?:in\s+)?(?:₹|rs\.?|inr)?\s*(?:in\s+)?(?:crores?|cr\.?|lakhs?|lacs?|millions?|mn\.?|billions?|bn\.?)\s*[\)\]]|(?:₹|\brs\.?|\binr)\s*(?:in\s+)?(?:crores?|cr\.?|lakhs?|millions?|mn\.?|billions?|bn\.?)?", re.I)


def clean_label(s):
    s = _UNIT_BANNER.sub(" ", s or "")
    s = " ".join(s.split())
    prev = None
    while prev != s:
        prev = s
        s = _LABEL_STRIP.sub("", s)
    return s if len(re.findall(r"[A-Za-z]", s)) >= 2 else None


_SEP = re.compile(r"[|;•·]")


def basis_candidates(label, table):
    """{metric: [basis, ...]} for count metrics whose basis vocabulary the label uses ('touchpoints', 'states', 'on-roll')."""
    out = {}
    for key, spec in table["metrics"].items():
        if spec["class"] != "count": continue
        hits = [b for b, ph in spec.get("basis_variants", {}).items() if find_phrases(label or "", ph)]
        if hits: out[key] = hits
    return out


def metric_candidates(label, table):
    out = []
    for key, spec in table["metrics"].items():
        t = label or ""
        for p in spec.get("not", []):
            t = phrase_regex(p).sub(" ", t)
        if find_phrases(t, spec["synonyms"]):
            out.append(key)
    return out


def is_axis_run(values):
    """>= 3 numbers in an arithmetic progression with a non-zero step: an axis, not data."""
    if len(values) < 3 or any(v is None for v in values): return False
    steps = [round(values[i + 1] - values[i], 6) for i in range(len(values) - 1)]
    return steps[0] != 0 and all(s == steps[0] for s in steps)


def extract(text, table, unit_override=None, target_period=None, from_chart=False, only_metric=None):
    warnings = []
    slide_units = find_units(text)
    slide_unit = unit_override or (slide_units[0] if len(slide_units) == 1 else None)
    if not unit_override and len(slide_units) > 1:
        warnings.append(f"the slide names more than one unit {slide_units}; numbers without their own unit suffix are left unit-unresolved. Re-run with --unit once you have read which unit applies.")
    slide_periods = []
    for p in find_periods(text):
        if p["period"] and p["kind"] != "as_at" and p["period"] not in slide_periods: slide_periods.append(p["period"])
    all_periods = {p["period"] for p in find_periods(text) if p["period"]}
    target = norm_period(target_period) if target_period else None
    if target_period and not target:
        warnings.append(f"--period {target_period!r} could not be parsed; is_target_period is not set")
    excl_phrases = table["excluded"]["restructured_book"]["phrases"]

    lines = [l for l in text.splitlines()]
    header, cands, excluded, axis = [], [], [], []
    vertical_axis = set()
    if from_chart:   # an axis printed one tick per line: >= 3 consecutive lines holding one bare number each, evenly spaced
        bare = []
        for i, line in enumerate(lines + [""]):
            ns = find_numbers(line) if line.strip() and not re.search(r"[A-Za-z]", line) else []
            if len(ns) == 1 and ns[0]["value"] is not None and ns[0]["suffix_unit"] in (None, "percent"):
                bare.append((i, ns[0]["value"])); continue
            if is_axis_run([v for _, v in bare]):
                vertical_axis.update(k for k, _ in bare)
                axis.append({"line": bare[0][0] + 1, "values": [v for _, v in bare], "note": "evenly spaced bare numbers on consecutive lines: an axis scale, not data"})
            bare = []
    for i, line in enumerate(lines):
        if not line.strip() or i in vertical_axis: continue
        lp = find_periods(line)
        label_text = mask_spans(line, [(p["start"], p["end"]) for p in lp])
        masked = mask_spans(label_text, [m.span() for m in _LABEL_DIGITS.finditer(label_text)], fill="_")
        nums = [n for n in find_numbers(masked)]
        if len(lp) >= 2 and not nums:
            # a header row; growth columns ('YoY', 'QoQ') between the period columns are columns too
            growth_cols = [{"label": m.group(0), "period": None, "kind": "growth", "start": m.start(), "end": m.end()} for m in _GROWTH_COL.finditer(label_text)]
            header = sorted(lp + growth_cols, key=lambda h: h["start"]); continue
        if not nums: continue
        if find_phrases(line, excl_phrases):
            excluded.append({"line": i + 1, "text": line.strip(), "reason": table["excluded"]["restructured_book"]["reason"]}); continue
        letters_before = len(re.findall(r"[A-Za-z]", masked[:nums[0]["start"]]))
        if from_chart and letters_before == 0 and not re.search(r"[A-Za-z]", masked) and is_axis_run([n["value"] for n in nums]):
            axis.append({"line": i + 1, "values": [n["value"] for n in nums], "note": "evenly spaced label-less numbers: an axis scale, not data"}); continue
        number_first = letters_before == 0 and bool(re.search(r"[A-Za-z]", masked))
        line_units = find_units(re.sub(r"\d[\d,.]*\s*(?:crores?|crs?\.?|lakhs?|mn\.?|millions?|bn\.?|billions?)", " ", line, flags=re.I))
        row_label, row = None, []
        for j, n in enumerate(nums):
            left = label_text[(nums[j - 1]["end"] if j else 0):n["start"]]
            right = label_text[n["end"]:(nums[j + 1]["start"] if j + 1 < len(nums) else len(label_text))]
            growth = None
            g = _GROWTH_AFTER.match(right)
            if g: growth = g.group(1).lower()
            elif n["suffix_unit"] == "percent" and _GROWTH_BEFORE.search(left): growth = "unspecified"
            label, src = None, None
            left, right = _SEP.split(left)[-1], _SEP.split(right)[0]      # a label never crosses a '|' or a bullet
            if number_first:
                label = clean_label(_GROWTH_AFTER.sub("", right)); src = "same_line_right" if label else None
                if not label and len(_SEP.split(label_text[:n["start"]])) > 1:      # a label-first tile on a number-first line
                    label = clean_label(left); src = "same_line_left" if label else None
            else:
                label = clean_label(_GROWTH_BEFORE.sub("", left))
                if label: row_label, src = label, "same_line_left"
                elif row_label: label, src = row_label, "same_line_left"
            row.append({"n": n, "label": label, "label_source": src, "growth": growth})
        if all(r["label"] is None for r in row) and not from_chart:
            nxt = next((l for l in lines[i + 1:i + 2] if l.strip()), "")
            prv = next((l for l in reversed(lines[max(0, i - 1):i]) if l.strip()), "")
            for cand_line, src in ((nxt, "next_line"), (prv, "previous_line")):
                if cand_line and not find_numbers(mask_spans(cand_line, [(p["start"], p["end"]) for p in find_periods(cand_line)])) and clean_label(cand_line):
                    for r in row: r["label"], r["label_source"] = clean_label(cand_line), src
                    break
        data = [r for r in row if not r["growth"]]
        has_growth_cols = any(h["kind"] == "growth" for h in header)
        below = []
        nxt_line = next((l for l in lines[i + 1:] if l.strip()), "")
        if nxt_line:
            bp = find_periods(nxt_line)
            if len(bp) >= 2 and not find_numbers(mask_spans(nxt_line, [(p["start"], p["end"]) for p in bp])): below = bp
        for r in row:
            n = r["n"]
            c = {"line": i + 1, "label": r["label"], "label_source": r["label_source"], "raw": n["raw"], "source_value": n["value"],
                 "source_unit": None, "value": None, "unit": None, "unit_source": None, "period": None, "period_kind": None, "period_source": None,
                 "is_growth_rate": bool(r["growth"]), "approximate": False, "flags": []}
            if r["growth"]: c["growth_basis"] = r["growth"]
            if n["value"] is None:
                c["flags"].append("unparseable_number"); cands.append(c); continue
            if n["usd"]:
                c["flags"].append("usd_convenience_translation_ignored"); c["ignored"] = True; cands.append(c); continue
            mets = metric_candidates(r["label"], table) if r["label"] else []
            if r["label"] and _GROWTH_LABEL.search(r["label"]) and n["suffix_unit"] == "percent":
                c["is_growth_rate"] = True
            c["metric_candidates"] = mets
            bases = basis_candidates(r["label"], table) if r["label"] else {}
            if bases: c["basis_candidates"] = bases
            classes = {table["metrics"][m]["class"] for m in mets} or ({"count"} if bases else set())
            # ---- unit
            su = n["suffix_unit"]
            if su in ("percent", "bps", "multiple"):
                c["unit"], c["source_unit"], c["value"], c["unit_source"] = su, su, n["value"], "number_suffix"
            elif su:
                c["source_unit"], c["unit"], c["value"], c["unit_source"] = su, "crore", units.to_crore(n["value"], su), "number_suffix"
            elif r["label"] and "%" in r["label"]:
                c["unit"], c["source_unit"], c["value"], c["unit_source"] = "percent", "percent", n["value"], "label"
            elif classes == {"count"}:
                c["unit"], c["source_unit"], c["value"], c["unit_source"] = "count", "count", n["value"], "metric_class"
                if n["value"] != int(n["value"]) or n["value"] < 0: c["flags"].append("count_not_a_non_negative_integer")
            elif classes == {"percent"}:
                c["flags"].append("percent_metric_without_percent_sign"); c["value"] = None
            else:
                u = line_units[0] if len(line_units) == 1 else slide_unit if not line_units else None
                if u:
                    c["source_unit"], c["unit"], c["value"] = u, "crore", units.to_crore(n["value"], u)
                    c["unit_source"] = "line" if len(line_units) == 1 else "option" if unit_override else "slide_header"
                    if not mets: c["flags"].append("unit_assumed_from_slide_label_unknown")
                else:
                    c["flags"].append("unit_unresolved")
            if c["value"] is not None and c["unit"] == "crore": c["value"] = round(c["value"], 6)
            # ---- period
            if has_growth_cols and len(row) == len(header):
                hp = header[row.index(r)]
                if hp["kind"] == "growth":
                    c["is_growth_rate"], c["growth_basis"], c["period_source"] = True, hp["label"].lower(), "column_header"
                else:
                    c["period"], c["period_kind"], c["period_source"] = hp["period"], hp["kind"], "column_header"
                    if hp["period"] is None: c["flags"].append("period_label_unparsed:" + hp["label"])
            elif not c["is_growth_rate"] and header and not has_growth_cols and len(data) == len(header) and r in data:
                hp = header[data.index(r)]
                c["period"], c["period_kind"], c["period_source"] = hp["period"], hp["kind"], "column_header"
                if hp["period"] is None: c["flags"].append("period_label_unparsed:" + hp["label"])
            elif not c["is_growth_rate"] and below and len(data) == len(below) and r in data and not (header and len(lp) == 1):
                hp = below[data.index(r)]
                c["period"], c["period_kind"], c["period_source"] = hp["period"], hp["kind"], "category_labels_below"
                if hp["period"] is None: c["flags"].append("period_label_unparsed:" + hp["label"])
            elif len(lp) == 1 and lp[0]["period"]:
                c["period"], c["period_kind"], c["period_source"] = lp[0]["period"], lp[0]["kind"], "same_line"
            elif len(all_periods) == 1:
                only = [p for p in find_periods(text) if p["period"]][0]
                c["period"], c["period_kind"], c["period_source"] = only["period"], only["kind"], "only_period_on_slide"
            else:
                c["flags"].append("period_ambiguous" if all_periods else "no_period_on_slide")
            if target and c["period"]: c["is_target_period"] = c["period"] == target
            if c["period_kind"] in ("cumulative", "year", "trailing"): c["flags"].append("not_a_discrete_quarter")
            # ---- chart
            if from_chart and (r["label"] is None or r["label_source"] not in ("same_line_left", "same_line_right")):
                c["approximate"] = True
                c["flags"].append("chart_number_not_tied_to_a_label: confirm on the slide image which bar/segment this is; keep approximate unless it is a printed data label for that bar")
            if only_metric and only_metric not in mets: continue
            cands.append(c)
    return {"slide_unit": slide_unit, "units_found": slide_units, "header_periods": [h["period"] or h["label"] for h in header],
            "periods_on_slide": sorted(all_periods), "candidates": cands, "excluded": excluded, "axis_ticks": axis, "warnings": warnings,
            "reminder": "Candidates only. Check each against the slide before writing a row; a flag means the script could not decide."}


def _self_test():
    table = load_table("metric-synonyms.json")
    checks = []
    def ok(name, cond, detail=None):
        checks.append({"check": name, "ok": bool(cond), **({"detail": detail} if not cond else {})})
    def pick(res, **kw):
        return [c for c in res["candidates"] if all(c.get(k) == v for k, v in kw.items())]

    t = "AUM and Disbursement trend (₹ crore)\nQ2 FY25  Q1 FY26  Q2 FY26  H1 FY26\nDisbursements 890 960 1,050 2,010\nAUM 10,460 11,870 12,345"
    r = extract(t, table, target_period="Q2FY26")
    d = pick(r, label="Disbursements")
    ok("table row maps onto the period header", [(c["value"], c["period"]) for c in d] == [(890.0, "Q2 FY25"), (960.0, "Q1 FY26"), (1050.0, "Q2 FY26"), (2010.0, "H1 FY26")], d)
    ok("the H1 figure is flagged as not a discrete quarter; the target quarter is marked", "not_a_discrete_quarter" in d[3]["flags"] and d[2]["is_target_period"] and not d[3]["is_target_period"])
    a = pick(r, label="AUM")
    ok("a row with fewer figures than header columns gets NO period (not guessed)", all(c["period"] is None and "period_ambiguous" in c["flags"] for c in a) and len(a) == 3, a)
    ok("metric candidates from the label", d[0]["metric_candidates"] == ["disbursements"] and a[0]["metric_candidates"] == ["aum"], (d[0]["metric_candidates"], a[0]["metric_candidates"]))

    t2 = "Trend (₹ crore)\n                 Q2 FY25   Q1 FY26   Q2 FY26   YoY    H1 FY26\nDisbursements        890       960     1,050   18%      2,010\nAUM               10,460    11,870    12,345   18%"
    r = extract(t2, table, target_period="Q2FY26")
    d = pick(r, label="Disbursements")
    ok("a YoY column inside the header is a column: its figure is a growth rate, the rest map to their periods",
       [(c["source_value"], c["period"], c["is_growth_rate"]) for c in d] == [(890.0, "Q2 FY25", False), (960.0, "Q1 FY26", False), (1050.0, "Q2 FY26", False), (18.0, None, True), (2010.0, "H1 FY26", False)], d)
    a = pick(r, label="AUM")
    ok("...and a row with a blank cell under that header stays period_ambiguous", all("period_ambiguous" in c["flags"] for c in a if not c["is_growth_rate"]) and len(a) == 4, a)
    r = extract("Key highlights – Q2 FY26\n₹ in million\nAUM 1,23,450 up 18.2% YoY\nDisbursements ₹ 10,500 mn; up 9% QoQ\nBranches 215  Employees 3,410\nGNPA 1.42%  Spread 3.5", table)
    a = pick(r, label="AUM")[0]
    ok("millions -> crore, Indian digit grouping, source kept", (a["value"], a["unit"], a["source_value"], a["source_unit"], a["period"]) == (12345.0, "crore", 123450.0, "million", "Q2 FY26"), a)
    g = [c for c in r["candidates"] if c["is_growth_rate"]]
    ok("growth rates are marked, with basis", [(c["source_value"], c["growth_basis"]) for c in g] == [(18.2, "yoy"), (9.0, "qoq")], g)
    ok("suffix on the number wins ('mn')", pick(r, label="Disbursements")[0]["value"] == 1050.0 and pick(r, label="Disbursements")[0]["unit_source"] == "number_suffix")
    b, e = pick(r, label="Branches")[0], pick(r, label="Employees")[0]
    ok("counts are counts, never converted by the slide's money unit", (b["value"], b["unit"], e["value"], e["unit"]) == (215.0, "count", 3410.0, "count"), (b, e))
    s = pick(r, label="Spread")[0]
    ok("a percent metric printed without % is not given a unit", s["value"] is None and "percent_metric_without_percent_sign" in s["flags"], s)
    ok("GNPA % read as percent", pick(r, label="GNPA")[0]["unit"] == "percent")

    r = extract("215 branches across 14 states\n3,410 on-roll employees", table)
    ok("number-first tiles take the label to the RIGHT", [(c["source_value"], c["label"]) for c in r["candidates"]] == [(215.0, "branches across"), (14.0, "states"), (3410.0, "on-roll employees")], r["candidates"])
    r = extract("215 branches across 14 states | 480 touchpoints | 3,410 employees | Disbursement per branch ₹ 4.9 Cr", table)
    got = [(c["source_value"], c["label"], c["unit"], c["metric_candidates"]) for c in r["candidates"]]
    ok("tiles separated by '|': labels stop at the separator; states/touchpoints are counts with a basis; 'per branch' is not disbursements",
       got == [(215.0, "branches across", "count", ["branches"]), (14.0, "states", "count", []), (480.0, "touchpoints", "count", []),
               (3410.0, "employees", "count", ["employees"]), (4.9, "Disbursement per branch", "crore", [])] and r["candidates"][2]["basis_candidates"] == {"branches": ["touchpoints"]}, r["candidates"])
    r = extract("₹ crore  Q2 FY26  H1 FY26\nCo-lending: partner's share of disbursements 45 80", table)
    ok("the partner's share of co-lending is a sell-down candidate, not disbursements", r["candidates"][0]["metric_candidates"] == ["sell_down_volume"], r["candidates"][0])
    r = extract("₹ 12,345 Cr\nAssets under management\n18%\nYoY growth", table)
    c0, c1 = r["candidates"]
    ok("big-number tile: label from the next line, flagged as adjacent", (c0["label"], c0["label_source"], c0["value"], c0["unit"]) == ("Assets under management", "next_line", 12345.0, "crore"), c0)
    ok("'YoY growth' label marks a growth rate", c1["is_growth_rate"] is True, c1)

    r = extract("Borrowings INR bn (US$ mn)\nTotal borrowings 98.5 (US$ 1,180 mn)\nNCDs 17.7", table)
    ok("two units on the slide -> unit unresolved, USD ignored", [c.get("ignored", False) for c in r["candidates"]] == [False, True, False] and
       "unit_unresolved" in r["candidates"][0]["flags"] and r["candidates"][0]["value"] is None and r["warnings"], r["candidates"])
    r = extract("Borrowings INR bn (US$ mn)\nTotal borrowings 98.5 (US$ 1,180 mn)", table, unit_override="billion")
    ok("--unit resolves it: billions x 100", r["candidates"][0]["value"] == 9850.0 and r["candidates"][0]["unit_source"] == "option", r["candidates"][0])

    r = extract("Asset quality ₹ crore\nGross Stage 3 175\nRestructured book 95\nOTR 2.0 outstanding 60", table)
    ok("restructured lines are excluded, not candidates; the 3 in 'Stage 3' is label, not value", len(r["excluded"]) == 2 and
       [(c["label"], c["value"]) for c in r["candidates"]] == [("Gross Stage 3", 175.0)], r)
    r = extract("Tier 1 capital 27.1%  30+ DPD 2.9%  Top 10 lenders 61%", table)
    ok("label digits: Tier 1, 30+ DPD, Top 10", [(c["label"], c["value"]) for c in r["candidates"]] == [("Tier 1 capital", 27.1), ("30+ DPD", 2.9), ("Top 10 lenders", 61.0)], r["candidates"])

    chart = "Disbursements (₹ crore)\n1,200\n900\n600\n300\n0\n890 960 1,050\nQ2 FY25 Q1 FY26 Q2 FY26"
    r = extract(chart, table, from_chart=True)
    ok("chart: a vertical axis (one tick per line) is recognised and kept out of the candidates", [x["values"] for x in r["axis_ticks"]] == [[1200.0, 900.0, 600.0, 300.0, 0.0]]
       and [c["source_value"] for c in r["candidates"]] == [890.0, 960.0, 1050.0] and all(c["approximate"] for c in r["candidates"]), r)
    r = extract("Disbursements (₹ crore)\n0 300 600 900 1,200\n890 960 1,050\nQ2 FY25 Q1 FY26 Q2 FY26", table, from_chart=True)
    ok("chart: evenly spaced run is an axis; data labels stay but are approximate (not tied to a label)", [x["values"] for x in r["axis_ticks"]] == [[0.0, 300.0, 600.0, 900.0, 1200.0]]
       and [c["source_value"] for c in r["candidates"]] == [890.0, 960.0, 1050.0] and all(c["approximate"] for c in r["candidates"]), r)
    ok("chart: category labels printed BELOW the bars give the periods", [(c["period"], c["period_source"]) for c in r["candidates"]] ==
       [("Q2 FY25", "category_labels_below"), ("Q1 FY26", "category_labels_below"), ("Q2 FY26", "category_labels_below")], r["candidates"])
    r = extract("Product mix\nIndividual housing 71%\nLAP 19%\nConstruction finance 10%", table, from_chart=True)
    ok("chart: a data label on its own labelled line is exact", [(c["label"], c["value"], c["approximate"]) for c in r["candidates"]] ==
       [("Individual housing", 71.0, False), ("LAP", 19.0, False), ("Construction finance", 10.0, False)], r["candidates"])
    r = extract("0 300 600 900", table, from_chart=False)
    ok("without --from-chart nothing is called an axis and nothing is approximate", r["axis_ticks"] == [] and all(not c["approximate"] for c in r["candidates"]))

    r = extract("Sell down during Q2 FY26 ₹ crore\nDirect assignment 180\nPortfolio buyout Nil", table)
    ok("'Nil' yields no number candidate (the model writes the nil row)", [c["label"] for c in r["candidates"]] == ["Direct assignment"] and r["candidates"][0]["metric_candidates"] == ["sell_down_volume"], r["candidates"])
    r = extract("Branches 215.5", table)
    ok("a fractional count is flagged", "count_not_a_non_negative_integer" in r["candidates"][0]["flags"])
    r = extract("Disbursements 1,050\nAUM 12,345", table, only_metric="aum")
    ok("--metric filter; no unit anywhere -> unresolved", len(r["candidates"]) == 1 and "unit_unresolved" in r["candidates"][0]["flags"] and "no_period_on_slide" in r["candidates"][0]["flags"], r["candidates"])
    r = extract("", table)
    ok("empty slide -> no candidates, no crash", r["candidates"] == [])
    return checks


def main():
    ap = argparse.ArgumentParser(description="Slide text -> labelled number candidates (label, value in Rs crore/percent/count, period). JSON on stdout.")
    ap.add_argument("--index", help="JSON from slide_index.py (built WITH text)")
    ap.add_argument("--slide", type=int, help="slide number in the index")
    ap.add_argument("--text-file", help="plain text of one slide ('-' for stdin)")
    ap.add_argument("--unit", choices=["crore", "lakh", "million", "billion", "thousand"], help="the slide's money unit, when you have read it and the script could not")
    ap.add_argument("--period", help="the quarter being read, e.g. Q2FY26; candidates get is_target_period")
    ap.add_argument("--metric", help="keep only candidates whose label matches this metric key")
    ap.add_argument("--from-chart", action="store_true", help="the numbers sit on a chart: detect axis scales, mark numbers not tied to a label as approximate")
    ap.add_argument("--self-test", action="store_true", help="run built-in cases (no input files) and exit 0 or 1")
    a = ap.parse_args()
    if a.self_test:
        checks = _self_test()
        bad = [c for c in checks if not c["ok"]]
        emit({"script": "extract_labelled_numbers.py", "passed": len(checks) - len(bad), "failed": len(bad), "failures": bad})
        sys.exit(1 if bad else 0)
    table = load_table("metric-synonyms.json")
    if a.metric and a.metric not in table["metrics"]:
        fail(f"unknown metric key {a.metric!r}; known: {sorted(table['metrics'])}")
    meta = {}
    if a.text_file:
        text = sys.stdin.read() if a.text_file == "-" else open(a.text_file, encoding="utf-8").read()
    elif a.index and a.slide:
        try: index = json.load(open(a.index, encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as x: fail(f"cannot read the slide index: {x}")
        s = next((s for s in index.get("slides", []) if s.get("slide") == a.slide), None)
        if s is None: fail(f"slide {a.slide} is not in the index (it has {index.get('slide_count')} slides)")
        if s.get("excluded"): fail(f"slide {a.slide} is a restructured-book slide; the analysts exclude it, nothing is extracted", 6)
        if "text" not in s: fail("the index was built with --no-text; rebuild it without that flag")
        if s.get("image_only"): fail(f"slide {a.slide} has no text layer; read it as a chart (chart-only-figures skill) and mark what you read approximate", 6)
        text, meta = s["text"], {"document": index.get("document"), "slide": a.slide, "title": s.get("title")}
    else:
        fail("give --index with --slide, or --text-file, or --self-test")
    out = extract(text, table, a.unit, a.period, a.from_chart, a.metric)
    emit({**meta, **out})


if __name__ == "__main__":
    main()
