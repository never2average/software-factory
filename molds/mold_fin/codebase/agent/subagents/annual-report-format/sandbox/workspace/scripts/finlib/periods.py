"""Indian fiscal periods (April-March). Normalises labels, tells discrete from cumulative,
and derives a discrete quarter from cumulative figures."""
import re

_MONTH = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "sept": 9,
          "oct": 10, "nov": 11, "dec": 12}
_Q_END = {6: 1, 9: 2, 12: 3, 3: 4}           # month a quarter ends -> fiscal quarter
_CUM = {1: "Q1", 2: "H1", 3: "9M", 4: "FY"}   # cumulative label through quarter n

def fy_of(year, month):
    """Fiscal year label (two-digit, the year it ENDS) of a calendar month: Sep 2025 -> 26, Mar 2026 -> 26."""
    return (year + 1 if month >= 4 else year) % 100

def _end_date(text):
    t = text.lower()
    m = re.search(r"(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})", t)
    if m:
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3)); y += 2000 if y < 100 else 0
        return y, mo
    m = re.search(r"(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})[,]?\s+(\d{4})", t)
    if m and m.group(2)[:3] in _MONTH: return int(m.group(3)), _MONTH[m.group(2)[:3]]
    m = re.search(r"([a-z]{3,9})\s+(\d{1,2})[,]?\s+(\d{4})", t)
    if m and m.group(1)[:3] in _MONTH: return int(m.group(3)), _MONTH[m.group(1)[:3]]
    return None

def normalise(label):
    """-> {'period': 'Q2 FY26'|'H1 FY26'|'9M FY26'|'FY26', 'kind': 'quarter'|'cumulative'|'year', 'quarter': n|None, 'fy': 26}
    or None when the label cannot be read. Accepts 'Q2FY26', 'Q2 FY2025-26', '2QFY26', 'H1 FY26', '9MFY26', 'FY26',
    'Quarter ended 30.09.2025', 'Half year ended September 30, 2025', 'Nine months ended 31-12-2025', 'Year ended 31 March 2026'."""
    if not label: return None
    t = " ".join(str(label).lower().replace("’", "'").split())
    fy = None
    m = re.search(r"fy\s*'?\s*(?:20)?(\d{2})\s*[-/]\s*(?:20)?(\d{2})", t)
    if m: fy = int(m.group(2))
    else:
        m = re.search(r"fy\s*'?\s*(?:20)?(\d{2})\b", t)
        if m: fy = int(m.group(1))
    if fy is not None:
        m = re.search(r"\bq\s*([1-4])|\b([1-4])\s*q", t)
        if m:
            q = int(m.group(1) or m.group(2)); return {"period": f"Q{q} FY{fy:02d}", "kind": "quarter", "quarter": q, "fy": fy}
        if re.search(r"(?<![a-z0-9])(h1|1h|6m)(?![0-9])", t): return {"period": f"H1 FY{fy:02d}", "kind": "cumulative", "quarter": 2, "fy": fy}
        if re.search(r"(?<![a-z0-9])9m(?![0-9])", t): return {"period": f"9M FY{fy:02d}", "kind": "cumulative", "quarter": 3, "fy": fy}
        if re.search(r"(?<![a-z0-9])(h2|2h)(?![0-9])", t): return None   # H2 is neither a quarter nor cumulative-from-April
        return {"period": f"FY{fy:02d}", "kind": "year", "quarter": 4, "fy": fy}
    end = _end_date(t)
    if not end or end[1] not in _Q_END: return None
    q, fy = _Q_END[end[1]], fy_of(*end)
    if re.search(r"quarter|three months|3 months", t): return {"period": f"Q{q} FY{fy:02d}", "kind": "quarter", "quarter": q, "fy": fy}
    if re.search(r"half[- ]year|six months|6 months", t) and q == 2: return {"period": f"H1 FY{fy:02d}", "kind": "cumulative", "quarter": 2, "fy": fy}
    if re.search(r"nine months|9 months", t) and q == 3: return {"period": f"9M FY{fy:02d}", "kind": "cumulative", "quarter": 3, "fy": fy}
    if re.search(r"\byear\b|twelve months|12 months", t) and q == 4: return {"period": f"FY{fy:02d}", "kind": "year", "quarter": 4, "fy": fy}
    return None

def previous_quarter(period):
    p = normalise(period)
    if not p or p["kind"] != "quarter": return None
    q, fy = p["quarter"], p["fy"]
    return f"Q{q-1} FY{fy:02d}" if q > 1 else f"Q4 FY{(fy-1) % 100:02d}"

def derive_quarter(quarter, cumulative_through, cumulative_before):
    """Discrete FLOW for fiscal quarter n = cumulative through n minus cumulative through n-1
    (Q2 = H1 - Q1, Q3 = 9M - H1, Q4 = FY - 9M). Only for flows (income, PAT, disbursements) — never for
    balances (AUM, loan book, networth), which are point-in-time. Returns None if an input is missing."""
    if quarter not in (2, 3, 4): raise ValueError("derive_quarter is for Q2, Q3, Q4; Q1's cumulative IS the quarter")
    if cumulative_through is None or cumulative_before is None: return None
    return cumulative_through - cumulative_before

def cumulative_label(quarter): return _CUM[quarter]

def _self_test():
    ok = {"Q2FY26": "Q2 FY26", "Q2 FY2025-26": "Q2 FY26", "2QFY26": "Q2 FY26", "H1 FY26": "H1 FY26", "9MFY26": "9M FY26",
          "FY26": "FY26", "Quarter ended 30.09.2025": "Q2 FY26", "Half year ended September 30, 2025": "H1 FY26",
          "Nine months ended 31-12-2025": "9M FY26", "Year ended 31 March 2026": "FY26", "Quarter ended 31.03.2026": "Q4 FY26",
          "Three months ended June 30, 2025": "Q1 FY26"}
    bad = [(k, v, normalise(k)) for k, v in ok.items() if (normalise(k) or {}).get("period") != v]
    assert not bad, bad
    assert normalise("H2 FY26") is None and normalise("Particulars") is None and normalise("Quarter ended 31.10.2025") is None
    assert previous_quarter("Q1 FY26") == "Q4 FY25" and previous_quarter("Q3 FY26") == "Q2 FY26"
    assert derive_quarter(4, 1000.0, 720.0) == 280.0 and derive_quarter(2, None, 1.0) is None
    return len(ok) + 7
