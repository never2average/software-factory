# HFC coverage universe: sources, counts, caveats

Compiled 2026-09-19. Companion to `onfinance_hfc.hfc-universe.csv`. Every row comes from a fetched source; nothing was filled from memory. Empty cells mean "not confirmed", not "does not exist".

## Sources (all fetched 2026-09-19)

| What | URL | Date of data |
|---|---|---|
| NHB "List of Housing Finance Companies (HFCs) as on March 31, 2026" (91 names, with asset size; base list for every row) | https://www.nhb.org.in/wp-content/uploads/2026/08/Asset-size-2026.pdf (linked from https://www.nhb.org.in/supervision/list-of-hfcs-in-india/, page last updated 07/08/26) | 31-Mar-2026, provisional figures |
| NHB: CoR with permission to accept public deposits (lists A and B) | https://www.nhb.org.in/a-list-of-housing-finance-companies-granted/ | undated, visibly stale |
| NHB: CoR not valid for public deposits | https://www.nhb.org.in/list-of-housing-finance-companies-granted-certificate/ | undated, visibly stale |
| NHB: CoR cancelled | https://www.nhb.org.in/companies-whose-application-for-cor-have-been-cancelled/ | undated |
| NSE listed equity master | https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv | file of 2026-09-19 |
| NSE listed debt master | https://nsearchives.nseindia.com/content/equities/DEBT.csv | file of 2026-09-19 |
| BSE scrip master (Equity / Debentures and Bonds / Commercial Papers; Active, Suspended, Delisted) | https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?segment=...&status=... | 2026-09-19 |

RBI cross-check: NOT done. `rbidocs.rbi.org.in` (List of NBFCs and ARCs registered with RBI, XLSX and PDF) served a bot-protection/CAPTCHA page to both curl and WebFetch.

## Why the 31-Mar-2026 list is the base

The two NHB CoR web pages are not maintained: they still carry Dewan Housing, Indiabulls Housing, Reliance Home Finance, Piramal Capital & Housing, HUDCO, L&T Housing, APAC and IFL Housing, all of which NHB's own "cancelled" page also lists. The 31-Mar-2026 PDF is the most recent dated list NHB publishes, so company names and membership come from it. The CoR pages were used only for `deposit_taking` and for "formerly known as" names.

## Counts

- NHB list as on 31-Mar-2026: **91** HFCs. CSV rows: **91** (no exclusions needed from this list; ICICI Home Finance Company Limited is on it, no. 7).
- `both` (equity + active listed debt): **13**
- `equity` only: **2** (India Home Loan, Sahara Housingfina; both BSE only)
- `debt` only (Reg 52 filers): **24**
- `none`: **52**
- Deposit-taking `yes`: 11 (8 from NHB list A; 3 from list B, which need prior NHB permission: GIC Housing, Repco, Saral; flagged in notes).

Method: legal names were normalised (case, Ltd/Limited/Private, punctuation) and matched exactly against issuer names in the exchange masters; misses were re-checked by keyword and former name. NSE symbol and ISIN are from the NSE master, BSE code from the BSE master; where both exist the ISINs were asserted equal. `debt` means at least one ACTIVE debenture/bond/CP on BSE or a series in the NSE debt master today.

## Parent companies: confirmation sources

Filled only for non-equity-listed HFCs where a source stated the relationship: Tata Capital (tatacapital.com/tchfl/about-us.html), Aditya Birla Capital (homefinance.adityabirlacapital.com), ICICI Bank, IIFL Finance (iifl.com press release; ADIA holds 20%), Sundaram Finance (CARE rationale Jun 2024), Hinduja Leyland Finance (hindujaleylandfinance.com subsidiaries page; itself unlisted, subsidiary of Ashok Leyland), SMFG India Credit (CARE rationale; debt-listed only), M&M Financial Services, Godrej Industries via Godrej Capital (godrejindustries.com), Hero FinCorp (ICRA/CRISIL rationales; debt-listed only), Capri Global Capital, Motilal Oswal Financial Services (97.49%), Edelweiss Financial Services, Muthoot Fincorp (82.56%; debt-listed only), Muthoot Finance, JM Financial via JM Financial Products (ICRA), Manappuram Finance (CRISIL May 2025), Central Bank of India (centralbank.bank.in subsidiary page), Satin Creditcare, MAS Financial Services, Religare Enterprises via Religare Finvest (religare.com corporate structure). These came from web-search summaries of those pages, not from reading each annual report.

