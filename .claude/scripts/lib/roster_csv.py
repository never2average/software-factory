#!/usr/bin/env python3
"""roster_csv.py <app_id> <roster.csv> [--dry-run] | --template | --self-test

One spreadsheet from the operator -> who is in the workspace and who covers which company.

The CSV has one row per (analyst, company) pair:

  analyst_name, analyst_email, manager_email, company_name, nse_symbol, bse_code, isin, sector,
  listing_type (equity | debt | both), parent_company, secondary_analyst_email

It writes, for a stamped application:
  state/application/<app_id>/application.json   workspace.members, workspace.roster, workspace.customers
  state/application/<app_id>/seed/customers.json   the mold's seed contract (agent/lib/customer-schema.ts customerStoreSchema)
  state/application/<app_id>/seed/people.json      peopleStoreSchema (internal staff assignments)

The seed files live in state, not under build/<app_id>/: `branding.py prepare` rebuilds that directory from the
mold with rsync --delete on every deploy, so anything written there is replaced by the mold's own fixture data.
Seeding copies them over build/<app_id>/data/ after prepare, immediately before `npm run seed:postgres`.

In a research mold a "customer" row is a covered company and its owner is the covering analyst, written under the key
the mold's seed contract uses for the account owner: what the mold's own agent/lib/owner-keys.ts maps `accountOwner` to
(its record key still carries the base product's role word), or `accountOwner` itself for a mold without that map. The mold has two
staff roles only; the covering analyst is recorded as `solution_engineer` and a second analyst as
`account_executive` — the role names are the mold's, the meaning here is primary and secondary coverage.

Nothing is guessed: a row with a bad email, no company name, an unknown listing_type, two different analysts as
primary for one company, or one email spelt with two names is reported with its line number and nothing is written.
"""
import csv, io, json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import legacy

NEUTRAL_OWNER = "accountOwner"


def owner_key(mold_id="mold_v1"):
    """The seed contract's key for the account owner, as the mold itself maps it (see above)."""
    f = os.path.join(ROOT, "molds", mold_id, "codebase", "agent", "lib", "owner-keys.ts")
    try: src = open(f).read()
    except OSError: return NEUTRAL_OWNER
    m = re.search(r'\[\s*"([A-Za-z]+)"\s*,\s*"' + NEUTRAL_OWNER + r'"\s*\]', src)
    return m.group(1) if m else NEUTRAL_OWNER
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
COLS = ["analyst_name", "analyst_email", "manager_email", "company_name", "nse_symbol", "bse_code", "isin", "sector",
        "listing_type", "parent_company", "secondary_analyst_email"]
REQUIRED = ["analyst_name", "analyst_email", "company_name"]
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
ISIN = re.compile(r"^IN[A-Z0-9]{10}$")
LISTING = {"equity", "debt", "both", ""}

def slug(text):
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s

def company_id(row):
    """NSE symbol when there is one (stable, short); otherwise the company name."""
    return slug(row["nse_symbol"]) or slug(re.sub(r"\b(limited|ltd\.?)\b", "", row["company_name"], flags=re.I))

def parse(text):
    """-> (rows, problems). rows are dicts with every COLS key, values stripped."""
    rd = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    head = [h.strip().lower() for h in (rd.fieldnames or [])]
    problems = [f"missing column '{c}'" for c in REQUIRED if c not in head]
    unknown = [h for h in head if h and h not in COLS]
    if unknown: problems.append(f"unknown column(s): {', '.join(unknown)} (expected: {', '.join(COLS)})")
    if problems: return [], problems
    rows = []
    for n, raw in enumerate(rd, 2):
        r = {c: "" for c in COLS}
        r.update({(k or "").strip().lower(): (v or "").strip() for k, v in raw.items() if (k or "").strip().lower() in COLS})
        if not any(r.values()): continue
        r["_line"] = n
        for c in ("analyst_email", "manager_email", "secondary_analyst_email"): r[c] = r[c].lower()
        r["listing_type"] = r["listing_type"].lower(); r["isin"] = r["isin"].upper(); r["nse_symbol"] = r["nse_symbol"].upper()
        for c in REQUIRED:
            if not r[c]: problems.append(f"line {n}: {c} is empty")
        for c in ("analyst_email", "manager_email", "secondary_analyst_email"):
            if r[c] and not EMAIL.match(r[c]): problems.append(f"line {n}: {c} '{r[c]}' is not an email address")
        if r["isin"] and not ISIN.match(r["isin"]): problems.append(f"line {n}: isin '{r['isin']}' is not 12 characters starting IN")
        if r["listing_type"] not in LISTING: problems.append(f"line {n}: listing_type '{r['listing_type']}' must be equity, debt or both")
        if r["secondary_analyst_email"] and r["secondary_analyst_email"] == r["analyst_email"]:
            problems.append(f"line {n}: secondary analyst is the same person as the analyst")
        if r["company_name"] and not company_id(r): problems.append(f"line {n}: cannot make an id from company '{r['company_name']}'")
        rows.append(r)
    if not rows and not problems: problems.append("the file has a header and no rows")
    return rows, problems

