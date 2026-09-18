#!/usr/bin/env python3
"""The canonical KPI list of the analysts' rulebook (schemas/kpi-spec.md), shared by every script and by
kpi-row.schema.json. One entry per KPI, in rulebook order.

  python3 /workspace/scripts/kpi_catalog.py --list
  python3 /workspace/scripts/kpi_catalog.py --kpi roa_pct
  python3 /workspace/scripts/kpi_catalog.py --match "Gross Stage 3 assets (%)"
  python3 /workspace/scripts/kpi_catalog.py --self-test

Fields of an entry
  key          the value of `kpi` in a kpis.jsonl row
  label        the row label in the analysts' workbook
  category     rulebook category (CATEGORIES gives the order)
  unit         one of UNITS
  kind         balance (point in time) | flow (accumulates over the year) | ratio | count
  nature       operational | financial | computed   (drives source precedence)
  source_pref  IP | QR | computed
  formula      the rulebook's formula text, or "" when the KPI is taken as disclosed
  inputs       input names compute_kpis.py needs for it
  decimals     rounding applied by the scripts
  synonyms     case-insensitive regexes for the label as it is printed in filings
  exclude      regexes that veto a synonym hit (the same words in another metric's label)
"""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import argparse, json, re

UNIT_CRORE, UNIT_PCT, UNIT_X, UNIT_COUNT = "₹ crore", "%", "x", "count"
UNITS = [UNIT_CRORE, UNIT_PCT, UNIT_X, UNIT_COUNT]
CATEGORIES = ["Scale", "Sell Down & Buy Out", "Asset Quality", "Margin & Yield", "Capital & Leverage",
              "Efficiency", "Return", "Productivity"]
STATUSES = ["ok", "carried_forward", "not_found", "needs_review"]
SOURCES = ["QR", "IP", "parent IP", "computed"]
BASES = ["standalone", "consolidated"]

# Anything matching this is restructured-book content, which the rulebook excludes from the report.
RESTRUCTURED_RE = (r"restructur|\bOTR\b|one[- ]time\s+restructuring|resolution\s+framework|\bRF\s*[12]\b|"
                   r"resolution\s+plan\s+implemented|covid[- ]?19\s+(?:related\s+)?stress")


def _k(key, label, category, unit, kind, nature, source_pref, synonyms, exclude=(), formula="", inputs=(), decimals=2):
    return {"key": key, "label": label, "category": category, "unit": unit, "kind": kind, "nature": nature,
            "source_pref": source_pref, "formula": formula, "inputs": list(inputs), "decimals": decimals,
            "synonyms": list(synonyms), "exclude": list(exclude)}


