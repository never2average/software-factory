#!/usr/bin/env python3
"""Which slides are worth reading for a metric?

  python3 /workspace/scripts/find_metric_slides.py --index /workspace/out/slide-index.json --metric sell_down_volume
  python3 /workspace/scripts/find_metric_slides.py --index /workspace/out/slide-index.json --all
  python3 /workspace/scripts/find_metric_slides.py --list-metrics

Takes the JSON written by slide_index.py and the synonym table references/metric-synonyms.json (the same table the
operational-metrics skill shows). Returns candidate slides ranked by score, each with the phrases that matched and
where (title or body). It finds places to read; it does not read the number. No candidate means "not found by label",
which is a reason to look at the image-only slides it lists, not proof that the deck omits the metric.

Scoring: a synonym in the title 5 (3 for a synonym of three letters or fewer), in the body 2 (1), each phrase once;
+3 when the slide's section is one the metric usually sits in; +3 for an appendix slide when the metric is an appendix
metric (sell down, buy out). Phrases listed under "not" (e.g. 'disbursement per branch', 'share buyback') are blanked
before matching. Restructured-book slides are never candidates.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, json
from iplib import emit, fail, load_table, find_phrases, phrase_regex


def _blank(text, phrases):
    for p in phrases:
        text = phrase_regex(p).sub(lambda m: " " * len(m.group(0)), text)
    return text


def score_slide(slide, spec):
    title = _blank(slide.get("title") or "", spec.get("not", []))
    body = _blank(slide.get("text") or "", spec.get("not", []))
    in_title = find_phrases(title, spec["synonyms"])
    in_body = [p for p in find_phrases(body, spec["synonyms"]) if p not in in_title]
    if not in_title and not in_body:
        return None
    w = lambda p, long, short: short if len(p) <= 3 else long
    score = min(10, sum(w(p, 5, 3) for p in in_title)) + min(8, sum(w(p, 2, 1) for p in in_body))
    reasons = []
    pref = spec.get("preferred_sections", [])
    if slide.get("section") in pref:
        score += 3; reasons.append(f"section '{slide['section']}' is a usual place for this metric")
    if slide.get("in_appendix") and "appendix" in pref:
        score += 3; reasons.append("slide is in the appendix, where this metric is usually disclosed")
    out = {"slide": slide["slide"], "title": slide.get("title"), "score": score,
           "matched": [{"phrase": p, "where": "title"} for p in in_title] + [{"phrase": p, "where": "body"} for p in in_body],
           "section": slide.get("section"), "in_appendix": bool(slide.get("in_appendix")), "unit": slide.get("unit"),
           "units_found": slide.get("units_found", []), "mixed_periods": bool(slide.get("mixed_periods")),
           "periods": [p.get("period") or p.get("label") for p in slide.get("periods", [])], "reasons": reasons}
    if "basis_variants" in spec:
        out["basis_hits"] = {b: find_phrases(body + "\n" + title, ph) for b, ph in spec["basis_variants"].items() if find_phrases(body + "\n" + title, ph)}
    if slide.get("restructured_mentions"):
        out["caution"] = "this slide also mentions a restructured book; skip those lines"
    return out


def find(index, metric, table, limit=8):
    spec = table["metrics"][metric]
    cands, excluded = [], []
    for s in index["slides"]:
        if s.get("excluded"):
            if score_slide(s, spec): excluded.append({"slide": s["slide"], "title": s.get("title"), "reason": table["excluded"]["restructured_book"]["reason"]})
            continue
        c = score_slide(s, spec)
        if c: cands.append(c)
    cands.sort(key=lambda c: (-c["score"], c["slide"]))
    unsearch = [s["slide"] for s in index["slides"] if s.get("image_only")]
    no_text = all("text" not in s for s in index["slides"]) if index["slides"] else False
    out = {"metric": metric, "class": spec["class"], "status": "candidates" if cands else "not_found_by_label",
           "candidates": cands[:limit], "more_candidates": max(0, len(cands) - limit), "excluded_slides": excluded,
           "unsearchable_slides": unsearch}
    if no_text:
        out["warning"] = "the index was built with --no-text, so only titles were searched"
    if not cands:
        out["next"] = ("No label matched. Read the image-only slides listed in unsearchable_slides (chart-only-figures skill); if the metric "
                       "is still absent, write a not_disclosed row. For branches/employees also give the previous quarter's IP value.")
    return out


_INDEX = {"document": "synthetic", "kind": "text", "slide_count": 8, "slides": [
    {"slide": 1, "title": "Key Highlights – Q2 FY26", "section": "highlights", "in_appendix": False, "excluded": False, "image_only": False, "unit": "crore",
     "units_found": ["crore"], "periods": [{"label": "Q2 FY26", "period": "Q2 FY26", "kind": "quarter"}],
     "text": "Key Highlights – Q2 FY26\nAUM 12,345 Disbursements 1,050\n215 branches across 14 states 3,410 employees\nDisbursement per branch 4.9"},
    {"slide": 2, "title": "Pan-India distribution network", "section": "network", "in_appendix": False, "excluded": False, "image_only": False, "unit": None,
     "units_found": [], "periods": [], "text": "Pan-India distribution network\nBranches 215 Locations 162 Touchpoints 480 Districts 140\nOn-roll employees 3,410"},
    {"slide": 3, "title": "AUM and Disbursement trend", "section": "aum_disbursements", "in_appendix": False, "excluded": False, "image_only": False, "unit": "crore",
     "units_found": ["crore"], "mixed_periods": True, "periods": [], "text": "AUM and Disbursement trend\nDisbursements 890 960 1,050 2,010\nOn-book 10,900 Off-book 1,445"},
    {"slide": 4, "title": "Capital management", "section": "capital", "in_appendix": False, "excluded": False, "image_only": False, "unit": None,
     "units_found": [], "periods": [], "text": "Capital management\nShare buyback completed in Q1\nCRAR 28.4%"},
    {"slide": 5, "title": None, "section": None, "in_appendix": False, "excluded": False, "image_only": True, "unit": None, "units_found": [], "periods": [], "text": ""},
    {"slide": 6, "title": "Appendix", "section": "appendix", "in_appendix": True, "excluded": False, "image_only": True, "unit": None, "units_found": [], "periods": [], "text": "Appendix"},
    {"slide": 7, "title": "Details of loans transferred and acquired", "section": "appendix", "in_appendix": True, "excluded": False, "image_only": False, "unit": "crore",
     "units_found": ["crore"], "periods": [], "text": "Details of loans transferred and acquired\nLoans assigned during the quarter 180\nDirect assignment 180 Co-lending volume 45\nPortfolio buyout Nil"},
    {"slide": 8, "title": "Restructured book", "section": "restructured_book", "in_appendix": True, "excluded": True, "image_only": False, "unit": "crore",
     "units_found": ["crore"], "periods": [], "restructured_mentions": True, "text": "Restructured book\nRestructured loan book 95\nLoans assigned from restructured pool 4"},
]}


def _self_test():
    table = load_table("metric-synonyms.json")
    checks = []
    def ok(name, cond, detail=None):
        checks.append({"check": name, "ok": bool(cond), **({"detail": detail} if not cond else {})})

    r = find(_INDEX, "branches", table)
    ok("branches: network slide ranks first, highlights second", [c["slide"] for c in r["candidates"]][:2] == [2, 1], [(c["slide"], c["score"]) for c in r["candidates"]])
    ok("branches: basis variants on the slide are reported", set(r["candidates"][0].get("basis_hits", {})) == {"branches", "locations", "touchpoints", "districts"}, r["candidates"][0].get("basis_hits"))
    ok("matched phrase and where are given", {"phrase": "distribution network", "where": "title"} in r["candidates"][0]["matched"], r["candidates"][0]["matched"])

    r = find(_INDEX, "disbursements", table)
    ok("disbursements: trend slide first; 'disbursement per branch' does not count as a hit", [c["slide"] for c in r["candidates"]][:1] == [3] and
       all(m["phrase"] != "disbursement" for c in r["candidates"] if c["slide"] == 1 for m in c["matched"]), r["candidates"])
    ok("mixed-period flag is carried to the candidate", r["candidates"][0]["mixed_periods"] is True)

    r = find(_INDEX, "sell_down_volume", table)
    ok("sell down: appendix slide found with appendix bonus", r["candidates"][0]["slide"] == 7 and any("appendix" in x for x in r["candidates"][0]["reasons"]), r["candidates"])
    ok("sell down: restructured slide never a candidate, listed as excluded", all(c["slide"] != 8 for c in r["candidates"]) and [e["slide"] for e in r["excluded_slides"]] == [8], r)

    r = find(_INDEX, "buy_out_volume", table)
    ok("buy out: 'share buyback' slide is not a candidate", [c["slide"] for c in r["candidates"]] == [7], [c["slide"] for c in r["candidates"]])

    r = find(_INDEX, "off_book_aum", table)
    ok("off-book found on the trend slide", [c["slide"] for c in r["candidates"]] == [3], r["candidates"])

    r = find(_INDEX, "avg_ltv", table)
    ok("no label match -> not_found_by_label, image-only slides listed, next step given", r["status"] == "not_found_by_label" and r["unsearchable_slides"] == [5, 6] and "not_disclosed" in r["next"], r)

    idx = {"slides": [{k: v for k, v in s.items() if k != "text"} for s in _INDEX["slides"]]}
    r = find(idx, "employees", table)
    ok("--no-text index: warns that only titles were searched", "warning" in r and r["status"] == "not_found_by_label", r)

    ok("every metric has synonyms, a class and preferred sections", all(m.get("synonyms") and m.get("class") in ("count", "amount", "percent", "percent_or_amount")
       and "preferred_sections" in m for m in table["metrics"].values()))
    ok("core metrics exist in the table", all(k in table["metrics"] for k in table["core_metrics"]))
    return checks


def main():
    ap = argparse.ArgumentParser(description="Rank the slides of an indexed deck for a metric, using the label synonym table. JSON on stdout.")
    ap.add_argument("--index", help="JSON written by slide_index.py ('-' for stdin)")
    ap.add_argument("--metric", action="append", help="metric key (repeatable); see --list-metrics")
    ap.add_argument("--all", action="store_true", help="every metric in the table")
    ap.add_argument("--core", action="store_true", help="the core metrics hfc-kpi-extraction needs")
    ap.add_argument("--limit", type=int, default=8, help="candidates per metric (default 8)")
    ap.add_argument("--list-metrics", action="store_true", help="print the metric keys and exit")
    ap.add_argument("--self-test", action="store_true", help="run built-in cases (no input files) and exit 0 or 1")
    a = ap.parse_args()
    if a.self_test:
        checks = _self_test()
        bad = [c for c in checks if not c["ok"]]
        emit({"script": "find_metric_slides.py", "passed": len(checks) - len(bad), "failed": len(bad), "failures": bad})
        sys.exit(1 if bad else 0)
    table = load_table("metric-synonyms.json")
    if a.list_metrics:
        emit({"metrics": {k: v["class"] for k, v in table["metrics"].items()}, "core_metrics": table["core_metrics"]}); return
    if not a.index:
        fail("give --index <slide-index.json>, or --list-metrics, or --self-test")
    try:
        index = json.load(sys.stdin) if a.index == "-" else json.load(open(a.index, encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as x:
        fail(f"cannot read the slide index: {x}")
    if not isinstance(index, dict) or not isinstance(index.get("slides"), list):
        fail("that file is not a slide index (no 'slides' list); build it with slide_index.py")
    keys = list(table["metrics"]) if a.all else list(table["core_metrics"]) if a.core else (a.metric or [])
    if not keys:
        fail("name a metric with --metric, or use --core / --all")
    unknown = [k for k in keys if k not in table["metrics"]]
    if unknown:
        fail(f"unknown metric key(s) {unknown}; known: {sorted(table['metrics'])}")
    emit({"document": index.get("document"), "results": [find(index, k, table, a.limit) for k in keys]})


if __name__ == "__main__":
    main()
