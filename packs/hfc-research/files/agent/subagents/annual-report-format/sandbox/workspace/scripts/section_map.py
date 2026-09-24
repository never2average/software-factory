#!/usr/bin/env python3
"""Build the section map of an annual report without reading it linearly.

Order of evidence, strongest first:
  1. the PDF outline (bookmarks)          -> PDF pages directly
  2. the contents page                    -> printed pages, turned into PDF pages with page_offset segments
  3. a heading search                     -> top lines of every page for report sections; the notes inside the
                                             standalone statements' page range for the note-level sections
Every start page taken from 1 or 2 is confirmed by looking for the heading on that page (and two pages either side).
A section that cannot be confirmed is 'unconfirmed'; one that cannot be located is 'not_found'. Nothing is guessed.

The heading table is ../references/section-headings.json (shared with the build-the-section-map skill).
pypdf and pdfplumber are imported only inside the functions that open a real PDF.

Without a PDF (for a contents page the agent has already read, and for tests):
  section_map.py --toc-text contents.txt --samples samples.json --page-count 412
"""
import argparse, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ar_common as C
import page_offset as PO

BASES = ("standalone", "consolidated")
TOP_LINES = 8            # a section heading sits in the first lines of its page
HEADING_SLACK = 30       # a heading line is little more than the heading itself
CONFIRM_WINDOW = 2


# ---------------------------------------------------------------- heading table

def load_table():
    return C.load_reference("section-headings.json")


def resolved_keys(table):
    """Every key a map may carry: contextual entries exist once per basis."""
    keys = []
    for e in table["sections"]:
        keys += [f"{b}_{e['key']}" for b in BASES] if e.get("contextual") else [e["key"]]
    return keys


def required_keys(table):
    """Keys the map must carry, found or explicitly not_found. For contextual entries only the standalone one."""
    return [f"standalone_{e['key']}" if e.get("contextual") else e["key"] for e in table["sections"] if e.get("required")]


def entry_for_key(table, key):
    for e in table["sections"]:
        if e["key"] == key or (e.get("contextual") and key in (f"{b}_{e['key']}" for b in BASES)):
            return e
    return None


def _resolve_parent(entry, basis):
    parent = entry.get("parent")
    if parent == "financial_statements":
        return f"{basis}_financial_statements" if basis else None
    return parent


def _any(patterns, text):
    return any(re.search(p, text, re.I) for p in patterns or [])


def match_section(title, table):
    """-> (entry, labelled) for the first table entry matching a cleaned title, or (None, None).
    labelled is False when only a 'patterns_unlabelled' pattern matched ("Financial Statements" with no basis)."""
    t = C.clean(title)
    if not t:
        return None, None
    for e in table["sections"]:
        if _any(e.get("exclude"), t):
            continue
        if _any(e["patterns"], t):
            return e, True
        if _any(e.get("patterns_unlabelled"), t):
            return e, False
    return None, None


def basis_in(text):
    """'standalone' | 'consolidated' | None from the words of a title. Both words present -> None (not guessed)."""
    t = C.clean(text).lower()
    s, c = "standalone" in t, "consolidated" in t
    return "standalone" if s and not c else "consolidated" if c and not s else None


# ---------------------------------------------------------------- contents page

_NUM = re.compile(r"(?<![\w#\-/])(\d{1,3})(?:\s*-\s*(\d{1,3}))?(?![\w#%/]|\s*-\s*\d)")
_ROMAN_END = re.compile(r"(?<![\w'])([ivxl]{1,7})\s*$")
_ROMAN_START = re.compile(r"^\s*([ivxl]{1,7})(?![\w'])")
_LEADERS = re.compile(r"(?:[.\u00b7\u2026_]\s?){2,}")
_SERIAL = re.compile(r"^\s*\(?\d{1,2}[.)]\s+")


def _mask(line, table):
    """Same-length copy of the line with the digits of protected phrases ('Ind AS 109', 'AOC-2', '2025-26') hidden,
    dot leaders blanked and a leading serial ('1.', '(2)') blanked, so that only page numbers remain as numbers."""
    masked = list(line)
    for p in table["protected_phrases"]:
        for m in re.finditer(p, line, re.I):
            for i in range(m.start(), m.end()):
                if masked[i].isdigit():
                    masked[i] = "#"
    s = "".join(masked)
    s = _LEADERS.sub(lambda m: " " * len(m.group(0)), s)
    m = _SERIAL.match(s)
    if m:
        s = " " * m.end() + s[m.end():]
    return s


def _title(text):
    t = re.sub(r"^[\s:\-|.,;/]+|[\s:\-|.,;/]+$", "", text)
    return t if len(re.findall(r"[A-Za-z]", t)) >= 3 else ""


def _tokens(line, table):
    """[('T', title) | ('N', start_label, end_label_or_None)] in reading order."""
    masked = _mask(line, table)
    spans = [(m.start(), m.end(), m.group(1), m.group(2)) for m in _NUM.finditer(masked)]
    r = _ROMAN_END.search(masked)
    if r and C.parse_page_label(r.group(1)) and r.group(1).islower() and r.start(1) > 0:
        spans.append((r.start(1), r.end(1), r.group(1), None))
    r = _ROMAN_START.match(masked)
    if r and C.parse_page_label(r.group(1)) and r.group(1).islower() and masked[r.end(1):].strip():
        spans.append((r.start(1), r.end(1), r.group(1), None))
    spans = sorted(set(spans))
    out, pos = [], 0
    serial = _SERIAL.match(line)
    if serial and not _SERIAL.match(masked):          # the serial was blanked in the mask; keep it out of the title too
        line = " " * serial.end() + line[serial.end():]
    for a, b, first, last in spans:
        t = _title(line[pos:a])
        if t:
            out.append(("T", t))
        out.append(("N", first.lstrip("0") or "0", (last.lstrip("0") or "0") if last else None))
        pos = b
    t = _title(line[pos:])
    if t:
        out.append(("T", t))
    return out


def _shape(tokens):
    return "".join(t[0] for t in tokens)