CATALOG = [
    # ---- Scale -------------------------------------------------------------------------------------------
    _k("aum", "AUM", "Scale", UNIT_CRORE, "balance", "operational", "IP",
       [r"\bAUM\b", r"assets?\s+under\s+management", r"\bmanaged\s+(?:loan\s+)?(?:book|assets?|portfolio|AUM)\b",
        r"\btotal\s+(?:loan\s+)?portfolio\b", r"\bgross\s+AUM\b"],
       exclude=[r"per\s+(?:branch|employee)", r"\bgrowth\b", r"\bmix\b", r"\bon[- ]book\b", r"\boff[- ]book\b",
                r"opex|cost|expense|yield|return|\bRO[AE]\b|GNPA|NNPA|stage"]),
    _k("loan_book", "Loan Book", "Scale", UNIT_CRORE, "balance", "financial", "QR",
       [r"\bloan\s+book\b", r"^\s*(?:\(?[a-z]\)?\s*)?loans\s*$", r"\bloans\s*\(?\s*(?:at\s+amortised\s+cost|net)\s*\)?",
        r"\bloan\s+assets\b", r"\bon[- ]book\s*(?:loans?|AUM|portfolio|assets?|book)?\b", r"\bown\s+book\b",
        r"\bloans\s+and\s+advances\b", r"\bgross\s+loans?\b", r"\bnet\s+loans?\b", r"\bbalance\s+sheet\s+(?:loans?|assets)\b"],
       exclude=[r"under\s+management", r"\boff[- ]book\b", r"assigned|securitis|securitiz|co[- ]?lend", r"opex|cost|expense",
                r"\bgrowth\b", r"\bmix\b", r"yield|GNPA|NNPA|stage|provision|impairment", r"per\s+(?:branch|employee)",
                r"transferred|acquired"]),
    _k("disbursements", "Disbursements", "Scale", UNIT_CRORE, "flow", "operational", "IP",
       [r"\bdisbursements?\b", r"\bdisbursals?\b", r"\bloans?\s+disbursed\b", r"\bfresh\s+(?:sanctions\s+and\s+)?disbursements?\b",
        r"\bamount\s+disbursed\b"],
       exclude=[r"per\s+(?:branch|employee)", r"\bgrowth\b", r"\bmix\b", r"\byield\b", r"sanction(?:s|ed)?\s*$"]),
    _k("networth", "Networth", "Scale", UNIT_CRORE, "balance", "financial", "QR",
       [r"\bnet\s*-?\s*worth\b", r"\btotal\s+equity\b", r"\bshareholders'?\s+(?:funds?|equity)\b", r"\bequity\s+attributable\b",
        r"\btangible\s+net\s*worth\b"],
       exclude=[r"return\s+on|\bRO[AE]\b", r"debt|borrowing", r"per\s+share", r"equity\s+share\s+capital", r"other\s+equity"]),
    _k("borrowings", "Borrowings", "Scale", UNIT_CRORE, "balance", "financial", "QR",
       [r"\btotal\s+borrowings?\b", r"\bborrowings?\b", r"\btotal\s+debt\b", r"\bdebt\s+securities\b",
        r"\bborrowings?\s*\(other\s+than\s+debt\s+securities\)", r"\bsubordinated\s+liabilit(?:y|ies)\b", r"\bdeposits\b"],
       exclude=[r"cost\s+of", r"\bmix\b", r"\bprofile\b", r"\bequity\b", r"ratio", r"incremental", r"\brate\b"]),
    _k("branches", "Branches", "Scale", UNIT_COUNT, "count", "operational", "IP",
       [r"\bbranch(?:es)?\b", r"\bbranch\s+network\b", r"\bnumber\s+of\s+(?:branches|offices|locations)\b", r"\bno\.?\s+of\s+branches\b",
        r"\bpoints?\s+of\s+presence\b", r"\btouch\s*points?\b", r"\boffices\b"],
       exclude=[r"per\s+branch", r"\bnew\s+branches\b", r"branches\s+(?:added|opened)", r"disbursement", r"\bAUM\b"]),
    _k("employees", "Employees", "Scale", UNIT_COUNT, "count", "operational", "IP",
       [r"\bemployees?\b", r"\bemployee\s+(?:count|strength|base)\b", r"\bhead\s*count\b", r"\bno\.?\s+of\s+employees\b",
        r"\bnumber\s+of\s+employees\b", r"\bteam\s+(?:size|strength)\b", r"\bworkforce\b", r"\bmanpower\b"],
       exclude=[r"per\s+employee", r"employee\s+(?:benefits?|cost|expenses?)", r"\bESOP\b", r"stock\s+option", r"\battrition\b"]),
    # ---- Sell Down & Buy Out --------------------------------------------------------------------------------
    _k("sell_down_volume", "Sell Down Volume", "Sell Down & Buy Out", UNIT_CRORE, "flow", "financial", "QR",
       [r"\bsell[- ]?down\b", r"\bsold[- ]?down\b", r"\bdirect\s+assignment\b", r"\bloans?\s+assigned\b", r"\bassignment\s+(?:volume|of\s+loans|transactions?)\b",
        r"\bloans?\s+(?:transferred|securitised|securitized)\b", r"\baggregate\s+(?:principal\s+outstanding|amount)\s+of\s+loans\s+transferred\b",
        r"\bco[- ]?lending\s+(?:volume|disbursements?)\b", r"\bdetails\s+of\s+(?:transfer|loans\s+transferred)\s+through\s+assignment\b"],
       exclude=[r"acquired|bought|buy[- ]?out|purchased", r"income|gain|upfront", r"outstanding\s+(?:assigned|off[- ]book)", r"\boff[- ]book\s+AUM\b"]),
    _k("buy_out_volume", "Buy Out Volume", "Sell Down & Buy Out", UNIT_CRORE, "flow", "financial", "QR",
       [r"\bbuy[- ]?outs?\b", r"\bbought[- ]?out\b", r"\bloans?\s+acquired\b", r"\bportfolio\s+(?:buy[- ]?out|acquired|purchased?)\b",
        r"\bpool\s+(?:buy[- ]?out|purchased?|acquired)\b", r"\baggregate\s+(?:principal\s+outstanding|amount)\s+of\s+loans\s+acquired\b",
        r"\bdetails\s+of\s+loans\s+acquired\s+through\s+assignment\b", r"\binorganic\s+(?:AUM|book|growth)\b"],
       exclude=[r"transferred|sold|sell[- ]?down", r"income|gain"]),
    # ---- Asset Quality --------------------------------------------------------------------------------------
    _k("gnpa_pct", "GNPA %", "Asset Quality", UNIT_PCT, "ratio", "financial", "QR",
       [r"\bGNPA\b", r"\bgross\s+NPAs?\b", r"\bgross\s+non[- ]performing\s+assets?\b", r"\bgross\s+stage[- ]?(?:3|III)\b",
        r"\bGS\s?3\b", r"\bstage[- ]?(?:3|III)\s+(?:assets|loans)\s*(?:\(%\)|%|ratio)", r"\bgross\s+credit[- ]impaired\b"],
       exclude=[r"\bnet\b", r"provision|coverage|\bPCR\b|\bECL\b", r"restructur"]),
    _k("nnpa_pct", "NNPA %", "Asset Quality", UNIT_PCT, "ratio", "financial", "QR",
       [r"\bNNPA\b", r"\bnet\s+NPAs?\b", r"\bnet\s+non[- ]performing\s+assets?\b", r"\bnet\s+stage[- ]?(?:3|III)\b", r"\bNS\s?3\b",
        r"\bnet\s+credit[- ]impaired\b"],
       exclude=[r"\bgross\b", r"coverage|\bPCR\b", r"restructur", r"net\s*worth"]),
    _k("pcr_stage3_pct", "Stage-3 PCR %", "Asset Quality", UNIT_PCT, "ratio", "financial", "QR",
       [r"\bPCR\b", r"\bprovision(?:ing)?\s+coverage\b", r"\bcoverage\s+ratio\b", r"\bstage[- ]?(?:3|III)\s+(?:provision\s+)?coverage\b",
        r"\bECL\s+(?:provision\s+)?(?:coverage|cover)\s*(?:on\s+)?stage[- ]?(?:3|III)\b", r"\bNPA\s+coverage\b"],
       exclude=[r"stage[- ]?(?:1|2|I|II)\b(?!I)", r"\btotal\s+(?:ECL|provisions?)\b", r"interest\s+(?:service\s+)?coverage", r"debt\s+service",
                r"liquidity\s+coverage|\bLCR\b", r"restructur"]),
    # ---- Margin & Yield -------------------------------------------------------------------------------------
    _k("yield_pct", "Yield %", "Margin & Yield", UNIT_PCT, "ratio", "financial", "QR",
       [r"\byield\b", r"\bportfolio\s+yield\b", r"\byield\s+on\s+(?:loans?|advances|AUM|loan\s+book|portfolio|average\s+\w+)\b",
        r"\baverage\s+(?:lending|loan)\s+(?:rate|yield)\b", r"\beffective\s+interest\s+rate\b", r"\bweighted\s+average\s+yield\b"],
       exclude=[r"incremental|origination|disbursement\s+yield|on\s+disbursements?", r"\bspread\b", r"\binvestments?\b", r"dividend"]),
    _k("cost_of_funds_pct", "Cost of Funds %", "Margin & Yield", UNIT_PCT, "ratio", "financial", "QR",
       [r"\bcost\s+of\s+funds?\b", r"\bcost\s+of\s+borrowings?\b", r"\bCoF\b", r"\bCoB\b", r"\baverage\s+(?:cost\s+of\s+)?borrowing\s+cost\b",
        r"\bweighted\s+average\s+cost\s+of\s+(?:funds|borrowings?)\b", r"\bborrowing\s+cost\s*\(%\)"],
       exclude=[r"incremental|marginal", r"\bspread\b"]),
    _k("spread_pct", "Spread %", "Margin & Yield", UNIT_PCT, "ratio", "financial", "QR",
       [r"\bspreads?\b", r"\binterest\s+spread\b", r"\bloan\s+spread\b", r"\bgross\s+spread\b"],
       exclude=[r"incremental", r"credit\s+spread", r"geograph|branch"],
       formula="as disclosed; when not disclosed: Yield % − Cost of Funds %", inputs=["yield_pct", "cost_of_funds_pct"]),
    _k("nim_pct", "NIM %", "Margin & Yield", UNIT_PCT, "ratio", "financial", "QR",
       [r"\bNIM\b", r"\bnet\s+interest\s+margin\b", r"\bNII\s*/\s*(?:average\s+)?(?:AUM|assets|loans?)\b", r"\bnet\s+interest\s+income\s+(?:margin|to\s+average)"],
       exclude=[r"net\s+interest\s+income\s*(?:\(|$)(?!.*%)"]),
    # ---- Capital & Leverage ---------------------------------------------------------------------------------
    _k("crar_pct", "CRAR %", "Capital & Leverage", UNIT_PCT, "ratio", "financial", "QR",
       [r"\bCRAR\b", r"\bcapital\s+adequacy\b", r"\bcapital\s+to\s+risk[- ]?(?:weighted)?\s+assets?\s+ratio\b", r"\bCAR\b",
        r"\btotal\s+capital\s+ratio\b"],
       exclude=[r"tier[- ]?(?:1|2|I|II)\b"]),
    _k("debt_equity", "Debt/Equity", "Capital & Leverage", UNIT_X, "ratio", "financial", "QR",
       [r"\bdebt\s*[-/:]?\s*(?:to\s+)?equity\b", r"\bD\s*/\s*E\b", r"\bgearing\b", r"\bleverage\s*\(x\)|\bleverage\s+ratio\b",
        r"\bdebt\s+to\s+net\s*worth\b"],
       exclude=[r"debt\s+service", r"total\s+debts?\s+to\s+total\s+assets"]),
    # ---- Efficiency -----------------------------------------------------------------------------------------
    _k("cost_to_income_pct", "Cost to Income %", "Efficiency", UNIT_PCT, "ratio", "computed", "computed",
       [r"\bcost[- ]to[- ]income\b", r"\bcost\s*/\s*income\b", r"\bC\s*/\s*I\s+ratio\b", r"\bopex\s+to\s+(?:net\s+)?(?:total\s+)?income\b"],
       formula="(Operating Expenses ÷ Net Interest Income) × 100", inputs=["opex", "nii"]),
    _k("opex_to_loan_book_pct", "Opex / Loan Book %", "Efficiency", UNIT_PCT, "ratio", "computed", "computed",
       [r"\bopex\s*(?:/|to)\s*(?:average\s+)?(?:loan\s+book|loans?|on[- ]book)\b"],
       formula="(Operating Expenses ÷ Loan Book) × 100", inputs=["opex", "loan_book"]),
    _k("opex_to_aum_pct", "Opex / AUM %", "Efficiency", UNIT_PCT, "ratio", "computed", "computed",
       [r"\bopex\s*(?:/|to)\s*(?:average\s+)?(?:AUM|assets|ATA|AAUM)\b", r"\boperating\s+expenses?\s+to\s+(?:average\s+)?(?:AUM|assets)\b",
        r"\bcost\s+to\s+(?:average\s+)?assets\b"],
       formula="(Operating Expenses ÷ AUM) × 100", inputs=["opex", "aum"]),
    # ---- Return ---------------------------------------------------------------------------------------------
    _k("roa_pct", "ROA %", "Return", UNIT_PCT, "ratio", "computed", "computed",
       [r"\bRO(?:T)?A\b", r"\bRoAA\b", r"\breturn\s+on\s+(?:average\s+)?(?:total\s+)?assets\b", r"\breturn\s+on\s+(?:average\s+)?AUM\b"],
       formula="(Quarterly PAT × 4 ÷ AUM) × 100", inputs=["pat_quarter", "aum"]),
    _k("roe_pct", "ROE %", "Return", UNIT_PCT, "ratio", "computed", "computed",
       [r"\bROE\b", r"\bRoAE\b", r"\breturn\s+on\s+(?:average\s+)?(?:equity|net\s*worth)\b", r"\bRONW\b"],
       formula="(Quarterly PAT × 4 ÷ Networth) × 100", inputs=["pat_quarter", "networth"]),
    # ---- Productivity ---------------------------------------------------------------------------------------
    _k("disbursement_per_branch", "Disbursement per Branch", "Productivity", UNIT_CRORE, "ratio", "computed", "computed",
       [r"\bdisbursements?\s*(?:per|/)\s*branch\b"],
       formula="Disbursement ÷ Number of Branches", inputs=["disbursements", "branches"], decimals=4),
    _k("disbursement_per_employee", "Disbursement per Employee", "Productivity", UNIT_CRORE, "ratio", "computed", "computed",
       [r"\bdisbursements?\s*(?:per|/)\s*employee\b"],
       formula="Disbursement ÷ Number of Employees", inputs=["disbursements", "employees"], decimals=4),
    _k("expense_per_employee", "Expense per Employee", "Productivity", UNIT_CRORE, "ratio", "computed", "computed",
       [r"\b(?:opex|expenses?|cost)\s*(?:per|/)\s*employee\b"], exclude=[r"employee\s+cost\s+per"],
       formula="(Operating Expenses + Employee Cost) ÷ Number of Employees", inputs=["opex", "employee_cost", "employees"], decimals=4),
    _k("employee_cost_per_employee", "Employee Cost per Employee", "Productivity", UNIT_CRORE, "ratio", "computed", "computed",
       [r"\bemployee\s+(?:cost|benefits?\s+expenses?)\s*(?:per|/)\s*employee\b"],
       formula="Employee Cost ÷ Number of Employees", inputs=["employee_cost", "employees"], decimals=4),
]

