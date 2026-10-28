# Linux v6.6.87 evaluation report

## Result

This section preserves the archived Phase 6 analyzer run; it is not the fresh
Phase 12 source-only analyzer output below.

The analyzer parsed all five selected translation units with generated Kbuild
compile commands. It extracted 396 function definitions and 12 configured lock
operations in 6.644 seconds summed across separate processes. Peak RSS was
192,312 KiB for the largest single-file run. No file was skipped or failed.
It produced six lock dependencies and three cycle reports; all three are
`inconclusive_analysis` reports in `netdev.c` involving unresolved lock
identities. They are not validated deadlocks.

The macro-expanded `_raw_spin_lock_irqsave` acquisitions at `netdev.c:501` and
`:3935` are now represented. Their lock expressions expand through
`spinlock_check(...)` and remain unresolved; their saved-flags state also
remains unknown because the helper returns flags rather than taking the flags
lvalue as an argument. The corresponding `spin_unlock_irqrestore` calls are
extracted at lines 503 and 3938. This closes the previous silent acquisition
gap, but unresolved identity and state still limit conclusions. The tool
emitted 43,705 uncertainty entries and two CFG mapping diagnostics across the
five reports.

| Translation unit | Functions | Lock operations | Dependencies | Findings | Time (s) | Peak RSS (KiB) | Diagnostics |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `netdev.c` | 154 | 10 | 6 | 3 inconclusive | 2.723 | 192312 | 2 |
| `ethtool.c` | 51 | 0 | 0 | 0 | 1.119 | 131840 | 0 |
| `ich8lan.c` | 98 | 2 | 0 | 0 | 1.017 | 133452 | 0 |
| `phy.c` | 76 | 0 | 0 | 0 | 0.969 | 131580 | 0 |
| `nvm.c` | 17 | 0 | 0 | 0 | 0.817 | 130588 | 0 |
| **Sum / max** | **396** | **12** | **6** | **3 inconclusive** | **6.644** | **192312 max** | **2** |

The five independent reports contain 43,705 uncertainty entries in aggregate.
Counts can repeat header-derived or inline facts across translation units.
The lock graph summaries are projections of one analyzer pass; they are not
separate basic, IRQ-disabled, and feasibility-refined executions. No precision
or recall is reported because this evaluation has no independently labeled
kernel ground truth. No unfamiliar cycle was validated as a kernel bug.

## Phase 10 uncertainty review

The Phase 9.0 reports were independently re-counted by
[`summarize_uncertainties.py`](../../summarize_uncertainties.py). The raw event
count remains **43,705**; no message was deleted or rewritten. Under the
documented cause-key rules, they group into **4,872 structured records** across
the five translation units. Of the raw messages, **38,771** carry an
interprocedural or IRQ-summary propagation prefix. This grouping reduces the
number of displayed causes by 88.85%, but it does not establish that each group
is one independently verified program defect.

| Category | Raw events | Unique records | Main interpretation |
| --- | ---: | ---: | --- |
| `unresolved_call` | 21,742 | 2,352 | 20,683 missing/unavailable bodies and 1,059 unresolved indirect calls |
| `interrupt_state` | 21,734 | 2,356 | Unknown call effects, unresolved irqsave flags, and unmatched restores |
| `handler_lifecycle` | 41 | 6 | `free_irq` teardown timing is not modeled |
| `unsupported_api` | 154 | 154 | Name-based warnings; some may be false positives and require API review |
| `lock_identity` | 30 | 2 | Two source sites with unresolved lock identity (`netdev.c:501`, `:3935`) |
| `control_flow` | 4 | 2 | Two CFG event mapping misses and their propagated summary records |
| **Total** | **43,705** | **4,872** | |

| Analysis stage | Raw events | Unique records |
| --- | ---: | ---: |
| `interprocedural` | 21,742 | 2,352 |
| `interrupt_state` | 21,734 | 2,356 |
| `handler_discovery` | 41 | 6 |
| `api_model` | 154 | 154 |
| `lock_extraction` | 30 | 2 |
| `control_flow` | 4 | 2 |

There are **2,636 high-impact records** under the documented rule-based
priority labels. This is not a probability or a calibrated risk score.