def parse_toc_lines(text, table=None):
    """Contents-page text -> {'entries': [...], 'mode': 'title_first'|'page_first'|None, 'unparsed_lines': [...]}.

    entry = {'title', 'printed_page' (str|None), 'printed_end' (str|None), 'group_header' (bool)}

    Handles dot leaders, page ranges ('45-78'), roman numerals, page-first layouts ('02 Corporate Information'),
    two-column contents pages flattened onto one line, serial numbers ('1. Corporate Information 2'), titles wrapped
    onto a second line, and group headers printed without a page number."""
    table = table or load_table()
    lines = [C.clean(l) for l in (text or "").splitlines()]
    lines = [l for l in lines if l]
    toks = [_tokens(l, table) for l in lines]
    votes = {"title_first": 0, "page_first": 0}
    for tk in toks:
        sh = _shape(tk)
        if re.fullmatch(r"(TN)+", sh):
            votes["title_first"] += 1
        elif re.fullmatch(r"(NT)+", sh):
            votes["page_first"] += 1
    mode = None
    if votes["title_first"] != votes["page_first"]:
        mode = max(votes, key=votes.get)

    entries, unparsed, carry = [], [], None
    for line, tk in zip(lines, toks):
        sh = _shape(tk)
        if not tk:
            continue
        if sh == "T":
            title = tk[0][1]
            if _any(table["contents_headers"], title):
                carry = None; continue
            entry, _ = match_section(title, table)
            if _any(table["group_headers"], title) or (entry is not None and entry["level"] == "top"):
                entries.append({"title": title, "printed_page": None, "printed_end": None, "group_header": True})
                carry = None; continue
            if carry is not None:
                unparsed.append(carry)
            carry = title
            continue
        pairs = None
        if re.fullmatch(r"(TN)+", sh):
            pairs = [(tk[i][1], tk[i + 1]) for i in range(0, len(tk), 2)]
        elif re.fullmatch(r"(NT)+", sh):
            pairs = [(tk[i + 1][1], tk[i]) for i in range(0, len(tk), 2)]
        elif re.fullmatch(r"N(TN)+", sh) and mode == "title_first":
            pairs = [(tk[i][1], tk[i + 1]) for i in range(1, len(tk), 2)]        # leading number is a serial
        elif re.fullmatch(r"(NT)+N", sh) and mode == "page_first":
            pairs = None
        if pairs is None:
            unparsed.append(line)
            if carry is not None:
                unparsed.append(carry)
            carry = None; continue
        for n, (title, num) in enumerate(pairs):
            if n == 0 and carry is not None and tk[0][0] == "T":
                alone, _ = match_section(title, table)
                joined = f"{carry} {title}"
                if alone is None:
                    title = joined
            entries.append({"title": title, "printed_page": num[1], "printed_end": num[2], "group_header": False})
        carry = None
    if carry is not None:
        unparsed.append(carry)
    return {"entries": entries, "mode": mode, "unparsed_lines": unparsed}


def looks_like_contents(text, table=None):
    """A page is a contents page when it parses into at least five paged entries, two of them known sections."""
    table = table or load_table()
    entries = [e for e in parse_toc_lines(text, table)["entries"] if e["printed_page"]]
    known = sum(1 for e in entries if match_section(e["title"], table)[0] is not None)
    return len(entries) >= 5 and known >= 2


# ---------------------------------------------------------------- printed labels on a page

_LABEL_PATTERNS = [
    r"^(\d{1,3})$", r"^([ivxl]{1,7})$",
    r"^page\s+(\d{1,3})(?:\s+of\s+\d{1,3})?$",
    r"^(\d{1,3})\s*\|\s*\D.*$", r"^\D.*\|\s*(\d{1,3})$",
    r"^(\d{1,3})\s{1,3}(?:annual|integrated)\s+report\b.*$", r"^.*\b(?:annual|integrated)\s+report\s+(?:20\d{2}\s*-\s*\d{2,4}\s+)?(\d{1,3})$",
]


def _label_in(line, table):
    masked_line = C.clean(line)
    for p in _LABEL_PATTERNS:
        m = re.match(p, masked_line, re.I)
        if m and C.parse_page_label(m.group(1)):
            return m.group(1).lower().lstrip("0") or None
    return None


def extract_printed_label(page_text, table=None):
    """The page number printed in the header or footer, or None. Looks only at the first two and last three lines,
    and returns None when the header and footer candidates disagree (never picks one)."""
    table = table or load_table()
    lines = [l for l in (C.clean(x) for x in (page_text or "").splitlines()) if l]
    if not lines:
        return None
    found = {lab for lab in (_label_in(l, table) for l in lines[:2] + lines[-3:]) if lab}
    return found.pop() if len(found) == 1 else None


# ---------------------------------------------------------------- confirming and searching headings

def _heading_like(line, entry, anywhere=False):
    t = C.clean(line)
    if not t or len(t) > 140 or _any(entry.get("exclude"), t):
        return False
    if re.search(r"\s\d{1,3}$", t) and _LEADERS.search(line or ""):
        return False                                    # a contents line, not the heading itself
    for p in entry["patterns"] + entry.get("patterns_unlabelled", []):
        m = re.search(p, t, re.I)
        if m and (anywhere and p.startswith("^") or len(t) - (m.end() - m.start()) <= HEADING_SLACK):
            return True
    return False


def heading_on_page(page_text, entry, anywhere=False):
    lines = [l for l in (page_text or "").splitlines() if l.strip()]
    if not anywhere:
        lines = lines[:TOP_LINES]
    return any(_heading_like(l, entry, anywhere) for l in lines)