def build(rows, owner_email, org_name, owner_field=NEUTRAL_OWNER):
    """-> (members, roster, customers_state, customers_seed, people_seed, problems)"""
    problems, names, managers, companies = [], {}, {}, {}
    for r in rows:
        e = r["analyst_email"]
        if e in names and names[e] != r["analyst_name"]:
            problems.append(f"line {r['_line']}: {e} is '{r['analyst_name']}' here and '{names[e]}' earlier")
        names.setdefault(e, r["analyst_name"])
        if r["manager_email"]:
            if e in managers and managers[e] != r["manager_email"]:
                problems.append(f"line {r['_line']}: {e} reports to {r['manager_email']} here and {managers[e]} earlier")
            managers.setdefault(e, r["manager_email"])
        cid = company_id(r)
        if cid in companies:
            first = companies[cid]
            if first["analyst_email"] != e:
                problems.append(f"line {r['_line']}: {r['company_name']} already has {first['analyst_email']} as its analyst "
                                f"(line {first['_line']}); put the second person in secondary_analyst_email")
            elif first["company_name"] != r["company_name"]:
                problems.append(f"line {r['_line']}: id '{cid}' is both '{first['company_name']}' and '{r['company_name']}'")
            else: problems.append(f"line {r['_line']}: {r['company_name']} / {e} is listed twice")
        else: companies[cid] = r
    people = set(names) | set(managers.values()) | {r["secondary_analyst_email"] for r in rows if r["secondary_analyst_email"]}
    members = [{"email": owner_email, "role": "owner"}] if owner_email else []
    for e in sorted(people):
        if e == owner_email: continue
        members.append({"email": e, "role": "admin" if e in set(managers.values()) else "member"})
    roster = []
    for e in sorted(people):
        x = {"email": e, "team": "Research"}
        if e in names: x["name"] = names[e]
        if e in managers: x["manager_email"] = managers[e]
        roster.append(x)
    state, seed, staff = [], [], []
    for cid, r in sorted(companies.items()):
        listing = r["listing_type"] or "equity"
        st = [{"email": r["analyst_email"], "name": r["analyst_name"], "role": "solution_engineer", "employer_org": org_name}]
        if r["secondary_analyst_email"]:
            st.append({"email": r["secondary_analyst_email"], "name": names.get(r["secondary_analyst_email"], r["secondary_analyst_email"]),
                       "role": "account_executive", "employer_org": org_name})
        c = {"id": cid, "name": r["company_name"], "vertical": r["sector"] or "Housing Finance", "region": "India", "staff": st}
        c["tier"] = {"equity": "Listed", "both": "Listed", "debt": "Unlisted (debt-listed)"}[listing]
        state.append(c)
        profile = "; ".join(x for x in [f"listing: {listing}", f"NSE: {r['nse_symbol']}" if r["nse_symbol"] else "",
                                         f"BSE: {r['bse_code']}" if r["bse_code"] else "",
                                         f"parent: {r['parent_company']}" if r["parent_company"] else ""] if x)
        s = {"id": cid, "name": r["company_name"], "tier": c["tier"], owner_field: r["analyst_email"], "arrCurrency": "INR",
             "accountRegion": "APAC", "vertical": c["vertical"], "industrySegment": "Housing Finance Company", "regulatoryProfile": profile}
        if r["secondary_analyst_email"]: s["aeOwner"] = r["secondary_analyst_email"]
        if r["isin"]: s["externalAccountId"] = r["isin"]
        if r["company_name"]: s["legalEntityName"] = r["company_name"]
        seed.append(s)
        for p in st:
            staff.append({"customer_id": cid, "staffRole": p["role"], "name": p["name"], "employerOrg": org_name, "email": p["email"]})
    return members, roster, state, {"customers": seed}, {"internalStaffAssignments": staff, "customerStakeholders": []}, problems

