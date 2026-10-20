# Phase 1 design: Clang AST fact extraction

## Pipeline

`deadlock-analyzer analyze` loads the built-in API registry, optionally overlays entries from JSON, then creates a `ClangTool`. If `--compile-commands DIR` is supplied, Clang uses the command associated with the source in that database. Otherwise, a fixed compilation database parses the source as C11 and accepts repeatable extra Clang arguments. Compiler diagnostics remain visible; a nonzero Clang tool status is returned as failure and no report is written.

The frontend's `RecursiveASTVisitor` walks the translation unit. It emits function definitions, call expressions, selected API calls, and control constructs. Extraction is restricted to AST nodes whose expansion location is in the requested main file. Direct calls use Clang's resolved declaration name. Indirect calls retain a printed callee expression and are not assigned guessed targets.

## Intermediate representation

The internal model is in `include/deadlock/Model.h`. Function, call, API operation, lock expression, control construct, and source-location records do not depend on AST node lifetime. Both expansion and spelling locations are kept, including macro status. Each location stores file, one-based line and column, plus an explicit validity bit.

The API registry in `ApiRegistry` maps names to operation kinds and an optional lock-argument index. The built-in registry covers the requested initial API list. A user JSON file extends or replaces entries by name, so subsystem-specific APIs can be introduced without changing AST traversal. API categories are descriptive facts only; there is no state analysis yet.

## Lock expression and macro handling

Lock arguments retain Clang-extracted token text and a shallow AST syntax category. The identity field remains `unresolved` for all expressions: textual equality and simple syntax are not alias analysis. Missing configured arguments are reported as diagnostics. Calls expanded from macros retain an expansion point (usually the invocation) and a spelling point (usually the macro body or argument), with JSON and text output showing macro status.

## Known limitations

- One source translation unit per invocation; declarations from included headers are used by Clang but not emitted as facts.
- No points-to/alias analysis, function-pointer target resolution, interprocedural summaries, lock-state tracking, interrupt-state semantics, graph construction, cycle detection, or feasibility checking.
- Macro source text may be approximate for token-pasting, stringification, or compiler-generated locations.
- API matching uses the direct callee's unqualified name. Namespace overloads, wrappers, macros that erase the call, and indirect calls may need richer models in later phases.
- A valid translation unit needs the same include paths, defines, and language settings as its intended build. Compilation databases are preferred for project code.
- Linux kernel translation units depend on generated headers and configuration-specific compile commands; the standalone default is not a kernel build recipe.
