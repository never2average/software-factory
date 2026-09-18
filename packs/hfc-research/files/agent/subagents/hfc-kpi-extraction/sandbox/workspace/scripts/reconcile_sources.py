#!/usr/bin/env python3
"""Choose between the Quarterly Report (QR) value and the Investor Presentation (IP) value of one KPI, by the
analysts' rulebook.

  python3 /workspace/scripts/reconcile_sources.py --request request.json
  echo '{"kpi":"disbursements","period":"Q2 FY26","listing":"listed",
         "qr":{"value":"1,88,000","unit":"lakh","document":"Customers/example-hfl/filings/lodr/q2fy26-results.pdf","page_or_slide":7},
         "ip":{"value":"1,900","unit":"crore","document":"Customers/example-hfl/filings/presentations/q2fy26-ip.pdf","page_or_slide":"slide 9"}}' \
      | python3 /workspace/scripts/reconcile_sources.py --stdin
  python3 /workspace/scripts/reconcile_sources.py --self-test

Rules implemented (schemas/kpi-spec.md)
  Listed company
    - one source has the KPI              -> that source, status ok (a note says when it is not the preferred source)
    - both have it, values equal          -> the PREFERRED source is cited: IP for operational KPIs (branches, employees,
                                             disbursements, AUM), QR for financial KPIs
    - both have it, differ by <= 5%       -> the QR value, status ok, footnote shows the IP value and the difference
    - both have it, differ by  > 5%       -> the QR value, status needs_review, footnote shows BOTH values (open point in the spec)
  Unlisted company (debt-listed HFC / subsidiary)
    - LODR filing (qr) first, the parent's investor presentation (parent_ip) second, source 'parent IP'.
    - both present: the same 5% rule, against the parent IP value.
  The percentage difference is |QR - IP| / |QR| x 100 after BOTH values are converted to the same unit (Rs crore for amounts).
  A candidate whose period is not the requested quarter, or whose value is blank/unparseable, is not compared; it is listed
  under `ignored` with the reason. Nothing is chosen by guesswork: with no usable candidate the status is not_found.
Exit 0 = a decision was produced (including not_found); 1 = the request is invalid; 2 = bad usage.
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, json
from finlib import numbers, periods, schema
import kpi_catalog, convert_units

SCHEMA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "schemas", "reconcile-request.schema.json")
RULEBOOK_TOLERANCE = 5.0


def _load_schema():
    with open(SCHEMA, encoding="utf-8") as f: return json.load(f)


def _usable(name, cand, entry, target):
    """-> (value_in_kpi_unit | None, reason_ignored | None)"""
    if cand is None: return None, None
    raw = cand.get("value")
    if cand.get("period"):
        p = periods.normalise(cand["period"])
        if p is None: return None, f"{name}: period {cand['period']!r} cannot be read"
        if p["period"] != target:
            return None, f"{name}: value belongs to {p['period']}, not {target}; a different period is never compared (use the carry-forward rule instead)"
    if entry["unit"] == kpi_catalog.UNIT_CRORE:
        r = convert_units.convert({"value": raw, "unit": cand.get("unit"), "header": cand.get("header")}, decimals=entry["decimals"])
        if not r["ok"]: return None, f"{name}: {r['problem']}"
        return r["crore"], None
    if cand.get("unit") in ("crore", "lakh", "million", "billion", "thousand", "rupee"):
        return None, f"{name}: {entry['key']} is reported in {entry['unit']}, but the candidate carries the currency unit {cand['unit']!r}"
    v, problem = convert_units.parse_printed(raw)
    if v is None: return None, f"{name}: {problem}"
    if entry["unit"] == kpi_catalog.UNIT_COUNT and v != int(v): return None, f"{name}: a count must be a whole number, got {raw!r}"
    return v, None


def _cite(cand): return {"document": cand.get("document"), "page_or_slide": cand.get("page_or_slide")}


def _fmt(v, entry):
    d = 0 if entry["unit"] == kpi_catalog.UNIT_COUNT else entry["decimals"]
    s = f"{v:,.{d}f}"
    return {"₹ crore": f"₹{s} crore", "%": f"{s}%", "x": f"{s}x", "count": s}[entry["unit"]]


def reconcile(req):
    problems = schema.validate(req, _load_schema())
    if problems: return {"ok": False, "problems": problems}
    entry = kpi_catalog.BY_KEY[req["kpi"]]
    if entry["source_pref"] == "computed":
        return {"ok": False, "problems": [f"{req['kpi']} is computed from extracted inputs with compute_kpis.py, never reconciled between sources; "
                                         "put the company's own published figure in compute_kpis' `published` input so it is footnoted"]}
    target = periods.normalise(req["period"])["period"]
    tol = req.get("tolerance_pct", RULEBOOK_TOLERANCE)
    listed = req["listing"] == "listed"
    second_name, second_source = ("ip", "IP") if listed else ("parent_ip", "parent IP")
    ignored = []
    if listed and req.get("parent_ip") is not None: ignored.append("parent_ip: a listed company's own documents are used; the parent's presentation is for unlisted companies only")
    if not listed and req.get("ip") is not None:
        ignored.append("ip: an unlisted company's sources are its LODR filing, then the PARENT's investor presentation; pass that as parent_ip. "
                       "(If the company publishes its own presentation, tell the analyst: the rulebook does not rank it.)")
    qv, why = _usable("qr", req.get("qr"), entry, target)
    if why: ignored.append(why)
    sv, why = _usable(second_name, req.get(second_name), entry, target)
    if why: ignored.append(why)
    preferred = "QR" if (not listed or entry["source_pref"] == "QR") else "IP"
    out = {"ok": True, "kpi": entry["key"], "category": entry["category"], "unit": entry["unit"], "period": target, "listing": req["listing"],
           "nature": entry["nature"], "preferred_source": preferred if listed else "QR", "tolerance_pct": tol,
           "value": None, "source": None, "document": None, "page_or_slide": None, "status": "not_found", "pct_diff": None,
           "alt_value": None, "alt_source": None, "footnote": "", "note": "", "ignored": ignored}
    d = 0 if entry["unit"] == kpi_catalog.UNIT_COUNT else entry["decimals"]
    rnd = lambda v: int(round(v)) if entry["unit"] == kpi_catalog.UNIT_COUNT else round(v, d)
    if qv is None and sv is None:
        out["note"] = "no usable candidate for the requested quarter" + ("; see `ignored`" if ignored else "")
        out["footnote"] = f"Not found in the {'quarterly results or the investor presentation' if listed else 'LODR filing or the parent’s investor presentation'} for {target}."
        return out
    if sv is None:
        out.update(value=rnd(qv), source="QR", status="ok", **_cite(req["qr"]))
        if listed and preferred == "IP": out["note"] = f"{entry['label']} is an operational metric normally taken from the IP; only the QR gives it for {target}"
        return out
    if qv is None:
        out.update(value=rnd(sv), source=second_source, status="ok", **_cite(req[second_name]))
        if not listed:
            out["footnote"] = f"Not disclosed in the company's LODR filing; taken from the parent company's investor presentation ({req[second_name].get('document')})."
        elif preferred == "QR": out["note"] = f"{entry['label']} is a financial metric normally taken from the QR; only the IP gives it for {target}"
        return out
    diff = numbers.pct_diff(qv, sv)
    bases = (req["qr"].get("basis"), req[second_name].get("basis"))
    basis_note = (f" The QR figure is {bases[0]} and the {second_source} figure is {bases[1]}, which may explain the difference." if all(bases) and bases[0] != bases[1] else "")
    defs = (req["qr"].get("definition"), req[second_name].get("definition"))
    def_note = (f" Definitions differ: QR '{defs[0]}', {second_source} '{defs[1]}'." if all(defs) and defs[0] != defs[1] else "")
    if rnd(qv) == rnd(sv):
        use_second = listed and preferred == "IP"
        out.update(value=rnd(sv if use_second else qv), source=second_source if use_second else "QR", status="ok", pct_diff=0.0,
                   **_cite(req[second_name] if use_second else req["qr"]))
        out["note"] = f"QR and {second_source} agree"; return out
    if diff is None:   # QR value is zero and the other is not
        out.update(value=rnd(qv), source="QR", status="needs_review", alt_value=rnd(sv), alt_source=second_source, **_cite(req["qr"]))
        out["footnote"] = (f"QR shows {_fmt(qv, entry)} and the {second_source} shows {_fmt(sv, entry)}; a percentage difference cannot be computed on a zero base. "
                           f"QR value reported pending analyst review.{basis_note}{def_note}")
        return out
    diff = round(diff, 6)
    out.update(value=rnd(qv), source="QR", pct_diff=round(diff, 2), alt_value=rnd(sv), alt_source=second_source, **_cite(req["qr"]))
    if diff <= tol:
        out["status"] = "ok"
        out["footnote"] = (f"QR {_fmt(qv, entry)} vs {second_source} {_fmt(sv, entry)} ({diff:.2f}% apart, within the {tol:g}% tolerance): QR value used.{basis_note}{def_note}")
    else:
        out["status"] = "needs_review"
        out["footnote"] = (f"QR {_fmt(qv, entry)} vs {second_source} {_fmt(sv, entry)} ({second_source}: {req[second_name].get('document')}, {req[second_name].get('page_or_slide')}) "
                           f"differ by {diff:.2f}%, more than the {tol:g}% tolerance. QR value shown; needs analyst review.{basis_note}{def_note}")
    return out


def _self_test():
    fails = []
    def eq(name, got, want):
        if got != want: fails.append(f"{name}: got {got!r}, want {want!r}")
    QR = {"document": "Customers/example-hfl/filings/lodr/q2fy26-results.pdf", "page_or_slide": 7}
    IP = {"document": "Customers/example-hfl/filings/presentations/q2fy26-ip.pdf", "page_or_slide": "slide 9"}
    base = {"period": "Q2 FY26", "listing": "listed"}
    def run(kpi, qr=None, ip=None, **kw):
        req = dict(base, kpi=kpi, **kw)
        if qr is not None: req["qr"] = dict(QR, **qr)
        if ip is not None: req["parent_ip" if req["listing"] == "unlisted" else "ip"] = dict(IP, **ip)
        return reconcile(req)
    r = run("disbursements", {"value": "1,88,000", "unit": "lakh"}, {"value": "1,900", "unit": "crore"})
    eq("operational, 1.06% apart -> QR ok", (r["value"], r["source"], r["status"], r["pct_diff"]), (1880.0, "QR", "ok", 1.06))
    eq("within-tolerance footnote shows IP", "IP ₹1,900.00 crore" in r["footnote"] and "within the 5% tolerance" in r["footnote"], True)
    r = run("disbursements", {"value": "1,900", "unit": "crore"}, {"value": "19.0", "header": "INR bn"})
    eq("equal after unit conversion -> preferred IP cited", (r["value"], r["source"], r["status"], r["page_or_slide"]), (1900.0, "IP", "ok", "slide 9"))
    r = run("gnpa_pct", {"value": "1.82%"}, {"value": "1.82"})
    eq("equal financial -> QR cited", (r["source"], r["status"], r["footnote"]), ("QR", "ok", ""))
    r = run("gnpa_pct", {"value": "1.82%"}, {"value": "1.20%", "definition": "GNPA on AUM"})
    eq(">5% -> needs_review with both", (r["value"], r["status"], r["alt_value"], r["alt_source"], "1.82%" in r["footnote"] and "1.20%" in r["footnote"]),
       (1.82, "needs_review", 1.2, "IP", True))
    r = run("networth", {"value": 1000, "unit": "crore"}, {"value": 1050, "unit": "crore"})
    eq("exactly 5% is within tolerance", (r["status"], r["pct_diff"], r["value"]), ("ok", 5.0, 1000.0))
    r = run("networth", {"value": 1000, "unit": "crore"}, {"value": 1050.1, "unit": "crore"})
    eq("5.01% is outside", (r["status"], r["pct_diff"]), ("needs_review", 5.01))
    r = run("networth", {"value": 1000, "unit": "crore"}, {"value": 940, "unit": "crore"})
    eq("IP lower by 6%", r["status"], "needs_review")
    r = run("branches", None, {"value": "212"})
    eq("IP only", (r["value"], r["source"], r["status"], r["note"]), (212, "IP", "ok", ""))
    r = run("branches", {"value": "212"}, None)
    eq("QR only for operational notes it", (r["source"], r["status"], "normally taken from the IP" in r["note"]), ("QR", "ok", True))
    r = run("yield_pct", None, {"value": "11.4%"})
    eq("financial only in IP", (r["source"], r["value"], "normally taken from the QR" in r["note"]), ("IP", 11.4, True))
    r = run("crar_pct", {"value": "-"}, {"value": "NA"})
    eq("both blank -> not_found", (r["status"], r["value"], len(r["ignored"])), ("not_found", None, 2))
    r = run("aum", {"value": "9,000", "unit": "crore"}, {"value": "9,100", "unit": "crore", "period": "Q1 FY26"})
    eq("other-period candidate ignored", (r["value"], r["source"], any("Q1 FY26" in i for i in r["ignored"])), (9000.0, "QR", True))
    r = run("aum", {"value": "9,000"}, {"value": "9,100", "unit": "crore"})
    eq("amount without unit is not used", (r["source"], any("no header" in i for i in r["ignored"])), ("IP", True))
    r = run("employees", {"value": "1,204.5"}, {"value": "1,204"})
    eq("fractional count ignored", (r["value"], r["source"]), (1204, "IP"))
    r = run("loan_book", {"value": "8,20,000", "unit": "lakh", "basis": "standalone"}, {"value": "9,000", "unit": "crore", "basis": "consolidated"})
    eq("basis mismatch is said", (r["status"], "QR figure is standalone" in r["footnote"]), ("needs_review", True))
    r = run("sell_down_volume", {"value": "0", "unit": "crore"}, {"value": "120", "unit": "crore"})
    eq("zero QR base", (r["status"], r["pct_diff"], "zero base" in r["footnote"]), ("needs_review", None, True))
    r = run("networth", {"value": "2,400", "unit": "crore"}, {"value": "2,390", "unit": "crore"}, listing="unlisted")
    eq("unlisted both -> QR, parent IP in footnote", (r["source"], r["status"], r["alt_source"]), ("QR", "ok", "parent IP"))
    r = run("branches", None, {"value": "96"}, listing="unlisted")
    eq("unlisted parent IP only", (r["source"], r["status"], "parent company's investor presentation" in r["footnote"]), ("parent IP", "ok", True))
    r = reconcile(dict(base, kpi="branches", listing="unlisted", ip=dict(IP, value="96")))
    eq("unlisted own ip not ranked", (r["status"], any("parent_ip" in i for i in r["ignored"])), ("not_found", True))
    r = run("roa_pct", {"value": "2.1%"}, {"value": "2.4%"})
    eq("computed KPI refused", (r["ok"], "compute_kpis" in r["problems"][0]), (False, True))
    r = reconcile({"kpi": "aum", "period": "H1 FY26", "listing": "listed"})
    eq("bad period refused", r["ok"], False)
    r = reconcile(dict(base, kpi="aum", tolerance_pct=10, qr=dict(QR, value=1, unit="crore")))
    eq("tolerance cannot be loosened", r["ok"], False)
    r = run("debt_equity", {"value": "3.2x"}, {"value": "3.25"})
    eq("multiple", (r["value"], r["status"], r["pct_diff"]), (3.2, "ok", 1.56))
    r = run("gnpa_pct", {"value": "1.8", "unit": "crore"}, None)
    eq("percent KPI with currency unit ignored", r["status"], "not_found")
    return fails, 26


def main():
    ap = argparse.ArgumentParser(description="QR value vs IP value of one KPI -> chosen value, status, percentage difference and footnote, per the rulebook's precedence and 5% rule.")
    ap.add_argument("--request", help="path of a JSON file matching schemas/reconcile-request.schema.json (one object, or a list of them)")
    ap.add_argument("--stdin", action="store_true", help="read the request JSON from stdin")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        fails, n = _self_test()
        print(json.dumps({"script": "reconcile_sources", "cases": n, "failed": fails, "ok": not fails}, ensure_ascii=False, indent=1)); return 1 if fails else 0
    try:
        if a.stdin: req = json.load(sys.stdin)
        elif a.request:
            with open(a.request, encoding="utf-8") as f: req = json.load(f)
        else: ap.print_help(sys.stderr); return 2
    except (OSError, json.JSONDecodeError) as x:
        print(f"cannot read the request: {x}", file=sys.stderr); return 2
    many = isinstance(req, list)
    results = [reconcile(r) if isinstance(r, dict) else {"ok": False, "problems": ["request is not a JSON object"]} for r in (req if many else [req])]
    print(json.dumps(results if many else results[0], ensure_ascii=False, indent=1))
    bad = [r for r in results if not r["ok"]]
    for r in bad: print("invalid request: " + "; ".join(r["problems"]), file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