TEMPLATE = ",".join(COLS) + "\n" + \
    "Asha Example,asha@example.com,head@example.com,Example Housing Finance Ltd,EXAMPLEHFL,500000,INE000A01010,Housing Finance,equity,,ravi@example.com\n" + \
    "Asha Example,asha@example.com,head@example.com,Example Home Loans Ltd,,,,Affordable Housing Finance,debt,Example Financial Holdings Ltd,\n"

def self_test():
    rows, p = parse(TEMPLATE); assert not p and len(rows) == 2, p
    m, ro, st, seed, people, p = build(rows, "owner@example.com", "OnFinance AI", "recordOwner"); assert not p, p
    assert [x["role"] for x in m] == ["owner", "member", "admin", "member"], m
    assert st[0]["id"] == "example-home-loans" and st[1]["id"] == "examplehfl", [c["id"] for c in st]
    assert seed["customers"][1]["recordOwner"] == "asha@example.com" and seed["customers"][1]["aeOwner"] == "ravi@example.com"
    assert seed["customers"][0]["tier"].startswith("Unlisted") and "parent: Example Financial" in seed["customers"][0]["regulatoryProfile"]
    assert len(people["internalStaffAssignments"]) == 3
    bad = TEMPLATE + "Ravi Example,ravi@example.com,,Example Housing Finance Ltd,EXAMPLEHFL,,,,equity,,\n" + "X,not-an-email,,Y Ltd,,,,,listed,,\n"
    rows, p = parse(bad); assert len(p) == 2, p                      # bad email, bad listing_type
    rows, _ = parse(TEMPLATE + "Ravi Example,ravi@example.com,,Example Housing Finance Ltd,EXAMPLEHFL,,,,equity,,\n")
    assert any("already has" in x for x in build(rows, "", "O")[5])  # two primaries for one company
    assert parse("analyst_name,company_name\nA,B\n")[1] == ["missing column 'analyst_email'"]
    assert parse(",".join(COLS) + "\n")[1] == ["the file has a header and no rows"]
    assert build(rows[:1], "", "O")[3]["customers"][0].get(NEUTRAL_OWNER) and owner_key("no_such_mold") == NEUTRAL_OWNER
    print("roster_csv: 12 checks passed"); return 0

def main(a):
    if "--self-test" in a: return self_test()
    if "--template" in a: sys.stdout.write(TEMPLATE); return 0
    pos = [x for x in a if not x.startswith("--")]
    if len(pos) != 2: sys.exit(__doc__)
    app_id, path = pos; dry = "--dry-run" in a
    appf = os.path.join(ROOT, "state", "application", app_id, "application.json")
    if not os.path.exists(appf): sys.exit(f"{app_id}: no state/application/{app_id}/application.json — run intake first")
    app = json.load(open(appf)); ws = app.setdefault("workspace", {})
    owner = next((m["email"] for m in ws.get("members", []) if m.get("role") == "owner"), legacy.get(ws, "operator_self", {}).get("email", ""))
    org = (ws.get("org") or {}).get("name") or "Research"
    rows, problems = parse(open(path, encoding="utf-8-sig").read())
    built = build(rows, owner.lower(), org, owner_key(app.get("mold_id") or "mold_v1")) if not problems else None
    if built: problems += built[5]
    if problems:
        for p in problems: print(p, file=sys.stderr)
        sys.exit(f"{len(problems)} problem(s) in {path}; nothing was written")
    members, roster, state, seed, people, _ = built
    summary = {"analysts": len({r['analyst_email'] for r in rows}), "people": len(roster), "companies": len(state),
               "unlisted": sum(1 for c in state if c["tier"].startswith("Unlisted")), "owner": owner or None}
    if not owner: print("note: the application has no owner yet; members were written without one", file=sys.stderr)
    if not dry:
        ws["members"], ws["roster"], ws["customers"] = members, roster, state
        json.dump(app, open(appf, "w"), indent=2, ensure_ascii=False); open(appf, "a").write("\n")
        out = os.path.join(ROOT, "state", "application", app_id, "seed"); os.makedirs(out, exist_ok=True)
        json.dump(seed, open(os.path.join(out, "customers.json"), "w"), indent=2, ensure_ascii=False)
        json.dump(people, open(os.path.join(out, "people.json"), "w"), indent=2, ensure_ascii=False)
        summary["wrote"] = [os.path.relpath(appf, ROOT), f"state/application/{app_id}/seed/customers.json", f"state/application/{app_id}/seed/people.json"]
    print(json.dumps(summary, indent=2)); return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