The three saved inconclusive cycles are all associated by source-location
evidence with five structured records at `netdev.c:501`: the missing body for
`spinlock_check`, unresolved lock identity, unresolved irqsave flags, the
unknown IRQ effect of `spinlock_check`, and its unsupported-API heuristic
warning. There are 15 record-to-cycle associations (five records × three
cycles). This explains why the cycles are inconclusive; it does not validate
them as deadlocks. No uncertainty event is marked proven non-affecting because
the saved data does not support that conclusion.

The breakdown and per-record evidence are preserved in
[`uncertainty-summary-phase10.json`](uncertainty-summary-phase10.json),
including SHA-256 hashes of the five input reports. This is a retrospective
classification of the schema-v3 saved reports. The original report files,
43,705 raw strings, counts, cycle results, and Phase 9.0 checksums remain
unchanged. The Phase 10 schema-v4 analyzer adds the same structured fields to
new runs, but a fresh post-fix kernel run was not possible because the pinned
source checkout is no longer present in this environment.

## Target and scope

- Stable release tag: `v6.6.87`
- Commit: `814637ca257f4faf57a73fd4e38888cce88b5911`
- Subsystem: `drivers/net/ethernet/intel/e1000e`
- Translation units: `netdev.c`, `ethtool.c`, `ich8lan.c`, `phy.c`, `nvm.c`
- Configuration: x86_64 `x86_64_defconfig`, with `CONFIG_E1000E=m`
- Compilation database: five Kbuild `.cmd` records, generated by the pinned
  tree's `scripts/clang-tools/gen_compile_commands.py`

The original Phase 6 run compiled the selected objects with Clang 20, but used
`CONFIG_OBJTOOL=`. Its `SKIP_STACK_VALIDATION=1` argument is not recognized by
the pinned kernel's Kbuild and had no effect. The original runner's statement
that both `ld.lld` and `libelf-dev` were required is corrected by the Phase 12
investigation: a GNU `HOSTLD=/usr/bin/ld` override avoids lld, while objtool
still requires the `libelf-dev` headers. The original run did not execute
objtool or produce ORC metadata. After `libelf-dev` was installed, the Phase 12
full validation built the e1000e composite object, ran deferred objtool with
ORC/IBT options, and verified ORC sections. It did not link the final module or
build the full kernel. See the [Phase 12 validation report](phase12-report.md)
for exact stage statuses, logs, dependencies, and limitations. Original Phase 6
measurement files remain unchanged.

## Reproduction

From the repository root, with Git, GNU make, GCC, Clang/LLVM, Python 3, and
`/usr/bin/time` installed:

```sh
git clone --depth 1 --branch v6.6.87 \
  https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git \
  /tmp/linux-v6.6.87
git -C /tmp/linux-v6.6.87 rev-parse HEAD
# Expected: 814637ca257f4faf57a73fd4e38888cce88b5911
cmake --build build -j2
python3 evaluation/run_kernel_eval.py \
  --kernel /tmp/linux-v6.6.87 \
  --analyzer build/deadlock-analyzer \
  --llvm /usr/lib/llvm-20/bin \
  --output evaluation/results/linux-v6.6.87 --jobs 2
```

The script rejects a different kernel commit. It builds out of tree, records
the `.config` hash and Kbuild commands, analyzes each selected file separately,
and records raw JSON, stderr, elapsed time, and peak RSS. It does not edit
tracked kernel source, boot the kernel, or load a module.

## Benchmark and limits

[`../../benchmark-set.json`](../../benchmark-set.json) describes controlled
positive, negative, and inconclusive fixtures asserted by the Phase 3/4 test
suites. These are analyzer self-tests, not independent Linux kernel labels.
The report computes no kernel precision or recall. The unresolved lock
identities and saved-flags state on the extracted irqsave helpers, together
with the inconclusive cycles, prevent a useful negative or positive bug
conclusion for e1000e. Further kernel scope should wait until macro arguments
and saved flags can be modeled more precisely.

The committed `raw-measurements.json` contains per-file counts, timings,
resource measurements, tool versions, configuration hash, and executed
commands. Full per-file JSON reports, stderr/time files, and `build.log` are
generated under ignored output paths; reproduce them with the command above.
The raw manifest records generated artifact paths relative to the evaluation
output directory.
