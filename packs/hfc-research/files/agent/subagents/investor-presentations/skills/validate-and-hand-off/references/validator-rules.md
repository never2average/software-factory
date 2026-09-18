# Validator rules

Both validators print JSON `{file, rows, valid, errors[], warnings[], next}` and exit 0 (valid), 1 (errors),
2+ (could not run). Each error carries `line`, `rule`, `message`.

## validate_ip_metrics.py

| Rule | Error when | Usual cause and fix |
|---|---|---|
| `schema` | a required field is missing, a type is wrong, an unknown field is present, `status`/`unit` outside the enum, a line is not JSON | Compare with `/workspace/schemas/ip-metric-row.schema.json` |
| `period` | period does not parse; H1/9M/FY without `period_basis`; `ytd` on a quarter; non-quarter row without a note | `mixed-periods-on-a-slide` |
| `slide` | a row with a value has no slide; value null without `not_disclosed` / `no_off_book` | Cite the slide |
| `unit` | counts not in `count`; amounts not in `crore`; ratios not in `percent` | `units-in-decks`: convert, keep `source_value` / `source_unit` |
| `count` | branches/employees negative or fractional | A rounded "3.4k": write approximate with a whole number, or not at all |
| `range` | negative amount; share or LTV outside 0..100 (warning for implausible yields/spreads) | bps left unconverted; wrong column |
| `conversion` | `source_value` × `source_unit` ≠ `value` | Let `extract_labelled_numbers.py` convert |
| `approximate` | `approximate: true` without a note | Say what was read and how |
| `parent` | `from_parent` without `parent_document` or without a `_parent-` document; or the reverse | `parent-deck-for-unlisted-hfc` |
| `restructured` | metric key or `source_label` names restructured-book detail | Drop the row: the rulebook excludes it |
| `duplicate` | same customer/period/metric/basis twice with different values; or already in `--existing` (same value twice in the new file is a warning) | `deck-layout-variants` > which slide to cite |
| `aum_loan_book` | AUM equals loan book while sell down or off-book is positive (warnings: AUM below loan book; loan book + off-book ≠ AUM) | `aum-mix-and-off-book`, `sell-down-and-buy-out-in-appendix` |
| `mix_sum` | product or customer mix shares on one basis exceed 100 | Overlapping classifications: give the cut its own `basis` |
| `carry_forward` | carried fields on a row that is not `not_disclosed`; carried period without value (warning: branches/employees not disclosed and nothing offered) | `operational-metrics` step 7 |
| `core` | with `--require-core`, a core metric has no row for the period (warning otherwise) | Add the `not_disclosed` / `nil` / `no_off_book` row |

## validate_guidance.py

| Rule | Error when | Fix |
|---|---|---|
| `schema` | required field missing; topic outside the taxonomy; `change_vs_previous` outside maintained / raised / lowered / withdrawn / new / not_comparable; `withdrawn` or `not_comparable` without a note; `other` without a note | `/workspace/schemas/guidance-row.schema.json` |
| `statement` | shorter than 20 or longer than 600 characters; blank; the same statement twice (warnings: an elision; two rows on one topic without subtopics) | `quoting-rules.md` |
| `page` | speaker or page missing on anything but a withdrawn row using the fixed sentence | Cite them |
| `period` | not a quarter; two calls in one file (warning: `previous_period` not adjacent) | One call per file |
| `figures` | `value_low` > `value_high`; values without `value_unit` | |
| `change` | with `--previous`: the row contradicts the numeric or presence comparison; a topic guided last quarter has no row; `new` while a previous statement exists | Run `guidance_diff.py`, read both statements |
| `verbatim` | with `--transcript`: the statement is not in the transcript word for word (warning: found on another page) | Quote, do not paraphrase |

## Worked example

```
$ python3 /workspace/scripts/validate_guidance.py /workspace/out/guidance.new.jsonl --previous /workspace/in/guidance.jsonl
{"valid": false, "errors": [{"line": 1, "rule": "change", "message": "aum_growth: row says 'maintained' but the comparison shows 'raised' (18-20 then, 20-22 now)"},
                            {"line": null, "rule": "change", "message": "capital_raise was guided in Q1 FY26 (\"We will look at a capital raise at an appropriate time.\") and has no row now: add a withdrawn row after searching the transcript, or the row that continues it"}], …}
```

Row 1 is corrected to `raised` because the figures show it (the extraction was wrong, not the document). A
withdrawn row is added for capital raise after reading page 9. Re-run: `valid: true`.
