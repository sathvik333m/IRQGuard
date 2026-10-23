# Phase 6: real Linux source evaluation

## Selected target

The pinned target is stable Linux `v6.6.87`, commit
`814637ca257f4faf57a73fd4e38888cce88b5911` (tag object
`6494364a1b9f85fc173d197e7ce79f9d4a6db5ce`). The initial subsystem is the
Intel `e1000e` PCI network driver. Its `netdev.c` contains IRQ registration and
locking operations, giving the analyzer relevant kernel constructs without
attempting a whole-tree parse. The initial translation-unit list is `netdev.c`,
`ethtool.c`, `ich8lan.c`, `phy.c`, and `nvm.c`.

The script uses x86_64 `x86_64_defconfig`, enables `CONFIG_E1000E=m`, runs
`olddefconfig` and `prepare0`, then compiles only the five selected object files
with Clang through Kbuild's `LLVM=` setting. The host lacks both `ld.lld` and
`libelf-dev`; therefore the object compile explicitly overrides
`CONFIG_OBJTOOL=` and `SKIP_STACK_VALIDATION=1`. This bypasses objtool's host
build and validation pass but retains the selected source's Kbuild compiler
arguments and generated kernel headers/macros. It is not a complete module
build. GNU `/usr/bin/ld` is recorded for any remaining link operations. It invokes the
pinned kernel's `scripts/clang-tools/gen_compile_commands.py` on the selected
output directory containing only the requested object `.cmd` files to produce
a small, justified compilation database. This
preserves generated-header, macro, architecture, and Kbuild flags without
building every configured kernel translation unit. Build artifacts go into an
out-of-tree output directory; source files are not edited.

The runner records exact commands, tool versions, Kconfig SHA-256, build logs,
and per-TU analyzer wall time, peak RSS, return status, parse diagnostics, raw
JSON and extracted counts. It reports missing files/commands and parse errors
explicitly. Only successful schema-v3 JSON contributes to aggregate counts.
Counts are summed across translation units and can include duplicated inline or
header-derived facts; they should not be interpreted as unique whole-subsystem
symbols.

## Three analysis views

The analyzer currently has no options that independently disable IRQ modeling
or feasibility refinement. `evaluation/summarize.py` therefore makes explicit
projections over each one-pass report:

1. Basic lock cycles: count cyclic SCCs in `lock_dependencies` with Tarjan's
   algorithm. This is a component count, not an enumeration of simple cycles.
2. Interrupt-aware: report regular candidate and interrupt-aware candidate
   counts emitted from the context-labelled graph.
3. Feasibility refined: preserve separate candidate, rejected, and inconclusive
   categories from the analyzer's findings.

This is not an ablation study with separate analyzer executions. A cycle or
candidate remains an analysis result, not evidence of a confirmed kernel bug.

## Benchmark labels and validation

`evaluation/benchmark-set.json` lists the positive, negative, and inconclusive
controlled fixtures asserted by Phase 3/4 tests. These labels are known because
the source is intentionally constructed for each property, but they are not
independent real-kernel ground truth. The report computes no kernel precision
or recall because no independent Linux bug labels are available. Source review
and external bug evidence would be required before calling a real candidate a
bug.

## Recorded execution and limitations

The refreshed pinned run completed on all five translation units: 396 function
definitions, 12 lock operations, 6 lock dependencies, and 6 interrupt graph
edges. It emitted 3 inconclusive cycle reports, all in `netdev.c`, with
unresolved lock identities. Separate analyzer processes took 6.644 seconds in
total; the largest peak RSS was 192,312 KiB. There were 43,705 uncertainty
entries and two CFG mapping diagnostics. The macro-expanded irqsave
acquisitions at `netdev.c` lines 501 and 3935 are now extracted, but their lock
expressions and saved-flags state remain unknown. All five units parsed, with
none skipped. See the raw per-file data and exact commands in
`evaluation/results/linux-v6.6.87/`.

These results demonstrate parsing and resource use on a real kernel subsystem,
but not validated lock-analysis accuracy. The inconclusive cycles are not
confirmed bugs, and unresolved lock identities prevent treating them as
validated candidates. There is no independently labeled kernel ground truth,
so precision, recall, false-positive rates, and missed-bug counts are
unavailable.

Kbuild object compilation succeeded with Clang 20 after skipping objtool
validation via `CONFIG_OBJTOOL=` and `SKIP_STACK_VALIDATION=1`, because
`ld.lld` and `libelf-dev` are absent. This is not a complete module build.
The full measurement, including this setup limitation, is recorded in
`evaluation/results/linux-v6.6.87/REPORT.md`.

## Reproduction

See [`evaluation/results/linux-v6.6.87/REPORT.md`](../evaluation/results/linux-v6.6.87/REPORT.md)
for the exact clone, revision verification, and runner commands. The upstream
stable tag is browsable at
<https://kernel.googlesource.com/pub/scm/linux/kernel/git/stable/linux/+/refs/tags/v6.6.87>.
Kbuild's compile database generator is
<https://github.com/torvalds/linux/blob/v6.6/scripts/clang-tools/gen_compile_commands.py>.

No kernel is booted, no module is loaded, and no hardware IRQ experiment is
performed.
