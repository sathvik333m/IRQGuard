# Interrupt-Aware Deadlock Analyzer

The analyzer uses Clang LibTooling to extract C source facts and computes bounded call-graph and interprocedural lock summaries. It reports possible lock-order dependencies with source provenance. It does **not** construct an interrupt-aware graph or detect deadlock cycles.

## Build on Ubuntu 24.04 / WSL 2

Install the C++ build tools and matching LLVM/Clang development packages:

```sh
sudo apt update
sudo apt install build-essential cmake ninja-build clang-20 llvm-20-dev libclang-20-dev \
  zlib1g-dev libzstd-dev libedit-dev libcurl4-openssl-dev python3
```

Build with LLVM 20's CMake package files:

```sh
cmake -S . -B build -G Ninja \
  -DLLVM_DIR=/usr/lib/llvm-20/lib/cmake/llvm \
  -DClang_DIR=/usr/lib/llvm-20/lib/cmake/clang
cmake --build build
ctest --test-dir build --output-on-failure
```

To use a different installed LLVM/Clang version, point `LLVM_DIR` and `Clang_DIR` at that version's `lib/cmake/llvm` and `lib/cmake/clang` directories. The frontend is compiled against the selected development libraries; the Clang executable alone is not sufficient. CMake prefers the dependency development packages above; if only their runtime libraries are present, it can link those directly on common Linux layouts.

## CLI

Parse a standalone source file (defaults to C11):

```sh
build/deadlock-analyzer analyze --source tests/fixtures/extraction.c
```

Write machine-readable JSON:

```sh
build/deadlock-analyzer analyze --source tests/fixtures/extraction.c --format json
```

Use an existing `compile_commands.json` directory, for example one generated for a project build:

```sh
build/deadlock-analyzer analyze --source /path/to/file.c \
  --compile-commands /path/to/build
```

For direct mode, add compiler arguments one at a time:

```sh
build/deadlock-analyzer analyze --source file.c \
  --clang-arg -Iinclude --clang-arg -DCONFIG_EXAMPLE=1
```

Each `--clang-arg` value is the next single argument. Compilation-database mode uses the command recorded for the requested source and does not accept `--clang-arg`.

API models can be extended or overridden by name with `--api-config config/apis.example.json`. The configuration is JSON with an `apis` array. Each item has `name`, `kind`, and, for lock calls, an optional zero-based `lock_argument`. Built-in APIs include the mutex, spinlock, IRQ-state and IRQ-registration names listed in the phase requirements. Configured lock expressions are captured as source text and a syntactic shape; this phase does not resolve aliases or prove lock-object identity.

Both human-readable output and JSON preserve expansion and spelling locations. Calls introduced through macros are attributed to their expansion site, with spelling location retained for inspection. Parser errors are printed by Clang and cause a nonzero exit; the analyzer will not emit a successful report for a failed parse.

## JSON example

The report contains `functions`, `calls`, `api_operations`, `call_graph`, `function_summaries`, `lock_dependencies`, `uncertainties`, and `diagnostics`. A dependency labels itself `direct` when its acquisitions are in one function, or `inferred_through_call` when a summary contributes across a call boundary. It includes both acquisition locations and the call chain. The [generated fixture report](examples/extraction-report.json) shows a full report.

An API event retains a symbolic lock identity and location, for example:

```json
{
  "api": "spin_lock",
  "kind": "lock_acquire",
  "caller": "inner",
  "arguments": ["(s)"],
  "lock": {
    "expression": "(s)",
    "syntax": "decl_ref",
    "identity_template": "@param[0]",
    "identity_status": "symbolic",
    "location": {"is_macro": false, "expansion": {}, "spelling": {}}
  },
  "location": {"is_macro": true, "expansion": {}, "spelling": {}}
}
```

Regenerate the report with:

```sh
build/deadlock-analyzer analyze --source tests/fixtures/extraction.c \
  --format json --output examples/extraction-report.json
```

## Current scope

The analyzer parses one requested translation unit and emits AST facts written in that main file. Definitions and calls found only in included headers are treated as unavailable bodies. Direct calls are resolved by declaration. A supported indirect-call pattern is a local/global function-pointer variable initialized or assigned directly to one or more function addresses; targets are unioned conservatively. Other indirect calls are reported as unresolved.

Lock identities use declaration location for variables, structural field/array/unary expressions, and `@param[n]` placeholders for formal parameters. Call-site summaries substitute actual arguments. This does not prove pointer aliasing: structurally different aliases may remain distinct and unknown expressions stay unresolved. Function summaries use Clang CFG blocks, a may-held lock union at joins, and must-release intersection at returns. They do not enumerate paths; branch feasibility and path predicates are not solved. Recursive summaries use a bounded fixed point and cap call-chain provenance at four steps. Limits, unresolved calls, and CFG mapping gaps appear in report uncertainties or diagnostics.

The control-construct list includes `if`, `switch`, loops, and the ternary operator. Macro locations contain expansion and spelling points where Clang exposes them; token-pasting and generated source can produce less intuitive spellings. This is not Linux kernel build integration, interrupt-aware analysis, or deadlock cycle detection. See [Phase 2 design](docs/design-phase2.md) for summary semantics and precision limits.
