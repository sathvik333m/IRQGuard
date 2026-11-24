# IRQGuard final evaluation baseline

This directory freezes the fresh evaluation runs used by [the evaluation report](../../../docs/phase19_5-final-evaluation.md). It contains measured output, not hand-authored analyzer results. The analyzer source revision, binary SHA-256, kernel pin, configuration, toolchain, exact runner commands, and artifact hashes are in `manifest.json`.

## Layout

- `controlled/`: Phase 17 dataset runner output for the existing 8 positive, negative, and edge-case assertions, with the raw reports and source-run timing/RSS.
- `historical/`: affected/fixed MIPS GIC and 8250 JSON reports, build logs, Kbuild configuration, compilation databases, and the analyzed C objects.
- `kernel/`: Linux v6.6.87 e1000e raw aggregate, per-translation-unit reports, timing files, generated config, compilation database, selected objects, composite object, and objtool binary/command evidence.
- `evidence/`: copied controlled-dataset manifest and upstream-evidence JSON for historical cases.
- `summary.csv`: one row per controlled case, historical revision, and kernel translation unit.
- `latest-uncertainty.json`: small report payload for the GUI and current uncertainty totals.
- `manifest.json`: pins, environment, measured summaries, run commands and SHA-256 for evidence files.
- `SHA256SUMS`: checksums for the frozen files (excluding the checksum file itself).
- `build.log`, `ctest.log`: exact project build and CTest output.

Transient Kbuild intermediates were pruned after validation to keep the evidence directory manageable. The source checkouts are pinned separately by revision; this baseline retains the generated `.config`, compilation database, selected object artifacts, analyzer reports, and build logs needed to inspect what ran.

## Reproduction

Use new output directories; the runner scripts refuse or may replace data in configured output locations, and frozen results should be preserved. Commands from the repository root are listed in `manifest.json` and `docs/phase19_5-final-evaluation.md`. After re-running into fresh locations, compare the generated reports and run `python3 evaluation/freeze_phase19_5.py` only after placing the completed outputs at the documented baseline paths.

Verify the frozen artifact checksums with:

```sh
cd evaluation/baselines/phase19_5
sha256sum --check SHA256SUMS
```

The controlled pass rate is a fixture regression result, not a statistical accuracy score. The two historical outcomes are one partial match and one miss. The five-file kernel result is exploratory and has zero dependency cycles; this is not evidence that the scope is deadlock-free.
