import { useState } from 'react'
import {
  ArrowRight,
  Check,
  FileCode2,
  FileJson2,
  GitBranch,
  Info,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react'
import type { AnalysisMetadata, AnalysisReport, Finding } from '../types'
import { LoadExampleButton } from '../components/DemoBadge'

function basename(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path
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

function categoryLabel(category: string) {
  if (category === 'candidate_lock_order_cycle') return 'Lock-order candidate'
  if (category === 'interrupt_aware_candidate') return 'Interrupt-aware candidate'
  if (category === 'rejected_candidate') return 'Rejected candidate'
  if (category === 'inconclusive_analysis') return 'Inconclusive'
  return category.replaceAll('_', ' ')
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

function firstFindingFile(finding: Finding) {
  return firstFindingLocation(finding)?.file ?? ''
}

export function FindingsPage({
  report,
  analysis,
  selectedIndex,
  onSelect,
  onOpenSource,
  onOpenGraph,
  onLoadExample,
}: {
  report: AnalysisReport | null
  analysis: AnalysisMetadata | null
  selectedIndex: number | null
  onSelect: (index: number | null) => void
  onOpenSource: (file: string, line: number) => void
  onOpenGraph: (index: number) => void
  onLoadExample?: () => void
}) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [sort, setSort] = useState<'category' | 'file'>('category')
  const [page, setPage] = useState(0)
  const [exportMessage, setExportMessage] = useState('')
  const cycles = report?.interrupt_cycles ?? []

  const filtered = cycles
    .map((finding, index) => ({ finding, index, id: findingId(finding, index, analysis?.id) }))
    .filter(({ finding, id }) => {
      const text = [
        id,
        finding.category,
        finding.explanation,
        ...(finding.lock_sequence ?? []),
        ...(finding.edges ?? []).flatMap((edge) => [
          edge.from_context ?? '',
          edge.to_context ?? '',
          edge.source_function ?? '',
          edge.target_function ?? '',
        ]),
      ]
        .join(' ')
        .toLowerCase()
      return (category === 'all' || finding.category === category) && text.includes(search.toLowerCase())
    })
    .sort((a, b) =>
      sort === 'category'
        ? a.finding.category.localeCompare(b.finding.category)
        : firstFindingFile(a.finding).localeCompare(firstFindingFile(b.finding))
    )

  const pageSize = 25
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const visible = filtered.slice(page * pageSize, (page + 1) * pageSize)
  const categories = [...new Set(cycles.map((finding) => finding.category))]

  const exportJson = () => {
    if (!report) return
    const exportedFindings = report.interrupt_cycles.map((finding, index) => {
      const id = findingId(finding, index, analysis?.id)
      return {
        ...finding,
        review_classification:
          finding.category === 'inconclusive_analysis'
            ? 'inconclusive'
            : finding.category === 'rejected_candidate'
            ? 'rejected_by_feasibility_checks'
            : 'candidate',
        uncertainty_records: (report.uncertainty_records ?? []).filter((item) => item.associated_findings.includes(id)),
      }
    })
    const blob = new Blob(
      [JSON.stringify({ schema_version: report.schema_version, source: report.source, interrupt_cycles: exportedFindings }, null, 2)],
      { type: 'application/json' }
    )
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `irqguard-findings-${analysis?.id ?? 'report'}.json`
    link.click()
    URL.revokeObjectURL(link.href)
    setExportMessage('Findings JSON exported.')
  }

  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">STATIC ANALYSIS</div>
          <h1>Findings</h1>
          <p className="page-caption">Review candidate lock cycles and the source evidence included in the analyzer report.</p>
        </div>
        {report && (
          <button className="button button-secondary" onClick={exportJson}>
            <FileJson2 size={15} /> Export JSON
          </button>
        )}
      </div>

      {!report ? (
        <div className="empty-panel">
          <FileJson2 size={21} />
          <h2>No report selected</h2>
          <p>Run an analysis or load a bundled example.</p>
          {onLoadExample && <LoadExampleButton onLoadExample={onLoadExample} label="Load bundled example" />}
        </div>
      ) : (
        <>
          <div className="finding-countline">
            <span>
              <strong>{filtered.length}</strong> of {cycles.length} findings
            </span>
            <span>Severity is not reported by the analyzer; static candidates are not confirmed deadlocks.</span>
          </div>

          <div className="findings-table-wrap">
            <div className="table-toolbar">
              <div className="toolbar-search">
                <Search size={15} />
                <input
                  aria-label="Search findings"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value)
                    setPage(0)
                  }}
                  placeholder="Search findings, locks, explanations…"
                />
              </div>
              <div className="toolbar-filters">
                <label>
                  <span>Category</span>
                  <select
                    aria-label="Filter findings by category"
                    value={category}
                    onChange={(event) => {
                      setCategory(event.target.value)
                      setPage(0)
                    }}
                  >
                    <option value="all">All categories</option>
                    {categories.map((item) => (
                      <option value={item} key={item}>
                        {categoryLabel(item)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Sort</span>
                  <select
                    aria-label="Sort findings"
                    value={sort}
                    onChange={(event) => setSort(event.target.value as 'category' | 'file')}
                  >
                    <option value="category">Category</option>
                    <option value="file">Source file</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="finding-table" role="table" aria-label="Analyzer findings">
              <div className="finding-table-header" role="row">
                <span>Finding</span>
                <span>Lock sequence</span>
                <span>Execution context</span>
                <span>Evidence location</span>
                <span>Feasibility</span>
                <span />
              </div>
              {visible.map(({ finding, index, id }) => {
                const place = firstFindingLocation(finding)
                const contexts = [
                  ...new Set((finding.edges ?? []).map((edge) => `${edge.from_context ?? 'unknown'} → ${edge.to_context ?? 'unknown'}`)),
                ]
                return (
                  <button
                    role="row"
                    className={`finding-table-row ${selectedIndex === index ? 'row-selected' : ''}`}
                    key={id}
                    onClick={() => onSelect(index)}
                  >
                    <span className="finding-table-title">
                      <i className={`finding-mini-dot ${finding.category}`} />
                      <span>
                        <strong>{categoryLabel(finding.category)}</strong>
                        <small>{id}</small>
                      </span>
                    </span>
                    <span className="lock-sequence-cell">
                      {finding.lock_sequence?.slice(0, 4).map(shortLock).join(' → ') ?? 'Unavailable'}
                    </span>
                    <span className="finding-context-cell">
                      {contexts.length ? contexts.slice(0, 2).join(' · ') : 'Not reported'}
                    </span>
                    <span className="location-cell">
                      <code>{place ? `${basename(place.file)}:${place.line}` : 'Not available'}</code>
                    </span>
                    <span className={`feasibility-label ${finding.feasibility ?? 'unknown'}`}>
                      {finding.feasibility ?? 'Not available'}
                    </span>
                    <ArrowRight size={14} className="row-arrow" />
                  </button>
                )
              })}
            </div>
          </div>

          {filtered.length === 0 && (
            <div className="table-empty">
              <Search size={17} />
              <span>No findings match these filters.</span>
            </div>
          )}

          {pageCount > 1 && (
            <div className="pagination">
              <span>
                Page {page + 1} of {pageCount} · showing up to 25
              </span>
              <div>
                <button
                  type="button"
                  className="button button-small button-secondary"
                  onClick={() => setPage((value) => Math.max(0, value - 1))}
                  disabled={page === 0}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="button button-small button-secondary"
                  onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
                  disabled={page + 1 >= pageCount}
                >
                  Next
                </button>
              </div>
            </div>
          )}

          {selectedIndex != null && cycles[selectedIndex] && (
            <FindingDetail
              finding={cycles[selectedIndex]}
              id={findingId(cycles[selectedIndex], selectedIndex, analysis?.id)}
              onClose={() => onSelect(null)}
              onOpenSource={onOpenSource}
              onOpenGraph={() => onOpenGraph(selectedIndex)}
            />
          )}

          {exportMessage && (
            <div className="toast" role="status">
              <Check size={14} />
              {exportMessage}
              <button onClick={() => setExportMessage('')} aria-label="Dismiss export message">
                <X size={13} />
              </button>
            </div>
          )}
        </>
      )}
    </>
  )
}

function FindingDetail({
  finding,
  id,
  onClose,
  onOpenSource,
  onOpenGraph,
}: {
  finding: Finding
  id: string
  onClose: () => void
  onOpenSource: (file: string, line: number) => void
  onOpenGraph: () => void
}) {
  const edges = finding.edges ?? []
  return (
    <div
      className="detail-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="finding-detail" role="dialog" aria-modal="true" aria-labelledby="finding-detail-title">
        <header className="detail-header">
          <div>
            <div className="eyebrow">FINDING EVIDENCE · {id}</div>
            <h2 id="finding-detail-title">{categoryLabel(finding.category)}</h2>
          </div>
          <button className="icon-button" aria-label="Close finding details" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className={`detail-status-line ${finding.category}`}>
          <ShieldCheck size={15} />
          <span>{finding.feasibility ?? 'Feasibility not reported'}</span>
          <span>{finding.contains_uncertain_edge ? 'Contains uncertain edge' : 'No uncertain edge recorded'}</span>
        </div>
        <p className="detail-explanation">
          {finding.explanation ?? 'The analyzer did not provide an explanation for this finding.'}
        </p>
        <div className="detail-section">
          <div className="eyebrow">ORDERED LOCK SEQUENCE</div>
          <div className="cycle-sequence">
            {(finding.lock_sequence ?? []).map((lock, index) => (
              <span key={`${lock}-${index}`}>
                <code>{shortLock(lock)}</code>
                {index < (finding.lock_sequence?.length ?? 0) - 1 && <ArrowRight size={13} />}
              </span>
            ))}
          </div>
        </div>
        <div className="detail-section">
          <div className="eyebrow">EDGE PROVENANCE · {edges.length}</div>
          <div className="detail-edge-list">
            {edges.map((edge, index) => {
              const sourcePoint = locationOf(edge.from_location)
              const targetPoint = locationOf(edge.to_location)
              return (
                <article className="detail-edge" key={`${edge.kind}-${index}`}>
                  <div className="detail-edge-top">
                    <span className="edge-order">{String(index + 1).padStart(2, '0')}</span>
                    <strong>
                      {shortLock(edge.from_lock)} <ArrowRight size={12} /> {shortLock(edge.to_lock)}
                    </strong>
                    <span className={`edge-kind ${edge.kind}`}>{edge.kind}</span>
                  </div>
                  <div className="edge-meta">
                    <span>
                      {edge.from_context ?? 'context unavailable'} → {edge.to_context ?? 'context unavailable'}
                    </span>
                    <span>
                      {edge.source_function ?? 'function unavailable'} → {edge.target_function ?? 'function unavailable'}
                    </span>
                  </div>
                  <div className="edge-locations">
                    {[
                      [sourcePoint, 'Acquisition from'],
                      [targetPoint, 'Acquisition to'],
                    ].map(([place, label], locationIndex) =>
                      place ? (
                        <button
                          className="source-link"
                          key={locationIndex}
                          onClick={() =>
                            onOpenSource(
                              (place as { file: string; line: number }).file,
                              (place as { file: string; line: number }).line
                            )
                          }
                        >
                          <FileCode2 size={12} />
                          {label as string} · {basename((place as { file: string }).file)}:
                          {(place as { line: number }).line}
                        </button>
                      ) : null
                    )}
                    {edge.registration_location && locationOf(edge.registration_location) && (
                      <span className="registration-location">
                        Handler registration · {basename(locationOf(edge.registration_location)!.file)}:
                        {locationOf(edge.registration_location)!.line}
                      </span>
                    )}
                  </div>
                  {edge.irq_state && edge.irq_state !== 'not_applicable' && (
                    <div className="irq-state-line">
                      IRQ state: <strong>{edge.irq_state}</strong>
                      {edge.handler && <span>· handler {edge.handler}</span>}
                    </div>
                  )}
                  {edge.feasibility_reason && (
                    <div className="edge-reason">
                      <Info size={13} />
                      {edge.feasibility_reason}
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        </div>
        {finding.provenance_variants && finding.provenance_variants.length > 1 && (
          <div className="variant-note">
            <GitBranch size={14} />
            {finding.provenance_variants.length} equivalent provenance paths are grouped in this finding.
          </div>
        )}
        <div className="detail-footnote">
          <Info size={14} />
          <span>
            A cycle is a static candidate. It does not establish that the locks alias at runtime, that the handler will run, or that a deadlock occurred.
          </span>
        </div>
        <button className="button button-primary finding-open-graph" onClick={onOpenGraph}>
          <GitBranch size={14} /> Highlight in lock graph
        </button>
      </section>
    </div>
  )
}
