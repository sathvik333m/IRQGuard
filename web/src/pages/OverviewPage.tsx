import { Suspense, useMemo, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
  Braces,
  Check,
  Clock3,
  FileCode2,
  GitBranch,
  Info,
  LoaderCircle,
  LockKeyhole,
  Play,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react'
import type { AnalysisMetadata, AnalysisReport, Finding, Health } from '../types'
import { LockGraph } from '../components/LockGraph'
import { LoadExampleButton } from '../components/DemoBadge'

function basename(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function statusTone(status?: string) {
  if (status === 'completed' || status === 'matched' || status === 'succeeded' || status === 'passed') return 'good'
  if (status === 'running' || status === 'queued') return 'running'
  if (status === 'failed') return 'bad'
  return 'muted'
}

function categoryLabel(category: string) {
  if (category === 'candidate_lock_order_cycle') return 'Lock-order candidate'
  if (category === 'interrupt_aware_candidate') return 'Interrupt-aware candidate'
  if (category === 'rejected_candidate') return 'Rejected candidate'
  if (category === 'inconclusive_analysis') return 'Inconclusive'
  return category.replaceAll('_', ' ')
}

function formatDuration(duration?: number | null) {
  if (duration == null) return 'Not available'
  if (duration < 1000) return `${duration} ms`
  return `${(duration / 1000).toFixed(1)} s`
}

function shortLock(lock: string) {
  if (!lock) return 'Unknown lock'
  const named = lock.match(/:([^:)]+)\)?$/)?.[1]
  if (named) return named
  const suffix = lock.split('/').at(-1) ?? lock
  return suffix.length > 30 ? `${suffix.slice(0, 27)}…` : suffix
}

function locationOf(value: { expansion?: { file?: string; line?: number; valid?: boolean } } | undefined) {
  const point = value?.expansion
  if (!point?.valid || !point.file || !point.line) return null
  return { file: point.file, line: point.line }
}

function findingId(finding: Finding, index: number, analysisId?: string) {
  return finding.finding_id ?? `${analysisId?.slice(0, 8) ?? 'finding'}-${String(index + 1).padStart(3, '0')}`
}

