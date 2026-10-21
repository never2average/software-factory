"""Researcher and scientist personas grounded in the Stack Overflow Developer Survey 2025 (ODbL).

The main persona set (so_personas.py) samples professional developers, so researchers barely appear in it. Scientific
software (simulation packages, ML research code, lab tooling) is used mostly by academic researchers, data scientists and
applied scientists, many of whom are not developers by profession but write code for their work or studies. This samples
those respondents who use AI agents at work, at random, so the set follows the survey's real mix.

  python so_researchers.py sample N FACTS.json            # pick respondents; FACTS.json is the writing brief
  python so_researchers.py merge FACTS.json DRAFTS.json PROFILES.json

The narrative and answering instructions are written from FACTS.json (one draft per respondent, same keys as a
profile, "id" = the fact's id). merge checks each draft against its respondent and the same blind rules as
so_personas.py (no vendor names, no inventing seniority or stack), then adds the drafts to PROFILES.json.
"""
import json, sys
from so_common import facts, load_survey, vendor_regex

DEV_TYPES = ["Academic researcher", "Data scientist", "Applied scientist"]
BRANCHES = ["I am a developer by profession", "I am not primarily a developer, but I write code sometimes as part of my work/studies"]
EMPLOYMENT = ["Employed", "Independent contractor, freelancer, or self-employed", "Student"]

BRIEF = """Write one researcher persona per respondent for a simulation. A coding agent works on a task for this person;
when the agent asks a question, an orchestrator answers in character using the persona. Ground everything in the survey
attributes; do not invent seniority, institution size or stack beyond them. A respondent whose main_branch says they are
not primarily a developer writes code for their research: they know their science and their scripts, not software
engineering practice, and they say so.
Hard rules:
- Never name any database, cloud/hosting platform, SaaS tool, vendor, AI model or third-party package. Describe them
  generically ("a shared university compute cluster", "a major public cloud", "the lab's existing analysis scripts").
- You MAY name programming languages and web frameworks from the attributes.
- Invent a plausible first name + last initial matching nothing real. No real people, institutions or papers.
- instructions: 3-6 sentences on how this person answers a coding agent: what they care about (reproducible results,
  correctness of the numbers, running on the hardware they have, a deadline for a paper or thesis, grant budget, the
  group's existing code), what they defer to the agent. They never suggest a specific vendor or package; if the agent
  offers options, they choose by their constraints.
Each draft: {"id", "name", "summary" (1-2 sentences), "attributes": {"role", "experience_years" (int), "company_size",
"industry", "work_mode", "stack" (languages + web frameworks only), "constraints" (3-5 short items), "tone",
"buying_influence", "ai_agent_use"}, "instructions"}"""


def years(v):
    try: return int(float(v))
    except (TypeError, ValueError): return None


def sample(n, out):
    df = load_survey()
    pool = df[df.DevType.isin(DEV_TYPES) & df.MainBranch.isin(BRANCHES) & df.Employment.isin(EMPLOYMENT)
              & df.AIAgents.fillna("").str.startswith("Yes") & df.WorkExp.notna() & df.LanguageHaveWorkedWith.notna()]
    print(f"eligible researcher respondents: {len(pool)} of {len(df)}")
    rows = pool.sample(n=n, random_state=20261016)
    items = [{"id": f"so25-{int(r.ResponseId)}", "response_id": int(r.ResponseId), "facts": facts(r)} for _, r in rows.iterrows()]
    json.dump({"brief": BRIEF, "respondents": items}, open(out, "w"), indent=1, ensure_ascii=False, default=str)
    print(f"wrote {len(items)} respondents to {out}; mix: {rows.DevType.value_counts().to_dict()}")


def issues(d, f, vendor_re):
    out = []
    for k in ("name", "summary", "instructions"):
        if not str(d.get(k) or "").strip(): out.append(f"{k} is missing")
    a = d.get("attributes") or {}
    for k in ("role", "experience_years", "company_size", "industry", "work_mode", "stack", "constraints", "tone",
              "buying_influence", "ai_agent_use"):
        if k not in a: out.append(f"attributes.{k} is missing")
    text = json.dumps({k: d.get(k) for k in ("name", "summary", "instructions")}) + json.dumps(a.get("constraints"))
    if (hit := vendor_re.search(text)): out.append(f"names a vendor: {hit.group(0)}")
    allowed = {x.lower() for x in f["languages"] + f["web_frameworks"]}
    extra = [x for x in a.get("stack") or [] if str(x).lower() not in allowed]
    if extra: out.append(f"stack adds {extra}, not in the respondent's languages or frameworks")
    if a.get("experience_years") is not None and years(f["years_professional"]) is not None \
            and abs(years(a["experience_years"]) - years(f["years_professional"])) > 1:
        out.append(f"experience_years {a['experience_years']} differs from the survey's {f['years_professional']}")
    if f["dev_type"].split()[0].lower() not in str(a.get("role", "")).lower():
        out.append(f"role does not say {f['dev_type']}")
    return out


def merge(facts_path, drafts_path, profiles_path):
    resp = {x["id"]: x for x in json.load(open(facts_path))["respondents"]}
    drafts = json.load(open(drafts_path))
    vendor_re = vendor_regex(load_survey())
    bad, good = {}, []
    for d in drafts:
        r = resp.get(d.get("id"))
        if not r: bad[str(d.get("id"))] = ["id is not a sampled respondent"]; continue
        if (e := issues(d, r["facts"], vendor_re)): bad[d["id"]] = e; continue
        d["attributes"]["survey"] = {"source": "Stack Overflow Developer Survey 2025", "response_id": r["response_id"],
                                     "license": "ODbL-1.0", "segment": "researcher"}
        good.append(d)
    if bad:
        print(json.dumps(bad, indent=1)); sys.exit(f"{len(bad)} drafts failed; nothing merged")
    missing = sorted(set(resp) - {d["id"] for d in good})
    if missing: sys.exit(f"no draft for {missing}; nothing merged")
    profiles = json.load(open(profiles_path))
    ids = {d["id"] for d in good}
    profiles = [p for p in profiles if p.get("id") not in ids] + good
    json.dump(profiles, open(profiles_path, "w"), indent=2, ensure_ascii=False)
    print(f"merged {len(good)} researcher personas; {len(profiles)} profiles in {profiles_path}")


if __name__ == "__main__":
    if sys.argv[1] == "sample": sample(int(sys.argv[2]), sys.argv[3])
    elif sys.argv[1] == "merge": merge(*sys.argv[2:5])
    else: sys.exit(__doc__)