BY_KEY = {e["key"]: e for e in CATALOG}
KEYS = [e["key"] for e in CATALOG]
AMOUNT_KEYS = [e["key"] for e in CATALOG if e["unit"] == UNIT_CRORE]
COMPUTED_KEYS = [e["key"] for e in CATALOG if e["source_pref"] == "computed"]

# Inputs of compute_kpis.py that are not themselves KPIs (P&L lines), with their labels in filings.
INPUT_LINES = {
    "opex": {"label": "Operating Expenses", "kind": "flow",
             "synonyms": [r"\boperating\s+expenses?\b", r"\bopex\b", r"\btotal\s+operating\s+(?:expenses?|cost)\b", r"\bother\s+expenses\b"]},
    "employee_cost": {"label": "Employee Cost", "kind": "flow",
                      "synonyms": [r"\bemployee\s+benefits?\s+expenses?\b", r"\bemployee\s+(?:cost|expenses?)\b", r"\bstaff\s+(?:cost|expenses?)\b",
                                   r"\bpersonnel\s+(?:cost|expenses?)\b"]},
    "nii": {"label": "Net Interest Income", "kind": "flow",
            "synonyms": [r"\bnet\s+interest\s+income\b", r"\bNII\b"]},
    "pat_quarter": {"label": "Profit after tax (quarter)", "kind": "flow",
                    "synonyms": [r"\bprofit\s+after\s+tax\b", r"\bPAT\b", r"\bnet\s+profit\s+(?:after\s+tax|for\s+the\s+period)\b",
                                 r"\bprofit\s*/?\s*\(?loss\)?\s+for\s+the\s+(?:period|quarter|year)\b"]},
}


