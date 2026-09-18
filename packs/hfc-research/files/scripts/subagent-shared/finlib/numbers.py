"""Parse numbers the way Indian filings print them. Never guesses: unparseable -> None."""
import re

_BLANK = {"", "-", "–", "—", "na", "n.a.", "n/a", "nil", "nm", "n.m.", "*"}

def parse_number(text):
    """'1,23,456.78' -> 123456.78 ; '(1,234.5)' -> -1234.5 ; '12.5%' -> 12.5 ; '3.2x' -> 3.2 ;
    '-', 'NA', 'Nil', '' -> None ; anything else unparseable -> None."""
    if text is None: return None
    if isinstance(text, (int, float)): return float(text)
    s = str(text).strip().replace(" ", " ").replace("₹", "").replace("Rs.", "").replace("Rs", "").replace("INR", "").strip()
    if s.lower() in _BLANK: return None
    neg = False
    if s.startswith("(") and s.endswith(")"): neg, s = True, s[1:-1].strip()
    if s.startswith("-") or s.startswith("−"): neg, s = True, s[1:].strip()
    s = s.rstrip("%").rstrip("xX").strip()
    s = s.replace(" ", "") if "," not in s else s   # a space inside a comma-grouped number is not a separator we accept
    if "," in s:
        # Commas must be real digit grouping: Indian (1,23,456), western (1,234,567) or a single thousands
        # group. '12,5' or '1,2345' is a decimal comma or a typo — reported as unparseable, never read as 125.
        whole = s.split(".")[0]
        if not (re.fullmatch(r"\d{1,2}(,\d{2})*,\d{3}", whole) or re.fullmatch(r"\d{1,3}(,\d{3})+", whole)): return None
        if s.count(".") > 1: return None
        s = s.replace(",", "")
    if not re.fullmatch(r"\d+(\.\d+)?|\.\d+", s): return None
    v = float(s)
    return -v if neg else v

def is_blank(text):
    return text is None or str(text).strip().lower() in _BLANK

def pct_diff(a, b):
    """Absolute percentage difference of b from a, relative to a. None if either is None or a == 0."""
    if a is None or b is None or a == 0: return None
    return abs(a - b) / abs(a) * 100.0

def _self_test():
    cases = [("1,23,456.78", 123456.78), ("(1,234.5)", -1234.5), ("12.5%", 12.5), ("3.2x", 3.2), ("-", None),
             ("NA", None), ("Nil", None), ("₹ 4,500", 4500.0), ("-12", -12.0), ("abc", None), ("1.2.3", None), (".5", 0.5),
             ("12,5", None), ("1,2345", None), ("1 234,56", None), ("1,234,567.5", 1234567.5), ("12,34,567", 1234567.0), ("1,234", 1234.0)]
    bad = [(t, e, parse_number(t)) for t, e in cases if parse_number(t) != e]
    assert not bad, bad
    assert round(pct_diff(100, 104), 6) == 4.0 and pct_diff(0, 1) is None
    return len(cases) + 2
