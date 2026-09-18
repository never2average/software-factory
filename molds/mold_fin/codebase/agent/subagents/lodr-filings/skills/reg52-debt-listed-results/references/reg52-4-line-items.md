# Reg 52(4) line items: what to look for, and the disclosure key

The regulation lists items to be disclosed along with the results; the exact list has been amended over time and
several items do not apply to an NBFC / HFC. The filing in front of you is the authority on which items exist. This
table maps the labels you will commonly see to the keys of `/workspace/schemas/results-extract.schema.json`.

| Label as commonly printed | Key | Unit | Notes |
|---|---|---|---|
| Debt-equity ratio | `debt_equity_ratio` | times | The analysts express D/E as a decimal ("3.2x"). Keep as printed. |
| Debt service coverage ratio | `debt_service_coverage_ratio` | times | Often "Not applicable" for an NBFC/HFC |
| Interest service coverage ratio | `interest_service_coverage_ratio` | times | Often "Not applicable" |
| Outstanding redeemable preference shares (quantity and value) | `outstanding_redeemable_preference_shares` | crore | Often "Nil" -> status `nil` |
| Capital redemption reserve / debenture redemption reserve | `capital_redemption_reserve`, `debenture_redemption_reserve` | crore | Often "Nil" or "Not applicable" |
| Net worth | `net_worth` | crore | This is the net worth the ROE input needs; note the definition if footnoted |
| Net profit after tax | `net_profit_after_tax` | crore | Check quarter vs year-to-date column |
| Earnings per share | `eps` | rupees_per_share | Not converted |
| Current ratio; long-term debt to working capital; bad debts to accounts receivable; current liability ratio; debtors turnover; inventory turnover | (no key) | | Usually "Not applicable" for an NBFC. Not extracted. |
| Total debts to total assets | `total_debts_to_total_assets` | times or percent, as printed | |
| Operating margin (%) | `operating_margin_pct` | percent | Often "Not applicable" |
| Net profit margin (%) | `net_profit_margin_pct` | percent | |
| Sector-specific: Gross NPA / Gross Stage 3 (%) | `gnpa_pct` | percent | See skill `notes-asset-quality-and-ecl` for vocabulary |
| Sector-specific: Net NPA / Net Stage 3 (%) | `nnpa_pct` | percent | |
| Sector-specific: Provision coverage ratio (%) | `pcr_pct` | percent | Only when printed; never computed here |
| Sector-specific: Capital adequacy (CRAR), Tier I, Tier II | `crar_pct`, `tier1_pct`, `tier2_pct` | percent | |
| Sector-specific: Liquidity coverage ratio | `liquidity_coverage_ratio_pct` | percent | Can exceed 100 |
| Security cover available | `security_cover_times` | times | "1.10 times" -> 1.1. If printed as a percentage (110%), keep `times` = 1.1 only when the filing itself also states it in times; otherwise put the printed figure in `note` and leave the key out |

Rules:

- One disclosure row per item per period. `label_reported` is the label exactly as printed.
- "Nil" -> `status: "nil"`, value 0 or null. "NA" / "Not applicable" / "-" -> `status: "not_disclosed"`, value null,
  printed text in `note`.
- A ratio is never recomputed, rescaled or annualised here.
- If an item appears that has no key, mention it in the reply with its page; do not force it into a near key.
