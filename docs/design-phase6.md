# Phase 6: real Linux source evaluation

## Selected target

The pinned target is stable Linux `v6.6.87`, commit
`814637ca257f4faf57a73fd4e38888cce88b5911` (tag object
`6494364a1b9f85fc173d197e7ce79f9d4a6db5ce`). The initial subsystem is the
Intel `e1000e` PCI network driver. Its `netdev.c` contains IRQ registration and
locking operations, giving the analyzer relevant kernel constructs without
attempting a whole-tree parse. The initial translation-unit list is `netdev.c`,
`ethtool.c`, `ich8lan.c`, `phy.c`, and `nvm.c`.

The runner uses x86_64 `x86_64_defconfig`, enables `CONFIG_E1000E=m`, and builds
only the five selected object files. Full validation is the default: `make
prepare` builds objtool, then Kbuild runs it on the selected objects. The runner
uses Clang 20 from `LLVM=/usr/lib/llvm-20/bin/`, with GNU `/usr/bin/ld` for
kernel and host linking. This supported override avoids requiring `ld.lld-20`.
Objtool requires the `libelf-dev` headers and library. The optional
`--skip-objtool` mode explicitly disables objtool so users can still validate
source compilation and analyzer parsing; its result must not be described as a
fully validated object build.

The selected `x86_64_defconfig` sets `CONFIG_OBJTOOL=y` and
`CONFIG_UNWINDER_ORC=y`. Objtool is required to generate ORC unwind metadata.
The separate `CONFIG_STACK_VALIDATION` Kconfig feature is not enabled by this
defconfig (it depends on a frame-pointer unwinder). The make variable
`SKIP_STACK_VALIDATION=1` does not occur in this pinned kernel's Kbuild files
and is ignored. Reports distinguish objtool/ORC processing from the separate
stack-validation option instead of using “stack validation” as a synonym for
all objtool work.

The runner invokes the pinned kernel's
`scripts/clang-tools/gen_compile_commands.py` on the selected output directory
containing only the requested object `.cmd` files to produce a small,
justified compilation database. This preserves generated-header, macro,
architecture, and Kbuild flags without building every configured kernel
translation unit. Build artifacts go into an out-of-tree output directory;
source files are not edited.

The runner records exact commands, tool versions, Kconfig SHA-256, build logs,
and per-TU analyzer wall time, peak RSS, return status, parse diagnostics, raw
JSON and extracted counts. It reports missing files/commands and parse errors
explicitly. Successful schema-v3 or schema-v4 JSON contributes to aggregate counts.
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

The earlier Phase 6 run compiled the five source objects but explicitly set
`CONFIG_OBJTOOL=`; its saved build log does not show objtool invocations. Its
`SKIP_STACK_VALIDATION=1` argument had no effect because that variable is not
recognized by this kernel revision. Phase 12 reran the default validation
path: `prepare` reached objtool but failed compiling it because `libelf.h` and
`gelf.h` were unavailable. A second, explicit `--skip-objtool` run compiled
all five objects and analyzed all five source files; objtool and ORC metadata
generation were skipped. `CONFIG_STACK_VALIDATION` was not selected. See
[`phase12-report.md`](../evaluation/results/linux-v6.6.87/phase12-report.md)
for exact environment, command outcomes, and installation constraints.

## Reproduction

See [`evaluation/results/linux-v6.6.87/REPORT.md`](../evaluation/results/linux-v6.6.87/REPORT.md)
for the exact clone, revision verification, and runner commands. The upstream
stable tag is browsable at
<https://kernel.googlesource.com/pub/scm/linux/kernel/git/stable/linux/+/refs/tags/v6.6.87>.
Kbuild's compile database generator is
<https://github.com/torvalds/linux/blob/v6.6/scripts/clang-tools/gen_compile_commands.py>.

No kernel is booted, no module is loaded, and no hardware IRQ experiment is
performed.