def is_restructured(text):
    return bool(text) and re.search(RESTRUCTURED_RE, str(text), re.I) is not None


def match_label(text):
    """-> {'text', 'matches': [keys], 'kpi': key|None, 'verdict': matched|ambiguous|no_match|excluded_restructured}.
    More than one KPI matching is reported as ambiguous, never resolved by order."""
    out = {"text": text, "matches": [], "kpi": None, "verdict": "no_match"}
    if is_restructured(text):
        out["verdict"] = "excluded_restructured"; return out
    for e in CATALOG:
        if any(re.search(x, text, re.I) for x in e["exclude"]): continue
        if any(re.search(s, text, re.I) for s in e["synonyms"]): out["matches"].append(e["key"])
    if len(out["matches"]) == 1: out["kpi"], out["verdict"] = out["matches"][0], "matched"
    elif out["matches"]: out["verdict"] = "ambiguous"
    return out


def public(entry):
    return {k: v for k, v in entry.items()}


def _self_test():
    fails = []
    def check(name, cond):
        if not cond: fails.append(name)
    check("27 KPIs", len(CATALOG) == 27)
    check("keys unique", len(set(KEYS)) == len(KEYS))
    check("categories in rulebook order", [c for i, c in enumerate([e["category"] for e in CATALOG]) if i == 0 or c != CATALOG[i - 1]["category"]] == CATEGORIES)
    check("units allowed", all(e["unit"] in UNITS for e in CATALOG))
    check("computed have formula+inputs", all(e["formula"] and e["inputs"] for e in CATALOG if e["source_pref"] == "computed"))
    check("rulebook formulas verbatim", BY_KEY["roa_pct"]["formula"] == "(Quarterly PAT × 4 ÷ AUM) × 100"
          and BY_KEY["cost_to_income_pct"]["formula"] == "(Operating Expenses ÷ Net Interest Income) × 100"
          and BY_KEY["expense_per_employee"]["formula"] == "(Operating Expenses + Employee Cost) ÷ Number of Employees")
    check("operational = branches, employees, disbursements, aum",
          sorted(e["key"] for e in CATALOG if e["nature"] == "operational") == ["aum", "branches", "disbursements", "employees"])
    for e in CATALOG:
        for rx in e["synonyms"] + e["exclude"]:
            try: re.compile(rx)
            except re.error as x: fails.append(f"bad regex in {e['key']}: {rx} ({x})")
    labels = {
        "Assets under management (AUM)": "aum", "Managed book": "aum", "Loan assets under management": "aum",
        "Loans": "loan_book", "(c) Loans": "loan_book", "Loan book": "loan_book", "On-book loans": "loan_book", "Loan assets": "loan_book",
        "Disbursements": "disbursements", "Disbursals during the quarter": "disbursements",
        "Net worth": "networth", "Networth": "networth", "Total equity": "networth",
        "Total borrowings": "borrowings", "No. of branches": "branches", "Number of employees": "employees", "Headcount": "employees",
        "Direct assignment during the quarter": "sell_down_volume", "Aggregate amount of loans transferred": "sell_down_volume",
        "Aggregate principal outstanding of loans acquired": "buy_out_volume", "Portfolio buyout": "buy_out_volume",
        "Gross Stage 3 (%)": "gnpa_pct", "GNPA": "gnpa_pct", "Gross NPA ratio": "gnpa_pct",
        "Net Stage 3 (%)": "nnpa_pct", "NNPA %": "nnpa_pct", "Net NPA": "nnpa_pct",
        "Provision coverage ratio (Stage 3)": "pcr_stage3_pct", "PCR": "pcr_stage3_pct",
        "Yield on loans": "yield_pct", "Portfolio yield": "yield_pct", "Cost of borrowings": "cost_of_funds_pct", "CoF": "cost_of_funds_pct",
        "Spread": "spread_pct", "Net interest margin": "nim_pct", "NIM": "nim_pct",
        "Capital adequacy ratio": "crar_pct", "CRAR": "crar_pct", "Debt-equity ratio": "debt_equity", "Debt to equity (x)": "debt_equity",
        "Cost to income ratio": "cost_to_income_pct", "Opex to AUM": "opex_to_aum_pct", "Return on average assets": "roa_pct", "RoA": "roa_pct",
        "Return on equity": "roe_pct", "ROE": "roe_pct", "Disbursement per branch": "disbursement_per_branch",
        "Employee cost per employee": "employee_cost_per_employee", "Opex per employee": "expense_per_employee",
    }
    for text, want in labels.items():
        got = match_label(text)
        if got["kpi"] != want: fails.append(f"match {text!r}: want {want}, got {got['verdict']} {got['matches']}")
    negatives = {
        "Incremental yield on disbursements": "no_match", "Incremental cost of funds": "no_match", "Employee benefits expense": "no_match",
        "Restructured loans (OTR 2.0)": "excluded_restructured", "Loans restructured under resolution framework": "excluded_restructured",
        "AUM growth": "no_match", "Tier I capital ratio": "no_match", "Net interest income": "no_match", "Particulars": "no_match",
        "Stage 2 provision coverage": "no_match", "Interest service coverage ratio": "no_match", "Off-book AUM": "no_match",
    }
    for text, want in negatives.items():
        got = match_label(text)
        if got["verdict"] != want: fails.append(f"negative {text!r}: want {want}, got {got['verdict']} {got['matches']}")
    amb = match_label("GNPA / NNPA")
    check("two metrics in one label is ambiguous", amb["verdict"] == "ambiguous" and amb["kpi"] is None)
    check("input lines defined", set(INPUT_LINES) == {"opex", "employee_cost", "nii", "pat_quarter"})
    # the schemas share this catalog: fail when an enum drifts
    sdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "schemas")
    for fname, path, want in (("kpi-row.schema.json", ("kpi",), KEYS), ("kpi-row.schema.json", ("category",), CATEGORIES), ("kpi-row.schema.json", ("unit",), UNITS),
                              ("kpi-row.schema.json", ("status",), STATUSES), ("kpi-row.schema.json", ("source",), SOURCES), ("kpi-row.schema.json", ("basis",), BASES),
                              ("reconcile-request.schema.json", ("kpi",), KEYS)):
        try:
            with open(os.path.join(sdir, fname), encoding="utf-8") as f: got = json.load(f)["properties"][path[0]]["enum"]
        except (OSError, KeyError, ValueError) as x: fails.append(f"{fname} {path[0]}: cannot read enum ({x})"); continue
        if got != want: fails.append(f"{fname} {path[0]} enum differs from the catalog")
    return fails, len(labels) + len(negatives) + 16


