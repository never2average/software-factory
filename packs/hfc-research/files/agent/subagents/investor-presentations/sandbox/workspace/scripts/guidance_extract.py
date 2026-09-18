#!/usr/bin/env python3
"""Earnings-call transcript -> CANDIDATE guidance sentences by topic, with speaker and page. The model confirms each one.

  python3 /workspace/scripts/guidance_extract.py /workspace/in/transcript.pdf > /workspace/out/guidance-candidates.json
  python3 /workspace/scripts/guidance_extract.py --text-file transcript.txt      (pages separated by a form feed, \\f)

How it reads the transcript:
  * Speaker turns start with 'Name:' at the beginning of a line ('Moderator:', 'Asha Rao:', 'Asha Rao – MD & CEO:').
  * The Q&A starts at the moderator's 'question-and-answer session' / 'first question' line. Whoever the moderator
    introduces ('the next question is from the line of X from Y') is an analyst. Whoever spoke before the Q&A, other
    than the moderator, is management. Anyone else is 'unknown' and is kept (and flagged), never silently dropped.
  * A guidance candidate is a management/unknown sentence that has a forward-looking cue AND a topic keyword AND either
    a figure or a direction word. Tables: references/guidance-topics.json.
  * Also listed: deflections (a management reply that declines to answer, with the analyst's question) and
    explanations (a causal cue next to asset quality / yields / cost of funds / balance-transfer vocabulary).

It never decides that something IS guidance, never paraphrases, and never picks between two figures in one sentence.
pdfplumber is imported lazily, only for a PDF.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, re
from finlib import pdfdoc
from iplib import emit, fail, load_table, find_phrases, parse_range

_TURN = re.compile(r"^\s*(?P<name>[A-Z][A-Za-z.'’\-]*(?:\s+[A-Z][A-Za-z.'’\-]*){0,4})(?:\s*[-–—,]\s*(?P<desig>[^:]{2,80}))?\s*:\s*(?P<rest>.*)$")
_ABBR = re.compile(r"\b(Rs|Mr|Ms|Mrs|Dr|approx|vs|no|Nos|i\.e|e\.g|Ltd|Pvt|Co|Inc|St)\.", re.I)
_PAGE_NOISE = re.compile(r"^\s*(?:page\s*)?\d{1,3}\s*(?:of\s*\d{1,3})?\s*$", re.I)


def split_sentences(text):
    t = _ABBR.sub(lambda m: m.group(1) + "․", text)            # protect 'Rs.' 'Mr.' from the splitter
    parts = re.split(r"(?<=[.?!])[\"')\]]?\s+(?=[\"'(\[]?[A-Z0-9₹])", t)
    return [p.replace("․", ".").strip() for p in parts if p.strip()]


def parse_turns(pages, table):
    """pages: [(page_no, text)] -> [{'speaker','designation','page','chunks':[(page, line)]}]"""
    stop = set(table["not_a_speaker"])
    turns, cur = [], None
    for pno, text in pages:
        for line in text.splitlines():
            if not line.strip() or _PAGE_NOISE.match(line): continue
            m = _TURN.match(line)
            if m and m.group("name").strip().lower() not in stop and len(m.group("name")) <= 60:
                cur = {"speaker": " ".join(m.group("name").split()), "designation": (m.group("desig") or "").strip() or None, "page": pno, "chunks": []}
                turns.append(cur)
                if m.group("rest").strip(): cur["chunks"].append((pno, m.group("rest").strip()))
            elif cur is not None:
                cur["chunks"].append((pno, line.strip()))
    return turns


def turn_sentences(turn):
    """[(page, sentence)]: the page is where the sentence STARTS."""
    text, marks = "", []
    for pno, line in turn["chunks"]:
        marks.append((len(text), pno)); text += line + " "
    out, pos = [], 0
    for s in split_sentences(text):
        at = text.find(s[:25], pos)
        if at < 0: at = pos
        page = [p for o, p in marks if o <= at][-1] if marks else turn["page"]
        out.append((page, s)); pos = at + 1
    return out


def assign_roles(turns, table):
    mods = set(table["moderator_names"])
    intro = [re.compile(p) for p in table["analyst_intro_patterns"]]
    analysts, management, qa_turn = {}, [], None
    for i, t in enumerate(turns):
        body = " ".join(l for _, l in t["chunks"])
        if t["speaker"].lower() in mods:
            if qa_turn is None and find_phrases(body, table["qa_start_cues"]): qa_turn = i
            for rx in intro:
                for m in rx.finditer(body):
                    analysts[m.group("name").strip().lower()] = m.group("firm").strip()
        elif qa_turn is None and t["speaker"] not in management:
            management.append(t["speaker"])
    for i, t in enumerate(turns):
        n = t["speaker"].lower()
        t["section"] = "qa" if qa_turn is not None and i >= qa_turn else "opening"
        if n in mods: t["role"] = "moderator"
        elif n in analysts or any(n.split()[-1] == a.split()[-1] and n.split()[0] == a.split()[0] for a in analysts): t["role"] = "analyst"
        elif t["speaker"] in management: t["role"] = "management"
        else: t["role"] = "unknown"
    return qa_turn, analysts, management


def classify_topics(sentence, table):
    hits = []
    for key, spec in table["topics"].items():
        found = find_phrases(sentence, spec["keywords"])
        if found: hits.append((key, found, sum(len(f.split()) for f in found)))
    hits.sort(key=lambda h: (-h[2], h[0]))
    if not hits: return None, []
    primary = hits[0][0] if len(hits) == 1 or hits[0][2] > hits[1][2] else None
    return primary, [{"topic": k, "matched": f} for k, f, _ in hits]


def direction_of(sentence, table):
    found = {d for d, words in table["direction_words"].items() if find_phrases(sentence, words)}
    return (found.pop() if len(found) == 1 else None), sorted(found) if len(found) > 1 else []


def extract(pages, table, document=None):
    warnings = []
    turns = parse_turns(pages, table)
    if not turns:
        return {"document": document, "pages": len(pages), "speakers": [], "guidance_candidates": [], "deflections": [], "explanations": [],
                "warnings": ["no 'Name:' speaker turns found: this may not be a transcript, or it uses another layout. Read it page by page; do not attribute speakers you cannot see."]}
    qa_turn, analysts, management = assign_roles(turns, table)
    if qa_turn is None: warnings.append("no question-and-answer start found; every non-moderator speaker is treated as management, analysts included. Check the speaker of each candidate.")
    if not management: warnings.append("nobody spoke before the Q&A, so management could not be identified; roles are 'unknown'")
    lo, hi = table["statement_length"]["min"], table["statement_length"]["max"]
    cands, defl, expl = [], [], []
    last_q = None
    for t in turns:
        if t["role"] == "analyst":
            body = " ".join(l for _, l in t["chunks"])
            last_q = {"by": t["speaker"], "firm": analysts.get(t["speaker"].lower()), "page": t["page"], "excerpt": body[:400]}
            continue
        if t["role"] == "moderator": continue
        for page, s in turn_sentences(t):
            base = {"statement": s, "speaker": t["speaker"], "designation": t["designation"], "role": t["role"], "page": page, "section": t["section"]}
            if t["section"] == "qa" and last_q: base["in_reply_to"] = {"by": last_q["by"], "firm": last_q["firm"], "page": last_q["page"]}
            d = find_phrases(s, table["deflection_phrases"])
            if d:
                defl.append({**base, "matched": d, "question": last_q})
            ec = find_phrases(s, table["explanation_cues"])
            if ec:
                et = [k for k, words in table["explanation_topics"].items() if find_phrases(s, words)]
                if et: expl.append({**base, "about": et, "cues": ec})
            cues = find_phrases(s, table["forward_cues"])
            if not cues: continue
            primary, topics = classify_topics(s, table)
            if not topics: continue
            rng = parse_range(s)
            direction, conflict = direction_of(s, table)
            if not rng["matches"] and not direction and not conflict: continue
            flags = []
            if primary is None: flags.append("topic_ambiguous: choose after reading the sentence in context")
            if len(rng["matches"]) > 1: flags.append("several_figures: the script did not choose one; set value_low/value_high yourself")
            if conflict: flags.append("direction_words_conflict: " + "/".join(conflict))
            if len(s) > hi: flags.append(f"longer_than_{hi}_chars: quote the clause that carries the guidance")
            if len(s) < lo: flags.append(f"shorter_than_{lo}_chars: quote enough to stand alone")
            if t["role"] == "unknown": flags.append("speaker_role_unknown: confirm this is management")
            cands.append({**base, "topic": primary, "topics": topics, "value_low": rng["low"], "value_high": rng["high"], "value_unit": rng["unit"],
                          "figures": rng["matches"], "direction": direction, "cues": cues[:6],
                          "score": (2 if rng["matches"] else 0) + min(3, len(cues)) + (1 if direction else 0), "flags": flags})
    speakers = {}
    for t in turns:
        k = t["speaker"]
        sp = speakers.setdefault(k, {"name": k, "designation": t["designation"], "role": t["role"], "turns": 0, "first_page": t["page"]})
        sp["turns"] += 1
        if t["designation"] and not sp["designation"]: sp["designation"] = t["designation"]
    topics_seen = sorted({c["topic"] for c in cands if c["topic"]})
    return {"document": document, "pages": len(pages), "qa_starts_page": turns[qa_turn]["page"] if qa_turn is not None else None,
            "speakers": list(speakers.values()), "management": management, "guidance_candidates": cands, "topics_with_candidates": topics_seen,
            "topics_without_candidates": [k for k in table["topics"] if k != "other" and k not in topics_seen],
            "deflections": defl, "explanations": expl, "warnings": warnings,
            "reminder": "Candidates only. Read each in context, quote management's words exactly, and drop anything that is a report on the past quarter rather than guidance."}


_T = [
    (1, "Example Housing Finance Ltd\nQ2 FY26 Earnings Conference Call\nManagement: Asha Rao, Vikram Shah\nNote: This transcript has been edited for clarity.\n"
        "Moderator: Ladies and gentlemen, welcome to the Q2 FY26 earnings call of Example Housing Finance Ltd. I now hand over to Ms. Asha Rao.\n"
        "Asha Rao – MD & CEO: Thank you. AUM grew 18% YoY to Rs. 12,345 crore during the quarter. "
        "For the full year we expect AUM growth of 18% to 20%. We will add around 25 branches this year.\n1"),
    (2, "Vikram Shah: On margins, we expect spreads to remain in the 3.2-3.4% band going forward. "
        "Credit cost should be 30 to 40 basis points for FY26 and disbursement growth should be north of 20% with cost to income of 38%.\n"
        "Moderator: We will now begin the question-and-answer session. The first question is from the line of Rohan Mehta from Example Securities. Please go ahead.\n"
        "Rohan Mehta: Thank you. Can you give a number for the capital raise and its timing? Also why did GNPA move up?\n2"),
    (3, "Asha Rao: We would not like to comment on the timing of any capital raise at this point. "
        "GNPA moved up mainly because of seasonal delinquencies in the self-employed segment, and we expect asset quality to improve in the second half. "
        "Balance transfer attrition was higher due to aggressive pricing by banks.\n"
        "Moderator: The next question is from the line of Priya Nair from Example Asset Management.\n"
        "Priya Nair: Do you expect NIM to expand next year?\n"
        "Sanjay Gupta: We will continue to maintain NIM at current levels next year.\n3"),
]


def _self_test():
    table = load_table("guidance-topics.json")
    checks = []
    def ok(name, cond, detail=None):
        checks.append({"check": name, "ok": bool(cond), **({"detail": detail} if not cond else {})})

    r = extract(_T, table, "synthetic")
    roles = {s["name"]: s["role"] for s in r["speakers"]}
    ok("roles: moderator, management before Q&A, introduced analysts, late joiner unknown", roles == {"Moderator": "moderator", "Asha Rao": "management", "Vikram Shah": "management",
       "Rohan Mehta": "analyst", "Priya Nair": "analyst", "Sanjay Gupta": "unknown"}, roles)
    ok("'Management:' and 'Note:' lines are not speakers", "Management" not in roles and "Note" not in roles)
    ok("designation after the dash is captured", next(s for s in r["speakers"] if s["name"] == "Asha Rao")["designation"] == "MD & CEO", r["speakers"])
    ok("Q&A start page", r["qa_starts_page"] == 2)
    g = {c["statement"][:40]: c for c in r["guidance_candidates"]}
    by_topic = {}
    for c in r["guidance_candidates"]: by_topic.setdefault(c["topic"], []).append(c)
    a = by_topic.get("aum_growth", [None])[0]
    ok("AUM growth guidance: range, unit, speaker, page", a and (a["value_low"], a["value_high"], a["value_unit"], a["speaker"], a["page"]) == (18.0, 20.0, "percent", "Asha Rao", 1), a)
    ok("the reported-quarter sentence ('grew 18% YoY') is not a candidate", not any("grew 18%" in c["statement"] for c in r["guidance_candidates"]))
    b = by_topic.get("branch_additions", [None])[0]
    ok("branch additions: 25, count", b and (b["value_low"], b["value_unit"]) == (25.0, "count"), b)
    s = by_topic.get("spread_nim", [])
    ok("spread band 3.2-3.4% on page 2 by Vikram Shah ('Rs.' and decimals did not split the sentence)", any((c["value_low"], c["value_high"], c["page"], c["speaker"]) == (3.2, 3.4, 2, "Vikram Shah") for c in s), s)
    multi = [c for c in r["guidance_candidates"] if "several_figures" in " ".join(c["flags"])]
    ok("a sentence with three figures: none chosen, all listed, topic ambiguous or primary with others", len(multi) == 1 and multi[0]["value_low"] is None and len(multi[0]["figures"]) == 3
       and len(multi[0]["topics"]) >= 3, multi)
    aq = by_topic.get("asset_quality", [])
    ok("directional guidance without a figure is kept ('expect asset quality to improve')", any(c["direction"] == "up" and c["figures"] == [] for c in aq), aq)
    u = [c for c in r["guidance_candidates"] if c["speaker"] == "Sanjay Gupta"]
    ok("unknown speaker kept and flagged; direction stable", len(u) == 1 and u[0]["direction"] == "stable" and any("speaker_role_unknown" in f for f in u[0]["flags"]) and
       u[0]["in_reply_to"]["by"] == "Priya Nair", u)
    ok("analyst sentences are never candidates", not any(c["speaker"] in ("Rohan Mehta", "Priya Nair") for c in r["guidance_candidates"]))
    ok("deflection caught with the analyst's question", len(r["deflections"]) == 1 and r["deflections"][0]["question"]["by"] == "Rohan Mehta" and
       r["deflections"][0]["question"]["firm"] == "Example Securities" and r["deflections"][0]["page"] == 3, r["deflections"])
    ex = {tuple(e["about"]) for e in r["explanations"]}
    ok("explanations: asset quality and BT attrition", ("asset_quality",) in ex and ("bt_attrition",) in ex, r["explanations"])
    ok("topics without candidates are listed (so silence is visible)", "borrowing_mix" in r["topics_without_candidates"] and "aum_growth" not in r["topics_without_candidates"], r["topics_without_candidates"])

    r2 = extract([(1, "Example Housing Finance Ltd\nInvestor letter\nWe expect AUM growth of 20%.")], table)
    ok("no speaker turns -> no candidates, a warning, no invented speaker", r2["guidance_candidates"] == [] and r2["warnings"], r2)
    r3 = extract([(1, "Asha Rao: We expect AUM growth of 20% next year.\nRohan Mehta: And spreads, do you expect them to be stable at 3%?")], table)
    ok("no Q&A marker -> warning, and the analyst's sentence is flagged for checking rather than trusted", any("question-and-answer" in w for w in r3["warnings"]) and len(r3["guidance_candidates"]) == 2, r3)
    ss = split_sentences("AUM is Rs. 12,345 crore. Spread was 3.4% vs. 3.2% last year. We expect 20% growth! Is that clear? Yes.")
    ok("sentence splitter keeps 'Rs.' 'vs.' and decimals intact", len(ss) == 5 and ss[0] == "AUM is Rs. 12,345 crore.", ss)
    long = "Asha Rao: We expect AUM growth of 20% " + "and we will keep investing in the franchise " * 20 + "."
    r4 = extract([(1, long)], table)
    ok("over-long sentence is flagged for clause quoting", any("longer_than" in f for f in r4["guidance_candidates"][0]["flags"]), r4["guidance_candidates"])
    return checks


def read_pages(path):
    kind = pdfdoc.sniff(path)
    if kind == "pdf":
        return pdfdoc.page_texts(path)   # lazy pdfplumber import inside finlib
    if kind == "text":
        return list(enumerate(open(path, encoding="utf-8").read().split("\f"), 1))
    fail(f"{path} is neither a PDF nor plain text (looks like: {kind}); run detect_content_type.py and report it")


def main():
    ap = argparse.ArgumentParser(description="Transcript -> candidate guidance sentences by topic, with speaker and page; plus deflections and explanations. JSON on stdout.")
    ap.add_argument("file", nargs="?", help="transcript PDF (or .txt with \\f between pages)")
    ap.add_argument("--text-file", help="plain text, pages separated by a form feed; '-' for stdin")
    ap.add_argument("--topic", help="keep only candidates that mention this topic key")
    ap.add_argument("--self-test", action="store_true", help="run built-in cases (no input files, no pdfplumber) and exit 0 or 1")
    a = ap.parse_args()
    if a.self_test:
        checks = _self_test()
        bad = [c for c in checks if not c["ok"]]
        emit({"script": "guidance_extract.py", "passed": len(checks) - len(bad), "failed": len(bad), "failures": bad})
        sys.exit(1 if bad else 0)
    table = load_table("guidance-topics.json")
    if a.topic and a.topic not in table["topics"]:
        fail(f"unknown topic {a.topic!r}; known: {list(table['topics'])}")
    if a.text_file:
        text = sys.stdin.read() if a.text_file == "-" else open(a.text_file, encoding="utf-8").read()
        pages, doc = list(enumerate(text.split("\f"), 1)), a.text_file
    elif a.file:
        if not os.path.isfile(a.file): fail(f"no such file: {a.file}")
        try: pages = read_pages(a.file)
        except ImportError: fail("pdfplumber is not installed in this sandbox; cannot read the transcript PDF", 3)
        except SystemExit: raise
        except Exception as x: fail(f"could not read {a.file} ({type(x).__name__}: {x}); report the file as unreadable", 4)
        doc = os.path.basename(a.file)
    else:
        fail("give a transcript file, --text-file, or --self-test")
    if pages and sum(len(t.strip()) for _, t in pages) < 40 * len(pages):
        fail("the transcript has no usable text layer (scanned). Do not quote from an image; report it and look for a text version.", 6)
    out = extract(pages, table, doc)
    if a.topic:
        out["guidance_candidates"] = [c for c in out["guidance_candidates"] if any(t["topic"] == a.topic for t in c["topics"])]
    emit(out)


if __name__ == "__main__":
    main()
