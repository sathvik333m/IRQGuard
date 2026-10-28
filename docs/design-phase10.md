# Phase 10: uncertainty classification and reporting

## What the 43,705 count measures

The saved Linux v6.6.87 schema-v3 reports contain 43,705 strings in their
`uncertainties` arrays. Each string is an emitted message, not one distinct
source defect. The saved report set contains no duplicate exact strings, but
interprocedural summaries prepend caller/call-chain context and IRQ summaries
project call effects again. The cause-level grouping below removes those
propagation wrappers while preserving each raw message in the report.

The baseline buckets, derived directly from message text, are:

| Baseline message class | Events |
| --- | ---: |
| External or unavailable function body | 20,683 |
| IRQ-state summary uncertainty | 21,777 |
| Unresolved indirect call | 1,059 |
| Possibly unsupported lock/IRQ API | 154 |
| Unresolved lock identity | 30 |
| CFG event mapping | 2 |
| **Total** | **43,705** |

The 21,777 IRQ-state messages include 21,674 unknown-call IRQ effects, 41
unmodeled `free_irq` lifecycle cases, 30 irqsave flag cases, 30 irqrestore
matching cases, and 2 CFG mapping cases. The two CFG items also appear in the
interprocedural category, so the old text buckets are diagnostic projections,
not disjoint semantic root causes. Schema 4 uses a single primary category for
each emitted event.

The event strings are emitted primarily by `summarizeFunction` in
`src/Interprocedural.cpp` and `src/InterruptAnalysis.cpp`, then propagated by
those summary engines. Analyzer-side registration uncertainty is emitted from
`src/Analyzer.cpp`. Parse diagnostics are held separately in `diagnostics`;
the two saved CFG mapping diagnostics were not parser recovery errors. The
saved data did not show uncertainty caused by parser recovery.

## Schema 4 fields

Schema 4 keeps the original `uncertainties: string[]` array unchanged and adds:

- `uncertainty_summary`: total event count, unique-record count, propagated
  event count, impact counts, stage/category counts, and candidate associations.
- `uncertainty_records`: grouped cause records with stable ID, category, reason,
  analysis stage, severity, impact, explanation, root-cause text, source point,
  function/API where resolvable, event/propagation counts, candidate IDs, and up
to three example raw messages.
- `finding_id` on candidate cycles (`C-1`, `C-2`, … within that report), so an
  uncertainty can reference relevant candidates.

Record IDs are 64-bit FNV-1a over `category + "|" + root_cause`, rendered as
`U-` plus 16 lowercase hex digits. This is a deterministic identifier, not a
cryptographic identity or proof that the cause is unique in the program.

### Counting rules

- **Event:** one string in the unchanged `uncertainties` array.
- **Unique record:** events with the same primary category and terminal cause
  text, including API/expression and source location, after removing caller
  propagation prefixes and presentation-only suffixes. Distinct locations or
  different reasons remain distinct.
- **Propagated event:** a raw message containing an interprocedural `via call`
  or IRQ-summary `via` wrapper. The message is retained even when grouped.
- **Translation units:** evaluation aggregation keeps same-named cause IDs
  separate for each translation-unit report. Header or inline duplication
  across translation units is not merged.
- **Candidate association:** a record is associated when its source file and
  line occur in a candidate's lock identity or edge source locations. This is
  traceability evidence, not a proof that the uncertainty caused the candidate.
- **Non-affecting:** no record is marked non-affecting unless established.
  Current summary reports zero proven non-affecting events, rather than
  guessing that an unrelated-looking warning is harmless.

The text classifier maps missing external bodies and unresolved indirect calls
to `unresolved_call`; unresolved lock expressions to `lock_identity`; saved
state, restore, and unmodeled IRQ effects to `interrupt_state`; unresolved
registration targets to `handler_resolution`; unmodeled deregistration timing
to `handler_lifecycle`; name-heuristic warnings to `unsupported_api`; CFG
mapping issues to `control_flow`; caps and nonconvergence to `analysis_limit`.
Unmatched text remains in `other`. Severity is a rule-based review priority,
not a calibrated probability or deadlock risk score. The `unsupported_api`
category can contain heuristic false positives, such as APIs with `irq` in a
name that do not manipulate processor interrupt state.

The C++ serializer creates schema-v4 records for current analyses. The
standalone `evaluation/summarize_uncertainties.py` applies the same cause
identity rules to archived schema-v3 or current schema-v4 reports, enabling
retrospective analysis without modifying saved raw report files.

## Phase 10 reproduction and findings

Run the structured analyzer tests and rebuild:

```sh
cmake --build build -j2
ctest --test-dir build --output-on-failure
cd web && npm test -- --run && npm run build
```

Reclassify the preserved kernel report files:

```sh
python3 evaluation/summarize_uncertainties.py \
  evaluation/results/linux-v6.6.87/reports \
  evaluation/results/linux-v6.6.87/uncertainty-summary-phase10.json
```

The saved reports were independently recounted as 43,705 events and 4,872
unique classified records. There were 38,771 propagated events, 2,636 records
classified high impact, and five unique records associated with all three
inconclusive lock cycles (15 record-to-cycle links). The five candidate-related
records point to `netdev.c:501`, the unresolved `spinlock_check` expansion.
These counts use the pre-Phase-9.1 archived reports and do not measure the
post-Phase-9 extraction fix. The kernel source checkout is unavailable in this
environment, so a fresh post-fix kernel analysis was not run. The raw reports
and Phase 9.0 checksum manifest remain unchanged.

The detailed per-record aggregate, input report hashes, source locations, and
sample messages are in
[`evaluation/results/linux-v6.6.87/uncertainty-summary-phase10.json`](../evaluation/results/linux-v6.6.87/uncertainty-summary-phase10.json).
