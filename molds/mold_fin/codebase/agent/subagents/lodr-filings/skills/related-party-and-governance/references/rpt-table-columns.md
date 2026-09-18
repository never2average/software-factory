# The Reg 23(9) disclosure table: column families

The prescribed format is one wide table. Column order, numbering and wording have changed across SEBI's format
revisions, and companies submit it as XBRL / Excel with a PDF print in which headers wrap over several lines. Read
the header row of the file in front of you; this list is what to look for, not a positional map.

| Column family | Typical header wording | Use |
|---|---|---|
| Entity entering into the transaction | "Details of the party (listed entity / subsidiary) entering into the transaction": name, PAN | whether it is the HFC itself or its subsidiary |
| Counterparty | "Details of the counterparty": name, PAN, "relationship of the counterparty with the listed entity or its subsidiary" | holding company, fellow subsidiary, associate, KMP, relative, entity controlled by KMP |
| Transaction type | "Type of related party transaction" | loan taken / given, ICD, investment, interest paid / received, assignment / sale of loan portfolio, servicing fee, commission, rent, royalty, reimbursement, remuneration, dividend, guarantee |
| Approved value | "Value of the related party transaction as approved by the audit committee" (+ remarks on approval) | compare with the value during the period |
| Value in the period | "Value of transaction during the reporting period" | the flow |
| Balances | "In case monies are due to either party as a result of the transaction": opening balance, closing balance | the stock; never add to the flow |
| Borrowing to fund a loan / ICD / investment | "In case any financial indebtedness is incurred to make or give loans ...": nature of indebtedness, cost, tenure | usually blank for a lender acting in its ordinary course |
| Terms of loans / ICDs / advances / investments | nature, interest rate (%), tenure, secured / unsecured, purpose for which the funds will be utilised by the ultimate recipient | the funding terms the analysts ask about |
| Notes | free text | netting, currency, "ordinary course / arm's length" statements |

Reading tips:

- Unit is stated once, above the table or in a note ("Rs. in lakhs"). Repeat it with every figure you quote.
- One economic relationship appears in several rows (loan taken, interest paid, closing balance). Report them
  together, by counterparty.
- PANs are personal / entity identifiers: never copy them into the log, the reply or memory.
- Remuneration rows name individuals: report only a change of KMP, not amounts, unless asked.
- A lender's deposits from, or home loans to, its directors and their relatives on staff-scheme terms are routine;
  mention only by count and total if the filing gives a total.
