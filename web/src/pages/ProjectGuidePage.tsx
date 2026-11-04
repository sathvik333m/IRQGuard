import { useState } from 'react'
import {
  Activity,
  ArrowRight,
  BookOpen,
  Check,
  FileCode2,
  GitBranch,
  HardDrive,
  Info,
  Play,
  TerminalSquare,
  Zap,
} from 'lucide-react'
import type { KernelEvaluation } from '../types'

interface PipelineStep {
  id: string
  number: string
  name: string
  shortLabel: string
  summary: string
  beforeLabel: string
  beforeCode: string
  afterLabel: string
  afterCode: string
}

const PIPELINE_STEPS: PipelineStep[] = [
  {
    id: 'parse',
    number: '01',
    name: 'Parse the program (Clang AST & CFG)',
    shortLabel: 'Parse (AST/CFG)',
    summary: 'Clang extracts function definitions, calls, conditionals, loops, macros, and source locations from the requested C translation unit. Parser failures are surfaced instead of reported as successful runs.',
    beforeLabel: 'Input: C Source Code (examples/basic.c)',
    beforeCode: `static void update_state(mutex_t *lock) {
    mutex_lock(lock);
    mutex_unlock(lock);
}`,
    afterLabel: 'Extracted: Clang AST & CFG FunctionRecord',
    afterCode: `{
  "id": "update_state@examples/basic.c:8:13",
  "name": "update_state",
  "parameters": ["lock"],
  "cfg_available": true,
  "cfg_blocks": 2
}`,
  },
  {
    id: 'resolve',
    number: '02',
    name: 'Resolve lock events (API Registry)',
    shortLabel: 'Resolve lock events',
    summary: 'A configurable API registry identifies supported acquire, release, IRQ-state, and handler-registration calls. Lock expressions keep symbolic identity and macro spelling/expansion locations.',
    beforeLabel: 'AST Call: mutex_lock(outer) at worker:15',
    beforeCode: `void worker(mutex_t *outer, mutex_t *inner) {
    mutex_lock(outer);
    ...`,
    afterLabel: 'Resolved ApiOperation Fact',
    afterCode: `{
  "api": "mutex_lock",
  "kind": "lock_acquire",
  "lock": {
    "syntax": "outer",
    "identity_template": "@param[0]",
    "identity_status": "symbolic"
  }
}`,
  },
  {
    id: 'calls',
    number: '03',
    name: 'Follow calls (Interprocedural summaries)',
    shortLabel: 'Follow calls (summaries)',
    summary: 'Interprocedural summaries propagate lock events through direct calls and supported function-pointer patterns. Recursion uses a bounded fixed point; unresolved targets remain explicit.',
    beforeLabel: 'Call Chain: worker() -> update_state(inner)',
    beforeCode: `worker(mutex_t *outer, mutex_t *inner) {
    mutex_lock(outer);
    update_state(inner); // inner lock taken here!
}`,
    afterLabel: 'Inferred Lock Dependency',
    afterCode: `{
  "from_lock": "@param[0]",
  "to_lock": "@param[1]",
  "origin_function": "update_state",
  "reporting_function": "worker",
  "origin": "inferred_through_call"
}`,
  },
  {
    id: 'context',
    number: '04',
    name: 'Model execution context (Process vs Hard IRQ)',
    shortLabel: 'Model context (hard IRQ)',
    summary: 'The scoped Linux model links statically resolved request_irq handlers to hard-IRQ context and tracks selected local IRQ and irqsave/restore transitions. irqrestore restores saved state; it is not treated as unconditional enable.',
    beforeLabel: 'Registration: request_irq(1, cross_handler, ...)',
    beforeCode: `request_irq(1, cross_handler, 0, "cross", 0);
// Handler callback executes in hardirq context!`,
    afterLabel: 'Context-Labelled Dependency Edges',
    afterCode: `[
  { "from": "cross_a", "to": "cross_b", "context": "process -> process" },
  { "from": "cross_a", "to": "cross_b", "context": "process -> hardirq" (preemption) },
  { "from": "cross_b", "to": "cross_a", "context": "hardirq -> hardirq" }
]`,
  },
  {
    id: 'explain',
    number: '05',
    name: 'Explain candidates (Cycles & Feasibility)',
    shortLabel: 'Explain candidates (cycles)',
    summary: 'A bounded CFG check compares simple branch predicates for direct same-function lock paths; interprocedural paths remain unrefined. Contradictory supported guards reject an edge, while unknown conditions remain inconclusive. No static candidate is a confirmed deadlock.',
    beforeLabel: 'Cycle candidate detection over edge graph',
    beforeCode: `Lock path: cross_a -> cross_b -> cross_a
Checking: same-CPU preemption feasibility & IRQ flags...`,
    afterLabel: 'Categorized Finding Report',
    afterCode: `{
  "category": "interrupt_aware_candidate",
  "feasibility": "candidate",
  "lock_sequence": ["cross_a", "cross_b", "cross_a"],
  "contains_uncertain_edge": false,
  "explanation": "Static candidate under process/hardirq model."
}`,
  },
]

