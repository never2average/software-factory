#!/usr/bin/env python3
"""Printed page number <-> PDF page index.

An annual report's printed page numbers almost never equal the PDF page index: the cover and inside cover are
unnumbered, front matter may be numbered in roman numerals, section dividers may be unnumbered inserts, the
financial statements are sometimes paginated afresh, and a report exported as double-page spreads carries two
printed pages on each PDF page.

Give this script sampled (pdf_page, printed label) pairs. It fits offset segments of the form
    printed = a * pdf_page + b        a = 1 (single pages) or a = 2 (spreads; label = the LOWER number on the spread)
and reports every sample that does not fit instead of averaging it away. It never invents an offset: a printed
page that falls in no segment, or in more than one, is returned as unresolved with the reason.

Input (file or '-' for stdin): [[pdf_page, "label"], ...] or [{"pdf_page": 9, "label": "1"}, ...]
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ar_common as C


def _normalise_samples(samples):
    out, problems = [], []
    for i, s in enumerate(samples):
        if isinstance(s, dict):
            pdf, label = s.get("pdf_page"), s.get("label")
        elif isinstance(s, (list, tuple)) and len(s) == 2:
            pdf, label = s
        else:
            problems.append(f"sample {i}: expected [pdf_page, label] or an object with pdf_page and label"); continue
        if isinstance(pdf, bool) or not isinstance(pdf, int) or pdf < 1:
            problems.append(f"sample {i}: pdf_page must be a positive integer, got {pdf!r}"); continue
        out.append((pdf, label))
    return sorted(out, key=lambda t: t[0]), problems


def _slope(p0, v0, p1, v1):
    """1 or 2 when the two samples lie on a single-page or spread numbering, else None."""
    if p1 == p0:
        return None
    for a in (1, 2):
        if v1 - v0 == a * (p1 - p0):
            return a
    return None


def _fits(seg, pdf, value):
    if seg["a"] is None:
        p0, v0 = seg["points"][0]
        return _slope(p0, v0, pdf, value)
    return seg["a"] if value == seg["a"] * pdf + seg["b"] else None


def compute_segments(samples, page_count=None):
    """-> {'segments': [...], 'inconsistencies': [...], 'unnumbered': [...]}."""
    samples, problems = _normalise_samples(samples)
    inconsistencies = list(problems)
    unnumbered, parsed, seen = [], [], {}
    for pdf, label in samples:
        if page_count and pdf > page_count:
            inconsistencies.append(f"pdf page {pdf} is beyond the page count {page_count}; sample ignored"); continue
        pl = C.parse_page_label(label)
        if pl is None:
            unnumbered.append({"pdf_page": pdf, "label": label}); continue
        if pdf in seen:
            if seen[pdf] != (pl["style"], pl["value"]):
                inconsistencies.append(f"pdf page {pdf} was sampled twice with different labels; both ignored after the first")
            continue
        seen[pdf] = (pl["style"], pl["value"])
        parsed.append((pdf, pl["style"], pl["value"], C.clean(label)))

    raw, i = [], 0
    while i < len(parsed):
        pdf, style, value, _ = parsed[i]
        seg = {"style": style, "a": None, "b": None, "points": [(pdf, value)]}
        j = i + 1
        while j < len(parsed):
            p, st, v, lab = parsed[j]
            if st != style:
                break
            a = _fits(seg, p, v)
            if a is not None:
                if seg["a"] is None:
                    seg["a"], seg["b"] = a, seg["points"][0][1] - a * seg["points"][0][0]
                seg["points"].append((p, v)); j += 1
                continue
            # Does the sample AFTER this one fit? Then this one is a misread label, not a new numbering.
            if j + 1 < len(parsed) and parsed[j + 1][1] == style and _fits(seg, parsed[j + 1][0], parsed[j + 1][2]) is not None:
                a_known = seg["a"] if seg["a"] is not None else _fits(seg, parsed[j + 1][0], parsed[j + 1][2])
                b_known = seg["points"][0][1] - a_known * seg["points"][0][0]
                expected = C.format_page_label(style, a_known * p + b_known) if a_known * p + b_known >= 1 else "?"
                inconsistencies.append(f"pdf page {p}: label {lab!r} does not fit its neighbours (expected {expected!r}); "
                                       "re-read that page's number, the sample was left out")
                j += 1
                continue
            break
        raw.append(seg); i = j

    segments = []
    for seg in raw:
        single = seg["a"] is None
        a = 1 if single else seg["a"]
        b = seg["points"][0][1] - a * seg["points"][0][0]
        pts = seg["points"]
        segments.append({
            "style": seg["style"], "pages_per_pdf_page": a, "b": b,
            "offset": (-b if a == 1 else None),
            "from_pdf_page": pts[0][0], "to_pdf_page": pts[-1][0],
            "first_printed": C.format_page_label(seg["style"], pts[0][1]),
            "last_printed": C.format_page_label(seg["style"], pts[-1][1] + (1 if a == 2 else 0)),
            "samples": len(pts), "single_sample": single,
        })
    for k, s in enumerate(segments):
        if s["single_sample"]:
            inconsistencies.append(f"segment {k} ({s['style']}, pdf page {s['from_pdf_page']}) rests on one sample; "
                                   "sample another page in that stretch before relying on it")
        if k and segments[k - 1]["style"] == s["style"]:
            prev = segments[k - 1]
            if s["pages_per_pdf_page"] != prev["pages_per_pdf_page"]:
                why = "the export switches between single pages and double-page spreads"
            elif C.parse_page_label(s["first_printed"])["value"] <= C.parse_page_label(prev["last_printed"])["value"]:
                why = "printed numbering restarts (a separately paginated part); printed numbers are no longer unique"
            else:
                why = "unnumbered pages were inserted or removed between them (dividers, advertisements, a missing page)"
            inconsistencies.append(f"offset changes between pdf pages {prev['to_pdf_page']} and {s['from_pdf_page']}: {why}")
    return {"segments": segments, "inconsistencies": inconsistencies, "unnumbered": unnumbered}


def _bounds(segments, k, page_count):
    lo = segments[k - 1]["to_pdf_page"] + 1 if k else 1
    hi = segments[k + 1]["from_pdf_page"] - 1 if k + 1 < len(segments) else (page_count or 10 ** 6)
    return lo, hi


def _value(label):
    return C.parse_page_label(label)["value"]


def _monotonic(segments, k, value):
    """Where numbering does not restart, a printed number beyond the next segment's first number cannot sit before
    it (and likewise behind the previous segment's last number)."""
    s = segments[k]
    same = [i for i, t in enumerate(segments) if t["style"] == s["style"]]
    pos = same.index(k)
    if pos + 1 < len(same):
        nxt = segments[same[pos + 1]]
        if _value(nxt["first_printed"]) > _value(s["last_printed"]) and value >= _value(nxt["first_printed"]):
            return False
    if pos > 0:
        prv = segments[same[pos - 1]]
        if _value(s["first_printed"]) > _value(prv["last_printed"]) and value <= _value(prv["last_printed"]):
            return False
    return True


def printed_to_pdf(segments, label, page_count=None):
    """-> {'pdf_page': int|None, 'segment': k|None, 'extrapolated': bool, 'reason': str|None}."""
    pl = C.parse_page_label(label)
    if pl is None:
        return {"pdf_page": None, "segment": None, "extrapolated": False, "reason": f"{label!r} is not a page number"}
    hits = []
    for k, s in enumerate(segments):
        if s["style"] != pl["style"]:
            continue
        num = pl["value"] - s["b"]
        if s["pages_per_pdf_page"] == 1:
            pdf = num
        else:
            pdf = num // 2   # the spread whose lower number is <= the label
        lo, hi = _bounds(segments, k, page_count)
        if not _monotonic(segments, k, pl["value"]):
            continue
        if pdf >= max(lo, 1) and pdf <= hi:
            hits.append((k, pdf, not (s["from_pdf_page"] <= pdf <= s["to_pdf_page"])))
    if len(hits) == 1:
        k, pdf, extra = hits[0]
        return {"pdf_page": pdf, "segment": k, "extrapolated": extra, "reason": None}
    if not hits:
        return {"pdf_page": None, "segment": None, "extrapolated": False,
                "reason": f"no {pl['style']} segment places printed page {C.clean(label)} inside the document"}
    return {"pdf_page": None, "segment": None, "extrapolated": False,
            "reason": f"printed page {C.clean(label)} fits {len(hits)} segments (pdf pages {[h[1] for h in hits]}); "
                      "either numbering restarts (say which part of the report it is in) or unnumbered pages sit somewhere between "
                      "the sampled stretches (sample a page label in between)",
            "candidates": [h[1] for h in hits]}


def pdf_to_printed(segments, pdf_page, page_count=None):
    """-> {'printed_page': str|None, 'segment': k|None, 'extrapolated': bool, 'reason': str|None}."""
    for k, s in enumerate(segments):
        lo, hi = _bounds(segments, k, page_count)
        inside = s["from_pdf_page"] <= pdf_page <= s["to_pdf_page"]
        if inside or (s["to_pdf_page"] < pdf_page <= hi):
            v = s["pages_per_pdf_page"] * pdf_page + s["b"]
            if v < 1:
                break
            return {"printed_page": C.format_page_label(s["style"], v), "segment": k, "extrapolated": not inside, "reason": None}
    return {"printed_page": None, "segment": None, "extrapolated": False,
            "reason": f"pdf page {pdf_page} lies before the first numbered sample or in an unnumbered stretch"}


def check_pair(segments, printed_label, pdf_page, page_count=None):
    """None when (printed, pdf) agrees with the segments or cannot be tested; otherwise a sentence."""
    if printed_label is None or pdf_page is None or not segments:
        return None
    r = printed_to_pdf(segments, printed_label, page_count)
    if r["pdf_page"] is None:
        if r.get("candidates") and pdf_page in r["candidates"]:
            return None
        return f"printed page {printed_label!r} cannot be placed by the offsets ({r['reason']})"
    if r["pdf_page"] != pdf_page:
        return f"printed page {printed_label!r} maps to pdf page {r['pdf_page']} by the offsets, but the map says {pdf_page}"
    return None


def _parse_pairs(text):
    out = []
    for part in text.split(","):
        if not part.strip():
            continue
        if ":" not in part:
            C.die(f"--pairs: {part!r} is not pdf_page:label")
        a, b = part.split(":", 1)
        if not a.strip().isdigit():
            C.die(f"--pairs: {a!r} is not a pdf page index")
        out.append([int(a), b.strip()])
    return out


def _cases():
    roman_then_arabic = [[1, "cover"], [2, ""], [3, "i"], [4, "ii"], [6, "iv"], [9, "1"], [10, "2"], [50, "42"], [300, "292"]]

    def basic():
        r = compute_segments(roman_then_arabic, 320)
        segs = r["segments"]
        assert [s["style"] for s in segs] == ["roman", "arabic"], segs
        assert segs[0]["offset"] == 2 and segs[1]["offset"] == 8, segs
        assert [u["pdf_page"] for u in r["unnumbered"]] == [1, 2]
        assert r["inconsistencies"] == [], r["inconsistencies"]
        assert printed_to_pdf(segs, "45", 320)["pdf_page"] == 53
        assert printed_to_pdf(segs, "iii", 320)["pdf_page"] == 5
        assert printed_to_pdf(segs, "v", 320) == {"pdf_page": 7, "segment": 0, "extrapolated": True, "reason": None}
        assert pdf_to_printed(segs, 53, 320)["printed_page"] == "45"
        assert pdf_to_printed(segs, 5, 320)["printed_page"] == "iii"
        assert pdf_to_printed(segs, 1, 320)["printed_page"] is None
        assert printed_to_pdf(segs, "400", 320)["pdf_page"] is None      # beyond the document
        assert printed_to_pdf(segs, "cover", 320)["pdf_page"] is None

    def outlier():
        r = compute_segments([[9, "1"], [10, "2"], [11, "8"], [12, "4"], [13, "5"]], 100)
        assert len(r["segments"]) == 1 and r["segments"][0]["samples"] == 4, r
        assert any("pdf page 11" in m and "'3'" in m for m in r["inconsistencies"]), r["inconsistencies"]

    def inserted_pages():
        r = compute_segments([[10, "2"], [20, "12"], [60, "48"], [70, "58"]], 200)
        assert [s["offset"] for s in r["segments"]] == [8, 12], r
        assert any("inserted or removed" in m for m in r["inconsistencies"]), r["inconsistencies"]
        assert printed_to_pdf(r["segments"], "50", 200)["pdf_page"] == 62
        assert printed_to_pdf(r["segments"], "5", 200)["pdf_page"] == 13

    def restart():
        r = compute_segments([[10, "2"], [20, "12"], [150, "1"], [160, "11"]], 300)
        assert any("restarts" in m for m in r["inconsistencies"]), r["inconsistencies"]
        amb = printed_to_pdf(r["segments"], "5", 300)
        assert amb["pdf_page"] is None and sorted(amb["candidates"]) == [13, 154], amb
        assert check_pair(r["segments"], "5", 154, 300) is None          # an ambiguous label is fine when the pdf page is a candidate
        assert check_pair(r["segments"], "5", 99, 300) is not None

    def spreads():
        # cover is one page, then each pdf page is a spread: pdf 2 = printed 2-3, pdf 3 = printed 4-5 ...
        r = compute_segments([[2, "2"], [3, "4"], [10, "18"], [40, "78"]], 120)
        s = r["segments"][0]
        assert s["pages_per_pdf_page"] == 2 and s["offset"] is None and s["b"] == -2, s
        assert printed_to_pdf(r["segments"], "18", 120)["pdf_page"] == 10
        assert printed_to_pdf(r["segments"], "19", 120)["pdf_page"] == 10   # right-hand page of the same spread
        assert pdf_to_printed(r["segments"], 40, 120)["printed_page"] == "78"
        assert s["last_printed"] == "79"

    def single_and_bad_input():
        r = compute_segments([[5, "iii"], [12, "4"], "junk", [0, "1"], [True, "2"]], 50)
        assert len(r["segments"]) == 2 and all(s["single_sample"] for s in r["segments"])
        assert sum("rests on one sample" in m for m in r["inconsistencies"]) == 2
        assert sum(m.startswith("sample ") for m in r["inconsistencies"]) == 3, r["inconsistencies"]
        assert compute_segments([], 10) == {"segments": [], "inconsistencies": [], "unnumbered": []}

    def pair_check():
        segs = compute_segments(roman_then_arabic, 320)["segments"]
        assert check_pair(segs, "45", 53, 320) is None
        assert "maps to pdf page 53" in check_pair(segs, "45", 54, 320)
        assert check_pair(segs, None, 54, 320) is None

    def duplicate_sample():
        r = compute_segments([[9, "1"], [9, "3"], [10, "2"]], 50)
        assert any("sampled twice" in m for m in r["inconsistencies"])

    return [("roman front matter then arabic body", basic), ("misread label is reported, not fitted", outlier),
            ("unnumbered inserts open a new segment", inserted_pages), ("restarted numbering is ambiguous", restart),
            ("double-page spreads", spreads), ("single samples and bad input", single_and_bad_input),
            ("pair check used by the validator", pair_check), ("same page sampled twice", duplicate_sample)]


def main():
    ap = argparse.ArgumentParser(description="Fit printed-page to PDF-page offset segments from sampled page labels.",
                                 epilog='Example: page_offset.py --pairs "1:cover,3:i,4:ii,9:1,10:2,300:292" --page-count 320 --lookup 45 --lookup iv')
    ap.add_argument("samples", nargs="?", help="JSON file of [pdf_page, label] pairs, or - for stdin")
    ap.add_argument("--pairs", help='inline samples: "pdf:label,pdf:label" (an empty label means the page is unnumbered)')
    ap.add_argument("--page-count", type=int, help="pages in the PDF; bounds the last segment")
    ap.add_argument("--lookup", action="append", default=[], metavar="PRINTED", help="printed page to convert to a PDF page (repeatable)")
    ap.add_argument("--reverse", action="append", default=[], type=int, metavar="PDF_PAGE", help="PDF page to convert to its printed label (repeatable)")
    ap.add_argument("--self-test", action="store_true", help="run the built-in cases and exit 0 or 1")
    args = ap.parse_args()
    if args.self_test:
        C.run_self_test(_cases())
    if args.pairs:
        samples = _parse_pairs(args.pairs)
    elif args.samples:
        samples = C.read_json_arg(args.samples)
        if not isinstance(samples, list):
            C.die("samples must be a JSON array")
    else:
        C.die("give a samples file, - for stdin, or --pairs")
    result = compute_segments(samples, args.page_count)
    result["lookups"] = [dict(printed_page=l, **printed_to_pdf(result["segments"], l, args.page_count)) for l in args.lookup]
    result["reverse_lookups"] = [dict(pdf_page=p, **pdf_to_printed(result["segments"], p, args.page_count)) for p in args.reverse]
    C.emit(result)
    if not result["segments"]:
        C.die("no sample carried a readable page number, so no offset can be stated", C.EXIT_CHECK_FAILED)


if __name__ == "__main__":
    main()
