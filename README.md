# IRQGuard: Static Deadlock Analyzer for C and Linux-Kernel-Style Locking

IRQGuard is a static concurrency analysis tool built on Clang LibTooling (C++17/20) that detects potential lock-order inversions crossing hardware interrupt boundaries in C and Linux driver code. By extracting interprocedural lock acquisition summaries and modeling same-CPU top-half interrupt preemption (`request_irq`), IRQGuard flags cycles between process-level execution and hard-IRQ handlers. All static findings are surfaced as candidate cycles rather than confirmed deadlocks, zero reported cycles does not prove deadlock freedom, and unresolved pointer aliases, external kernel functions, and unknown states are tracked explicitly as uncertainty events.

## 60-Second Demo

Run the command-line interface on the included basic mutex example:

```sh
./irqguard analyze --source examples/basic.c
```

**Expected terminal output:**

```text
Source: examples/basic.c
Functions (2):
  update_state at examples/basic.c:10:13 [update_state@examples/basic.c:10:13]
  worker at examples/basic.c:15:6 [worker@examples/basic.c:15:6]
Calls (5):
  update_state -> mutex_lock [modeled_api] at line 11
  update_state -> mutex_unlock [modeled_api] at line 12
  worker -> mutex_lock [modeled_api] at line 17
  worker -> update_state [direct] at line 18
  worker -> mutex_unlock [modeled_api] at line 19
Lock dependencies (1):
  @param[0] -> @param[1] [inferred_through_call, possible] reported in worker
Interrupt cycle candidates (0):
Cycle reports are static candidates under the process/hardirq model; they are not confirmed deadlocks.
```

To export an interactive Graphviz visualization of lock dependencies:

```sh
./irqguard graph --source tests/fixtures/interrupts.c --output /tmp/interrupts.dot
dot -Tsvg /tmp/interrupts.dot -o /tmp/interrupts.svg  # optional SVG rendering
```

---

## How It Works

IRQGuard processes source code through a transparent, 5-stage explainable pipeline:

```
[ C Source ] 
     │
     ▼ (1) Clang AST & CFG Frontend
Function records, call sites, macro locations, branch CFG blocks
     │
     ▼ (2) API Registry Resolution
Recognize acquire/release, irqsave/irqrestore, local_irq_disable, and request_irq
     │
     ▼ (3) Interprocedural Summaries
Propagate lock operations and dependencies across calls using symbolic identities (@param[n])
     │
     ▼ (4) Execution Context Modeling
Distinguish process context from hard-IRQ context; model same-CPU preemption when IRQs enabled
     │
     ▼ (5) Cycle Detection & Feasibility Refinement
Detect closed lock paths and verify branch/IRQ-state feasibility:
  • candidate_lock_order_cycle: Process-only lock order inversion
  • interrupt_aware_candidate: Feasible process ↔ hardirq cross-context preemption cycle
  • rejected_candidate: Counterfactual cycle refuted by proven disabled IRQs (irqsave / local_irq_disable)
  • inconclusive_analysis: Path contains unresolved conditional states or pointer aliases
```

---

## Scope and Limits

| Area | Status | Implementation Details & Constraints |
|---|---|---|
| **Hardware Interrupts (hardirq)** | **Supported** | Models top-half interrupt handlers registered via `request_irq()`. Computes directed `process → hardirq` preemption edges when process state has IRQs enabled. |
| **IRQ-Safe Lock Primitives** | **Supported** | Extracts `spin_lock_irqsave`, `spin_unlock_irqrestore`, `local_irq_disable`, and `local_irq_enable`. Associates saved flags identities where AST exposes them. |
| **Bounded Branch Predicates** | **Supported** | Direct same-function CFG branch conditions for simple comparisons. Contradictory paths are rejected; complex expressions remain inconclusive. |
| **Interprocedural Summaries** | **Supported** | Bounded interprocedural propagation with formal-parameter substitution (`@param[0]`) and symbolic alias canonicalization across single translation units. |
| **Soft IRQ / Bottom Halves** | *Not supported* | Softirqs, tasklets, workqueues, and timers have distinct preemption rules and run on softirq stacks. They are not currently distinguished from process context. |
| **Non-Maskable Interrupts (NMI)** | *Not supported* | NMIs cannot be masked by `local_irq_disable()`. General locks are prohibited in NMIs; IRQGuard does not model NMI handlers. |
| **Whole-Kernel Call Graph** | *Not supported* | Operates on individual C translation units with generated Kbuild compilation databases. Lock relationships crossing translation unit boundaries are not linked. |
| **General Pointer Aliasing** | *Not supported* | Does not perform whole-program pointer analysis. Heap objects, container_of indirections, and unresolvable pointers are explicitly recorded as uncertainty events. |
| **General SMT / Path Solving** | *Not supported* | No SMT solver (e.g. Z3) is embedded. The analyzer uses bounded CFG traversal up to 24 frames/blocks. Unsupported guards are kept as unknown rather than unconstrained. |
| **Lifecycle & Registration Ordering** | *Not supported* | Does not prove that `request_irq` executes before a lock acquisition, or that an interrupt is ever delivered by hardware. Matching `free_irq` is recorded as evidence only. |

