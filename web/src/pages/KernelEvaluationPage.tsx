import { useMemo } from 'react'
import { AlertCircle, Info, LoaderCircle } from 'lucide-react'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from 'recharts'
import type { KernelEvaluation } from '../types'
import { DEMO_KERNEL_EVALUATION } from '../demo/demoData'

function basename(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function statusTone(status?: string) {
  if (status === 'completed' || status === 'matched' || status === 'succeeded' || status === 'passed' || status === 'analyzed') return 'good'
  if (status === 'running' || status === 'queued') return 'running'
  if (status === 'failed') return 'bad'
  return 'muted'
}

export function KernelEvaluationPage({
  evaluation: propEval,
  loading,
  error,
}: {
  evaluation: KernelEvaluation | null
  loading?: boolean
  error?: string
}) {
  const evaluation = propEval ?? DEMO_KERNEL_EVALUATION

  if (loading) {
    return (
      <div className="kernel-eval-state">
        <LoaderCircle className="spin" size={17} />
        Loading the Linux evaluation…
      </div>
    )
  }

  if (!evaluation) {
    return (
      <div className="kernel-eval-error">
        <div className="page-header">
          <div>
            <div className="eyebrow">KERNEL EVALUATION</div>
            <h1>Linux kernel evaluation</h1>
            <p className="page-caption">Analysis of selected files from a pinned Linux kernel revision.</p>
          </div>
        </div>
        <div className="alert alert-error" role="alert">
          <AlertCircle size={16} />
          <span>{error || 'Evaluation data is unavailable.'}</span>
        </div>
      </div>
    )
  }

  const { aggregate, kernel, configuration } = evaluation
  const current = evaluation.phase19_2_uncertainty?.after
  const uncertainty = evaluation.phase19_2_uncertainty
  const counts: Record<string, any> = current ?? aggregate
  const files = uncertainty?.per_file ?? evaluation.translation_units.map((unit) => ({
    source_file: unit.file,
    status: unit.status,
    elapsed_seconds: unit.elapsed_seconds,
    peak_memory_kib: unit.peak_rss_kib,
    functions: unit.counts.functions,
    lock_operations: unit.counts.lock_operations,
    lock_dependencies: unit.counts.lock_dependencies,
    interrupt_cycles: unit.counts.interrupt_cycles,
    uncertainties: unit.counts.uncertainties,
  }))
  const validations = current?.validation ?? {}

  const uncertaintyChartData = useMemo(() => {
    const categoryLabels: Record<string, { name: string; color: string }> = {
      interrupt_state: { name: 'Interrupt state', color: '#43c8df' },
      unresolved_call: { name: 'Unresolved call', color: '#5b9ff4' },
      unsupported_api: { name: 'Unsupported API', color: '#f59e0b' },
      lock_identity: { name: 'Lock identity', color: '#ff5b56' },
      handler_lifecycle: { name: 'Handler lifecycle', color: '#a78bfa' },
      control_flow: { name: 'Control flow', color: '#10b981' },
    }
    return Object.entries(current?.category_counts ?? {}).map(([category, value]: [string, any]) => ({
      name: categoryLabels[category]?.name ?? category,
      category,
      events: Number(value.event_count ?? 0),
      unique: Number(value.unique_record_count ?? 0),
      chartValue: Math.log10(Number(value.event_count ?? 0) + 1),
      color: categoryLabels[category]?.color ?? '#94a3b8',
    }))
  }, [current])

  const number = (value: unknown, fallback = 0) => Number(value ?? fallback).toLocaleString()
  const statusText = (value: unknown) => String(value ?? 'not recorded').replaceAll('_', ' ')

  return (
    <div className="kernel-evaluation-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">REAL SOURCE EVALUATION</div>
          <h1>Linux {kernel.release_tag} · {configuration.subsystem}</h1>
          <p className="page-caption">
            Five selected Intel <code>e1000e</code> driver files from commit <code>{kernel.commit.slice(0, 12)}</code>, analyzed with generated Kbuild compiler commands.
          </p>
        </div>
        <span className={`status-pill ${evaluation.status === 'completed' ? 'good' : 'muted'}`}>
          {evaluation.status}
        </span>
      </header>

      <div className="kernel-headline-banner">
        <div className="flex items-start gap-3">
          <Info size={20} className="text-accent flex-shrink-0 mt-0.5" />
          <div>
            <strong className="text-sm">Exploratory measurements, not a safety proof</strong>
            <p className="text-xs text-secondary mt-1 leading-relaxed">
              <strong>Zero cycles do not prove deadlock freedom.</strong> These five source files are not a labeled bug benchmark. The analysis reports {number(counts.uncertainty_events ?? counts.uncertainties)} uncertainty events. Unknown calls and callback effects remain conservative, and these results do not establish kernel-wide correctness.
            </p>
          </div>
        </div>
      </div>

      <section className="phase17-headline-kpis" aria-label="Current kernel results">
        <div className="kpi-card">
          <span className="kpi-label">Files Analyzed</span>
          <strong className="kpi-value">{current?.files_analyzed ?? aggregate.files_analyzed} / {current?.files_requested ?? aggregate.files_requested}</strong>
          <small className="kpi-sub">Clang translation units</small>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Functions</span>
          <strong className="kpi-value">{number(counts.functions)}</strong>
          <small className="kpi-sub">Extracted from source</small>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Lock Operations</span>
          <strong className="kpi-value">{number(counts.lock_operations)}</strong>
          <small className="kpi-sub">{number(counts.lock_acquisitions)} acquires · {number(counts.lock_releases)} releases</small>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Dependencies / Cycles</span>
          <strong className="kpi-value">{number(counts.lock_dependencies)} / {number(counts.candidate_cycles ?? counts.interrupt_cycles)}</strong>
          <small className="kpi-sub">No candidate cycles reported</small>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Uncertainty</span>
          <strong className="kpi-value text-warn">{number(counts.uncertainty_events ?? counts.uncertainties)}</strong>
          <small className="kpi-sub">{number(counts.unique_records)} records · {number(counts.unique_root_causes)} root causes</small>
        </div>
      </section>

      <section className="panel kernel-eval-panel" aria-labelledby="current-kernel-results-title">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">PINNED SOURCE · CURRENT ANALYSIS</div>
            <h2 id="current-kernel-results-title">Results by source file</h2>
          </div>
          <span className="runtime-scope">
            {current?.files_analyzed ?? files.length} files · {Number(current?.analysis_seconds ?? 0).toFixed(3)}s · {((Number(current?.peak_memory_kib ?? 0) / 1024)).toFixed(1)} MiB peak
          </span>
        </div>
        <div className="runtime-table-wrap">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th style={{ width: '26%', textAlign: 'left' }}>Linux Source File</th>
                <th>Status</th><th>Functions</th><th>Lock Ops</th><th>Dependencies</th><th>Cycles</th><th>Uncertainties</th><th>Time</th>
              </tr>
            </thead>
            <tbody>
              {files.map((item: any) => (
                <tr key={item.source_file ?? item.file}>
                  <td><code>{basename(String(item.source_file ?? item.file))}</code></td>
                  <td><span className={`status-pill ${statusTone(item.status)}`}>{item.status ?? 'analyzed'}</span></td>
                  <td>{item.functions ?? '—'}</td>
                  <td>{item.lock_operations ?? '—'}</td>
                  <td>{item.lock_dependencies ?? 0}</td>
                  <td>{item.interrupt_cycles ?? 0}</td>
                  <td>{number(item.uncertainties)}</td>
                  <td>{item.elapsed_seconds == null ? '—' : `${Number(item.elapsed_seconds).toFixed(2)}s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="phase17-caveat mt-3 text-xs text-dim">
          These are exploratory source measurements, not independently verified bug labels. No precision or recall is claimed. Userspace runtime tests do not emulate hardware interrupts.
        </p>
      </section>

      <section className="panel uncertainty-explainer-panel" aria-labelledby="current-uncertainty-title">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">CURRENT UNCERTAINTY SUMMARY</div>
            <h2 id="current-uncertainty-title">Why the analyzer remains uncertain</h2>
          </div>
          <span className="runtime-scope">{number(counts.unique_root_causes)} unique root causes</span>
        </div>
        <p className="text-secondary text-sm">
          The analyzer keeps unsupported effects visible instead of assuming they are safe. {number(counts.paired_irq_effect_records)} IRQ-state records are linked to unresolved-call root causes as secondary effects.
        </p>
        <div className="uncertainty-explainer-grid">
          <div className="runtime-table-wrap">
            <table className="data-table w-full">
              <thead><tr><th>Category</th><th>Events</th><th>Unique records</th></tr></thead>
              <tbody>
                {uncertaintyChartData.map((item) => (
                  <tr key={item.category}><td>{item.name}</td><td>{number(item.events)}</td><td>{number(item.unique)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="uncertainty-chart-box">
            <span className="text-xs font-semibold text-dim block mb-2">Events by category · logarithmic scale</span>
            <div style={{ width: '100%', height: 230 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={uncertaintyChartData} margin={{ top: 10, right: 10, left: -20, bottom: 25 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2d3540" />
                  <XAxis dataKey="name" stroke="#8994a3" fontSize={10} interval={0} angle={-25} textAnchor="end" />
                  <YAxis
                    stroke="#8994a3"
                    fontSize={10}
                    domain={[0, 'dataMax']}
                    tickFormatter={(value: number) => value === 0 ? '0' : `${Math.round(10 ** value - 1).toLocaleString()}`}
                  />
                  <Tooltip formatter={(_value: any, _name: any, item: any) => [`${Number(item.payload.events).toLocaleString()} events`, item.payload.name]} />
                  <Bar dataKey="chartValue" radius={[3, 3, 0, 0]}>
                    {uncertaintyChartData.map((item, index) => <Cell key={`${item.category}-${index}`} fill={item.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
        <div className="phase17-detail-grid mt-3">
          <div>
            <strong>Most frequent unresolved calls</strong>
            {uncertainty?.largest_remaining_unresolved_calls.map((item: any) => (
              <small key={`${item.api}-${item.source_file}-${item.line}`}>
                <code>{item.api}</code> · {item.source_file}:{item.line} · {number(item.events)} events · {item.affected_functions} functions
              </small>
            ))}
          </div>
          <div>
            <strong>Analysis limits</strong>
            <small>{uncertainty?.classification_note ?? 'Repeated effects remain linked to the underlying uncertainty where the analyzer can identify the cause.'}</small>
            <small>{uncertainty?.interpretation ?? 'This selected source run does not establish that the wider kernel is free of deadlocks.'}</small>
            <small>{number(counts.parser_diagnostics)} parser diagnostics were recorded.</small>
          </div>
        </div>
      </section>

      <section className="panel phase12-validation" aria-labelledby="kernel-validation-title">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">BUILD VALIDATION</div>
            <h2 id="kernel-validation-title">What the kernel build checked</h2>
          </div>
          <span className="status-pill muted">bounded subsystem validation</span>
        </div>
        <div className="runtime-table-wrap">
          <table className="data-table w-full"><tbody>
            <tr><th>Kernel object compilation</th><td>{statusText(validations.kernel_object_compilation)}</td></tr>
            <tr><th>Objtool checks</th><td>{statusText(validations.objtool_object_checks)}</td></tr>
            <tr><th>ORC sections generated</th><td>{statusText(validations.orc_sections_present)}</td></tr>
            <tr><th>Final module link</th><td>{statusText(validations.kernel_module_link)}</td></tr>
            <tr><th>Separate stack validation</th><td>{statusText(validations.stack_validation)}</td></tr>
          </tbody></table>
        </div>
        <p className="phase12-validation-note">
          The selected driver object was compiled and checked. The final module link and a separate stack-validation run were not completed.
        </p>
      </section>
    </div>
  )
}