def confirm_start(entry, pdf_page, get_text, page_count, basis=None):
    """-> (confidence, pdf_page, note). Looks at pdf_page, then +1, -1, +2, -2."""
    if pdf_page is None:
        return "unconfirmed", None, None
    for d in [0] + [s * k for k in range(1, CONFIRM_WINDOW + 1) for s in (1, -1)]:
        p = pdf_page + d
        if p < 1 or (page_count and p > page_count):
            continue
        text = get_text(p)
        if text and heading_on_page(text, entry, anywhere=entry.get("search") == "anywhere_in_range"):
            if basis and entry.get("contextual"):
                seen = basis_in(" ".join(text.splitlines()[:25]))
                if seen and seen != basis:
                    return "unconfirmed", p, f"heading found on pdf page {p} but the page reads as {seen}, not {basis}"
            note = None if d == 0 else f"heading found on pdf page {p}; the contents page and offsets implied {pdf_page}"
            return "found", p, note
    return "unconfirmed", pdf_page, "heading not found on the page or two pages either side; open the page and check"


def _runs(pages):
    runs = []
    for p in sorted(set(pages)):
        if runs and p - runs[-1][-1] <= 1:
            runs[-1].append(p)
        else:
            runs.append([p])
    return runs


def search_heading(entry, get_text, first, last, skip_pages=()):
    """-> (confidence, pdf_page, candidates, note) by scanning pdf pages first..last."""
    anywhere = entry.get("search") == "anywhere_in_range"
    hits = [p for p in range(first, last + 1)
            if p not in skip_pages and heading_on_page(get_text(p) or "", entry, anywhere)]
    if not hits:
        return "not_found", None, [], f"no heading matched on pdf pages {first}-{last}"
    runs = _runs(hits)
    starts = [r[0] for r in runs]
    if len(runs) == 1:
        return "found", starts[0], starts, None
    return ("unconfirmed", starts[0], starts[:10],
            f"heading matched in {len(runs)} separate places (pdf pages {starts[:10]}); the first is recorded, check it")


# ---------------------------------------------------------------- assembling the map

def _section(key, entry, **kw):
    s = {"key": key, "title_as_printed": None, "printed_page": None, "pdf_page": None, "end_printed_page": None,
         "end_pdf_page": None, "method": "none", "confidence": "not_found", "level": entry["level"],
         "parent": None, "basis": None, "index_section": entry.get("index_section"), "notes": []}
    s.update(kw)
    return s


def sections_from_entries(entries, table, source):
    """Walk contents/outline entries in order. -> (sections {key: section}, other_entries [...]).
    entries carry 'title' and either 'printed_page' (contents) or 'pdf_page' (outline)."""
    sections, others, context, pending = {}, [], None, []
    generic_counts = {}
    for e in entries:
        entry, _ = match_section(e["title"], table)
        if entry is not None and entry.get("contextual") and basis_in(e["title"]) is None:
            generic_counts[entry["key"]] = generic_counts.get(entry["key"], 0) + 1
    seen_generic = {}
    for e in entries:
        entry, labelled = match_section(e["title"], table)
        has_page = e.get("printed_page") is not None or e.get("pdf_page") is not None
        if entry is None:
            if has_page:
                others.append({"title": e["title"], "printed_page": e.get("printed_page"), "pdf_page": e.get("pdf_page")})
                pending = _fill_pending(pending, sections, e, source)
            continue
        notes, confidence_cap = [], None
        title_basis = basis_in(e["title"])
        if entry.get("basis"):
            context = entry["basis"]
        if entry.get("contextual"):
            basis = title_basis or context
            if basis is None:
                n = seen_generic.get(entry["key"], 0)
                seen_generic[entry["key"]] = n + 1
                basis = BASES[min(n, 1)]
                confidence_cap = "unconfirmed"
                if generic_counts.get(entry["key"], 0) >= 2:
                    notes.append(f"the {source} lists this heading more than once without saying standalone or consolidated; "
                                 f"taken as {basis} from the order only. Confirm on the page.")
                else:
                    notes.append(f"the {source} does not say standalone or consolidated; if the company has no subsidiaries "
                                 "these are its only statements. Confirm on the page.")
            elif title_basis:
                context = title_basis if entry["key"] == "auditors_report" and context is None else context
            key = f"{basis}_{entry['key']}"
        else:
            basis = entry.get("basis") or (context if entry.get("parent") == "standalone_financial_statements" else None)
            key = entry["key"]
        if labelled is False:
            confidence_cap = "unconfirmed"
            notes.append("the heading does not say standalone or consolidated; if no consolidated statements exist these are "
                         "the company's only (standalone-basis) statements. Confirm, and say so in the reply.")
        if key in sections:
            continue                                       # first occurrence wins; running headers and sub-entries repeat
        sec = _section(key, entry, title_as_printed=e["title"], printed_page=e.get("printed_page"),
                       pdf_page=e.get("pdf_page"), method=source if has_page else "none",
                       confidence="unconfirmed" if has_page else "not_found",
                       parent=_resolve_parent(entry, basis) if entry["level"] == "sub" else None,
                       basis=basis if (entry.get("contextual") or entry.get("basis")) else None, notes=notes)
        sec["_cap"] = confidence_cap
        sec["_printed_end"] = e.get("printed_end")
        sections[key] = sec
        if has_page:
            pending = _fill_pending(pending, sections, e, source)
        else:
            pending.append(key)
    for key in pending:
        sections[key]["notes"].append(f"listed in the {source} as a group header with no page number and nothing after it")
    return sections, others


def _fill_pending(pending, sections, e, source):
    for key in pending:
        s = sections[key]
        s["printed_page"], s["pdf_page"] = e.get("printed_page"), e.get("pdf_page")
        s["method"], s["confidence"] = source, "unconfirmed"
        s["notes"].append("group header without a page number; start taken from the first item listed under it")
    return []


def apply_offsets(sections, others, segments, page_count):
    """Fill pdf_page from printed_page (contents) or printed_page from pdf_page (outline)."""
    for s in list(sections.values()) + others:
        if s.get("pdf_page") is None and s.get("printed_page") is not None:
            r = PO.printed_to_pdf(segments, s["printed_page"], page_count)
            s["pdf_page"] = r["pdf_page"]
            if r["pdf_page"] is None and "notes" in s:
                s["notes"].append(f"printed page {s['printed_page']} could not be turned into a pdf page: {r['reason']}")
            elif r["extrapolated"] and "notes" in s:
                s["notes"].append("pdf page extrapolated beyond the sampled page labels")
        elif s.get("printed_page") is None and s.get("pdf_page") is not None:
            r = PO.pdf_to_printed(segments, s["pdf_page"], page_count)
            s["printed_page"] = r["printed_page"]
            if r["printed_page"] is None and "notes" in s:
                s["notes"].append(f"printed page unknown: {r['reason']}")