def main():
    ap = argparse.ArgumentParser(description="The canonical KPI catalog of the HFC KPI rulebook: list it, show one KPI, or match a filing label to a KPI.")
    ap.add_argument("--list", action="store_true", help="print every KPI (key, label, category, unit, kind, source_pref, formula)")
    ap.add_argument("--full", action="store_true", help="with --list: include synonyms and excludes")
    ap.add_argument("--kpi", help="print one KPI entry in full")
    ap.add_argument("--match", help="a row/slide label as printed in the filing; reports the KPI it names, or ambiguous/no_match")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        fails, n = _self_test()
        print(json.dumps({"script": "kpi_catalog", "cases": n, "failed": fails, "ok": not fails}, ensure_ascii=False, indent=1))
        return 1 if fails else 0
    if a.kpi:
        if a.kpi not in BY_KEY:
            print(f"unknown kpi {a.kpi!r}; known: {', '.join(KEYS)}", file=sys.stderr); return 2
        print(json.dumps(public(BY_KEY[a.kpi]), ensure_ascii=False, indent=1)); return 0
    if a.match is not None:
        print(json.dumps(match_label(a.match), ensure_ascii=False, indent=1)); return 0
    if a.list:
        rows = [public(e) if a.full else {k: e[k] for k in ("key", "label", "category", "unit", "kind", "nature", "source_pref", "formula")} for e in CATALOG]
        print(json.dumps({"categories": CATEGORIES, "units": UNITS, "statuses": STATUSES, "sources": SOURCES, "kpis": rows}, ensure_ascii=False, indent=1)); return 0
    ap.print_help(sys.stderr); return 2


if __name__ == "__main__":
    sys.exit(main())
