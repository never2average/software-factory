"""Unit detection and conversion to Rs crore, per the analysts' rule:
lakhs / 100, millions / 10, billions * 100, crores as-is."""
import re

FACTOR_TO_CRORE = {"crore": 1.0, "lakh": 0.01, "million": 0.1, "billion": 100.0,
                   "thousand": 0.0001, "rupee": 0.0000001}

_PATTERNS = [
    ("crore", r"\bcrores?\b|\bcr\.?\b|\bcrs\.?\b"),
    ("lakh", r"\blakhs?\b|\blacs?\b|\blakh\b"),
    ("million", r"\bmillions?\b|\bmn\.?\b|\bmio\b"),
    ("billion", r"\bbillions?\b|\bbn\.?\b"),
    ("thousand", r"\bthousands?\b|\b000s\b|'000"),
]

def detect_unit(header_text):
    """Unit named in a table/slide header such as '(Rs. in Lakhs)', 'INR mn', 'Rs Cr'.
    Returns one of crore|lakh|million|billion|thousand, or None when no unit or MORE THAN ONE unit is named
    (an ambiguous header is reported, not guessed)."""
    if not header_text: return None
    t = header_text.lower()
    found = [u for u, p in _PATTERNS if re.search(p, t)]
    return found[0] if len(found) == 1 else None

def to_crore(value, unit):
    if value is None: return None
    if unit not in FACTOR_TO_CRORE: raise ValueError(f"unknown unit {unit!r}; expected one of {sorted(FACTOR_TO_CRORE)}")
    return value * FACTOR_TO_CRORE[unit]

def _self_test():
    assert detect_unit("(₹ in Lakhs)") == "lakh" and detect_unit("Rs. in Crore") == "crore"
    assert detect_unit("INR mn") == "million" and detect_unit("₹ bn") == "billion"
    assert detect_unit("Rs in lakhs unless stated in crore") is None and detect_unit("Particulars") is None
    assert to_crore(12345.0, "lakh") == 123.45 and to_crore(250.0, "million") == 25.0
    assert to_crore(1.5, "billion") == 150.0 and to_crore(7.0, "crore") == 7.0 and to_crore(None, "lakh") is None
    try: to_crore(1, "dozen"); raise AssertionError("unknown unit accepted")
    except ValueError: pass
    return 12