def compute_ends(sections, others, segments, page_count):
    """A section ends the page before the next thing starts. Sections found by searching inside the notes have no
    end (the next note heading is not in the table); the agent finds it when extracting."""
    starts = sorted({s["pdf_page"] for s in list(sections.values()) + others if s.get("pdf_page")})
    tops = sorted({s["pdf_page"] for s in sections.values() if s.get("pdf_page") and s["level"] == "top"} |
                  {o["pdf_page"] for o in others if o.get("pdf_page")})
    for s in sections.values():
        p = s.get("pdf_page")
        if not p or (s["level"] == "sub" and s["method"] == "heading_search"):
            continue
        later = [q for q in (tops if s["level"] == "top" else starts) if q > p]
        if s["key"].endswith("_auditors_report") and s.get("basis"):
            # the auditor's report usually sits inside the statements' range: it ends where the first statement starts
            inner = [x["pdf_page"] for x in sections.values() if x.get("pdf_page") and x["pdf_page"] > p and x["level"] == "sub"
                     and x.get("parent") == f"{s['basis']}_financial_statements" and x["method"] != "heading_search"]
            later = sorted(set(later) | set(inner))
        end = (later[0] - 1) if later else page_count
        if s["level"] == "top" and later:
            # a section that starts on the same page as the next one still occupies that page
            end = max(end, p)
        if end is None:
            continue
        explicit = s.get("_printed_end")
        if explicit:
            r = PO.printed_to_pdf(segments, explicit, page_count)
            if r["pdf_page"] and r["pdf_page"] >= p:
                end = r["pdf_page"]
        s["end_pdf_page"] = end
        s["end_printed_page"] = explicit or PO.pdf_to_printed(segments, end, page_count)["printed_page"]


def describe_layout(sections):
    def at(k):
        return (sections.get(k) or {}).get("pdf_page")
    sa, co = at("standalone_financial_statements"), at("consolidated_financial_statements")
    order = ("unknown" if not sa and not co else "standalone_only" if sa and not co else "consolidated_only" if co and not sa
             else "standalone_first" if sa < co else "consolidated_first")
    dr, ci = at("directors_report"), at("corporate_information")
    return {"statement_order": order,
            "statutory_reports_first": (dr < ci) if dr and ci else None,
            "notice_of_agm_inside": bool(at("notice_of_agm")),
            "brsr_inside": bool(at("brsr"))}


def finish(sections, others, table, segments, inconsistencies, page_count, meta):
    for key in required_keys(table):
        if key not in sections:
            e = entry_for_key(table, key)
            basis = key.split("_")[0] if e.get("contextual") else e.get("basis")
            sections[key] = _section(key, e, parent=_resolve_parent(e, basis or "standalone") if e["level"] == "sub" else None,
                                     basis=basis if (e.get("contextual") or e.get("basis")) else None,
                                     notes=["not located by the outline, the contents page or a heading search"])
    compute_ends(sections, others, segments, page_count)
    for s in sections.values():
        parent = sections.get(s.get("parent") or "")
        if s["level"] == "sub" and s.get("pdf_page") and parent and parent.get("pdf_page"):
            if not parent["pdf_page"] <= s["pdf_page"] <= (parent.get("end_pdf_page") or page_count):
                s["notes"].append(f"sits outside {parent['key']} in this report (pdf page {s['pdf_page']}); recorded on its own")
                s["parent"] = None
    out = []
    for s in sections.values():
        cap = s.pop("_cap", None); s.pop("_printed_end", None); s.pop("_source", None)
        if s["pdf_page"] is None and s["confidence"] != "not_found":
            s["confidence"] = "unconfirmed"
        if cap == "unconfirmed" and s["confidence"] == "found":
            s["confidence"] = "unconfirmed"
        if s["confidence"] == "not_found":
            s["method"] = "none"
        out.append(s)
    out.sort(key=lambda s: (s["pdf_page"] is None, s["pdf_page"] or 0, s["level"] != "top", s["key"]))
    from finlib import schema
    result = dict(schema.normalise_row(dict(meta))[0])      # the company id is recorded under schema.ROW_KEY
    result.update({"schema_version": 1, "page_count": page_count, "offsets": segments,
                   "offset_inconsistencies": inconsistencies, "layout": describe_layout(sections),
                   "sections": out, "other_entries": others})
    return result


def build_map(entries, source, table, segments, inconsistencies, page_count, meta, get_text=None, search=True,
              contents_pages=()):
    """entries from the outline or the contents page -> the map. get_text(pdf_page) -> str enables confirmation and
    the heading search; without it everything stays 'unconfirmed' and nothing is searched."""
    sections, others = sections_from_entries(entries, table, source)
    apply_offsets(sections, others, segments, page_count)
    if get_text is not None:
        for key, s in sections.items():
            if s["pdf_page"] is None:
                continue
            conf, page, note = confirm_start(entry_for_key(table, key), s["pdf_page"], get_text, page_count, s.get("basis"))
            if page != s["pdf_page"]:
                s["pdf_page"] = page
                s["printed_page"] = PO.pdf_to_printed(segments, page, page_count)["printed_page"] or s["printed_page"]
            s["confidence"] = conf
            if note:
                s["notes"].append(note)
        if search:
            _search_missing(sections, table, get_text, page_count, segments, contents_pages)
    return finish(sections, others, table, segments, inconsistencies, page_count, meta)


