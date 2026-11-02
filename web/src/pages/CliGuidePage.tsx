import { useState } from 'react'
import { AlertCircle, Check, Copy } from 'lucide-react'

export function CliGuidePage() {
  const [copied, setCopied] = useState('')
  const [copyError, setCopyError] = useState('')

  const commands = [
    {
      title: 'Analyze C source',
      detail: 'Parse real C with Clang and print the readable report.',
      command: './irqguard analyze --source examples/basic.c',
    },
    {
      title: 'Export JSON',
      detail: 'Write schema-v4 facts, dependency edges, locations, findings, and grouped uncertainty records.',
      command: './irqguard analyze --source examples/basic.c --format json --output /tmp/basic.json',
    },
    {
      title: 'Export Graphviz',
      detail: 'Generate a dependency graph that can be opened with Graphviz.',
      command: './irqguard graph --source tests/fixtures/interrupts.c --output /tmp/interrupts.dot',
    },
    {
      title: 'Validate API registry',
      detail: 'Check custom API names, event kinds, and argument indexes.',
      command: './irqguard api-registry validate --config config/apis.example.json',
    },
    {
      title: 'Run runtime evidence',
      detail: 'Run a controlled userspace scenario; this does not emulate kernel IRQs.',
      command: './irqguard runtime run --scenario deadlock --timeout 1.5 --trace /tmp/deadlock.jsonl',
    },
    {
      title: 'Measure runtime overhead',
      detail: 'Compare the wrapped pthread loop with its uninstrumented baseline.',
      command: './irqguard benchmark runtime --iterations 1000 --repeats 5 --output /tmp/overhead.json',
    },
    {
      title: 'Run the pinned-source evaluation',
      detail: 'Evaluate the Phase 17 dataset and validate the Linux v6.6.87 source pin.',
      command:
        'python3 evaluation/run_phase17.py --analyzer build/deadlock-analyzer --kernel third_party/linux-v6.6.87 --output evaluation/results/phase17-rerun',
    },
  ]

  const copyCommand = async (title: string, command: string) => {
    setCopyError('')
    try {
      await navigator.clipboard.writeText(command)
      setCopied(title)
    } catch {
      setCopyError('Clipboard access is unavailable here. Select and copy the command text instead.')
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">COMMAND LINE WORKFLOW</div>
          <h1>CLI & report guide</h1>
          <p className="page-caption">The command line is the primary interface. The GUI is an optional view over analysis and evidence.</p>
        </div>
      </div>

      <div className="cli-guide-layout">
        <section className="cli-command-list" aria-label="IRQGuard commands">
          {commands.map((item) => (
            <article className="cli-command" key={item.title}>
              <div className="cli-command-heading">
                <div>
                  <h2>{item.title}</h2>
                  <p>{item.detail}</p>
                </div>
                <button
                  type="button"
                  className="icon-button cli-copy"
                  onClick={() => void copyCommand(item.title, item.command)}
                  aria-label={`Copy ${item.title} command`}
                >
                  {copied === item.title ? <Check size={15} /> : <Copy size={15} />}
                </button>
              </div>
              <pre>
                <code>{item.command}</code>
              </pre>
            </article>
          ))}
          {copyError && (
            <p className="cli-copy-error" role="status">
              {copyError}
            </p>
          )}
        </section>

        <aside className="cli-guide-aside">
          <section className="cli-note">
            <span className="eyebrow">REPORT CONTRACT</span>
            <strong>Schema v4 · archived v3 supported</strong>
            <p>
              JSON includes extracted functions, calls, lock operations, dependencies, IRQ contexts, findings, source locations, uncertainty, and diagnostics.
            </p>
          </section>
          <section className="cli-note">
            <span className="eyebrow">FINDING CATEGORIES AND FEASIBILITY</span>
            <dl>
              <dt>Lock-order candidate</dt>
              <dd>Process-context dependency cycle. Feasibility may remain unestablished.</dd>
              <dt>Interrupt-aware candidate</dt>
              <dd>Cycle involving modeled hardirq preemption and registration evidence.</dd>
              <dt>Potentially feasible</dt>
              <dd>Supported CFG paths are compatible; static assumptions remain.</dd>
              <dt>Rejected candidate</dt>
              <dd>A documented supported path or IRQ-state constraint excludes the cycle.</dd>
              <dt>Inconclusive</dt>
              <dd>Unresolved identity, conditions, summary effects, or lifecycle prevent a decision.</dd>
            </dl>
            <p>No static classification confirms a runtime deadlock.</p>
          </section>
          <section className="cli-caveat">
            <AlertCircle size={15} />
            <p>
              A candidate is not a confirmed deadlock, and IRQGuard does not report a severity score. The Phase 15 extraction regression evidence found both `spin_lock_irqsave` acquisitions with matching symbolic lock and saved-flags identities; the Phase 17 pinned-source run reports 89 unresolved lock-identity records across the selected files. No dependency edges or cycles were reported in that selected run; this does not prove the driver is deadlock-free. Kernel object/objtool/ORC checks were bounded; the final module and full kernel were not built.
            </p>
          </section>
        </aside>
      </div>
    </>
  )
}
