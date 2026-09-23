#!/usr/bin/env python3
"""Validate a Reg 31 shareholding extract, and compare it with the previous quarter's.

    python3 /workspace/scripts/validate_shareholding.py /workspace/out/shareholding.json
    python3 /workspace/scripts/validate_shareholding.py /workspace/out/shareholding.json --previous /workspace/in/prev.json

Schema (schemas/shareholding.schema.json) plus:
- as_on is a quarter end and agrees with period
- category shares add up to total_shares exactly; category percentages add up to 100 within 0.05
- each pct agrees with shares / total_shares within 0.02 percentage points
- pledged / encumbered shares do not exceed the promoter holding, and the two pledge percentages agree with the counts
- the public breakdown does not exceed the public category; named holders do not exceed their category
- status 'nil' means zero pledged shares; 'not_disclosed' means no number is given
With --previous: the quarter-on-quarter change per category in shares and percentage points, the change in pledged
shares, and whether the promoter holding crossed a band edge (26 / 50 / 75 percent). The previous file must be the
immediately preceding quarter, otherwise the comparison is refused (it would not be quarter-on-quarter).
The comparison states the change; it does not call it good or bad.
Exit 0 valid, 1 invalid. JSON on stdout.
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, json
from finlib import periods, schema

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_PATH = os.path.join(HERE, "..", "schemas", "shareholding.schema.json")
BANDS = (26.0, 50.0, 75.0)


def validate(doc):
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        errors = list(schema.validate(doc, json.load(f)))
    if errors:
        return {"valid": False, "errors": errors, "warnings": []}
    warnings = []
    p = periods.normalise(doc["period"]); end = periods.normalise("Quarter ended " + ".".join(reversed(doc["as_on"].split("-"))))
    if not end:
        errors.append(f"as_on {doc['as_on']} is not a quarter end")
    elif end["period"] != p["period"]:
        errors.append(f"as_on {doc['as_on']} is {end['period']} but period says {doc['period']}")
    elif doc["as_on"][8:] not in ("30", "31"):
        errors.append(f"as_on {doc['as_on']} is not the last day of the quarter")
    total, cats = doc["total_shares"], doc["categories"]
    s = sum(c["shares"] for c in cats.values())
    if s != total:
        errors.append(f"category shares add up to {s}, total_shares is {total} (difference {s - total})")
    pct = sum(c["pct"] for c in cats.values())
    if abs(pct - 100.0) > 0.05:
        errors.append(f"category percentages add up to {pct:.2f}, not 100")
    for name, c in cats.items():
        if abs(c["shares"] / total * 100 - c["pct"]) > 0.02:
            errors.append(f"{name}: pct {c['pct']} does not agree with {c['shares']} / {total} = {c['shares'] / total * 100:.2f}")
    enc, prom = doc["promoter_encumbrance"], cats["promoter_and_promoter_group"]
    n = enc.get("pledged_or_encumbered_shares")
    if enc["status"] == "nil" and n not in (0, None):
        errors.append("promoter_encumbrance: status nil with a non-zero share count")
    if enc["status"] == "not_disclosed" and n is not None:
        errors.append("promoter_encumbrance: status not_disclosed must not carry a share count")
    if enc["status"] == "disclosed":
        if n > prom["shares"]:
            errors.append(f"pledged/encumbered shares {n} exceed the promoter holding {prom['shares']}")
        for key, base in (("pct_of_promoter_holding", prom["shares"]), ("pct_of_total_shares", total)):
            v = enc.get(key)
            if v is not None and base and abs(n / base * 100 - v) > 0.02:
                errors.append(f"promoter_encumbrance.{key} {v} does not agree with {n} / {base} = {n / base * 100:.2f}")
    pub = sum(b["shares"] for b in doc.get("public_breakdown") or [])
    if pub > cats["public"]["shares"]:
        errors.append(f"public_breakdown adds up to {pub}, more than the public category {cats['public']['shares']}")
    elif doc.get("public_breakdown") and pub < cats["public"]["shares"]:
        warnings.append(f"public_breakdown covers {pub} of {cats['public']['shares']} public shares; the rest is not broken down")
    groups = [b["group"] for b in doc.get("public_breakdown") or [] if b["group"] != "others"]
    if len(groups) != len(set(groups)):
        errors.append("public_breakdown repeats a group")
    for cname, c in cats.items():
        held = sum(h["shares"] for h in doc.get("significant_holders") or [] if h["category"] == cname)
        if held > c["shares"]:
            errors.append(f"named holders in {cname} add up to {held}, more than the category {c['shares']}")
    return {"valid": not errors, "errors": errors, "warnings": warnings}


def compare(cur, prev):
    if cur["customer_id"] != prev["customer_id"]:
        raise ValueError("the two files are for different companies")
    want = periods.previous_quarter(cur["period"])
    if prev["period"] != want:
        raise ValueError(f"--previous is {prev['period']}; the quarter before {cur['period']} is {want}. Not a quarter-on-quarter comparison.")
    out = {"period": cur["period"], "previous_period": prev["period"], "total_shares_change": cur["total_shares"] - prev["total_shares"], "categories": {}, "notes": []}
    for name in ("promoter_and_promoter_group", "public", "non_promoter_non_public"):
        a, b = cur["categories"].get(name), prev["categories"].get(name)
        if a is None and b is None: continue
        a, b = a or {"shares": 0, "pct": 0.0}, b or {"shares": 0, "pct": 0.0}
        out["categories"][name] = {"shares_change": a["shares"] - b["shares"], "pct_point_change": round(a["pct"] - b["pct"], 2), "pct": a["pct"], "previous_pct": b["pct"]}
    a, b = cur["categories"]["promoter_and_promoter_group"]["pct"], prev["categories"]["promoter_and_promoter_group"]["pct"]
    crossed = [x for x in BANDS if (a - x) * (b - x) < 0 or (a == x) != (b == x)]
    out["promoter_band_crossed"] = crossed
    if crossed:
        out["notes"].append(f"promoter holding moved from {b}% to {a}%, across {crossed}%: a standing fact for the company record (upsert_company)")
    if out["total_shares_change"]:
        out["notes"].append("total shares changed: a percentage can move without anyone buying or selling (allotment, ESOP exercise, buy-back)")
    ea, eb = cur["promoter_encumbrance"], prev["promoter_encumbrance"]
    if "not_disclosed" in (ea["status"], eb["status"]):
        out["pledged_shares_change"] = None; out["notes"].append("pledge not disclosed in one of the two quarters; no change computed")
    else:
        out["pledged_shares_change"] = (ea.get("pledged_or_encumbered_shares") or 0) - (eb.get("pledged_or_encumbered_shares") or 0)
    return out


def _example(period="Q2 FY26", as_on="2025-09-30", promoter=48_000_000, pledged=4_800_000):
    total = 100_000_000; public = total - promoter - 1_000_000
    return {"customer_id": "example-housing-finance", "source_path": "Companies/example-housing-finance/filings/lodr/2025-10-15_reg31_shareholding_shareholding-pattern.pdf",
            "as_on": as_on, "period": period, "total_shares": total,
            "categories": {"promoter_and_promoter_group": {"holders": 3, "shares": promoter, "pct": round(promoter / total * 100, 2)},
                           "public": {"holders": 85_000, "shares": public, "pct": round(public / total * 100, 2)},
                           "non_promoter_non_public": {"holders": 1, "shares": 1_000_000, "pct": 1.0}},
            "promoter_encumbrance": {"status": "disclosed", "pledged_or_encumbered_shares": pledged, "pct_of_promoter_holding": round(pledged / promoter * 100, 2),
                                     "pct_of_total_shares": round(pledged / total * 100, 2), "page": 3},
            "public_breakdown": [{"group": "mutual_funds", "shares": 12_000_000, "pct": 12.0, "page": 4}, {"group": "foreign_portfolio_investors", "shares": 18_000_000, "pct": 18.0, "page": 4}],
            "significant_holders": [{"name": "Example Promoter Holdings Pvt Ltd", "category": "promoter_and_promoter_group", "shares": promoter - 1000, "pct": round((promoter - 1000) / total * 100, 2), "page": 3}],
            "page": 2, "extracted_at": "2025-10-16T06:00:00Z"}


def _self_test():
    import copy
    n = 0
    good = _example(); r = validate(good); assert r["valid"] and len(r["warnings"]) == 1, r; n += 1

    def bad(mutate, expect):
        d = copy.deepcopy(good); mutate(d); r = validate(d)
        assert not r["valid"] and any(expect in x for x in r["errors"]), (expect, r["errors"]); return 1
    n += bad(lambda d: d["categories"]["public"].update(shares=50_000_000), "category shares add up to")
    n += bad(lambda d: d["categories"]["public"].update(pct=55.0), "percentages add up to")
    n += bad(lambda d: d["promoter_encumbrance"].update(pledged_or_encumbered_shares=49_000_000), "exceed the promoter holding")
    n += bad(lambda d: d["promoter_encumbrance"].update(pct_of_promoter_holding=4.8), "does not agree with")     # % of total written as % of promoter holding
    n += bad(lambda d: d["promoter_encumbrance"].update(status="nil"), "status nil with a non-zero")
    n += bad(lambda d: d["promoter_encumbrance"].pop("page"), "missing required 'page'")
    n += bad(lambda d: d.update(as_on="2025-10-15"), "is not a quarter end")
    n += bad(lambda d: d.update(period="Q3 FY26"), "but period says")
    n += bad(lambda d: d["public_breakdown"].append({"group": "insurance_companies", "shares": 30_000_000, "pct": 30.0}), "more than the public category")
    n += bad(lambda d: d["significant_holders"][0].update(shares=60_000_000, pct=60.0), "named holders")
    n += bad(lambda d: d["categories"].pop("public"), "missing required 'public'")
    # quarter-on-quarter
    prev = _example("Q1 FY26", "2025-06-30", promoter=50_500_000, pledged=2_000_000)
    c = compare(good, prev)
    assert c["categories"]["promoter_and_promoter_group"] == {"shares_change": -2_500_000, "pct_point_change": -2.5, "pct": 48.0, "previous_pct": 50.5}; n += 1
    assert c["promoter_band_crossed"] == [50.0] and c["pledged_shares_change"] == 2_800_000 and any("upsert_company" in x for x in c["notes"]); n += 1
    try:
        compare(good, _example("Q4 FY25", "2025-03-31"))
    except ValueError as x:
        assert "Not a quarter-on-quarter" in str(x); n += 1
    else:
        raise AssertionError("compared against a non-adjacent quarter")
    nd = copy.deepcopy(prev); nd["promoter_encumbrance"] = {"status": "not_disclosed"}
    assert validate(nd)["valid"] and compare(good, nd)["pledged_shares_change"] is None; n += 1
    return n


def main():
    ap = argparse.ArgumentParser(description="Validate a Reg 31 shareholding extract; with --previous, report the quarter-on-quarter change.")
    ap.add_argument("file", nargs="?"); ap.add_argument("--previous", help="the previous quarter's validated shareholding extract")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        try:
            n = _self_test()
        except AssertionError as x:
            print(f"FAIL validate_shareholding: {x}", file=sys.stderr); return 1
        print(json.dumps({"self_test": "ok", "script": "validate_shareholding", "cases": n})); return 0
    docs = []
    for path in [a.file] + ([a.previous] if a.previous else []):
        if not path or not os.path.isfile(path):
            print(f"no such file: {path}", file=sys.stderr); return 2
        try:
            with open(path, encoding="utf-8") as f:
                docs.append(json.load(f))
        except ValueError as x:
            print(f"{path} is not JSON: {x}", file=sys.stderr); return 2
    rep = validate(docs[0]); rep["file"] = a.file
    if a.previous and rep["valid"]:
        pv = validate(docs[1])
        if not pv["valid"]:
            rep["comparison_refused"] = ["--previous is itself invalid"] + pv["errors"]
        else:
            try:
                rep["comparison"] = compare(docs[0], docs[1])
            except ValueError as x:
                rep["comparison_refused"] = [str(x)]
    print(json.dumps(rep, ensure_ascii=False))
    if not rep["valid"]:
        print(f"shareholding extract INVALID: {len(rep['errors'])} problem(s); do not write it", file=sys.stderr); return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
