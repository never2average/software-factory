# Vocabulary: asset quality, ECL, capital

Search terms are case-insensitive regular expressions to run over the notes and ratio pages.

| Concept | Search regex | Label variants you will meet |
|---|---|---|
| Stage 3 gross | `gross\s+stage\s*(3\|iii)\|stage\s*(3\|iii)\s+(assets\|loans\|exposure)\|\bgs3\b\|credit[- ]impaired` | Gross Stage 3, Stage III assets, GS3, credit-impaired loans, Stage 3 exposure at default |
| Stage 3 net | `net\s+stage\s*(3\|iii)\|\bns3\b\|stage\s*(3\|iii).{0,40}net of` | Net Stage 3, NS3, Stage 3 net of ECL / net of provisions |
| Gross NPA | `gross\s+(npa\|non[- ]performing)\|\bgnpa\b` | Gross NPA, GNPA, gross non-performing assets / loans / advances |
| Net NPA | `net\s+(npa\|non[- ]performing)\|\bnnpa\b` | Net NPA, NNPA |
| Stages 1 and 2 | `stage\s*(1\|2\|i\|ii)\b` | Stage 1, Stage 2, Stage I / II, "performing", "standard assets", "SMA" (special mention accounts are a regulatory bucket, not a stage: do not map SMA to a stage key) |
| ECL / provision | `expected credit loss\|\becl\b\|loss allowance\|impairment (loss )?allowance\|provision (for\|on) (stage\|npa\|non[- ]performing\|standard)` | ECL provision, loss allowance, impairment allowance, provisions as per Ind AS 109 |
| Coverage | `provision(ing)? coverage\|\bpcr\b\|coverage ratio` | Provision coverage ratio, PCR, Stage 3 coverage, "ECL / EAD %" for Stage 3 |
| Comparison table | `asset classification as per (rbi\|nhb)\|ind as 109.{0,80}(irac\|income recognition)\|provisions? (required )?as per iracp` | The Ind AS 109 vs IRACP norms table |
| Capital adequacy | `capital (to risk\|adequacy)\|\bcrar\b\|\bcrwa\b\|tier[- ]?(i\|1\|ii\|2)\b` | CRAR, capital adequacy ratio, capital to risk-weighted assets ratio, Tier I / Tier II capital ratio |
| Exclude | `restructur\|resolution framework\|resolution plan\|one[- ]time restructuring\|covid.{0,40}(restructur\|moratorium)` | Do not extract; do not quote |

Key choice when a filing uses both vocabularies:

| Printed | Key |
|---|---|
| "Gross Stage 3 (%)" only | `gnpa_pct`, label as printed |
| "Gross NPA (%)" only | `gnpa_pct`, label as printed |
| Both, equal | `gnpa_pct` once, label "Gross Stage 3 / Gross NPA (%)" as the filing words it |
| Both, different | `gnpa_pct` = the Stage 3 figure (the analysts' definition starts with GS3); the NPA figure in the reply with its page |

The same table applies to `nnpa_pct`, `gnpa_amount` vs `gross_stage3`, and `nnpa_amount` vs `net_stage3`: amounts
have separate keys, so when both are printed both are handed over.
