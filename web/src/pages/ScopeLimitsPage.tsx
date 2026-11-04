import { CheckCircle2, Info, XCircle } from 'lucide-react'

export function ScopeLimitsPage() {
  return (
    <div className="scope-limits-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">DESIGN & CAPABILITIES</div>
          <h1>Scope, Assumptions & Limits</h1>
          <p className="page-caption">
            IRQGuard focuses strictly on static lock order and same-CPU hardware interrupt preemption in single C translation units. It does not replace runtime validators, full symbolic execution, or dynamic stress tests.
          </p>
        </div>
      </header>

      {/* Honest Framing Banner */}
      <div className="honest-framing-box">
        <Info size={18} className="text-accent flex-shrink-0" />
        <div>
          <strong>Explicit Boundary Constraints</strong>
          <p>
            Static cycle candidates are <strong>not confirmed runtime deadlocks</strong>. Zero reported cycles is <strong>not proof of deadlock freedom</strong>. The runtime evidence harness covers controlled userspace pthread programs only, not kernel execution. IRQGuard does not reproduce or claim equivalence to Archerfish.
          </p>
        </div>
      </div>

      {/* Supported vs Unsupported Capabilities Table */}
      <section className="scope-section">
        <div className="section-title-wrap">
          <h2>Modeled Scope Matrix</h2>
          <p>Detailed breakdown of what the Clang AST/CFG analyzer models and what remains out of scope.</p>
        </div>

        <div className="scope-table-wrap">
          <table className="scope-matrix-table" aria-label="Feature support table">
            <thead>
              <tr>
                <th style={{ width: '24%' }}>Feature / Area</th>
                <th style={{ width: '16%' }}>Status</th>
                <th style={{ width: '60%' }}>Implementation & Constraints</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Hardware Interrupts (hardirq)</strong></td>
                <td><span className="badge badge-good"><CheckCircle2 size={13} /> Supported</span></td>
                <td>
                  Models top-half interrupt handlers registered via <code>request_irq()</code>. Computes directed <code>process → hardirq</code> preemption edges when process state has IRQs enabled.
                </td>
              </tr>
              <tr>
                <td><strong>IRQ-Safe Lock Primitives</strong></td>
                <td><span className="badge badge-good"><CheckCircle2 size={13} /> Supported</span></td>
                <td>
                  Extracts <code>spin_lock_irqsave</code>, <code>spin_unlock_irqrestore</code>, <code>local_irq_disable</code>, and <code>local_irq_enable</code>. Associates saved flags identities where AST exposes them.
                </td>
              </tr>
              <tr>
                <td><strong>Bounded Branch Predicates</strong></td>
                <td><span className="badge badge-good"><CheckCircle2 size={13} /> Supported</span></td>
                <td>
                  Direct same-function CFG branch conditions for simple comparisons. Contradictory paths are rejected; complex expressions remain inconclusive.
                </td>
              </tr>
              <tr>
                <td><strong>Interprocedural Summaries</strong></td>
                <td><span className="badge badge-good"><CheckCircle2 size={13} /> Supported</span></td>
                <td>
                  Bounded interprocedural propagation with formal-parameter substitution (<code>@param[0]</code>) and symbolic alias canonicalization across single translation units.
                </td>
              </tr>
              <tr>
                <td><strong>Soft IRQ / Bottom Halves</strong></td>
                <td><span className="badge badge-muted"><XCircle size={13} /> Not supported</span></td>
                <td>
                  Softirqs, tasklets, workqueues, and timers have distinct preemption rules and run on softirq stacks. They are not currently distinguished from process context.
                </td>
              </tr>
              <tr>
                <td><strong>Non-Maskable Interrupts (NMI)</strong></td>
                <td><span className="badge badge-muted"><XCircle size={13} /> Not supported</span></td>
                <td>
                  NMIs cannot be masked by <code>local_irq_disable()</code>. General locks are prohibited in NMIs; IRQGuard does not model NMI handlers.
                </td>
              </tr>
              <tr>
                <td><strong>Whole-Kernel Call Graph</strong></td>
                <td><span className="badge badge-muted"><XCircle size={13} /> Not supported</span></td>
                <td>
                  Operates on individual C translation units with generated Kbuild compilation databases. Lock relationships crossing translation unit boundaries are not linked.
                </td>
              </tr>
              <tr>
                <td><strong>General Pointer Aliasing</strong></td>
                <td><span className="badge badge-muted"><XCircle size={13} /> Not supported</span></td>
                <td>
                  Does not perform whole-program pointer analysis. Heap objects, container_of indirections, and unresolvable pointers are explicitly recorded as uncertainty events.
                </td>
              </tr>
              <tr>
                <td><strong>General SMT / Path Solving</strong></td>
                <td><span className="badge badge-muted"><XCircle size={13} /> Not supported</span></td>
                <td>
                  No SMT solver (e.g. Z3) is embedded. The analyzer uses bounded CFG traversal up to 24 frames/blocks. Unsupported guards are kept as unknown rather than unconstrained.
                </td>
              </tr>
              <tr>
                <td><strong>Lifecycle & Registration Ordering</strong></td>
                <td><span className="badge badge-muted"><XCircle size={13} /> Not supported</span></td>
                <td>
                  Does not prove that <code>request_irq</code> executes before a lock acquisition, or that an interrupt is ever delivered by hardware. Matching <code>free_irq</code> is recorded as evidence only.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Comparison with Established Linux Tools */}
      <section className="scope-section">
        <div className="section-title-wrap">
          <h2>Comparison with Established Linux Tools</h2>
          <p>
            Understanding how IRQGuard differs from runtime lock validators and research checkers (grounded directly in <code>docs/phase17-evaluation.md</code>).
          </p>
        </div>

        <div className="scope-table-wrap">
          <table className="scope-matrix-table" aria-label="Tool comparison table">
            <thead>
              <tr>
                <th style={{ width: '20%' }}>Tool</th>
                <th style={{ width: '40%' }}>Method and Positive Result</th>
                <th style={{ width: '40%' }}>Coverage and Comparison Limits</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>IRQGuard</strong></td>
                <td>
                  Static AST/CFG and bounded summaries for one translation unit; emits source-derived lock edges, candidate cycles, and explicit uncertainty.
                </td>
                <td>
                  Examines parsed paths without requiring runtime execution or hardware setup, but does not model the whole kernel or all aliases, contexts, and build configurations.
                </td>
              </tr>
              <tr>
                <td><strong>Linux lockdep<br /><code className="text-xs">CONFIG_PROVE_LOCKING</code></strong></td>
                <td>
                  Runtime lock validator observes lock acquisition chains, lock classes, and IRQ usage/context in a running kernel; reports dependency or IRQ-safety violations.
                </td>
                <td>
                  Requires an instrumented running kernel and exercised code paths. Reasons over runtime lock classes; cannot verify unexercised paths. Absence of a warning is not proof of safety.
                </td>
              </tr>
              <tr>
                <td><strong>locktorture</strong></td>
                <td>
                  Runtime stress test module designed for selected locking primitives and kernel configurations.
                </td>
                <td>
                  Measures lock implementation correctness and contention throughput under heavy load; not a general source-level lock-order detector.
                </td>
              </tr>
              <tr>
                <td><strong>KCSAN</strong></td>
                <td>
                  Runtime sampling data-race detector using watchpoints to observe concurrent accesses.
                </td>
                <td>
                  Detects data races, which is an orthogonal concurrency property from lock dependency cycles and deadlocks. Findings are not deadlock labels.
                </td>
              </tr>
              <tr>
                <td><strong>Archerfish</strong></td>
                <td>
                  Academic static analyzer for interrupt-driven OS kernels described in research literature.
                </td>
                <td>
                  IRQGuard does NOT reproduce Archerfish. IRQGuard is an independent static tool built from scratch on Clang LibTooling with bounded summaries and explicit uncertainty.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