export function ProjectGuidePage({
  latestUncertainty,
  onOpenWorkspace,
  onNew,
  onKernel,
  onRuntime,
  onCli,
  onWalkthrough,
  onScope,
}: {
  latestUncertainty: NonNullable<KernelEvaluation['phase19_2_uncertainty']> | null
  onOpenWorkspace: () => void
  onNew: () => void
  onKernel: () => void
  onRuntime: () => void
  onCli: () => void
  onWalkthrough?: () => void
  onScope?: () => void
}) {
  const [activePipelineStep, setActivePipelineStep] = useState<number>(0)
  const currentStep = PIPELINE_STEPS[activePipelineStep]

  const current = latestUncertainty?.after

  return (
    <div className="project-guide">
      {/* Hero Section */}
      <section className="guide-hero">
        <div className="guide-hero-copy">
          <span className="eyebrow">IRQGUARD · STATIC CONCURRENCY ANALYZER</span>
          <h1>Find the lock paths that cross interrupt boundaries.</h1>
          <p>
            IRQGuard reads real C source with Clang, traces lock use across functions, and checks whether normal execution and modeled hardware interrupts can form an unresolvable dependency cycle.
          </p>
          <div className="guide-actions">
            {onWalkthrough && (
              <button className="button button-primary" onClick={onWalkthrough}>
                <Zap size={14} /> Interactive walkthrough
              </button>
            )}
            <button className="button button-secondary" onClick={onNew}>
              <Play size={14} /> Analyze C source
            </button>
            <button className="button button-secondary" onClick={onOpenWorkspace}>
              Explore demo graph <ArrowRight size={14} />
            </button>
          </div>
          <div className="guide-hero-meta">
            <span>C++ Clang LibTooling</span>
            <i />
            <span>Process & Hardirq contexts</span>
            <i />
            <span>Explicit uncertainty</span>
          </div>
        </div>
        <div className="guide-flow-art" aria-label="IRQGuard analysis architecture">
          <div className="guide-flow-caption">
            <span>ANALYSIS PATH</span>
            <strong>FROM C SOURCE TO REVIEWABLE EVIDENCE</strong>
          </div>
          {[
            ['01', 'Clang frontend', 'AST · CFG · source locations'],
            ['02', 'Function summaries', 'calls · lock events · IRQ state'],
            ['03', 'Context graph', 'process · hard IRQ · provenance'],
            ['04', 'Finding review', 'cycles · feasibility · uncertainty'],
          ].map(([number, title, detail], index) => (
            <div className="guide-flow-step" key={number}>
              <b>{number}</b>
              <span>
                <strong>{title}</strong>
                <small>{detail}</small>
              </span>
              {index < 3 && <ArrowRight size={14} />}
            </div>
          ))}
        </div>
      </section>

      {/* Research Grounding Callout */}
      <div className="guide-research-note">
        <BookOpen size={16} />
        <p>
          <strong>Research grounding.</strong> Inspired by concepts in Archerfish (USENIX Security 2024), IRQGuard is an independently built, deliberately scoped analyzer. It does not reproduce Archerfish or claim equivalent coverage.
        </p>
      </div>

      {/* Problem Section: Why Interrupt Boundaries Matter */}
      <section className="guide-problem-section" aria-labelledby="guide-problem-title">
        <div className="guide-problem-copy">
          <span className="eyebrow">THE FAILURE MODE</span>
          <h2 id="guide-problem-title">A lock order can change meaning at an interrupt boundary.</h2>
          <p>
            Process code may hold one spinlock when a hard IRQ arrives. If the handler then tries to acquire that same lock—or follows the reverse order of another path—the interrupted CPU can wait on work it cannot resume.
          </p>
          <p>
            IRQGuard connects acquisition order, handler registration, and interrupt-state evidence so the path can be inspected. A graph cycle remains a candidate until its conditions and assumptions are reviewed.
          </p>
          {onWalkthrough && (
            <div className="mt-3">
              <button className="text-button" onClick={onWalkthrough}>
                Launch step-by-step walkthrough <ArrowRight size={14} />
              </button>
            </div>
          )}
        </div>
        <figure className="guide-fixture-example">
          <figcaption>
            <span>CONTROLLED FIXTURE</span>
            <code>tests/fixtures/interrupts.c</code>
          </figcaption>
          <pre>
            <code>
              <span className="syntax-comment">/* process_cross_context */</span>{'\n'}
              spin_lock(&amp;cross_a);{'\n'}
              acquire_cross_b(); <span className="syntax-comment">/* helper takes cross_b */</span>{'\n\n'}
              <span className="syntax-comment">/* request_irq registered cross_handler */</span>{'\n'}
              spin_lock(&amp;cross_b);{'\n'}
              spin_lock(&amp;cross_a);
            </code>
          </pre>
          <div className="fixture-edge-sequence">
            <span>process: cross_a → cross_b</span>
            <ArrowRight size={13} />
            <span>hard IRQ: cross_b → cross_a</span>
          </div>
          <small>Locking excerpts from a regression fixture; not a confirmed Linux defect.</small>
        </figure>
      </section>

      {/* WORK ITEM 4: Clickable 5-step Pipeline Explainer */}
      <section className="guide-pipeline-section" aria-labelledby="guide-pipeline-title">
        <div className="section-title-wrap">
          <span className="eyebrow">ANALYSIS METHOD</span>
          <h2 id="guide-pipeline-title">How the analyzer builds and checks the graph</h2>
          <p>Select any stage in the five-step pipeline to see real before/after data extracted from the analyzer reports.</p>
        </div>

        {/* Clickable Pipeline Nav */}
        <div className="pipeline-tabs" role="tablist" aria-label="Analysis pipeline stages">
          {PIPELINE_STEPS.map((s, idx) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={activePipelineStep === idx}
              className={`pipeline-tab-btn ${activePipelineStep === idx ? 'active' : ''}`}
              onClick={() => setActivePipelineStep(idx)}
            >
              <span className="tab-num">{s.number}</span>
              <span className="tab-name">{s.shortLabel}</span>
            </button>
          ))}
        </div>

        {/* Selected Step Detail Card */}
        <div className="pipeline-step-card" role="tabpanel">
          <div className="pipeline-step-header">
            <div>
              <span className="step-badge">Stage {currentStep.number}</span>
              <h3>{currentStep.name}</h3>
            </div>
            <p className="step-summary">{currentStep.summary}</p>
          </div>

          <div className="pipeline-before-after-grid">
            <div className="code-card">
              <div className="code-card-header">
                <FileCode2 size={13} />
                <span>{currentStep.beforeLabel}</span>
              </div>
              <pre className="pipeline-code">
                <code>{currentStep.beforeCode}</code>
              </pre>
            </div>

            <div className="code-card">
              <div className="code-card-header">
                <GitBranch size={13} />
                <span>{currentStep.afterLabel}</span>
              </div>
              <pre className="pipeline-code">
                <code>{currentStep.afterCode}</code>
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* WORK ITEM 5: Finding Categories Explainer */}
      <section className="guide-categories-section" aria-labelledby="guide-categories-title">
        <div className="section-title-wrap">
          <span className="eyebrow">FINDING CLASSIFICATION</span>
          <h2 id="guide-categories-title">Four Explicit Finding Categories</h2>
          <p>
            Rather than producing ambiguous warnings or numeric confidence scores, IRQGuard assigns every cycle finding to one of four verifiable categories (defined in <code>docs/design-phase4.md</code>).
          </p>
        </div>

        <div className="categories-grid">
          <article className="category-card cat-order">
            <div className="category-card-header">
              <span className="cat-pill">candidate_lock_order_cycle</span>
              <h3>Lock-Order Candidate</h3>
            </div>
            <p className="cat-desc">
              A standard process-context dependency cycle (e.g. AB-BA order between normal threads) where no contradictory IRQ fact exists.
            </p>
            <div className="cat-example">
              <strong>Example from repo:</strong>
              <code>normal_ab()</code> acquires <code>normal_a → normal_b</code> while <code>normal_ba()</code> acquires <code>normal_b → normal_a</code> in <code>tests/fixtures/interrupts.c</code>.
            </div>
          </article>

          <article className="category-card cat-interrupt">
            <div className="category-card-header">
              <span className="cat-pill">interrupt_aware_candidate</span>
              <h3>Interrupt-Aware Candidate</h3>
            </div>
            <p className="cat-desc">
              A cross-context cycle where process-side state may permit hardirq preemption by a registered handler on the same CPU.
            </p>
            <div className="cat-example">
              <strong>Example from repo:</strong>
              Process holds <code>cross_a</code> with IRQs enabled; handler preempts on same CPU and acquires <code>cross_b → cross_a</code>.
            </div>
          </article>

          <article className="category-card cat-rejected">
            <div className="category-card-header">
              <span className="cat-pill">rejected_candidate</span>
              <h3>Rejected Candidate (Infeasible)</h3>
            </div>
            <p className="cat-desc">
              A counterfactual interrupt cycle formally rejected because local interrupts are definitely disabled at process acquisition.
            </p>
            <div className="cat-example">
              <strong>Example from repo:</strong>
              Process executes <code>local_irq_disable()</code> before acquiring <code>blocked_a</code>; hardirq cannot preempt on this CPU.
            </div>
          </article>

          <article className="category-card cat-inconclusive">
            <div className="category-card-header">
              <span className="cat-pill">inconclusive_analysis</span>
              <h3>Inconclusive Analysis</h3>
            </div>
            <p className="cat-desc">
              A cycle path includes an uncertain edge, such as a conditional IRQ-state or unresolved symbolic pointer alias.
            </p>
            <div className="cat-example">
              <strong>Example from repo:</strong>
              <code>ambiguous_a</code> & <code>ambiguous_b</code> where IRQs are conditionally disabled (<code>if (disable) local_irq_disable()</code>).
            </div>
          </article>
        </div>
      </section>

      {/* Implementation details */}
      <section className="guide-technology-section" aria-labelledby="guide-technology-title">
        <div>
          <span className="eyebrow">IMPLEMENTATION</span>
          <h2 id="guide-technology-title">Built around source structure and explainable graph facts.</h2>
          <p>
            The analyzer is C++17/20 and uses Clang LibTooling, AST traversal, and CFG information. Bounded interprocedural summaries carry lock effects across supported calls; directed graph analysis finds candidate cycles. React and TypeScript present reports, with a local Node.js API that invokes only the configured analyzer and allowed source paths.
          </p>
        </div>
        <dl>
          <div>
            <dt>Frontend</dt>
            <dd>Clang AST · CFG · macro locations</dd>
          </div>
          <div>
            <dt>Analysis</dt>
            <dd>Function summaries · lock graph · bounded feasibility</dd>
          </div>
          <div>
            <dt>Evidence</dt>
            <dd>Versioned JSON · source provenance · runtime traces</dd>
          </div>
        </dl>
      </section>

      {/* Scope summary with link to full Scope page */}
      <section className="guide-scope-section">
        <div className="guide-section-heading">
          <span className="eyebrow">MODELED SCOPE</span>
          <h2>Useful evidence, with boundaries made visible.</h2>
        </div>
        <div className="guide-scope-columns">
          <div>
            <h3><Check size={16} />Currently modeled</h3>
            <ul>
              <li>Selected mutex and spinlock APIs, including irqsave/irqrestore variants</li>
              <li>Resolvable request_irq/free_irq registration evidence</li>
              <li>Normal process and hard-IRQ contexts</li>
              <li>Interprocedural dependencies and selected indirect-call patterns</li>
              <li>Structured JSON, terminal output, and Graphviz export</li>
            </ul>
          </div>
          <div>
            <h3><Info size={16} />Known limitations</h3>
            <ul>
              <li>One requested translation unit at a time; not a whole-kernel analyzer</li>
              <li>Softirq, NMI, arbitrary aliases, and general Boolean path solving are outside the modeled subset</li>
              <li>Unknown calls, identities, and state transitions can affect conclusions</li>
              <li>Zero reported cycles is not proof of absence of deadlocks</li>
              <li>Kernel candidates require manual validation and independent evidence</li>
            </ul>
          </div>
        </div>
        {onScope && (
          <div className="mt-4 text-center">
            <button className="button button-secondary" onClick={onScope}>
              View full Scope & Tool Comparison table <ArrowRight size={14} />
            </button>
          </div>
        )}
      </section>

      {/* Evidence & Kernel Results Section */}
      <section className="guide-evidence-section">
        <div className="guide-section-heading">
          <span className="eyebrow">EVIDENCE, NOT CLAIMS</span>
          <h2>Static analysis and runtime experiments answer different questions.</h2>
        </div>
        <div className="guide-evidence-columns">
          <article>
            <Activity size={18} />
            <h3>Controlled userspace traces</h3>
            <p>
              Instrumented pthread examples record lock attempts, acquisitions, releases, ordering, and timeouts. A watchdog safely ends the intentional deadlock fixture. Traces do not emulate hardware interrupts.
            </p>
            <button className="text-button" onClick={onRuntime}>
              Explore runtime evidence <ArrowRight size={14} />
            </button>
          </article>
          <article>
            <HardDrive size={18} />
            <h3>Selected Linux source</h3>
            <p>
              Linux v6.6.87 e1000e evaluation analyzed five pinned files. The latest run processed {current ? `${current.files_analyzed}/${current.files_requested} files, ${current.functions} functions, and ${current.lock_operations} lock operations` : 'five files from a pinned revision'}; bounded object, objtool, and ORC checks ran, while the final module link and separate stack validation remain incomplete.
            </p>
            <button className="text-button" onClick={onKernel}>
              See measurements and build limits <ArrowRight size={14} />
            </button>
          </article>
        </div>
        <div className="guide-current-result">
          <span className="status-dot online" />
          <strong>Latest pinned kernel run</strong>
          <span>
            {Number(current?.lock_dependencies ?? 0)} dependencies · {Number(current?.candidate_cycles ?? 0)} candidate cycles · {Number(current?.uncertainty_events ?? 36330).toLocaleString()} uncertainty events · {Number(current?.unique_records ?? 4644).toLocaleString()} unique records
          </span>
          <small>
            {Number(current?.unique_root_causes ?? 2431).toLocaleString()} root causes after linking repeated IRQ-state effects. Zero cycles do not prove deadlock freedom; no independently labeled Linux bug set supports accuracy metrics.
          </small>
        </div>
      </section>

      {/* Footer Call-to-Action */}
      <section className="guide-close">
        <div>
          <span className="eyebrow">START HERE</span>
          <h2>Try the full workflow on a small C example.</h2>
          <p>Build the analyzer, run the command line, inspect JSON or a graph, then compare controlled runtime evidence.</p>
        </div>
        <div className="guide-actions">
          <button className="button button-primary" onClick={onCli}>
            <TerminalSquare size={14} /> Commands and reports
          </button>
          <button className="button button-secondary" onClick={onOpenWorkspace}>
            Open analysis workspace
          </button>
        </div>
      </section>
    </div>
  )
}
