# What to say about a file you could not (fully) read

Fill the brackets; keep the sentences. They state facts and never read as "nothing was disclosed".

| Case | Wording for the reply | Log row |
|---|---|---|
| Whole file is a scan, no text version found | "[path] ([n] pages) is an image scan: no text can be extracted, so no figures were read from it. Looked for a text version at [exchange XBRL URL / IR URL]: not found. The filing is logged; no results extract was written." | `content: "scanned"`; summary "Image scan of the [period] results; nothing extracted." |
| Whole file is a scan, IR text copy found | "The exchange copy is an image scan. The company's IR copy ([url]) is the same document in text ([n] pages, same period on p.1); figures below come from the IR copy." | one row for the copy you stored, `source: "company_ir"` |
| Text PDF with image pages outside the statements | "Pages [list] are image scans ([letter / auditor's review report]); they were not read, so any qualification or emphasis of matter in the auditor's report was not seen. All figures come from text pages [list]." | `content: "mixed"` |
| Statements are text, notes are images | "The notes (pp. [list]) are image scans. Stage 3 / ECL, transfer of loan exposures and CRAR could not be read; they are marked not readable, which is different from not disclosed." | `content: "mixed"` |
| Text layer is garbage | "[path] has a text layer that does not decode (sample: '[first 40 characters]'); treated as a scan." | `content: "scanned"` |
| HTML saved as .pdf | "The download from [url] returned a web page, not the PDF. Not filed." | no row |
| Encrypted / damaged | "[path] could not be opened: [message]." | no row unless the analyst supplied the file; then `content: "not_pdf"` is wrong: leave `content` out and say so in the summary |

In a results extract, an item that may sit on an image page is **left out of `disclosures`** and named in the reply.
`status: "not_disclosed"` is reserved for items looked for on readable pages and not found.
