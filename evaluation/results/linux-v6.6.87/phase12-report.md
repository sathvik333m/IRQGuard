# Phase 12 — Kernel build validation status

## Scope and pinned input

The run used Ubuntu 24.04.4 LTS in WSL 2 on the repository's ext4 filesystem;
the host kernel was `6.6.87.2-microsoft-standard-WSL2`. The source was Linux
stable `v6.6.87`, commit `814637ca257f4faf57a73fd4e38888cce88b5911`, verified
by Git tag and commit checks. The configuration was x86_64
`x86_64_defconfig` with `CONFIG_E1000E=m`.

Tool versions: Clang/LLVM 20.1.2, GCC 13.3.0, GNU ld 2.42, GNU Make 4.3,
Python 3.12.3, and CMake 3.28.3. `/usr/lib/llvm-20/bin/ld.lld` is absent.
`libelf-dev 0.190-1.1ubuntu0.1` is now installed, and its headers enabled the
successful objtool build. `lld-20` was not needed because Kbuild was given
`HOSTLD=/usr/bin/ld`.

## Warning investigation

The old Phase 6 runner's message that both `lld-20` and `libelf-dev` were
missing was hardcoded, not emitted by its saved kernel log. Without
`HOSTLD=/usr/bin/ld`, Kbuild selected the missing LLVM `ld.lld` for host tools.
A direct build reproduced that linker error; the GNU host-linker override
resolved it. Objtool separately needs libelf headers and libraries. Before the
user installed `libelf-dev`, `make prepare` failed on missing `libelf.h` and
`gelf.h`; after installation, the full prepare stage succeeded.

`SKIP_STACK_VALIDATION=1` does not occur in the pinned Linux tree and is an
ignored make variable. `CONFIG_OBJTOOL=` is a command-line make override that
disables the configured objtool for that invocation. Neither should be used
to mask incomplete validation.

## Configuration and stage results

The selected config has `CONFIG_OBJTOOL=y`, `CONFIG_UNWINDER_ORC=y`, and
`CONFIG_X86_KERNEL_IBT=y`; `CONFIG_STACK_VALIDATION` is unset. In Linux 6.6,
IBT defers objtool until the composite module object. The runner now builds
`e1000e.o` in addition to the five analyzed translation-unit objects. It does
not attempt final `.ko` modpost, which needs a full kernel symbol table.

| Stage | Post-install full validation | Explicit source-only run |
| --- | --- | --- |
| Kernel revision/configuration | Passed: exact commit and configured e1000e module | Passed |
| Objtool host build (`make prepare`) | Passed with installed libelf headers | Explicitly skipped |
| Five selected C object compilations | Passed with Clang 20 | Passed with Clang 20 |
| Composite `e1000e.o` build | Passed | Not requested |
| Deferred objtool check | Passed; saved Kbuild command uses `--orc --ibt --retpoline --module --link` | Skipped |
| ORC metadata | `.orc_unwind` and `.orc_unwind_ip` sections present in composite object | Skipped despite ORC being configured |
| Separate stack validation | Not configured by defconfig | Not configured by defconfig |
| Analyzer parsing | Passed, five of five translation units | Passed, five of five translation units |
| Final `.ko` link / modpost | Not attempted | Not attempted |

A separate manual `.ko` target attempt stopped at modpost because no `vmlinux.o`
was built and kernel symbols were therefore unavailable. The runner correctly
stops at the successful composite object and objtool stage instead. No module
was installed, loaded, or booted.

The post-install analyzer run reported 396 functions, 12 lock operations, zero
lock-dependency edges, zero interrupt-graph edges, zero cycles, 43,514
uncertainties, and two diagnostics. Those two are analyzer CFG event-mapping
diagnostics, not Clang parser failures. Zero reported cycles is not evidence
that the driver is deadlock-free. The separate stack-validation feature was
not configured and no full kernel build was done.

## Preserved evidence

The original pre-install failure remains in `phase12/full-validation-*` to keep
the baseline history. The successful run is in
[post-install measurements](phase12/post-libelf-full-validation-measurements.json),
[post-install build log](phase12/post-libelf-full-validation-build.log), and
[build inputs and reports archive](phase12/post-libelf-build-inputs-and-reports.tar.gz).
The source-only run remains in [measurements](phase12/source-only-measurements.json)
and [build log](phase12/source-only-build.log). The original source report
archive is also retained.

## Reproduction

With `libelf-dev`, Git, GNU make, GCC, Clang/LLVM, Python 3, and `/usr/bin/time`
installed, from the repository root:

```sh
cmake --build build -j2
python3 evaluation/run_kernel_eval.py \
  --kernel /tmp/linux-v6.6.87 \
  --analyzer build/deadlock-analyzer \
  --llvm /usr/lib/llvm-20/bin \
  --output evaluation/results/linux-v6.6.87/phase12-rerun \
  --jobs 2
```

The full run builds the five selected source objects and the composite
`e1000e.o`, which triggers the deferred objtool invocation. The runner records
the expanded Kbuild command and verifies ORC sections. It does not claim final
module linking or a complete kernel build. Add `--skip-objtool` only to
reproduce the source-only mode. Do not pass `SKIP_STACK_VALIDATION=1`.
