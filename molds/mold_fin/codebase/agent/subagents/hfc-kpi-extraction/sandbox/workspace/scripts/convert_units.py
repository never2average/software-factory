#!/usr/bin/env python3
"""Convert an amount as printed in a filing to Rs crore, by the analysts' rule:
lakhs / 100, millions / 10, billions x 100, crores as-is.

  python3 /workspace/scripts/convert_units.py --value "1,23,456.78" --unit lakh
  python3 /workspace/scripts/convert_units.py --value "(2,350.4)" --header "(Rs. in Millions, except per share data)"
  echo '[{"id":"aum","value":"182.4","header":"INR bn"},{"id":"pat","value":"4,512","unit":"lakh"}]' | \
      python3 /workspace/scripts/convert_units.py --stdin
  python3 /workspace/scripts/convert_units.py --self-test

The unit comes from --unit, or is read from --header (the header of THAT table or slide). A header that names no
unit, or names two ("Rs in lakhs unless otherwise stated in crore"), is reported as ambiguous: the script does not
pick one. Percentages, multiples and counts are not amounts and are refused.
Exit 0 = every item converted; 1 = at least one item could not be converted; 2 = bad usage.
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, json, re
from finlib import numbers, units

ALIASES = {
    "crore": "crore", "crores": "crore", "cr": "crore", "cr.": "crore", "crs": "crore", "rs crore": "crore", "₹ crore": "crore", "inr crore": "crore",
    "lakh": "lakh", "lakhs": "lakh", "lac": "lakh", "lacs": "lakh", "lk": "lakh",
    "million": "million", "millions": "million", "mn": "million", "mn.": "million", "mio": "million", "m": "million",
    "billion": "billion", "billions": "billion", "bn": "billion", "bn.": "billion", "b": "billion",
    "thousand": "thousand", "thousands": "thousand", "000": "thousand", "'000": "thousand", "k": "thousand",
    "rupee": "rupee", "rupees": "rupee", "rs": "rupee", "inr": "rupee", "₹": "rupee",
}
NOT_AMOUNT = {"%", "pct", "percent", "x", "times", "count", "nos", "no.", "bps"}
# "lakh crore" is a real composite used on market-size slides (1 lakh crore = 1,00,000 crore).
_LAKH_CRORE = re.compile(r"\blakh\s+(?:crores?|cr\.?)\b", re.I)
_FOREIGN = re.compile(r"\bUS\s?\$|\bUSD\b|\$|€|\bEUR\b|£|\bGBP\b", re.I)


_GROUPED = re.compile(r"^\d{1,3}(?:,\d{3})+$|^\d{1,2}(?:,\d{2})*,\d{3}$")


def grouping_problem(raw):
    """Digit grouping must be Indian (1,23,45,678) or Western (12,345,678). '12,5' or '1 234,56' (decimal comma) is not
    silently squeezed into a number. -> problem text or None."""
    if not isinstance(raw, str): return None
    body = re.sub(r"[^\d,.\s]", "", raw).strip()
    if re.search(r"\d\s+\d", body): return f"{raw!r} has a space inside the number; it may be two cells read as one, or a decimal-comma format"
    intpart = body.split(".")[0].replace(" ", "")
    if "," in intpart and not _GROUPED.match(intpart): return f"{raw!r} has digit grouping that is neither Indian (1,23,456) nor Western (123,456); it may be a decimal comma or a broken cell"
    if "," in body.split(".", 1)[1] if "." in body else False: return f"{raw!r} has a comma after the decimal point"
    return None


def parse_printed(raw):
    """-> (number | None, problem | None). The one way every script in this workspace reads a printed number."""
    if isinstance(raw, bool): return None, f"{raw!r} is not a number"
    if isinstance(raw, (int, float)): return float(raw), None
    if numbers.is_blank(raw): return None, "blank in the filing ('-', 'NA', 'Nil' or empty): there is no number here; do not read it as zero"
    gp = grouping_problem(raw)
    if gp: return None, gp
    v = numbers.parse_number(raw)
    return (v, None) if v is not None else (None, f"cannot parse {raw!r} as a number")


def normalise_unit(u):
    if u is None: return None
    return ALIASES.get(str(u).strip().lower())


def unit_from_header(header):
    """-> (unit|None, factor|None, problem|None)"""
    if not header or not header.strip(): return None, None, "no header text given"
    if _FOREIGN.search(header): return None, None, f"header names a foreign currency: {header!r}; the rulebook converts rupee amounts only"
    if _LAKH_CRORE.search(header) and not re.search(r"unless|except|otherwise", header, re.I):
        return "lakh crore", 100000.0, None
    u = units.detect_unit(header)
    if u is None:
        return None, None, f"header {header!r} names no single unit (none, or more than one); read the unit from the table's own header and pass --unit"
    return u, units.FACTOR_TO_CRORE[u], None


def convert(item, decimals=2):
    """item: {id?, value, unit? | header?} -> result dict with 'ok'."""
    out = {"id": item.get("id"), "input": item.get("value"), "unit": None, "factor_to_crore": None, "crore": None, "crore_rounded": None,
           "ok": False, "problem": None}
    raw = item.get("value")
    if isinstance(raw, str) and re.search(r"%|\bbps\b|\d\s*x\s*$", raw.strip(), re.I):
        out["problem"] = f"{raw!r} is a percentage / multiple, not an amount; nothing to convert"; return out
    v, problem = parse_printed(raw)
    if v is None:
        out["problem"] = problem
        out["blank"] = numbers.is_blank(raw); return out
    out["parsed"] = v
    if item.get("unit") is not None:
        if str(item["unit"]).strip().lower() in NOT_AMOUNT:
            out["problem"] = f"unit {item['unit']!r} is not a currency unit; percentages, multiples and counts are not converted"; return out
        u = normalise_unit(item["unit"])
        if u is None:
            out["problem"] = f"unknown unit {item['unit']!r}; use crore | lakh | million | billion | thousand | rupee"; return out
        factor = units.FACTOR_TO_CRORE[u]
        if item.get("header"):
            hu, _, _ = unit_from_header(item["header"])
            if hu is not None and hu != u:
                out["problem"] = f"--unit says {u} but the header {item['header']!r} says {hu}; resolve before converting"; return out
    else:
        u, factor, problem = unit_from_header(item.get("header"))
        if problem: out["problem"] = problem; return out
    out.update(unit=u, factor_to_crore=factor, crore=v * factor, crore_rounded=round(v * factor, decimals), ok=True)
    out["rule"] = {"crore": "crores: use as-is", "lakh": "lakhs: divide by 100", "million": "millions: divide by 10", "billion": "billions: multiply by 100",
                   "thousand": "thousands: divide by 10,000 (not in the rulebook; arithmetic identity)",
                   "rupee": "rupees: divide by 1,00,00,000 (not in the rulebook; arithmetic identity)",
                   "lakh crore": "lakh crore: multiply by 1,00,000 (not in the rulebook; arithmetic identity)"}[u]
    return out


def _self_test():
    fails = []
    def eq(name, got, want):
        if got != want: fails.append(f"{name}: got {got!r}, want {want!r}")
    cases = [
        ({"value": "1,23,456.78", "unit": "lakh"}, 1234.57), ({"value": "12,345", "unit": "Lakhs"}, 123.45), ({"value": "2,500", "unit": "mn"}, 250.0),
        ({"value": "182.4", "header": "INR bn"}, 18240.0), ({"value": "7,015.2", "header": "(₹ in Crore)"}, 7015.2),
        ({"value": "(2,350.4)", "header": "(Rs. in Millions, except per share data)"}, -235.04), ({"value": 45120, "header": "Rs. in Lacs"}, 451.2),
        ({"value": "1.5", "header": "Market size (₹ lakh crore)"}, 150000.0), ({"value": "98,76,54,321", "unit": "rupee"}, 98.77),
        ({"value": "4,50,000", "unit": "thousand"}, 45.0), ({"value": "−12.5", "unit": "cr"}, -12.5),
    ]
    for item, want in cases:
        r = convert(item); eq(f"convert {item}", (r["ok"], r["crore_rounded"]), (True, want))
    refusals = [
        ({"value": "-", "unit": "lakh"}, "blank"), ({"value": "NA", "unit": "crore"}, "blank"), ({"value": "", "unit": "crore"}, "blank"),
        ({"value": "12.5%", "unit": "crore"}, "percentage"), ({"value": "3.2x", "unit": "crore"}, "percentage"), ({"value": "1.2.3", "unit": "crore"}, "cannot parse"),
        ({"value": "100", "header": "Rs in lakhs unless otherwise stated in crore"}, "no single unit"), ({"value": "100", "header": "Particulars"}, "no single unit"),
        ({"value": "100"}, "no header"), ({"value": "100", "unit": "dozen"}, "unknown unit"), ({"value": "100", "unit": "%"}, "not a currency unit"),
        ({"value": "100", "unit": "crore", "header": "(Rs. in Lakhs)"}, "resolve before converting"), ({"value": "100", "header": "USD mn"}, "foreign currency"),
        ({"value": "12,5", "unit": "crore"}, "digit grouping"), ({"value": "1 234,56", "unit": "crore"}, "space inside"), ({"value": "1,2345", "unit": "lakh"}, "digit grouping"),
        ({"value": "4,500 cr", "unit": "crore"}, "cannot parse"), ({"value": "~9,000", "unit": "crore"}, "cannot parse"), ({"value": "1,234 *", "unit": "crore"}, "cannot parse"),
    ]
    for item, frag in refusals:
        r = convert(item)
        if r["ok"] or frag not in (r["problem"] or ""): fails.append(f"refuse {item}: got ok={r['ok']} problem={r['problem']!r}, want problem containing {frag!r}")
    eq("blank flag", convert({"value": "Nil", "unit": "lakh"}).get("blank"), True)
    eq("QR lakh and IP crore agree", convert({"value": "8,25,340", "unit": "lakh"})["crore_rounded"], convert({"value": "8,253.40", "unit": "crore"})["crore_rounded"])
    for ok_text in ("1,23,456.78", "123,456.78", "12,34,56,789", "1,234", "(1,234.5)", "₹ 4,500", "0.00", "- 12"):
        if grouping_problem(ok_text): fails.append(f"grouping wrongly refused {ok_text!r}")
    eq("zero is a number, not a blank", convert({"value": "0.00", "unit": "crore"})["crore_rounded"], 0.0)
    return fails, len(cases) + len(refusals) + 11


def main():
    ap = argparse.ArgumentParser(description="Convert an amount printed in lakhs / millions / billions / crore to Rs crore (the rulebook's unit rule). Never guesses the unit.")
    ap.add_argument("--value", help="the number exactly as printed, e.g. '1,23,456.78' or '(2,350.4)'")
    ap.add_argument("--unit", help="crore | lakh | million | billion | thousand | rupee (common abbreviations accepted)")
    ap.add_argument("--header", help="the header text of the table or slide the value came from, e.g. '(Rs. in Lakhs)'; used when --unit is absent")
    ap.add_argument("--stdin", action="store_true", help="read a JSON list of {id, value, unit|header} from stdin")
    ap.add_argument("--decimals", type=int, default=2)
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        fails, n = _self_test()
        print(json.dumps({"script": "convert_units", "cases": n, "failed": fails, "ok": not fails}, ensure_ascii=False, indent=1)); return 1 if fails else 0
    if a.stdin:
        try: items = json.load(sys.stdin)
        except json.JSONDecodeError as x: print(f"stdin is not JSON: {x}", file=sys.stderr); return 2
        if not isinstance(items, list) or not all(isinstance(i, dict) for i in items): print("stdin must be a JSON list of objects", file=sys.stderr); return 2
    elif a.value is not None: items = [{"value": a.value, "unit": a.unit, "header": a.header}]
    else: ap.print_help(sys.stderr); return 2
    results = [convert(i, a.decimals) for i in items]
    print(json.dumps({"results": results, "ok": all(r["ok"] for r in results)}, ensure_ascii=False, indent=1))
    bad = [r for r in results if not r["ok"]]
    for r in bad: print(f"not converted ({r.get('id') or r['input']!r}): {r['problem']}", file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
