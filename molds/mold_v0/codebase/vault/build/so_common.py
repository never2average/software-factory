"""Shared pieces of the survey persona builders: the survey table, its list fields and the vendor-name check."""
import os, re
import pyarrow.parquet as pq

split = lambda v: [x.strip() for x in str(v).split(";") if x and str(v) != "nan"]


def load_survey():
    return pq.read_table(os.environ["SO_SURVEY_PARQUET"]).to_pandas()


def vendor_regex(df):
    """Vendor names respondents could pick for databases, platforms and AI models: personas must never name these."""
    vendors = set()
    for col in ["DatabaseHaveWorkedWith", "PlatformHaveWorkedWith", "AIModelsHaveWorkedWith", "OfficeStackAsyncHaveWorkedWith",
                "CommPlatformHaveWorkedWith"]:
        for v in df[col].dropna():
            vendors.update(split(v))
    stop = {"Other", "None", "Bash/Shell (all shells)", "Docker", "npm", "Homebrew", "Make", "Kubernetes"}
    terms = set()
    for v in vendors - stop:
        for part in re.split(r"[()/]", v):
            part = part.strip()
            if len(part) >= 4 and not part.lower() in {"models", "chatbot", "reasoning", "general", "purpose", "flash", "build tool", "image generating models"}:
                terms.add(part)
    return re.compile(r"\b(" + "|".join(sorted((re.escape(t) for t in terms), key=len, reverse=True)) + r")\b", re.I)


def generic_platforms(ps):
    s = set()
    for x in ps:
        xl = x.lower()
        if any(k in xl for k in ("aws", "azure", "google cloud", "oracle cloud", "ibm cloud", "alibaba")): s.add("major public cloud")
        elif any(k in xl for k in ("vercel", "netlify", "heroku", "render", "fly.io", "railway", "cloudflare", "digital ocean", "firebase", "supabase")): s.add("managed PaaS / edge hosting")
        elif any(k in xl for k in ("kubernetes", "docker", "podman")): s.add("containers")
        elif any(k in xl for k in ("terraform", "ansible", "pulumi")): s.add("infrastructure as code")
        elif any(k in xl for k in ("datadog", "new relic", "prometheus", "grafana", "sentry", "splunk")): s.add("observability tooling")
    return sorted(s)


def facts(row):
    f = {
        "dev_type": row.DevType, "main_branch": row.MainBranch, "employment": row.Employment, "years_professional": row.WorkExp,
        "years_coding": row.YearsCode, "org_size": row.OrgSize, "ic_or_manager": row.ICorPM, "industry": row.Industry,
        "remote": row.RemoteWork, "country": row.Country, "purchase_influence": row.PurchaseInfluence, "ai_agents": row.AIAgents,
        "languages": split(row.LanguageHaveWorkedWith), "web_frameworks": split(row.WebframeHaveWorkedWith),
        "database_count": len(split(row.DatabaseHaveWorkedWith)), "platforms_generic": generic_platforms(split(row.PlatformHaveWorkedWith)),
    }
    return {k: (None if str(v) == "nan" else v) for k, v in f.items()}
