import { useState, useEffect, useCallback } from 'react'
import {
  Activity,
  AlertCircle,
  Gauge,
  GitBranch,
  Info,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  Play,
  RefreshCw,
  ShieldAlert,
  Timer,
  X,
} from 'lucide-react'
import type { AnalysisMetadata, Health, RuntimeEvidence, RuntimeRun } from '../types'
import {
  compareRuntimeEvidence,
  getRuntimeEvidence,
  getRuntimeRuns,
  startRuntimeBenchmark,
  startRuntimeScenario,
} from '../api'

function basename(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function statusTone(status?: string) {
  if (status === 'completed' || status === 'matched' || status === 'succeeded' || status === 'passed') return 'good'
  if (status === 'running' || status === 'queued') return 'running'
  if (status === 'failed') return 'bad'
  return 'muted'
}

export function RuntimeEvidencePage({
  mode,
  health,
  history,
  activeAnalysis,
}: {
  mode: 'runtime' | 'benchmarks'
  health: Health | null
  history: AnalysisMetadata[]
  activeAnalysis: AnalysisMetadata | null
}) {
  const [runs, setRuns] = useState<RuntimeRun[]>([])
  const [selected, setSelected] = useState<RuntimeEvidence | null>(null)
  const [scenario, setScenario] = useState('deadlock')
  const [analysisId, setAnalysisId] = useState(
    activeAnalysis?.status === 'completed' ? activeAnalysis.id : history.find((item) => item.status === 'completed')?.id ?? ''
  )
  const [mapping, setMapping] = useState('{}')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const available = health?.runtime_evidence_available === true

  const refresh = useCallback(async () => {
    try {
      const list = await getRuntimeRuns()
      setRuns(list)
      if (selected) {
        const current = list.find((item) => item.id === selected.run.id)
        if (current && current.status !== selected.run.status) {
          setSelected(await getRuntimeEvidence(current.id))
        }
      }
      return list
    } catch (e: any) {
      return []
    }
  }, [selected])

  useEffect(() => {
    void refresh().catch((error) => setMessage(error.message))
  }, [])

  useEffect(() => {
    if (!runs.some((item) => item.status === 'running')) return
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [refresh, runs])

  const launchScenario = async () => {
    setBusy(true)
    setMessage('')
    try {
      const started = await startRuntimeScenario(scenario)
      setRuns((old) => [started, ...old])
      setSelected(await getRuntimeEvidence(started.id))
      setMessage(`Started ${scenario} scenario. Results are written to local runtime history.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not start runtime scenario.')
    } finally {
      setBusy(false)
    }
  }

  const launchBenchmark = async () => {
    setBusy(true)
    setMessage('')
    try {
      const started = await startRuntimeBenchmark()
      setRuns((old) => [started, ...old])
      setSelected(await getRuntimeEvidence(started.id))
      setMessage('Benchmark started. It compares the instrumented and baseline mutex-pair loops.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not start benchmark.')
    } finally {
      setBusy(false)
    }
  }

  const openRun = async (run: RuntimeRun) => {
    try {
      setSelected(await getRuntimeEvidence(run.id))
      setMessage('')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load runtime run.')
    }
  }

  const compare = async () => {
    if (!selected || selected.run.kind !== 'scenario' || !analysisId) return
    setBusy(true)
    setMessage('')
    try {
      const parsed = JSON.parse(mapping)
      const result = await compareRuntimeEvidence({
        analysis_id: analysisId,
        runtime_run_ids: [selected.run.id],
        static_to_runtime: parsed,
      })
      setRuns((old) => [result.run, ...old])
      setSelected(await getRuntimeEvidence(result.run.id))
      setMessage('Static/runtime comparison saved.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Comparison input must be a JSON object.')
    } finally {
      setBusy(false)
    }
  }

  const summary = selected?.summary
  const benchmark = selected?.benchmark
  const comparison = selected?.comparison

  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">{mode === 'runtime' ? 'CONTROLLED USERSPACE TRACES' : 'MEASURED OVERHEAD'}</div>
          <h1>{mode === 'runtime' ? 'Runtime evidence' : 'Benchmarks'}</h1>
          <p className="page-caption">
            {mode === 'runtime'
              ? 'Run the bundled pthread harness, inspect structured events, and compare observations with a static report.'
              : 'Measure wrapper and trace logging cost against the same uninstrumented mutex-pair workload.'}
          </p>
        </div>
        {mode === 'benchmarks' && (
          <button className="button button-primary" disabled={!available || busy} onClick={() => void launchBenchmark()}>
            <Gauge size={14} /> Run benchmark
          </button>
        )}
      </div>

      {!available && (
        <div className="inline-notice">
          <AlertCircle size={16} />
          <span>Runtime tools are unavailable. Configure and build the project with CMake to enable the controlled userspace harness.</span>
        </div>
      )}

      {message && (
        <div className="inline-notice runtime-message" role="status">
          <Info size={15} />
          <span>{message}</span>
          <button className="icon-button" aria-label="Dismiss message" onClick={() => setMessage('')}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="runtime-layout">
        <section className="runtime-primary">
          {mode === 'runtime' && (
            <div className="panel runtime-control">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">CONTROLLED FIXTURE</div>
                  <h2>Collect a runtime trace</h2>
                </div>
                <span className="runtime-scope">
                  <Activity size={13} /> Userspace pthreads
                </span>
              </div>
              <div className="runtime-control-row">
                <label className="field-label" htmlFor="runtime-scenario">
                  Scenario
                  <select id="runtime-scenario" value={scenario} onChange={(event) => setScenario(event.target.value)}>
                    <option value="safe">Safe lock order</option>
                    <option value="contention">Concurrent contention</option>
                    <option value="deadlock">Reproducible deadlock</option>
                    <option value="opposite-order">Opposite order · sequential</option>
                    <option value="reverse-only">Reverse order only</option>
                    <option value="static-only">Static candidate · unexercised</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={!available || busy}
                  onClick={() => void launchScenario()}
                >
                  {busy ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />} Run scenario
                </button>
              </div>
              <p className="runtime-caveat">
                <Info size={14} /> The deadlock fixture runs in a disposable process group. A watchdog kills it after the selected timeout; this does not model hardware interrupts.
              </p>
            </div>
          )}

          {mode === 'benchmarks' && (
            <div className="panel runtime-control">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">INSTRUMENTATION COST</div>
                  <h2>Baseline vs instrumented</h2>
                </div>
                <span className="runtime-scope">
                  <Timer size={13} /> Process timing
                </span>
              </div>
              <p className="runtime-caveat benchmark-note">
                Each sample runs the same lock-pair loop. Results include event serialization, synchronization, and flush costs and are specific to this machine.
              </p>
            </div>
          )}

          {mode === 'runtime' && selected?.run.kind === 'scenario' && summary && (
            <>
              <div className="metrics-row runtime-metrics">
                <div className="metric">
                  <div className="metric-head">
                    <span>Trace events</span>
                    <Activity size={15} />
                  </div>
                  <strong>{summary.event_count ?? '—'}</strong>
                  <small>Structured JSONL records</small>
                </div>
                <div className="metric">
                  <div className="metric-head">
                    <span>Threads</span>
                    <ListChecks size={15} />
                  </div>
                  <strong>{summary.thread_count ?? '—'}</strong>
                  <small>Observed in this process</small>
                </div>
                <div className="metric">
                  <div className="metric-head">
                    <span>Contention</span>
                    <LockKeyhole size={15} />
                  </div>
                  <strong>{summary.observed_contention_count ?? '—'}</strong>
                  <small>trylock returned EBUSY</small>
                </div>
                <div className="metric">
                  <div className="metric-head">
                    <span>Termination</span>
                    <ShieldAlert size={15} />
                  </div>
                  <strong className="runtime-status-text">
                    {summary.deadlock_reproduction === 'watchdog_timeout_with_persistent_wait_for_cycle'
                      ? 'Reproduced'
                      : summary.termination ?? '—'}
                  </strong>
                  <small>Bounded fixture result</small>
                </div>
              </div>

              <section className="panel runtime-result">
                <div className="panel-heading">
                  <div>
                    <div className="eyebrow">SELECTED TRACE</div>
                    <h2>
                      {selected.run.scenario}{' '}
                      <span className={`status-pill ${statusTone(selected.run.status)}`}>{selected.run.status}</span>
                    </h2>
                  </div>
                  <code>{selected.run.id.slice(0, 12)}</code>
                </div>
                <div className="runtime-provenance">
                  <span>Observed in controlled userspace process</span>
                  <span>Run ID <code>{summary.run_id ?? selected.run.id}</code></span>
                  <span>Created {new Date(selected.run.created_at).toLocaleString()}</span>
                  <span>Trace schema {summary.trace_schema_version ?? 'not reported'} · JSONL lock wrappers</span>
                </div>
                <div className="runtime-interpretation">
                  {summary.interpretation ?? 'Summary is still being collected.'}
                </div>
                {!!summary.terminal_wait_for_cycles?.length && (
                  <div className="runtime-cycle">
                    <strong>Persistent wait-for cycle</strong>
                    {summary.terminal_wait_for_cycles.map((cycle: any, index: number) => (
                      <div key={index}>
                        <code>{cycle.threads?.join(' → ')}</code>
                        <span>Locks: {(cycle.locks_involved ?? []).join(', ')}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="runtime-event-heading">
                  <strong>Event trace</strong>
                  <span>{selected.events.length} shown · latest 5,000 · monotonic clock</span>
                </div>
                <div className="runtime-table-wrap">
                  <table className="data-table runtime-event-table">
                    <thead>
                      <tr>
                        <th>Sequence</th>
                        <th>Event</th>
                        <th>Thread</th>
                        <th>Lock</th>
                        <th>Monotonic time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.events.map((event, index) => (
                        <tr key={`${event.sequence}-${index}`}>
                          <td>{event.sequence ?? '—'}</td>
                          <td>
                            <span className={`event-kind event-${event.event}`}>
                              {String(event.event ?? 'unknown').replaceAll('_', ' ')}
                            </span>
                          </td>
                          <td>{event.thread_id ?? '—'}</td>
                          <td>
                            <code>{event.lock_id ?? 'unresolved'}</code>
                          </td>
                          <td>{event.timestamp_monotonic_ns ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!selected.events.length && (
                    <div className="panel-empty">
                      {selected.run.status === 'running'
                        ? 'Trace events are still being collected.'
                        : 'No structured trace events were recorded for this run.'}
                    </div>
                  )}
                </div>
              </section>

              {selected.run.kind === 'scenario' && (
                <section className="panel runtime-compare">
                  <div className="panel-heading">
                    <div>
                      <div className="eyebrow">STATIC / RUNTIME COMPARISON</div>
                      <h2>Compare with a static candidate</h2>
                    </div>
                  </div>
                  <div className="runtime-compare-form">
                    <label className="field-label">
                      Static analysis
                      <select value={analysisId} onChange={(event) => setAnalysisId(event.target.value)}>
                        {history
                          .filter((item) => item.status === 'completed')
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {basename(item.source_path)} · {item.id.slice(0, 8)}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="field-label mapping-field">
                      Exact lock identity map
                      <textarea
                        aria-label="Exact static to runtime lock identity map"
                        spellCheck={false}
                        value={mapping}
                        onChange={(event) => setMapping(event.target.value)}
                        placeholder={'{\n  "exact static lock identity": "A"\n}'}
                      />
                    </label>
                    <div className="runtime-caveat">
                      <Info size={14} /> Map each static lock identity exactly to runtime IDs such as A, B, C, or D. Unobserved candidates remain unproven, not disproved.
                    </div>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={!analysisId || busy}
                      onClick={() => void compare()}
                    >
                      <GitBranch size={14} /> Compare selected trace
                    </button>
                  </div>
                </section>
              )}
            </>
          )}

          {mode === 'benchmarks' && benchmark && (
            <section className="panel runtime-result">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">BENCHMARK REPORT</div>
                  <h2>Instrumentation overhead</h2>
                </div>
                <span className="status-pill good">Measured</span>
              </div>
              <div className="benchmark-metrics">
                <div>
                  <span>Baseline median</span>
                  <strong>{Number(benchmark.median_ns?.baseline ?? 0).toLocaleString()} ns</strong>
                </div>
                <div>
                  <span>Instrumented median</span>
                  <strong>{Number(benchmark.median_ns?.instrumented ?? 0).toLocaleString()} ns</strong>
                </div>
                <div>
                  <span>Overhead</span>
                  <strong>
                    {typeof benchmark.overhead_percent === 'number'
                      ? `${benchmark.overhead_percent.toFixed(1)}%`
                      : 'Not available'}
                  </strong>
                </div>
              </div>
              <p className="runtime-caveat">{benchmark.limitations}</p>
              <pre className="benchmark-environment">{JSON.stringify(benchmark.environment, null, 2)}</pre>
            </section>
          )}

          {mode === 'runtime' && comparison && (
            <section className="panel runtime-result">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">STATIC / RUNTIME ASSOCIATION</div>
                  <h2>Mapped candidates and observed events</h2>
                </div>
                <span className="runtime-scope">{comparison.run_count ?? 0} controlled runs</span>
              </div>
              <div className="runtime-interpretation">
                Scope: {comparison.runtime_scope ?? 'runtime scope not reported'}.{' '}
                {comparison.interpretation ?? 'Observations apply only to the supplied traces.'}
              </div>
              {Array.isArray(comparison.findings) && comparison.findings.length ? (
                <div className="comparison-findings">
                  {comparison.findings.map((finding: any) => (
                    <article className="comparison-row evidence-comparison-row" key={finding.finding_id}>
                      <span>{finding.finding_id}</span>
                      <strong>
                        {finding.runtime_status === 'watchdog_deadlock_reproduced_in_controlled_process'
                          ? 'Watchdog reproduced a persistent wait-for cycle in this test process'
                          : String(finding.runtime_status ?? 'status unavailable').replaceAll('_', ' ')}
                      </strong>
                      <small>Static category: {finding.category ?? 'not reported'}</small>
                      {finding.static_lock_sequence && (
                        <code>Locks: {finding.static_lock_sequence.join(' → ')}</code>
                      )}
                      <p>{finding.explanation ?? 'No interpretation supplied.'}</p>
                      {finding.runs?.map((item: any, index: number) => (
                        <small className="runtime-run-provenance" key={`${item.run_id}-${index}`}>
                          Run {item.run_id ?? 'unknown'} · {item.scenario ?? 'scenario unavailable'} ·{' '}
                          {item.matched_order_edges?.length ?? 0}/{item.required_order_edges?.length ?? 0} order edges observed ·{' '}
                          {item.deadlock_reproduction ?? 'no reproduction claim'}
                        </small>
                      ))}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="panel-empty">No static candidates were attached to this comparison.</div>
              )}
              <p className="runtime-caveat">
                A watchdog reproduction applies to this controlled userspace process. It does not confirm a kernel deadlock. Missing observations do not disprove static candidates, and hard-IRQ findings are marked not comparable.
              </p>
            </section>
          )}
        </section>

        <aside className="panel runtime-history">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">LOCAL RECORDS</div>
              <h2>Recent evidence</h2>
            </div>
            <button className="icon-button" aria-label="Refresh runtime records" onClick={() => void refresh()}>
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="runtime-run-list">
            {runs
              .filter((run) => (mode === 'runtime' ? run.kind !== 'benchmark' : run.kind === 'benchmark'))
              .map((run) => (
                <button
                  key={run.id}
                  className={`runtime-run-item ${selected?.run.id === run.id ? 'selected' : ''}`}
                  onClick={() => void openRun(run)}
                >
                  <span className={`status-dot status-${statusTone(run.status)}`} />
                  <span>
                    <strong>{run.kind === 'scenario' ? run.scenario : run.kind}</strong>
                    <small>{new Date(run.created_at).toLocaleString()}</small>
                  </span>
                  <span className={`status-pill ${statusTone(run.status)}`}>{run.status}</span>
                </button>
              ))}
            {!runs.some((run) => (mode === 'runtime' ? run.kind !== 'benchmark' : run.kind === 'benchmark')) && (
              <div className="panel-empty">
                No {mode === 'runtime' ? 'runtime runs' : 'benchmark runs'} yet.
              </div>
            )}
          </div>
          {selected?.run.error && (
            <div className="runtime-error">
              <AlertCircle size={14} />
              {selected.run.error}
            </div>
          )}
        </aside>
      </div>
    </>
  )
}

