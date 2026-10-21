"""Developer personas grounded in the Stack Overflow Developer Survey 2025 (ODbL).

Each persona is one real respondent's joint attributes (role, experience, org size, industry, remote, languages, web
frameworks, purchase influence, AI-agent use), sampled at random from professional developers who use AI agents at
work, so the persona set follows the survey's real distribution and correlations. gpt-6.1-sol writes the narrative and
answering instructions. Databases, platforms and AI vendors are described generically, never named: personas answer a
coding agent blind, and must not steer it toward or away from any vendor. A check rejects any persona that names one.
  python so_personas.py OUT.json N
"""
import json, sys
from concurrent.futures import ThreadPoolExecutor
import llm
from so_common import facts, load_survey, vendor_regex

out_path, n = sys.argv[1], int(sys.argv[2])
df = load_survey()
pool = df[(df.MainBranch == "I am a developer by profession")
          & df.Employment.isin(["Employed", "Independent contractor, freelancer, or self-employed"])
          & df.AIAgents.fillna("").str.startswith("Yes")
          & df.DevType.notna() & df.WorkExp.notna() & df.LanguageHaveWorkedWith.notna()]
print(f"eligible respondents: {len(pool)} of {len(df)}", flush=True)
rows = pool.sample(n=n, random_state=20261011)
vendor_re = vendor_regex(df)

SYSTEM = """You write developer personas for a simulation. A coding agent works on a task for this developer; when the agent
asks a question, an orchestrator answers in character using your persona. Ground everything in the survey attributes given;
do not invent seniority, company size or stack beyond them.
Hard rules:
- Never name any database, cloud/hosting platform, SaaS tool, observability/payments/auth/email vendor, or AI model/vendor.
  Describe them generically ("an existing relational database", "a major public cloud", "a hosted error-tracking tool").
- You MAY name programming languages and web frameworks from the attributes (they define the codebase).
- Invent a plausible first name + last initial matching nothing real (e.g. "Priya S."). No real people.
- instructions: 3-6 sentences on how this developer answers a coding agent: brevity, what they care about (cost, compliance,
  time-to-ship, team conventions, scale), what they defer to the agent. They never suggest a specific vendor or package;
  if the agent offers options, they choose by their constraints and may ask for the simplest/cheapest/most standard one.
Return JSON: {"name", "summary" (1-2 sentences), "attributes": {"role", "experience_years" (int), "company_size",
"industry", "work_mode", "stack" (languages + web frameworks only), "constraints" (3-5 short items), "tone",
"buying_influence", "ai_agent_use"}, "instructions"}"""


def build(row):
    f = facts(row)
    for attempt in range(3):
        extra = "" if attempt == 0 else "\nYour previous draft named a vendor. Remove every vendor name."
        v = llm.chat_json("gpt-6.1-sol", SYSTEM, "Survey respondent attributes:\n" + json.dumps(f, default=str) + extra, 1500)
        text = json.dumps({k: v.get(k) for k in ("name", "summary", "instructions")}) + json.dumps((v.get("attributes") or {}).get("constraints"))
        hit = vendor_re.search(text)
        if v.get("name") and v.get("instructions") and not hit:
            v["attributes"]["survey"] = {"source": "Stack Overflow Developer Survey 2025", "response_id": int(row.ResponseId),
                                         "license": "ODbL-1.0"}
            v["id"] = f"so25-{int(row.ResponseId)}"
            return v
    return None


with ThreadPoolExecutor(8) as ex:
    personas = [p for p in ex.map(build, (r for _, r in rows.iterrows())) if p]
json.dump(personas, open(out_path, "w"), indent=2, ensure_ascii=False)
print(f"wrote {len(personas)} personas; spend so far {llm.spent()}")
