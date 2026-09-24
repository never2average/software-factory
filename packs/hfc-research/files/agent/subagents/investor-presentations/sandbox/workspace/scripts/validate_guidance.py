#!/usr/bin/env python3
"""The gate before dataroom_append_jsonl on guidance.jsonl: schema + the rules a schema cannot express.

  python3 /workspace/scripts/validate_guidance.py /workspace/out/guidance.new.jsonl
  python3 /workspace/scripts/validate_guidance.py /workspace/out/guidance.new.jsonl --previous /workspace/in/guidance.jsonl --transcript /workspace/in/transcript.pdf

Exit 0: no errors (read the warnings). Exit 1: errors, nothing may be appended. Exit 2: unreadable input.

Rules (each error names its rule):
  schema      schemas/guidance-row.schema.json (topic in the taxonomy, change_vs_previous in the set, required fields)
  statement   non-empty quoted text, 20..600 characters (references/guidance-topics.json 'statement_length'), no '...' elisions
              standing in for words, not the same statement twice
  page        speaker and page on every row; only a withdrawn row whose statement is the fixed 'No statement on this
              topic in the <period> call.' sentence may leave them null
  period      one quarter per file; previous_period, when given, is the quarter just before
  figures     value_low <= value_high; value_unit given whenever a value is
  change      with --previous: a row's change_vs_previous may not contradict what the figures or the presence of a
              previous statement show (guidance_diff.py); topics guided last quarter and absent now need a withdrawn row
  verbatim    with --transcript: the statement must occur in the transcript word for word (whitespace and quote marks
              aside), and on the page the row names (a different page is a warning)
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, json, re, tempfile
from finlib import periods, schema, pdfdoc
from iplib import emit, fail, load_table, load_schema, norm_period
import guidance_diff

FIXED_WITHDRAWN = re.compile(r"^No statement on this topic in the Q[1-4] ?FY\d{2} call\.$")


def squash(s):
    s = (s or "").replace("“", '"').replace("”", '"').replace("’", "'").replace("‘", "'").replace("–", "-").replace("—", "-")
    return re.sub(r"\s+", " ", s).strip().strip('"').lower()


def validate(rows, problems, table, sch, history=None, pages=None):
    errors = [{"line": None, "rule": "schema", "message": p} for p in problems]
    warnings = []
    E = lambda n, rule, msg: errors.append({"line": n, "rule": rule, "message": msg})
    W = lambda n, rule, msg: warnings.append({"line": n, "rule": rule, "message": msg})
    # rows stored under the key's older name read as the new key; both keys disagreeing is an error
    normed = []
    for n, r in rows:
        r, kp = schema.normalise_row(r); normed.append((n, r))
        for p in kp: E(n, "schema", p)
    rows = normed
    if history is not None: history = [(hn, schema.normalise_row(hr)[0]) for hn, hr in history]
    lo, hi = table["statement_length"]["min"], table["statement_length"]["max"]
    seen_stmt, seen_key = {}, {}
    for n, r in rows:
        for p in schema.validate(r, sch): E(n, "schema", p)
        st = r.get("statement")
        if isinstance(st, str):
            body = st.strip()
            if len(body) < lo: E(n, "statement", f"statement is {len(body)} characters; quote at least {lo} so it stands alone")
            if len(body) > hi: E(n, "statement", f"statement is {len(body)} characters; quote the clause that carries the guidance (at most {hi})")
            if re.search(r"\.\.\.|…", body): W(n, "statement", "the statement contains an elision ('...'); quote continuous words, or split into two rows")
            k = squash(body)
            if k in seen_stmt: E(n, "statement", f"same statement as line {seen_stmt[k]}")
            seen_stmt.setdefault(k, n)
        fixed = isinstance(st, str) and bool(FIXED_WITHDRAWN.match(st.strip()))
        change = r.get("change_vs_previous")
        if r.get("speaker") is None or r.get("page") is None:
            if not (change == "withdrawn" and fixed):
                E(n, "page", "speaker and page are required; only a withdrawn row using the fixed sentence 'No statement on this topic in the <period> call.' may leave them null")
        if fixed and change != "withdrawn":
            E(n, "page", "the fixed 'No statement on this topic' sentence is only for withdrawn rows")
        if isinstance(r.get("topic"), str) and r["topic"] not in table["topics"]:
            E(n, "schema", f"topic '{r['topic']}' is not in references/guidance-topics.json")
        if change is not None and change not in table["change_vs_previous"]:
            E(n, "schema", f"change_vs_previous '{change}' is not one of {table['change_vs_previous']}")
        per = periods.normalise(r.get("period")) if isinstance(r.get("period"), str) else None
        if not per or per["kind"] != "quarter":
            E(n, "period", f"period {r.get('period')!r} is not a quarter such as Q2FY26 (the call's quarter)")
        elif r.get("previous_period") is not None and norm_period(r["previous_period"]) != periods.previous_quarter(per["period"]):
            W(n, "period", f"previous_period {r['previous_period']} is not the quarter just before {per['period']}; say in the note why")
        vl, vh = r.get("value_low"), r.get("value_high")
        if isinstance(vl, (int, float)) and isinstance(vh, (int, float)) and vl > vh: E(n, "figures", f"value_low {vl} is above value_high {vh}")
        if (vl is not None or vh is not None) and not r.get("value_unit"): E(n, "figures", "value_low/value_high given without value_unit")
        if change in ("maintained", "raised", "lowered") and not (r.get("previous_statement") or history):
            W(n, "change", f"'{change}' claims a comparison: give previous_statement, or validate with --previous so the claim can be checked")
        key = (r.get("topic"), r.get("subtopic"))
        if key in seen_key and change != "withdrawn":
            W(n, "statement", f"second row for topic {key[0]}{'/' + key[1] if key[1] else ''} (first at line {seen_key[key]}); give each a subtopic so next quarter's comparison can match them")
        seen_key.setdefault(key, n)

    pers = sorted({norm_period(r.get("period")) for _, r in rows if isinstance(r.get("period"), str) and norm_period(r.get("period"))})
    if len(pers) > 1: E(None, "period", f"one call per file; found periods {pers}")

    if history is not None and len(pers) == 1 and rows:
        out, errs = guidance_diff.diff(rows, history)
        for m in errs: E(None, "change", m)
        if out:
            for x in out["results"]:
                name = f"{x['topic']}{'/' + x['subtopic'] if x['subtopic'] else ''}"
                if x["current"] is None:
                    E(None, "change", f"{name} was guided in {out['previous_period']} (\"{(x['previous']['statement'] or '')[:80]}\") and has no row now: add a withdrawn row after searching the transcript, or the row that continues it")
                elif x["agrees_with_recorded"] is False:
                    line = x["current"]["line"] if isinstance(x["current"], dict) else None
                    E(line, "change", f"{name}: row says '{x['recorded_change']}' but the comparison shows '{x['suggested_change']}' ({x['detail']})")
                elif x["basis"] not in ("numeric", "presence") and isinstance(x["current"], dict) and x["recorded_change"] in ("new", "withdrawn"):
                    E(x["current"]["line"], "change", f"{name}: a previous statement exists, so this is not '{x['recorded_change']}'; read both and choose maintained/raised/lowered, or not_comparable with a note")
            for w in out["warnings"]: W(None, "change", w)

    if pages is not None:
        flat = [(p, squash(t)) for p, t in pages]
        whole = " ".join(t for _, t in flat)
        for n, r in rows:
            st = r.get("statement")
            if not isinstance(st, str) or FIXED_WITHDRAWN.match(st.strip()): continue
            k = squash(st)
            on = [p for p, t in flat if k in t]
            if on:
                if isinstance(r.get("page"), int) and r["page"] not in on: W(n, "verbatim", f"the statement is on page {on}, the row says page {r['page']}")
            elif k in whole:
                pass   # runs across a page break
            else:
                E(n, "verbatim", "the statement does not occur word for word in the transcript; quote management's words, do not paraphrase")
    return errors, warnings


def _self_test():
    table, sch = load_table("guidance-topics.json"), load_schema("guidance-row.schema.json")
    checks = []
    def ok(name, cond, detail=None):
        checks.append({"check": name, "ok": bool(cond), **({"detail": detail} if not cond else {})})
    def row(topic, statement, change="new", period="Q2FY26", **kw):
        base = {schema.ROW_KEY: "example-hfl", "period": period, "topic": topic, "statement": statement, "speaker": "Asha Rao, MD & CEO", "page": 4,
                "change_vs_previous": change, "extracted_at": "2025-11-06"}
        base.update(kw); return base
    def run(objs, **kw):
        e, w = validate(list(enumerate(objs, 1)), [], table, sch, **kw)
        return [x["rule"] for x in e], [x["rule"] for x in w], e, w

    good = [row("aum_growth", "For the full year we expect AUM growth of 20% to 22%.", "raised", value_low=20, value_high=22, value_unit="percent",
                previous_statement="We expect AUM growth of 18% to 20% for FY26.", previous_period="Q1FY26"),
            row("capital_raise", "No statement on this topic in the Q2 FY26 call.", "withdrawn", speaker=None, page=None, note="Guided in Q1 FY26; not raised by management or analysts in this call."),
            row("borrowing_mix", "NHB refinance will rise to 15% of borrowings by March.", "new")]
    e, w, ed, wd = run(good)
    ok("a correct batch passes", e == [] and w == [], (ed, wd))

    e, _, ed, _ = run([row("aum_growth", "Growth of 20%.")])
    ok("statement under 20 characters", "statement" in e or "schema" in e, ed)
    e, _, ed, _ = run([row("aum_growth", "We expect growth " + "and more growth " * 50 + "of 20%.")])
    ok("statement over 600 characters", e == ["statement"], ed)
    e, _, ed, _ = run([row("aum_growth", "                                   ")])
    ok("whitespace-only statement", "statement" in e, ed)
    e, _, ed, _ = run([row("margins", "We expect spreads to stay in the 3.2-3.4% band."), row("spread_nim", "We expect spreads to stay in the 3.2-3.4% band.", "improved")])
    ok("topic outside the taxonomy; change outside the set; duplicate statement", e.count("schema") >= 2 and "statement" in e, ed)
    e, _, ed, _ = run([row("credit_cost", "Credit cost should be 30 to 40 basis points for FY26.", page=None)])
    ok("page missing on an ordinary row", "page" in e, ed)
    e, _, ed, _ = run([row("capital_raise", "We would not like to comment on the timing of any capital raise.", "withdrawn", speaker=None, page=None, note="Declined when asked by an analyst.")])
    ok("a withdrawn row that QUOTES a decline still needs speaker and page", "page" in e, ed)
    e, _, ed, _ = run([row("capital_raise", "We would not like to comment on the timing of any capital raise.", "withdrawn", page=9, note="Declined when asked by an analyst on page 9.")])
    ok("...and passes with them", e == [], ed)
    e, _, ed, _ = run([row("capital_raise", "No statement on this topic in the Q2 FY26 call.", "withdrawn", speaker=None, page=None)])
    ok("withdrawn without a note", "schema" in e, ed)
    e, _, ed, _ = run([row("other", "We will launch a co-branded product next year with a partner bank.")])
    ok("topic 'other' needs a note", "schema" in e, ed)
    e, _, ed, _ = run([row("aum_growth", "We expect AUM growth of 20% to 22% this year.", value_low=22, value_high=20, value_unit="percent"),
                       row("credit_cost", "Credit cost should be 30 to 40 basis points for FY26.", value_low=30, value_high=40)])
    ok("low above high; values without a unit", e.count("figures") == 2, ed)
    e, _, ed, _ = run([row("aum_growth", "We expect AUM growth of 20% to 22% this year.", period="H1FY26")])
    ok("a call belongs to a quarter, not H1", "period" in e, ed)
    e, _, ed, _ = run([row("aum_growth", "We expect AUM growth of 20% to 22% this year."), row("credit_cost", "Credit cost should be 30 to 40 basis points.", period="Q1FY26")])
    ok("two calls in one file", "period" in e, ed)
    _, w, _, wd = run([row("spread_nim", "We expect spreads to stay in the 3.2-3.4% band."), row("spread_nim", "NIM should be around 4% for the full year.")])
    ok("two rows on one topic without subtopics -> warning", "statement" in w, wd)
    _, w, _, wd = run([row("aum_growth", "We maintain our AUM growth guidance of 18% to 20%.", "maintained")])
    ok("'maintained' with nothing to check it against -> warning", "change" in w, wd)

    hist = list(enumerate([row("aum_growth", "We expect AUM growth of 18% to 20% for FY26.", period="Q1FY26"),
                           row("capital_raise", "We will look at a capital raise at an appropriate time.", period="Q1FY26")], 1))
    e, _, ed, _ = run([row("aum_growth", "For the full year we expect AUM growth of 20% to 22%.", "maintained")], history=hist)
    ok("--previous: 'maintained' contradicted by the figures, and the silent topic needs a withdrawn row", e.count("change") == 2, ed)
    e, _, ed, _ = run([row("aum_growth", "For the full year we expect AUM growth of 20% to 22%.", "raised"), good[1]], history=hist)
    ok("--previous: consistent rows pass", e == [], ed)
    e, _, ed, _ = run([row("aum_growth", "We remain confident of healthy AUM growth this year.", "new")], history=hist[:1])
    ok("--previous: 'new' refused when a previous statement exists, even if not numerically comparable", e == ["change"], ed)
    e, _, ed, _ = run([row("aum_growth", "We remain confident of healthy AUM growth this year.", "not_comparable", note="Q1 gave 18-20%; this quarter no figure was repeated.")], history=hist[:1])
    ok("--previous: not_comparable with a note passes", e == [], ed)

    pages = [(3, "Asha Rao: Thank you.  For the full year we expect AUM\ngrowth of 20% to 22%. We will add branches"), (4, "in the north. Moderator: Thank you.")]
    e, w, ed, wd = run([row("aum_growth", "For the full year we expect AUM growth of 20% to 22%.", page=4, change="new")], pages=pages)
    ok("--transcript: found verbatim across a line break, page mismatch is a warning", e == [] and "verbatim" in w, (ed, wd))
    e, _, ed, _ = run([row("aum_growth", "Management expects AUM to grow 20-22% in the full year.", page=3)], pages=pages)
    ok("--transcript: a paraphrase is refused", e == ["verbatim"], ed)
    e, _, ed, _ = run([row("branch_additions", "We will add branches in the north.", page=3)], pages=pages)
    ok("--transcript: a sentence running across a page break is accepted", e == [], ed)

    OLD = schema.LEGACY_ROW_KEYS[0]
    as_old = lambda r: {(OLD if k == schema.ROW_KEY else k): v for k, v in r.items()}
    e, w, ed, wd = run([as_old(r) for r in good])
    ok("rows under the key's older name pass", e == [] and w == [], (ed, wd))
    e, w, ed, wd = run([as_old(good[0])] + good[1:])
    ok("old and new rows mixed pass", e == [] and w == [], (ed, wd))
    e, _, ed, _ = run([row("aum_growth", "For the full year we expect AUM growth of 20% to 22%.", "raised"), good[1]], history=[(n, as_old(r)) for n, r in hist])
    ok("--previous rows under the older key are the same baseline", e == [], ed)
    e, _, ed, _ = run([{**good[2], OLD: "example-hfl"}])
    ok("both keys with the same value pass", e == [], ed)
    e, _, ed, _ = run([{**good[2], OLD: "another-hfc"}])
    ok("both keys with different values is an error", e == ["schema"] and "disagree" in ed[0]["message"], ed)

    d = tempfile.mkdtemp(); p = os.path.join(d, "g.jsonl")
    with open(p, "w", encoding="utf-8") as f: f.write(json.dumps(good[2]) + "\n{oops\n")
    rows, problems = schema.read_jsonl(p)
    e, _ = validate(rows, problems, table, sch)
    ok("an unreadable line is an error, not a crash", any("not JSON" in x["message"] for x in e), e)
    ok("schema topic enum and the taxonomy table agree", sorted(sch["properties"]["topic"]["enum"]) == sorted(table["topics"]) and
       sorted(sch["properties"]["change_vs_previous"]["enum"]) == sorted(table["change_vs_previous"]))
    return checks


def main():
    ap = argparse.ArgumentParser(description="Validate guidance rows (schema + rules) before they are appended to the data room. JSON on stdout; exit 1 on any error.")
    ap.add_argument("file", nargs="?", help="JSONL of the rows about to be appended (one call)")
    ap.add_argument("--previous", help="the guidance.jsonl already in the data room, to check change_vs_previous and withdrawn topics")
    ap.add_argument("--transcript", help="the transcript (PDF, or .txt with \\f between pages), to check every statement is verbatim")
    ap.add_argument("--self-test", action="store_true", help="run built-in cases (no input files, no pdfplumber) and exit 0 or 1")
    a = ap.parse_args()
    if a.self_test:
        checks = _self_test()
        bad = [c for c in checks if not c["ok"]]
        emit({"script": "validate_guidance.py", "passed": len(checks) - len(bad), "failed": len(bad), "failures": bad})
        sys.exit(1 if bad else 0)
    if not a.file: fail("give the JSONL file to validate, or --self-test")
    try:
        rows, problems = schema.read_jsonl(a.file)
        history = schema.read_jsonl(a.previous)[0] if a.previous else None
    except OSError as x:
        fail(f"cannot read: {x}")
    if not rows and not problems: fail(f"{a.file} has no rows; nothing to validate, nothing to append")
    pages = None
    if a.transcript:
        try:
            pages = pdfdoc.page_texts(a.transcript) if pdfdoc.sniff(a.transcript) == "pdf" else list(enumerate(open(a.transcript, encoding="utf-8").read().split("\f"), 1))
        except ImportError: fail("pdfplumber is not installed in this sandbox; cannot read the transcript PDF", 3)
        except Exception as x: fail(f"could not read the transcript ({type(x).__name__}: {x})", 4)
    errors, warnings = validate(rows, problems, load_table("guidance-topics.json"), load_schema("guidance-row.schema.json"), history, pages)
    emit({"file": a.file, "rows": len(rows), "valid": not errors, "errors": errors, "warnings": warnings,
          "next": "append with dataroom_append_jsonl" if not errors else "do NOT append. Fix the extraction or report the failure to the analyst; never edit a row just to pass."})
    if errors:
        sys.stderr.write(f"validate_guidance: {len(errors)} error(s) in {a.file}; nothing may be appended\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
