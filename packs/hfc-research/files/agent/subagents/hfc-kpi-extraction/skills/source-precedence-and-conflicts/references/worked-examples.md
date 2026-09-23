# Worked examples (synthetic numbers)

All companies and numbers here are made up. "Example Housing Finance Ltd" (`example-hfl`) is listed; "Example Home
Subsidiary Ltd" (`example-home-sub`) is an unlisted, debt-listed subsidiary of a listed parent.

## 1. More than 5% apart: needs_review with both values

QR note on asset classification: Gross Stage 3 = 1.82% (of on-book gross loans). IP slide 14: GNPA = 1.20% (footnote
on the slide: "on AUM").

```json
{"kpi": "gnpa_pct", "period": "Q2 FY26", "listing": "listed",
 "qr": {"value": "1.82%", "document": "Companies/example-hfl/filings/lodr/q2fy26-results.pdf", "page_or_slide": 6,
        "definition": "Gross Stage 3 / gross loans (on-book)"},
 "ip": {"value": "1.20%", "document": "Companies/example-hfl/filings/presentations/q2fy26-ip.pdf", "page_or_slide": "slide 14",
        "definition": "GNPA on AUM"}}
```

Output (abridged): `value 1.82`, `source QR`, `status needs_review`, `pct_diff 34.07`, `alt_value 1.2`,
`alt_source IP`, footnote:

> QR 1.82% vs IP 1.20% (IP: Companies/example-hfl/filings/presentations/q2fy26-ip.pdf, slide 14) differ by 34.07%,
> more than the 5% tolerance. QR value shown; needs analyst review. Definitions differ: QR 'Gross Stage 3 / gross
> loans (on-book)', IP 'GNPA on AUM'.

The row you write: `value 1.82`, `source "QR"`, `status "needs_review"`, `alt_value 1.2`, `alt_source "IP"`,
`pct_diff 34.07`, `definition "Gross Stage 3 / gross loans (on-book)"`, the footnote above. Then `remember` that this
company's presentation states GNPA on AUM.

## 2. Unlisted subsidiary: LODR first, parent's presentation second

```json
[{"kpi": "networth", "period": "Q2 FY26", "listing": "unlisted",
  "qr": {"value": "2,40,000", "header": "(Rs. in Lakhs)", "document": "Companies/example-home-sub/filings/lodr/q2fy26-reg52.pdf", "page_or_slide": 3},
  "parent_ip": {"value": "23.9", "header": "INR bn", "document": "Companies/example-home-sub/filings/presentations/parent-q2fy26-ip.pdf", "page_or_slide": "slide 31"}},
 {"kpi": "branches", "period": "Q2 FY26", "listing": "unlisted",
  "parent_ip": {"value": "96", "document": "Companies/example-home-sub/filings/presentations/parent-q2fy26-ip.pdf", "page_or_slide": "slide 30"}}]
```

- networth: 2,40,000 lakh = ₹2,400.00 crore; 23.9 bn = ₹2,390.00 crore; 0.42% apart → `value 2400.0`, `source QR`,
  `status ok`, footnote "QR ₹2,400.00 crore vs parent IP ₹2,390.00 crore (0.42% apart, within the 5% tolerance): QR
  value used."
- branches: only the parent's presentation has it → `value 96`, `source "parent IP"`, `status ok`, footnote "Not
  disclosed in the company's LODR filing; taken from the parent company's investor presentation (…parent-q2fy26-ip.pdf)."

Make sure the parent's slide is about the SUBSIDIARY (a segment slide titled with the subsidiary's name or "housing
finance business"), not about the parent group. If the slide mixes the two, the value is `not_found`.

## 3. A candidate from the wrong period is not compared

The IP for Q2 FY26 is not in the data room; you only have the Q1 FY26 deck. Passing its AUM with
`"period": "Q1 FY26"` makes the script ignore it ("value belongs to Q1 FY26, not Q2 FY26; a different period is never
compared"). That is right: an older value is a carry-forward question (`missing-data-and-carry-forward`), not a
conflict.

## 4. Unit missing on one side

`"qr": {"value": "9,000"}` with no `unit` and no `header` → ignored with "no header text given". Go back to the table,
read its header, and pass it. Never assume "the QR is always in lakhs".