def _search_missing(sections, table, get_text, page_count, segments, contents_pages):
    compute_ends(sections, [], segments, page_count)          # parents need an end before their notes are searched
    for level in ("top", "sub"):
        for e in table["sections"]:
            if e["level"] != level:
                continue
            for key in ([f"{b}_{e['key']}" for b in BASES] if e.get("contextual") else [e["key"]]):
                if key in sections and sections[key]["pdf_page"] is not None:
                    continue
                if not e.get("required") and key not in sections and level == "top":
                    if e["key"] != "notice_of_agm":
                        continue
                basis = key.split("_")[0] if e.get("contextual") else e.get("basis")
                first, last, parent = 1, page_count, None
                if level == "sub":
                    parent = _resolve_parent(e, basis or "standalone")
                    ps = sections.get(parent)
                    if not ps or not ps.get("pdf_page"):
                        continue
                    first, last = ps["pdf_page"], ps.get("end_pdf_page") or page_count
                elif e.get("contextual"):
                    continue          # a bare "Independent Auditor's Report" heading cannot say which basis it is
                conf, page, cands, note = search_heading(e, get_text, first, last, contents_pages)
                if conf == "not_found" and key not in sections and not e.get("required"):
                    continue
                s = sections.get(key) or _section(key, e)
                s.update({"pdf_page": page, "confidence": conf, "method": "heading_search" if page else "none",
                          "parent": parent, "basis": basis if (e.get("contextual") or e.get("basis")) else s.get("basis")})
                if page:
                    s["printed_page"] = PO.pdf_to_printed(segments, page, page_count)["printed_page"]
                    s["title_as_printed"] = s.get("title_as_printed") or _first_heading_line(get_text(page), e)
                if len(cands) > 1:
                    s["candidates"] = cands
                if note:
                    s["notes"].append(note)
                sections[key] = s
        if level == "top":
            compute_ends(sections, [], segments, page_count)


def _first_heading_line(text, entry):
    anywhere = entry.get("search") == "anywhere_in_range"
    for l in (text or "").splitlines():
        if _heading_like(l, entry, anywhere):
            return C.clean(l)
    return None


# ---------------------------------------------------------------- reading a real PDF (lazy imports)

class _Pdf:
    def __init__(self, path):
        import pdfplumber                                # lazy: only when a real document is opened
        self._pdf = pdfplumber.open(path)
        self.page_count = len(self._pdf.pages)
        self._cache = {}

    def text(self, n):
        if n not in self._cache:
            try:
                self._cache[n] = self._pdf.pages[n - 1].extract_text() or ""
            except Exception as x:                       # one unreadable page must not lose the whole map
                print(f"pdf page {n}: text extraction failed ({x})", file=sys.stderr)
                self._cache[n] = ""
        return self._cache[n]