Deliberately left blank: Truhome (Warburg Pincus, not listed), Grihum (private equity), Centrum Housing (Centrum Capital sold its whole stake to Weaver Services, completed 18-Mar-2026), ITI Housing (promoter-group entity of The Investment Trust of India, not a subsidiary per CRISIL), Aviom, and all small private HFCs (Clix, DMI, IKF, Satya Micro, Svatantra, etc.) where I did not confirm a listed parent.

## Recent events captured

- Bajaj Housing Finance IPO (NSE listing 16-Sep-2024); Aadhar Housing Finance IPO (15-May-2024); India Shelter IPO (20-Dec-2023); SRG Housing NSE listing 21-Aug-2023. Dates from the NSE master.
- Shriram Housing Finance renamed Truhome Finance after Warburg Pincus acquisition (Dec 2024); DRHP filed Mar 2026; not yet in either equity master, so `debt`.
- Tata Capital (parent) listed 13-Oct-2025.
- Nido Home Finance: Carlyle majority-stake deal announced 10-Feb-2026, subject to RBI/NHB/CCI. Completion not verified; parent shown as Edelweiss may be out of date.
- Aviom India Housing Finance: in insolvency since Feb 2025; Unity Small Finance Bank won the auction Dec 2025; completion not verified. Still shows 2 active BSE debentures, hence `debt`, but expect irregular filings.

## Exclusions (not on the 31-Mar-2026 list; all appear on NHB's "CoR cancelled" page)

Housing Development Finance Corporation (merged into HDFC Bank), Indiabulls Housing Finance (now Sammaan Capital, listed as SAMMAANCAP, no longer an HFC), Piramal Capital & Housing Finance (now Piramal Finance, PIRAMALFIN), HUDCO, L&T Housing Finance, Reliance Home Finance (surrendered CoR), IFL Housing Finance (NSE debt master shows "IFL Finance Limited, formerly IFL Housing Finance"), APAC Housing Finance (surrendered), Ind Bank Housing (still BSE equity-listed but CoR cancelled), National Trust Housing Finance, GRUH Finance, Capital First Home Finance, IDBI Homefinance, and older names. Dewan Housing Finance is on the stale deposit page but on neither the 2026 list nor the cancelled page (it was merged into Piramal Capital & Housing). The reasons in brackets for HDFC/Sammaan/Piramal are from the exchange masters and general news, not from NHB, which gives no reason or date.

## Not verified / known weaknesses

- RBI list not reachable (see above). CoR actions between 1-Apr-2026 and today are therefore not captured.
- `deposit_taking` rests on an undated, stale NHB page.
- Debt listing is a point-in-time snapshot. Five HFCs had BSE debentures that are now all delisted/matured and are marked `none` with a note: Capri Global Housing, Centrum Housing, KIFS Housing, Ummeed, Manappuram Home (one still "Suspended"); India Home Loan is `equity` for the same reason. An HFC whose last NCD matured mid-year may still owe a final Reg 52 filing.
- Privately placed debt listed under a differently spelled issuer name could be missed for the 52 `none` rows; keyword sweeps found nothing.
- `sector`: "Affordable Housing Finance" set only for Aadhar, Truhome, Hinduja Housing, Religare HDFC (own/parent pages say so) and Nanayasurabhi (in its name). Aavas, Home First, India Shelter, Aptus and others are widely called affordable HFCs, but I did not fetch a self-description, so they are left as "Housing Finance". Review this column.
- NSE symbol blank for Star Housing Finance, India Home Loan, Sahara Housingfina: they are absent from the NSE master (BSE only).