### Tool Comparison

- **Linux lockdep (`CONFIG_PROVE_LOCKING`):** Dynamic runtime validator tracking lock acquisition chains in an instrumented running kernel. Covers active execution paths but cannot verify unexercised code. IRQGuard operates statically on source code without requiring running kernels or hardware, but covers a scoped subset.
- **locktorture:** Dynamic runtime kernel stress-testing module for concurrency primitives. Measures throughput and contention under torture, not general source-level lock-order inversion detection.
- **KCSAN:** Kernel Concurrency Sanitizer detects dynamic data races using compiler instrumentation and watchpoints. Data races are an orthogonal concurrency property from lock dependency cycles and deadlocks.
- **Archerfish (USENIX Security 2024):** Academic research static analyzer for interrupt-driven OS kernels. IRQGuard was inspired by concepts in Archerfish but was built independently from scratch as a scoped, transparent tool with explicit uncertainty reporting; it does not reproduce Archerfish or claim equivalent coverage.

---

## Evaluation Summary (Phase 17)

Recorded analysis of the pinned Linux stable kernel (`v6.6.87`, commit `814637ca257f4faf57a73fd4e38888cce88b5911`) across five selected `drivers/net/e1000e` translation units:

- **Files analyzed:** 5 / 5 files requested
- **Functions analyzed:** 396 functions
- **Lock operations extracted:** 12 lock operations (including `spin_lock_irqsave` / `spin_unlock_irqrestore` pairs)
- **Lock dependencies:** 0 dependencies
- **Candidate cycles:** 0 candidate cycles
- **Uncertainty events:** 43,632 events (4,922 unique records across translation units, including 89 unresolved lock-identity records)
- **Honest framing:** Zero reported cycles does *not* prove deadlock freedom in the driver; the five files are exploratory translation units, not a labeled bug benchmark. Independent kernel bug cases: 0 (no precision or recall claims).
- **Validation stages:** Object compilation and `objtool` checks (`--orc`, `--ibt`) succeeded on the composite object; final `.ko` linking was not attempted and separate stack validation was not defconfig-configured.

---

## Running the Web Interface

The web interface is a standalone React 18 + TypeScript + Vite application featuring a visual project guide, an interactive 4-step walkthrough, a lock dependency graph explorer, findings inspector, and evaluation metrics.

### Option 1: Explore with Bundled Demo Data (No Backend Needed)

The site is fully functional offline without installing the C++ analyzer or running a backend API:

```sh
cd web
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser. The site defaults to the **Project guide** and allows exploring bundled real reports (`interrupts.c`, `basic.c`, Linux Phase 17 evaluation) with full graph visualization and interactive walkthroughs.

To build a standalone static bundle without the local backend:

```sh
cd web
VITE_STATIC=1 npm run build
# Built files are ready in web/dist/
```

### Option 2: Live Analysis with Local API Backend

To analyze local C source files and run new analyses through the GUI:

1. **Terminal 1: Start the local API backend**
   ```sh
   export IRQGUARD_ANALYZER="$PWD/build/deadlock-analyzer"
   export IRQGUARD_WORKSPACES="$PWD"
   export IRQGUARD_DATA_DIR="$HOME/.local/share/irqguard"
   cd backend
   npm start
   ```
   *(Alternatively, run `node backend/server.mjs` directly from the repository root).*

   - **`IRQGUARD_ANALYZER`**: Absolute path to the compiled C++ `deadlock-analyzer` binary.
   - **`IRQGUARD_WORKSPACES`**: Colon-separated list of directories the backend is allowed to read. Paths outside these roots are rejected for security.
   - **`IRQGUARD_DATA_DIR`**: Directory for persisted run metadata and JSON reports (defaults to `~/.local/share/irqguard`).

2. **Terminal 2: Start the frontend dev server**
   ```sh
   cd web
   npm ci
   npm run dev
   ```

   Open [http://localhost:5173](http://localhost:5173) in your browser. The frontend automatically proxies `/api/v1` calls to `http://127.0.0.1:8000`.