def _sample_pages(page_count, front=14, step=None):
    step = step or max(10, page_count // 25)
    return sorted(set(range(1, min(front, page_count) + 1)) | set(range(front, page_count + 1, step)) | {page_count})


def map_pdf(path, meta, search=True, contents_scan=20):
    from finlib import pdfdoc                            # pdfdoc itself imports pypdf/pdfplumber lazily
    if pdfdoc.sniff(path) != "pdf":
        C.die(f"{path} is not a PDF (detect_content_type.py says what it is)")
    table = load_table()
    pdf = _Pdf(path)
    samples = [[p, extract_printed_label(pdf.text(p), table)] for p in _sample_pages(pdf.page_count)]
    offsets = PO.compute_segments(samples, pdf.page_count)
    empty = [p for p, _ in samples if len(pdf.text(p).strip()) < 40]
    meta = dict(meta, sampled_pages_without_text=empty)
    contents_pages = [p for p in range(1, min(contents_scan, pdf.page_count) + 1) if looks_like_contents(pdf.text(p), table)]

    outline = [{"title": t, "pdf_page": p} for _, t, p in pdfdoc.outline(path)]
    known = [e for e in outline if match_section(e["title"], table)[0] is not None]
    if len(known) >= 3:
        entries, source = outline, "outline"
    elif contents_pages:
        parsed = [parse_toc_lines(pdf.text(p), table) for p in contents_pages]
        entries, source = [e for r in parsed for e in r["entries"]], "contents"
        meta["contents_pdf_pages"] = contents_pages
        meta["contents_unparsed_lines"] = [l for r in parsed for l in r["unparsed_lines"]]
    else:
        entries, source = [], "heading_search"
    meta["method_summary"] = source
    return build_map(entries, source if source != "heading_search" else "contents", table, offsets["segments"],
                     offsets["inconsistencies"], pdf.page_count, meta, get_text=pdf.text, search=search,
                     contents_pages=contents_pages)


# ---------------------------------------------------------------- self-test

TOC_SINGLE = """Contents
Corporate Overview
Corporate Information ........................................ 2
Chairman\u2019s Message . . . . . . . . . . . . . . . . . . . 4
Statutory Reports
Notice of the 28th Annual General Meeting .................... 12
Board\u2019s Report ........................................... 30
Management Discussion and
Analysis ..................................................... 62
Report on Corporate Governance ............................... 78
Business Responsibility & Sustainability Report .............. 104
Financial Statements
Standalone Financial Statements
Independent Auditor\u2019s Report ........................... 150
Balance Sheet ................................................ 164
Statement of Profit and Loss ................................. 165
Statement of Cash Flows ...................................... 166
Statement of Changes in Equity ............................... 168
Notes to the Financial Statements ............................ 170
Consolidated Financial Statements
Independent Auditor\u2019s Report ........................... 262
Consolidated Balance Sheet ................................... 270
Form AOC-1 ................................................... 340
"""

TOC_TWO_COLUMN = """What\u2019s Inside
Corporate Information 2 Standalone Financial Statements 150
Board\u2019s Report 30-61 Consolidated Financial Statements 262
Management Discussion & Analysis 62-77 Notice 344
Corporate Governance Report 78 Disclosures under Ind AS 109 210
"""

TOC_PAGE_FIRST = """INDEX
ii Corporate Information
02 Chairman's Letter
14 Directors' Report
48 Management Discussion and Analysis
60 Corporate Governance Report
96 Independent Auditors' Report on the Standalone Financial Statements
108 Standalone Financial Statements
"""

TOC_SERIAL = """Contents
1. Corporate Information 3
2. Directors' Report 10
3. Management Discussion and Analysis 41
4. Report on Corporate Governance 55
5. Independent Auditor's Report 80
6. Financial Statements 92
"""


def _cases():
    table = load_table()
    samples = [[1, "cover"], [2, ""], [3, "i"], [4, "ii"], [9, "1"], [10, "2"], [60, "52"], [200, "192"], [350, "342"]]
    seg = PO.compute_segments(samples, 360)

    def by_key(m):
        return {s["key"]: s for s in m["sections"]}

    def dot_leaders_and_wraps():
        r = parse_toc_lines(TOC_SINGLE, table)
        titles = {e["title"]: e for e in r["entries"]}
        assert r["mode"] == "title_first" and r["unparsed_lines"] == [], r["unparsed_lines"]
        assert titles["Board's Report"]["printed_page"] == "30"
        assert titles["Chairman's Message"]["printed_page"] == "4"
        assert titles["Management Discussion and Analysis"]["printed_page"] == "62"           # wrapped title rejoined
        assert titles["Notice of the 28th Annual General Meeting"]["printed_page"] == "12"   # '28th' is not a page
        assert titles["Form AOC-1"]["printed_page"] == "340"                                  # 'AOC-1' is not a page
        assert titles["Standalone Financial Statements"]["group_header"] is True
        assert "Contents" not in titles

    def two_column():
        r = parse_toc_lines(TOC_TWO_COLUMN, table)
        got = [(e["title"], e["printed_page"], e["printed_end"]) for e in r["entries"]]
        assert ("Standalone Financial Statements", "150", None) in got, got
        assert ("Board's Report", "30", "61") in got and ("Notice", "344", None) in got, got
        assert ("Disclosures under Ind AS 109", "210", None) in got, got                  # 'Ind AS 109' protected
        assert len(got) == 8, got

    def page_first_and_roman():
        r = parse_toc_lines(TOC_PAGE_FIRST, table)
        got = {e["title"]: e["printed_page"] for e in r["entries"]}
        assert r["mode"] == "page_first"
        assert got["Corporate Information"] == "ii" and got["Chairman's Letter"] == "2" and got["Directors' Report"] == "14", got

    def serial_numbers():
        r = parse_toc_lines(TOC_SERIAL, table)
        got = {e["title"]: e["printed_page"] for e in r["entries"]}
        assert got == {"Corporate Information": "3", "Directors' Report": "10", "Management Discussion and Analysis": "41",
                       "Report on Corporate Governance": "55", "Independent Auditor's Report": "80", "Financial Statements": "92"}, got

    def not_a_contents_page():
        r = parse_toc_lines("The Company disbursed loans during 2025-26 to 45,000 families.\nRefer Note 12 and Section 29C.", table)
        assert r["entries"] == [], r
        assert not looks_like_contents("Directors' Report\nYour Directors present the 28th Annual Report.", table)
        assert looks_like_contents(TOC_SINGLE, table)

    def matching():
        def k(t):
            e, _ = match_section(t, table)
            return e and e["key"]
        assert k("Board\u2019s Report") == "directors_report" and k("Report of the Board of Directors") == "directors_report"
        assert k("Annexure A to the Independent Auditor's Report") is None or k("Annexure A to the Independent Auditor's Report") != "auditors_report"
        assert k("Secretarial Audit Report") == "secretarial_audit_report"
        assert k("Auditors' Certificate on Corporate Governance") is None
        assert k("Management\u2019s Discussion & Analysis") == "mdna"
        assert k("Independent Auditors\u2019 Report on Consolidated Financial Statements") == "auditors_report"
        assert k("Consolidated Financial Statements") == "consolidated_financial_statements"
        assert k("Note 7: Loans") == "loans_note" and k("7. Loans (at amortised cost)") == "loans_note"
        assert k("Loans to related parties") is None
        assert k("14 Borrowings (other than debt securities)") == "borrowings_notes"
        assert k("Disclosures required by the Master Direction - Non-Banking Financial Company - Housing Finance Company (Reserve Bank) Directions, 2021") == "rbi_hfc_disclosures"
        assert k("45. Related party disclosures") == "related_party_transactions"
        assert k("Disclosure pursuant to RBI Master Direction on Transfer of Loan Exposures") in ("transfer_of_loan_exposures", "rbi_hfc_disclosures")
        assert match_section("Financial Statements", table)[1] is False
        assert basis_in("Standalone and Consolidated") is None and basis_in("Consolidated Balance Sheet") == "consolidated"

    def map_from_contents():
        entries = parse_toc_lines(TOC_SINGLE, table)["entries"]
        m = build_map(entries, "contents", table, seg["segments"], seg["inconsistencies"], 360, {"fy": "FY26"})
        s = by_key(m)
        assert s["directors_report"]["pdf_page"] == 38 and s["directors_report"]["end_pdf_page"] == 69, s["directors_report"]
        assert s["standalone_financial_statements"]["printed_page"] == "150"      # group header took its first item's page
        assert s["standalone_auditors_report"]["pdf_page"] == 158 and s["consolidated_auditors_report"]["pdf_page"] == 270
        assert s["standalone_balance_sheet"]["parent"] == "standalone_financial_statements"
        assert s["consolidated_balance_sheet"]["pdf_page"] == 278
        assert s["consolidated_financial_statements"]["end_pdf_page"] == 360
        assert all(x["confidence"] != "found" for x in m["sections"])             # nothing is 'found' without the pages
        assert s["rbi_hfc_disclosures"]["confidence"] == "not_found" and s["rbi_hfc_disclosures"]["method"] == "none"
        assert m["layout"]["statement_order"] == "standalone_first" and m["layout"]["notice_of_agm_inside"] is True
        assert {"title": "Chairman's Message", "printed_page": "4", "pdf_page": 12} in m["other_entries"]
        assert set(required_keys(table)) <= set(s)

    def confirm_and_search():
        pages = {10: "Example Housing Finance Ltd\nCorporate Information\nBoard of Directors", 38: "Annual Report 2025-26\nmore text",
                 39: "Board's Report\nDear Members,", 70: "Management Discussion and Analysis\nIndustry overview",
                 158: "Independent Auditor's Report\nTo the Members\nReport on the audit of the standalone financial statements",
                 172: "Balance Sheet as at March 31, 2026", 200: "Notes to the financial statements\n7. Loans (at amortised cost)\n(Rs. in lakh)",
                 201: "Notes to the financial statements\n7. Loans (at amortised cost) (contd.)",
                 240: "48. Related party disclosures\nas per Ind AS 24",
                 255: "52. Disclosures required by the Reserve Bank of India under the Master Direction\n52.1 Capital to risk assets ratio",
                 90: "Refer the Related party disclosures in the notes"}
        entries = parse_toc_lines(TOC_SINGLE, table)["entries"]
        m = build_map(entries, "contents", table, seg["segments"], seg["inconsistencies"], 360, {}, get_text=lambda p: pages.get(p, ""))
        s = by_key(m)
        assert s["corporate_information"]["confidence"] == "found"
        assert s["directors_report"]["pdf_page"] == 39 and s["directors_report"]["printed_page"] == "31"
        assert any("implied 38" in n for n in s["directors_report"]["notes"])
        assert s["mdna"]["confidence"] == "found" and s["corporate_governance_report"]["confidence"] == "unconfirmed"
        assert s["loans_note"]["pdf_page"] == 200 and s["loans_note"]["method"] == "heading_search" and s["loans_note"]["confidence"] == "found"
        assert s["loans_note"]["end_pdf_page"] is None and s["loans_note"]["title_as_printed"] == "7. Loans (at amortised cost)"
        assert s["related_party_transactions"]["pdf_page"] == 240                  # page 90 is outside the statements' range
        assert s["rbi_hfc_disclosures"]["pdf_page"] == 255 and s["rbi_hfc_disclosures"]["printed_page"] == "247"
        assert s["transfer_of_loan_exposures"]["confidence"] == "not_found"

    def outline_entries():
        entries = [{"title": "Cover", "pdf_page": 1}, {"title": "Directors\u2019 Report", "pdf_page": 22},
                   {"title": "Management Discussion and Analysis", "pdf_page": 50}, {"title": "Independent Auditor's Report", "pdf_page": 120},
                   {"title": "Financial Statements", "pdf_page": 132}]
        m = build_map(entries, "outline", table, seg["segments"], [], 300, {})
        s = by_key(m)
        assert s["directors_report"]["printed_page"] == "14" and s["directors_report"]["method"] == "outline"
        assert s["standalone_financial_statements"]["confidence"] == "unconfirmed"
        assert any("no subsidiaries" in n or "only" in n for n in s["standalone_auditors_report"]["notes"])
        assert m["layout"]["statement_order"] == "standalone_only"

    def printed_labels():
        assert extract_printed_label("Example Housing Finance Ltd\nsome text\n45", table) == "45"
        assert extract_printed_label("xii\nForeword text here", table) == "xii"
        assert extract_printed_label("text\n46 | Annual Report 2025-26", table) == "46"
        assert extract_printed_label("text\nExample Housing Finance Ltd | 47", table) == "47"
        assert extract_printed_label("Page 12 of 300\nbody", table) == "12"
        assert extract_printed_label("12\nbody text\n14", table) is None                 # header and footer disagree
        assert extract_printed_label("Total 1,234\nbody\nFor and on behalf of the Board", table) is None
        assert extract_printed_label("", table) is None

    def schema_valid():
        from finlib import schema
        entries = parse_toc_lines(TOC_SINGLE, table)["entries"]
        m = build_map(entries, "contents", table, seg["segments"], seg["inconsistencies"], 360,
                      {schema.ROW_KEY: "example-housing-finance", "fy": "FY26", "source_file": "FY26_annual-report.pdf",
                       "content_type": "text", "method_summary": "contents"})
        problems = schema.validate(m, C.load_schema("section-map.schema.json"))
        assert problems == [], problems[:5]
        # a caller passing the key's older name still gets a map keyed schema.ROW_KEY
        m = build_map(entries, "contents", table, seg["segments"], seg["inconsistencies"], 360,
                      {schema.LEGACY_ROW_KEYS[0]: "example-housing-finance", "fy": "FY26", "source_file": None, "content_type": "text", "method_summary": "contents"})
        assert m[schema.ROW_KEY] == "example-housing-finance" and schema.LEGACY_ROW_KEYS[0] not in m
        assert schema.validate(m, C.load_schema("section-map.schema.json")) == []

    def whole_pdf_path_with_a_stub_reader():
        """map_pdf end to end with a stand-in for pdfplumber: 60 synthetic pages, roman front matter, no bookmarks."""
        import tempfile, types
        from finlib import pdfdoc
        body = {1: "Example Housing Finance Ltd\nAnnual Report 2025-26", 2: "",
                3: "Contents\nCorporate Information ...... 1\nBoard's Report ...... 4\nManagement Discussion and Analysis ...... 12\n"
                   "Report on Corporate Governance ...... 18\nIndependent Auditor's Report ...... 26\nFinancial Statements ...... 30\ni",
                4: "Chairman's message\nii", 5: "Corporate Information\nBoard of Directors\n1", 8: "Board's Report\nDear Members\n4",
                16: "Management Discussion and Analysis\n12", 22: "Report on Corporate Governance\n18",
                30: "Independent Auditor's Report\nTo the Members of Example Housing Finance Ltd\n26",
                34: "Balance Sheet as at March 31, 2026\n(Rs. in lakh)\n30", 40: "Notes to the financial statements\n7. Loans (at amortised cost)\n36",
                52: "Notes to the financial statements\n41. Related party disclosures\n48",
                55: "Notes to the financial statements\n44. Disclosures required under the Master Direction issued by the Reserve Bank of India\n51"}
        texts = [body.get(n) if n in body else (f"Running text of the report, page body line one.\nmore text\n{n - 4}" if n > 4 else "") for n in range(1, 61)]

        class Page:
            def __init__(self, t): self.t = t
            def extract_text(self): return self.t
        class Doc:
            pages = [Page(t) for t in texts]
        stub = types.ModuleType("pdfplumber"); stub.open = lambda path: Doc()
        saved, saved_outline = sys.modules.get("pdfplumber"), pdfdoc.outline
        sys.modules["pdfplumber"] = stub; pdfdoc.outline = lambda path: []
        try:
            d = tempfile.mkdtemp(); path = os.path.join(d, "FY26_annual-report.pdf")
            with open(path, "wb") as f:
                f.write(b"%PDF-1.7\n")
            m = map_pdf(path, {"primary_context_entity": "example-housing-finance", "fy": "FY26", "content_type": "text"})
        finally:
            pdfdoc.outline = saved_outline
            if saved is None: del sys.modules["pdfplumber"]
            else: sys.modules["pdfplumber"] = saved
        s = by_key(m)
        assert m["method_summary"] == "contents" and m["contents_pdf_pages"] == [3] and m["page_count"] == 60
        assert [(o["style"], o["offset"]) for o in m["offsets"]] == [("roman", 2), ("arabic", 4)], m["offsets"]
        assert s["directors_report"]["pdf_page"] == 8 and s["directors_report"]["confidence"] == "found" and s["directors_report"]["end_pdf_page"] == 15
        assert s["standalone_financial_statements"]["pdf_page"] == 34 and s["standalone_financial_statements"]["confidence"] == "unconfirmed"
        assert s["standalone_auditors_report"]["pdf_page"] == 30
        assert s["loans_note"]["pdf_page"] == 40 and s["related_party_transactions"]["printed_page"] == "48"
        assert s["rbi_hfc_disclosures"]["pdf_page"] == 55 and s["brsr"]["confidence"] == "not_found"
        assert m["layout"]["statement_order"] == "standalone_only"
        import validate_section_map as V
        errors, _ = V.validate(m)
        assert errors == [], errors

    return [("map_pdf end to end with a stub PDF reader", whole_pdf_path_with_a_stub_reader),
            ("dot leaders, wrapped titles, protected phrases", dot_leaders_and_wraps), ("two-column contents page", two_column),
            ("page-first layout with roman numerals", page_first_and_roman), ("serial-numbered entries", serial_numbers),
            ("prose is not a contents page", not_a_contents_page), ("heading table matching", matching),
            ("map from a contents page", map_from_contents), ("confirmation and note-level heading search", confirm_and_search),
            ("map from an outline, company without subsidiaries", outline_entries), ("printed page labels", printed_labels),
            ("output validates against section-map.schema.json", schema_valid)]


def main():
    ap = argparse.ArgumentParser(description="Build an annual report's section map: outline, then contents page, then heading search.",
                                 epilog="Example: section_map.py /workspace/in/FY26_annual-report.pdf --company-id example-housing-finance --fy FY26 --out /workspace/out/map.json")
    ap.add_argument("pdf", nargs="?", help="the annual report PDF")
    ap.add_argument("--company-id", dest="company_id", help="the company's id, recorded in the map")
    ap.add_argument("--customer-id", dest="company_id", help=argparse.SUPPRESS)   # older name of --company-id, still accepted
    ap.add_argument("--fy", help="financial year of the report, e.g. FY26")
    ap.add_argument("--content-type", choices=["text", "mixed", "scanned"], help="what detect_content_type.py reported, recorded in the map")
    ap.add_argument("--out", help="also write the map to this file")
    ap.add_argument("--no-heading-search", action="store_true", help="skip the page-by-page search (faster; missing sections stay not_found)")
    ap.add_argument("--toc-text", help="text of the contents page (file or -); builds the map without opening a PDF")
    ap.add_argument("--samples", help="JSON [[pdf_page, label], ...] for --toc-text mode (see page_offset.py)")
    ap.add_argument("--page-count", type=int, help="pages in the PDF, for --toc-text mode")
    ap.add_argument("--self-test", action="store_true", help="run the built-in cases and exit 0 or 1")
    args = ap.parse_args()
    if args.self_test:
        C.run_self_test(_cases())
    meta = {"primary_context_entity": args.company_id, "fy": args.fy, "content_type": args.content_type}
    if args.fy:
        from finlib import periods
        p = periods.normalise(args.fy)
        if not p or p["kind"] != "year":
            C.die(f"--fy {args.fy!r} is not a financial year (write it as FY26)")
        meta["fy"] = p["period"]
    if args.toc_text:
        if not args.page_count or not args.samples:
            C.die("--toc-text needs --samples and --page-count; without them printed pages cannot become PDF pages")
        text = sys.stdin.read() if args.toc_text == "-" else open(args.toc_text, encoding="utf-8").read()
        table = load_table()
        offsets = PO.compute_segments(C.read_json_arg(args.samples), args.page_count)
        parsed = parse_toc_lines(text, table)
        meta.update({"source_file": None, "method_summary": "contents", "contents_unparsed_lines": parsed["unparsed_lines"]})
        result = build_map(parsed["entries"], "contents", table, offsets["segments"], offsets["inconsistencies"], args.page_count, meta)
    elif args.pdf:
        if not os.path.exists(args.pdf):
            C.die(f"no such file: {args.pdf}")
        meta["source_file"] = os.path.basename(args.pdf)
        try:
            result = map_pdf(args.pdf, meta, search=not args.no_heading_search)
        except ImportError as x:
            C.die(f"{x}; the sandbox installs pdfplumber and pypdf at start-up, see /tmp/eve-doc-libs.log")
    else:
        C.die("give a PDF, or --toc-text with --samples and --page-count")
    if args.out:
        import json
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    C.emit(result)
    located = [s for s in result["sections"] if s["pdf_page"]]
    if not located:
        C.die("no section could be located. If detect_content_type.py says the file is scanned, report that; "
              "do not return an empty map as if the report had no sections", C.EXIT_CHECK_FAILED)


if __name__ == "__main__":
    main()