export function OverviewPage({
  active,
  report,
  history,
  health,
  loading,
  isDemoMode,
  onLoadExample,
  onNew,
  onOpenHistory,
  onOpenGuide,
  onOpenFinding,
  onOpenGraph,
  onSelectAnalysis,
  selectedFinding,
  onSelectFinding,
  onOpenSource,
}: {
  active: AnalysisMetadata | null
  report: AnalysisReport | null
  history: AnalysisMetadata[]
  health: Health | null
  loading: boolean
  isDemoMode?: boolean
  onLoadExample?: () => void
  onNew: () => void
  onOpenHistory: () => void
  onOpenGuide: () => void
  onOpenFinding: (index: number) => void
  onOpenGraph: () => void
  onSelectAnalysis: (item: AnalysisMetadata) => void
  selectedFinding: Finding | null
  onSelectFinding: (finding: Finding | null) => void
  onOpenSource: (file: string, line: number) => void
}) {
  const summary = active?.summary
  const completed = active?.status === 'completed' && report
  const metrics = [
    { label: 'Translation units', value: summary?.translation_units, icon: FileCode2, tone: 'cyan', note: 'Submitted C units' },
    { label: 'Functions', value: summary?.functions, icon: Braces, tone: 'green', note: 'Definitions extracted' },
    { label: 'Lock operations', value: summary?.lock_operations, icon: LockKeyhole, tone: 'amber', note: 'API events observed' },
    { label: 'Dependencies', value: summary?.graph_edges, icon: GitBranch, tone: 'violet', note: 'Directed graph edges' },
    { label: 'Potential cycles', value: summary?.candidate_cycles, icon: ShieldAlert, tone: 'red', note: 'Static candidates' },
    { label: 'Analysis time', value: active?.duration_ms == null ? undefined : formatDuration(active.duration_ms), icon: Clock3, tone: 'blue', note: 'Backend measured' },
  ]
  const graphSize = report?.interrupt_lock_graph.edges.length ?? 0

  return (
    <>
      <div className="overview-project-strip">
        <div>
          <span className="eyebrow">INTERRUPT-AWARE STATIC ANALYSIS</span>
          <p>IRQGuard traces lock operations from C source into interprocedural dependencies and checks them against a scoped hard-IRQ model.</p>
        </div>
        <button className="text-button" onClick={onOpenGuide}>
          How the project works <ArrowRight size={14} />
        </button>
      </div>

      <div className="observatory-heading">
        <div>
          <div className="eyebrow">IRQGUARD / LOCAL WORKSPACE</div>
          <h1>Kernel lock observatory</h1>
          <p>{active ? active.source_path : 'Analyze a C translation unit to explore lock dependencies and interrupt contexts.'}</p>
        </div>
        <div className="observatory-heading-actions">
          <span className={`status-pill ${statusTone(active?.status)}`}>
            <i className={`status-dot status-${statusTone(active?.status)}`} />
            {active?.status ?? 'No run selected'}
          </span>
          <button className="button button-primary" onClick={onNew}>
            <Play size={14} /> New analysis
          </button>
        </div>
      </div>

      {!health?.analyzer_available && !isDemoMode && (
        <div className="inline-notice">
          <AlertCircle size={16} />
          <span>The local analyzer executable is unavailable. Build it with CMake or load a bundled demo report.</span>
          {onLoadExample && <LoadExampleButton onLoadExample={onLoadExample} variant="link" label="Load bundled demo" />}
        </div>
      )}

      {active?.status === 'failed' && (
        <div className="alert alert-error" role="alert">
          <AlertCircle size={16} />
          <span>{active.error ?? 'The analyzer did not produce a report.'}</span>
        </div>
      )}

      {loading && (
        <div className="loading-line">
          <LoaderCircle size={16} className="spin" />
          Loading report…
        </div>
      )}

      {!active && history.length === 0 && !loading ? (
        <div className="empty-workspace">
          <div className="empty-glyph">
            <TerminalSquare size={24} />
          </div>
          <div className="eyebrow">NO ANALYSIS RUNS</div>
          <h2>Start with a C source file</h2>
          <p>IRQGuard invokes the Clang-based analyzer on your WSL workspace and stores the resulting JSON report locally.</p>
          <div className="flex items-center gap-3 mt-3">
            <button className="button button-primary" onClick={onNew}>
              <Play size={15} /> Run your first analysis
            </button>
            {onLoadExample && (
              <LoadExampleButton onLoadExample={onLoadExample} label="Load bundled example" />
            )}
          </div>
          <div className="empty-help">
            <Info size={14} />
            Enter an absolute Linux path inside an allowed workspace.
          </div>
        </div>
      ) : null}

      {active && !completed && !loading && active.status !== 'failed' && (
        <div className="empty-workspace compact-empty">
          <div className="empty-glyph">
            <LoaderCircle size={23} className="spin" />
          </div>
          <div className="eyebrow">ANALYSIS {active.status.toUpperCase()}</div>
          <h2>Waiting for the analyzer</h2>
          <p>The local service reports status without percentage progress. This run remains available in history.</p>
        </div>
      )}

      {completed && (
        <>
          <section className="metrics-row observatory-metrics" aria-label="Analysis metrics">
            {metrics.map(({ label, value, icon: Icon, tone, note }) => (
              <div className={`metric metric-${tone}`} key={label}>
                <div className="metric-head">
                  <span>{label}</span>
                  <Icon size={15} />
                </div>
                <strong>{value == null ? 'Not available' : typeof value === 'number' ? value.toLocaleString() : value}</strong>
                <small>{note}</small>
              </div>
            ))}
          </section>

          <section className="observatory-workspace">
            <div className="panel observatory-graph-panel">
              <div className="observatory-panel-heading">
                <div>
                  <div className="eyebrow">REPORT · SCHEMA {report.schema_version}</div>
                  <h2>
                    <GitBranch size={17} /> Lock Dependency Graph
                  </h2>
                  <p>Actual lock relationships across the analyzer’s modeled execution contexts</p>
                </div>
                <div className="graph-heading-actions">
                  <span className="graph-edge-count">
                    <strong>{graphSize.toLocaleString()}</strong> edges
                  </span>
                  <button className="text-button" onClick={onOpenGraph}>
                    Full graph <ArrowUpRight size={14} />
                  </button>
                </div>
              </div>

              <div className="observatory-legend">
                <span><i className="legend-line normal-line" />Normal context</span>
                <span><i className="legend-line irq-line" />Interrupt relationship</span>
                <span><i className="legend-line candidate-line" />Selected candidate</span>
                <span><i className="legend-line rejected-line" />Rejected edge</span>
              </div>

              <div className="observatory-graph-canvas">
                <Suspense fallback={<div className="graph-loading"><LoaderCircle size={16} className="spin" />Loading report graph…</div>}>
                  <LockGraph
                    report={report}
                    selectedFinding={selectedFinding}
                    onSelectFinding={onSelectFinding}
                    onOpenSource={onOpenSource}
                    compact
                  />
                </Suspense>
              </div>

              <div className="graph-preview-foot">
                <span>{report.interrupt_lock_graph.nodes.length.toLocaleString()} lock nodes</span>
                <span>{report.interrupt_cycles.length.toLocaleString()} findings</span>
                <span>Lock type metadata: {report.api_operations.some((item) => item.api) ? 'API labels available' : 'Not reported'}</span>
                <button className="text-button" onClick={onOpenGraph}>
                  Open graph workspace <ArrowRight size={13} />
                </button>
              </div>
            </div>

            <FindingInspector
              finding={selectedFinding}
              index={selectedFinding ? report.interrupt_cycles.indexOf(selectedFinding) : -1}
              report={report}
              analysisId={active.id}
              onOpenSource={onOpenSource}
              onOpenAll={onOpenFinding}
            />
          </section>

          <section className="observatory-support-grid">
            <div className="panel observatory-findings-panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">REVIEW QUEUE</div>
                  <h2>Recent findings</h2>
                </div>
                <button className="text-button" onClick={() => onOpenFinding(0)} disabled={!report.interrupt_cycles.length}>
                  All findings <ArrowRight size={13} />
                </button>
              </div>
              {report.interrupt_cycles.length ? (
                <div className="observatory-finding-list">
                  {report.interrupt_cycles.slice(0, 5).map((finding, index) => {
                    const place = firstFindingLocation(finding)
                    return (
                      <button
                        className={`observatory-finding-row ${selectedFinding === finding ? 'selected' : ''}`}
                        key={findingId(finding, index, active.id)}
                        onClick={() => onSelectFinding(finding)}
                      >
                        <code>{findingId(finding, index, active.id)}</code>
                        <span className={`finding-classification ${finding.category}`}>
                          {categoryLabel(finding.category)}
                        </span>
                        <span className="finding-locks">
                          {finding.lock_sequence?.map(shortLock).join(' ↔ ') ?? 'Lock sequence unavailable'}
                        </span>
                        <code className="finding-source-location">
                          {place ? `${basename(place.file)}:${place.line}` : 'Location unavailable'}
                        </code>
                        <ArrowRight size={13} />
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="panel-empty">
                  <Check size={16} />
                  No cycles were reported for this translation unit.
                </div>
              )}
            </div>

            <LockApiMix operations={report.api_operations} />
            <AnalysisActivity report={report} active={active} />
          </section>

          <section className="panel recent-runs-panel">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">LOCAL HISTORY</div>
                <h2>Recent analyses</h2>
              </div>
              <button className="text-button" onClick={onOpenHistory}>
                All runs <ArrowRight size={14} />
              </button>
            </div>
            <div className="recent-runs-list">
              {history.slice(0, 3).map((item) => (
                <button
                  className={`recent-run-row ${item.id === active.id ? 'selected' : ''}`}
                  key={item.id}
                  onClick={() => onSelectAnalysis(item)}
                >
                  <span className={`status-dot status-${statusTone(item.status)}`} />
                  <span className="recent-run-copy">
                    <strong>{basename(item.source_path)}</strong>
                    <small>{item.source_path}</small>
                  </span>
                  <span className="recent-run-date">{new Date(item.created_at).toLocaleString()}</span>
                  <span className={`status-pill ${statusTone(item.status)}`}>{item.status}</span>
                  <ArrowRight size={13} />
                </button>
              ))}
            </div>
          </section>

          <div className="overview-bottomline">
            <span>
              <Info size={14} />
              Static candidates are not runtime-confirmed deadlocks. Severity classification is not provided by the analyzer.
            </span>
            <span>Analyzer version · {health?.environment?.analyzer_version ?? 'Not reported'}</span>
          </div>
        </>
      )}
    </>
  )
}

function firstFindingLocation(finding: Finding) {
  for (const edge of finding.edges ?? []) {
    const from = locationOf(edge.from_location)
    const to = locationOf(edge.to_location)
    if (from) return from
    if (to) return to
  }
  return null
}

function FindingInspector({
  finding,
  index,
  report,
  analysisId,
  onOpenSource,
  onOpenAll,
}: {
  finding: Finding | null
  index: number
  report: AnalysisReport
  analysisId: string
  onOpenSource: (file: string, line: number) => void
  onOpenAll: (index: number) => void
}) {
  const [tab, setTab] = useState<'Overview' | 'Source Code' | 'Execution Context' | 'Analysis Evidence'>('Overview')
  if (!finding) {
    return (
      <aside className="panel finding-inspector empty-inspector">
        <div className="eyebrow">FINDING INSPECTOR</div>
        <ShieldCheck size={22} />
        <h2>No finding selected</h2>
        <p>Select a reported candidate or graph edge to inspect its source evidence.</p>
      </aside>
    )
  }
  const tabs = ['Overview', 'Source Code', 'Execution Context', 'Analysis Evidence'] as const
  const edges = finding.edges ?? []
  const id = findingId(finding, index, analysisId)
  const relatedUncertainties = (report.uncertainty_records ?? []).filter((item) => item.associated_findings.includes(id))

  return (
    <aside className="panel finding-inspector">
      <div className="inspector-head">
        <div>
          <div className="eyebrow">FINDING INSPECTOR · {id}</div>
          <h2>{categoryLabel(finding.category)}</h2>
        </div>
        <button className="icon-button" aria-label="Open all findings" onClick={() => onOpenAll(Math.max(index, 0))}>
          <ArrowUpRight size={15} />
        </button>
      </div>
      <div className={`inspector-status ${finding.category}`}>
        <ShieldAlert size={14} />
        <span>
          {finding.category === 'rejected_candidate'
            ? 'Rejected by feasibility check'
            : finding.category === 'inconclusive_analysis'
            ? 'Inconclusive analysis'
            : finding.feasibility === 'potentially_feasible'
            ? 'Potentially feasible static scenario'
            : 'Candidate; feasibility not established'}
        </span>
        <span className="status-pill">{finding.feasibility ?? 'Not reported'}</span>
      </div>
      <div className="inspector-tabs" role="tablist" aria-label="Finding detail sections">
        {tabs.map((item) => (
          <button
            key={item}
            role="tab"
            aria-selected={tab === item}
            className={tab === item ? 'active' : ''}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="inspector-body" role="tabpanel">
        {tab === 'Overview' && (
          <>
            <p className="inspector-explanation">{finding.explanation ?? 'The analyzer did not provide an explanation.'}</p>
            <div className="inspector-section-title">Lock order cycle</div>
            <div className="inspector-cycle">
              {(finding.lock_sequence ?? []).map((lock, itemIndex) => (
                <div className="inspector-cycle-row" key={`${lock}-${itemIndex}`}>
                  <b>{itemIndex + 1}</b>
                  <code>{shortLock(lock)}</code>
                  {itemIndex < (finding.lock_sequence?.length ?? 0) - 1 && <ArrowRight size={12} />}
                </div>
              ))}
            </div>
            <div className="inspector-facts">
              <span>Classification</span>
              <strong>{finding.classification ?? finding.category}</strong>
              <span>Confidence</span>
              <strong>Not reported</strong>
              <span>Severity</span>
              <strong>Not reported</strong>
              <span>Uncertain edge</span>
              <strong>{finding.contains_uncertain_edge ? 'Yes' : 'No'}</strong>
            </div>
          </>
        )}
        {tab === 'Source Code' && <SourceEvidence edges={edges} onOpenSource={onOpenSource} />}
        {tab === 'Execution Context' && (
          <div className="inspector-evidence-list">
            {edges.map((edge, edgeIndex) => (
              <div className="inspector-context-row" key={edgeIndex}>
                <span className="context-step">{edgeIndex + 1}</span>
                <span>
                  <strong>
                    {edge.from_context ?? 'Context not reported'} → {edge.to_context ?? 'Context not reported'}
                  </strong>
                  <small>
                    {edge.source_function ?? 'Function unavailable'} → {edge.target_function ?? 'Function unavailable'}
                  </small>
                  <small>
                    IRQ state · {edge.irq_state ?? 'Not reported'}
                    {edge.handler ? ` · handler ${edge.handler}` : ''}
                  </small>
                </span>
              </div>
            ))}
          </div>
        )}
        {tab === 'Analysis Evidence' && (
          <div className="inspector-evidence-list">
            {edges.map((edge, edgeIndex) => (
              <div className="inspector-context-row" key={edgeIndex}>
                <span className="context-step">{edgeIndex + 1}</span>
                <span>
                  <strong>
                    {shortLock(edge.from_lock)} → {shortLock(edge.to_lock)}
                  </strong>
                  <small>
                    {edge.kind} · {edge.certainty ?? 'certainty not reported'} · summary {edge.summary_status ?? 'not reported'}
                  </small>
                  <small>{edge.feasibility_reason ?? 'No feasibility explanation attached to this edge.'}</small>
                  {edge.path_conditions?.map((condition, conditionIndex) => (
                    <small key={conditionIndex}>
                      Path constraint: {condition.atom} is {condition.truth ? 'true' : 'false'} (source: {condition.expression})
                      {!condition.supported ? ' · unresolved' : ''}
                    </small>
                  ))}
                  {edge.registration_lifecycle && edge.registration_lifecycle !== 'not_applicable' && (
                    <small>
                      Handler lifecycle: {edge.registration_lifecycle}
                      {edge.deregistration_evidence?.map((place) => ` · free_irq ${place.expansion?.file ?? 'source'}:${place.expansion?.line ?? '?'}`)}
                    </small>
                  )}
                </span>
              </div>
            ))}
            {relatedUncertainties.length > 0 ? (
              <section className="finding-uncertainties">
                <strong>Uncertainty records affecting {id}</strong>
                {relatedUncertainties.map((item) => (
                  <article key={item.id}>
                    <code>{item.id} · {item.category.replaceAll('_', ' ')}</code>
                    <small>{item.explanation}</small>
                    <small>
                      {item.source_location.file
                        ? `${item.source_location.file}:${item.source_location.line}:${item.source_location.column}`
                        : item.enclosing_function || item.reason}
                    </small>
                  </article>
                ))}
              </section>
            ) : report.uncertainties.length > 0 ? (
              <div className="inspector-limitation">
                <Info size={13} />
                <span>No structured uncertainty record is linked to this finding. Review report diagnostics separately.</span>
              </div>
            ) : null}
          </div>
        )}
      </div>
      <button className="inspector-open-findings" onClick={() => onOpenAll(Math.max(index, 0))}>
        Open finding in explorer <ArrowRight size={13} />
      </button>
    </aside>
  )
}

function SourceEvidence({
  edges,
  onOpenSource,
}: {
  edges: Finding['edges']
  onOpenSource: (file: string, line: number) => void
}) {
  const locations = (edges ?? []).flatMap((edge) => [
    { place: locationOf(edge.from_location), label: 'Acquisition from', lock: edge.from_lock },
    { place: locationOf(edge.to_location), label: 'Acquisition to', lock: edge.to_lock },
  ])
  const available = locations.filter((item): item is { place: { file: string; line: number }; label: string; lock: string } => item.place !== null)

  return (
    <div className="inspector-evidence-list">
      {available.map(({ place, label, lock }, index) => (
        <button
          className="inspector-source-row"
          key={`${place.file}-${place.line}-${index}`}
          onClick={() => onOpenSource(place.file, place.line)}
        >
          <FileCode2 size={14} />
          <span>
            <strong>{label} · {shortLock(lock)}</strong>
            <small>{place.file}:{place.line}</small>
          </span>
          <ArrowUpRight size={13} />
        </button>
      ))}
      {available.length < locations.length && (
        <p className="inspector-muted">{locations.length - available.length} source location(s) are unavailable in the report.</p>
      )}
      {locations.length === 0 && (
        <p className="inspector-muted">No source locations were provided for this finding.</p>
      )}
    </div>
  )
}

function LockApiMix({ operations }: { operations: AnalysisReport['api_operations'] }) {
  const counts = useMemo(() => {
    const result = new Map<string, number>()
    operations
      .filter((operation) => operation.lock && operation.api)
      .forEach((operation) => result.set(operation.api!, (result.get(operation.api!) ?? 0) + 1))
    return [...result.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  }, [operations])
  const total = counts.reduce((sum, [, count]) => sum + count, 0)

  return (
    <section className="panel mix-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">API EVENTS</div>
          <h2>Lock API mix</h2>
        </div>
        <LockKeyhole size={15} className="subtle-icon" />
      </div>
      {total ? (
        <div className="api-mix-list">
          {counts.map(([name, count], index) => (
            <div className="api-mix-row" key={name}>
              <div>
                <code>{name}</code>
                <span>{Math.round((count / total) * 100)}%</span>
              </div>
              <div className="api-mix-track">
                <i style={{ width: `${(count / total) * 100}%`, ['--mix-index' as string]: index }} />
              </div>
              <small>
                {count} recorded API operation{count === 1 ? '' : 's'}
              </small>
            </div>
          ))}
        </div>
      ) : (
        <div className="unavailable-mini">
          <Info size={15} />
          <span>Lock API distribution is not reported for this analysis.</span>
        </div>
      )}
      <div className="panel-footnote">Counts are grouped from actual lock-bearing API events.</div>
    </section>
  )
}

function AnalysisActivity({ report, active }: { report: AnalysisReport; active: AnalysisMetadata }) {
  const [filter, setFilter] = useState<'all' | 'diagnostic' | 'uncertainty'>('all')
  const [cleared, setCleared] = useState(false)
  const entries = [
    ...report.diagnostics.map((message) => ({ kind: 'diagnostic', message })),
    ...report.uncertainties.map((message) => ({ kind: 'uncertainty', message })),
  ]
  const visibleEntries = entries.filter((entry) => filter === 'all' || entry.kind === filter).slice(0, 8)
  const uncertaintySummary = report.uncertainty_summary
  const highImpact = (report.uncertainty_records ?? []).filter((item) => item.severity === 'high').slice(0, 3)

  return (
    <section className="panel activity-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">REPORT RECORD</div>
          <h2>Analysis activity</h2>
        </div>
        <span className="status-pill good">{active.status}</span>
      </div>
      <div className="activity-meta">
        <span>
          <Clock3 size={12} />
          {formatDuration(active.duration_ms)}
        </span>
        <code>{active.return_code === 0 ? 'exit 0' : `exit ${active.return_code ?? 'not reported'}`}</code>
      </div>
      <div className="activity-summary">
        <div>
          <span>Functions</span>
          <strong>{active.summary?.functions ?? 'Not available'}</strong>
        </div>
        <div>
          <span>Operations</span>
          <strong>{active.summary?.lock_operations ?? 'Not available'}</strong>
        </div>
        <div>
          <span>Diagnostics</span>
          <strong>{report.diagnostics.length}</strong>
        </div>
      </div>
      {uncertaintySummary && (
        <div className="activity-uncertainty-overview">
          <div>
            <strong>{uncertaintySummary.event_count.toLocaleString()}</strong>
            <span>events</span>
          </div>
          <div>
            <strong>{uncertaintySummary.unique_record_count.toLocaleString()}</strong>
            <span>unique causes</span>
          </div>
          <div>
            <strong>{uncertaintySummary.propagated_event_count.toLocaleString()}</strong>
            <span>propagated</span>
          </div>
          <div>
            <strong>{uncertaintySummary.high_impact_unique_records.toLocaleString()}</strong>
            <span>high impact</span>
          </div>
        </div>
      )}
      {highImpact.length > 0 && (
        <div className="activity-high-impact">
          <span>HIGH IMPACT UNCERTAINTIES</span>
          {highImpact.map((item) => (
            <div key={item.id}>
              <strong>{item.category.replaceAll('_', ' ')}</strong>
              <code>
                {item.source_location.file
                  ? `${item.source_location.file}:${item.source_location.line}:${item.source_location.column}`
                  : item.enclosing_function || item.reason}
              </code>
            </div>
          ))}
        </div>
      )}
      <div className="activity-filters">
        <button className={filter === 'all' ? 'selected' : ''} onClick={() => { setFilter('all'); setCleared(false) }}>
          All {entries.length}
        </button>
        <button className={filter === 'diagnostic' ? 'selected' : ''} onClick={() => { setFilter('diagnostic'); setCleared(false) }}>
          Diagnostics {report.diagnostics.length}
        </button>
        <button className={filter === 'uncertainty' ? 'selected' : ''} onClick={() => { setFilter('uncertainty'); setCleared(false) }}>
          Uncertainty {report.uncertainties.length}
        </button>
        <button className="activity-clear" onClick={() => setCleared((value) => !value)}>
          {cleared ? 'Restore view' : 'Clear view'}
        </button>
      </div>
      <div className="activity-log" aria-label="Analyzer report diagnostics">
        {cleared ? (
          <div className="activity-clean">Visible entries cleared. The saved report is unchanged.</div>
        ) : visibleEntries.length ? (
          visibleEntries.map((entry, index) => (
            <div className={`activity-line ${entry.kind}`} key={`${entry.kind}-${index}`}>
              <span>{entry.kind === 'diagnostic' ? 'DIAG' : 'NOTE'}</span>
              <code>{entry.message}</code>
            </div>
          ))
        ) : (
          <div className="activity-clean">
            {entries.length ? 'No entries in this filter.' : <><Check size={13} />The report contains no diagnostics or uncertainty notes.</>}
          </div>
        )}
      </div>
      <div className="panel-footnote">Summary from the final report. No live process log is available.</div>
    </section>
  )
}