#### Troubleshooting Local GUI Connection

- **The UI shows "Backend offline":** Confirm the Node.js backend is running on `127.0.0.1:8000` (`cd backend && npm start`).
- **"Analyzer unavailable":** Build the C++ binary (`cmake --build build`) and ensure `IRQGUARD_ANALYZER` points to `$PWD/build/deadlock-analyzer`.
- **"Source path outside configured workspace":** Provide an absolute Linux path located inside the directories exported in `IRQGUARD_WORKSPACES`.
- **WSL 2 networking:** WSL 2 forwards loopback connections automatically. If your Windows browser cannot reach port 5173 or 8000, verify localhost forwarding in `.wslconfig`.

---

## Build Prerequisites and Setup

For native builds on Ubuntu 24.04 LTS or WSL 2:

```sh
sudo apt update
sudo apt install -y build-essential cmake ninja-build clang-20 llvm-20-dev libclang-20-dev \
  zlib1g-dev libzstd-dev libedit-dev libcurl4-openssl-dev python3 python3-pip nodejs npm

# Build C++ analyzer
cmake -S . -B build -G Ninja \
  -DLLVM_DIR=/usr/lib/llvm-20/lib/cmake/llvm \
  -DClang_DIR=/usr/lib/llvm-20/lib/cmake/clang
cmake --build build
ctest --test-dir build --output-on-failure
```

---

## Design History

<details>
<summary>Click to view phase-by-phase design records and historical validation</summary>

### Phase 1–4: Core AST Extractor & Cycle Modeling
- [Phase 2: Source Extraction](docs/design-phase2.md): Traversal of Clang AST, basic blocks in CFG, and source location tracking.
- [Phase 3: Interprocedural Summaries](docs/design-phase3.md): Formal parameter substitution (`@param[n]`) across call boundaries.
- [Phase 4: Interrupt Preemption & Feasibility](docs/design-phase4.md): Directed process-to-hardirq graph edges and the 4 finding categories (`candidate_lock_order_cycle`, `interrupt_aware_candidate`, `rejected_candidate`, `inconclusive_analysis`).

### Phase 5–7: Runtime Harness & CLI Integration
- [Phase 5: Controlled Runtime Evidence](docs/design-phase5.md): Userspace pthread harness with watchdog-terminated deadlocks and JSONL trace emission. Pthread tests do not emulate kernel hardware interrupts.
- [Phase 6: Initial Linux Evaluation Baseline](docs/design-phase6.md): Earliest exploratory run on Linux v6.6.87 e1000e resulting in 6 false-positive dependencies due to irqsave identity mismatch.
- [Phase 7: CLI Integration](docs/design-phase7.md): Python wrapper CLI `./irqguard` uniting analysis, graphing, and runtime tests.

### Phase 8–13: Web UI & Kernel Validation Stages
- [Phase 8: Web UI & Node API](docs/design-phase8.md): React Flow dependency graph, findings table, and local Node.js API with workspace boundary enforcement.
- [Phase 10: Uncertainty Classification](docs/design-phase10.md): Structured uncertainty summary grouping events into stable cause records.
- [Phase 12: Object Validation](evaluation/results/linux-v6.6.87/phase12-report.md): Objtool and ORC section checks on composite e1000e kernel objects.
- [Phase 13: Comparative Post-Fix Evaluation](evaluation/results/linux-v6.6.87/phase13-report.md): Pinned kernel comparison between initial baseline and fixed extraction.

### Phase 14–18: Symbolic Identity, Branch Feasibility & Dataset v1
- [Phase 14: Dependency Generation Review](docs/phase14-dependency-generation.md): Detailed root cause analysis of baseline same-site self-edges.
- [Phase 15: Symbolic Identity Fix](docs/phase15-symbolic-identity.md): Canonicalization of pointer aliases and matching `spin_lock_irqsave` / `spin_unlock_irqrestore` pairs, resolving self-edges to 0 dependencies.
- [Phase 16: Bounded Feasibility Refinement](docs/phase16-feasibility-review.md): Direct CFG branch predicate resolution and `free_irq` pairing evidence.
- [Phase 17: Versioned Evaluation Dataset](docs/phase17-evaluation.md): Curated dataset v1 with controlled positive/negative fixtures and pinned Linux v6.6.87 exploratory cases.
- [Phase 18: Evidence Review & Semantic Diff](docs/phase18-integration.md): Multi-report semantic diff and runtime trace correlation.

</details>
