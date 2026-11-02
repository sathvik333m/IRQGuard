import { useState, Fragment } from 'react'
import {
  AlertCircle,
  ArrowRight,
  Braces,
  GitBranch,
  History as HistoryIcon,
  Info,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react'
import type { AnalysisMetadata } from '../types'
import type { SemanticComparison } from '../reportComparison'

function basename(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function statusTone(status?: string) {
  if (status === 'completed' || status === 'matched' || status === 'succeeded' || status === 'passed') return 'good'
  if (status === 'running' || status === 'queued') return 'running'
  if (status === 'failed') return 'bad'
  return 'muted'
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

function compareMetric(metadata: AnalysisMetadata, key: string) {
  const value = metadata.summary?.[key as keyof NonNullable<AnalysisMetadata['summary']>]
  return typeof value === 'string' || typeof value === 'number' ? value : 'Not available'
}

export function HistoryPage({
  history,
  activeId,
  compareIds,
  onRefresh,
  onOpen,
  onDelete,
  onCompareReports,
  onToggleCompare,
}: {
  history: AnalysisMetadata[]
  activeId?: string
  compareIds: string[]
  onRefresh: () => void
  onOpen: (metadata: AnalysisMetadata) => void
  onDelete: (metadata: AnalysisMetadata) => Promise<void>
  onCompareReports: (before: AnalysisMetadata, after: AnalysisMetadata) => Promise<SemanticComparison>
  onToggleCompare: (id: string) => void
}) {
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [semanticComparison, setSemanticComparison] = useState<SemanticComparison | null>(null)
  const [comparisonLoading, setComparisonLoading] = useState(false)
  const [comparisonError, setComparisonError] = useState('')

  const selected = history.filter((item) => compareIds.includes(item.id))
  const comparableSelection = selected.length === 2 && selected.every((item) => item.status === 'completed')

  const runComparison = async () => {
    if (!comparableSelection) return
    setComparisonLoading(true)
    setComparisonError('')
    setSemanticComparison(null)
    try {
      setSemanticComparison(await onCompareReports(selected[0], selected[1]))
    } catch (error) {
      setComparisonError(error instanceof Error ? error.message : 'Could not compare the saved reports.')
    } finally {
      setComparisonLoading(false)
    }
  }

  const remove = async (item: AnalysisMetadata) => {
    if (
      !window.confirm(
        `Delete the saved analysis for ${basename(item.source_path)}? Its report and history entry will be removed. The source file will stay untouched.`
      )
    )
      return
    setDeletingId(item.id)
    setDeleteError('')
    try {
      await onDelete(item)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Could not delete this analysis.')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">LOCAL RUNS</div>
          <h1>Analysis history</h1>
          <p className="page-caption">Completed reports and failures are stored in your local IRQGuard data directory.</p>
        </div>
        <button className="button button-secondary" onClick={onRefresh}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {deleteError && (
        <div className="alert alert-error" role="alert">
          <AlertCircle size={16} />
          <span>{deleteError}</span>
          <button className="icon-button alert-close" aria-label="Dismiss delete error" onClick={() => setDeleteError('')}>
            <X size={15} />
          </button>
        </div>
      )}

      {!history.length ? (
        <div className="empty-panel">
          <HistoryIcon size={20} />
          <h2>No saved analyses</h2>
          <p>Completed reports and failed run metadata will appear here.</p>
        </div>
      ) : (
        <div className="history-surface">
          <div className="table-toolbar">
            <div>
              <strong>{history.length}</strong> stored runs <span className="muted">· newest first</span>
            </div>
            <span className="muted">Select two completed reports for a semantic diff.</span>
          </div>
          <div className="history-list">
            {history.map((item) => (
              <div className={`history-row ${item.id === activeId ? 'selected' : ''}`} key={item.id}>
                <label className="compare-check" title="Select for summary comparison">
                  <input
                    type="checkbox"
                    checked={compareIds.includes(item.id)}
                    onChange={() => onToggleCompare(item.id)}
                  />
                  <span />
                </label>
                <span className={`history-status ${statusTone(item.status)}`}>
                  <span className="status-dot" />
                </span>
                <div className="history-main">
                  <div className="history-title">
                    <strong>{basename(item.source_path)}</strong>
                    <code>{item.source_path}</code>
                  </div>
                  <div className="history-meta">
                    <span>{new Date(item.created_at).toLocaleString()}</span>
                    <span>schema {item.analyzer_schema_version ?? 'not available'}</span>
                    {item.duration_ms != null && <span>{formatDuration(item.duration_ms)}</span>}
                  </div>
                </div>
                <div className="history-counts">
                  <span>
                    <Braces size={13} />
                    {item.summary?.functions ?? '—'}
                  </span>
                  <span>
                    <GitBranch size={13} />
                    {item.summary?.graph_edges ?? '—'}
                  </span>
                  <span>
                    <ShieldAlert size={13} />
                    {item.summary?.candidate_cycles ?? '—'}
                  </span>
                </div>
                <span className={`status-pill ${statusTone(item.status)}`}>{item.status}</span>
                <button
                  className="icon-button delete-run"
                  onClick={() => void remove(item)}
                  disabled={item.status === 'queued' || item.status === 'running' || deletingId !== null}
                  aria-label={`Delete analysis ${basename(item.source_path)}`}
                  title={
                    item.status === 'queued' || item.status === 'running'
                      ? 'Wait for this analysis to finish before deleting it'
                      : 'Delete saved analysis'
                  }
                >
                  {deletingId === item.id ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}
                </button>
                <button
                  className="icon-button open-run"
                  onClick={() => onOpen(item)}
                  aria-label={`Open analysis ${basename(item.source_path)}`}
                >
                  <ArrowRight size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {selected.length === 2 && (
        <div className="compare-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">RUN COMPARISON</div>
              <h2>Summary counts</h2>
            </div>
            <span className="schema-tag">
              {selected[0].analyzer_schema_version === selected[1].analyzer_schema_version
                ? `Schema ${selected[0].analyzer_schema_version ?? 'unknown'}`
                : 'Incompatible schemas'}
            </span>
          </div>

          {selected[0].analyzer_schema_version !== selected[1].analyzer_schema_version ? (
            <div className="inline-notice">
              <Info size={16} />
              Report schemas differ. Counts are shown separately and should not be compared directly.
            </div>
          ) : null}

          <div className="compare-grid">
            <span>Metric</span>
            <strong>{basename(selected[0].source_path)}</strong>
            <strong>{basename(selected[1].source_path)}</strong>
            {[
              ['Functions', 'functions'],
              ['Lock operations', 'lock_operations'],
              ['Graph edges', 'graph_edges'],
              ['Candidate cycles', 'candidate_cycles'],
              ['Rejected', 'rejected_candidates'],
              ['Inconclusive', 'inconclusive_findings'],
            ].map(([label, key]) => (
              <Fragment key={key}>
                <span>{label}</span>
                <span>{compareMetric(selected[0], key)}</span>
                <span>{compareMetric(selected[1], key)}</span>
              </Fragment>
            ))}
          </div>

          <button
            className="button button-secondary semantic-compare-action"
            disabled={!comparableSelection || comparisonLoading}
            onClick={() => void runComparison()}
          >
            {comparisonLoading ? <LoaderCircle className="spin" size={14} /> : <GitBranch size={14} />}
            Compare report semantics
          </button>

          {!comparableSelection && (
            <p className="comparison-help">
              Both selections must be completed reports. Older reports without fingerprints may compare with unknown input comparability.
            </p>
          )}

          {comparisonError && (
            <div className="alert alert-error" role="alert">
              <AlertCircle size={15} />
              {comparisonError}
            </div>
          )}

          {semanticComparison && (
            <SemanticComparisonView
              result={semanticComparison}
              before={selected[0]}
              after={selected[1]}
            />
          )}
        </div>
      )}
    </>
  )
}

function SemanticComparisonView({
  result,
  before,
  after,
}: {
  result: SemanticComparison
  before: AnalysisMetadata
  after: AnalysisMetadata
}) {
  const changes =
    result.edges.added.length +
    result.edges.removed.length +
    result.edges.changedLockIdentity.length +
    result.findings.added.length +
    result.findings.removed.length +
    result.findings.reclassified.length +
    result.edges.changedProvenance.length +
    result.diagnostics.added.length +
    result.diagnostics.removed.length

  const comparability =
    result.comparability === 'same_inputs'
      ? 'Recorded inputs match'
      : result.comparability === 'inputs_differ'
      ? 'Inputs differ; interpret changes with care'
      : 'Input comparability unknown'

  return (
    <section className="semantic-diff" aria-label="Semantic report comparison">
      <div className="semantic-diff-heading">
        <div>
          <span className="eyebrow">STRUCTURED REPORT DIFF</span>
          <h3>{changes ? `${changes} semantic changes` : 'No semantic changes detected'}</h3>
        </div>
        <span className={`status-pill ${result.comparability === 'same_inputs' ? 'good' : 'muted'}`}>
          {comparability}
        </span>
      </div>
      <p className="comparison-help">{result.comparabilityReasons.join(' ')}</p>
      <div className="semantic-metadata">
        <span>
          Schema: {result.metadata.beforeSchema} → {result.metadata.afterSchema}
        </span>
        <span>
          Kernel revision: {result.metadata.beforeKernelRevision ?? 'not reported'} →{' '}
          {result.metadata.afterKernelRevision ?? 'not reported'}
        </span>
        <span>
          Toolchain: {result.metadata.beforeToolchain ?? 'not reported'} →{' '}
          {result.metadata.afterToolchain ?? 'not reported'}
        </span>
        <span>
          Input paths: {before.source_path === after.source_path ? 'same source path' : 'different source paths'}
        </span>
        <span>Build validation: not recorded in saved analyzer reports; see pinned evaluation evidence</span>
      </div>
      <div className="semantic-diff-grid">
        <article>
          <strong>Dependency edges</strong>
          <p>
            +{result.edges.added.length} added · −{result.edges.removed.length} removed ·{' '}
            {result.edges.changedLockIdentity.length} changed identities
          </p>
          {[
            ...result.edges.added.map((edge) => ({ label: 'Added', edge })),
            ...result.edges.removed.map((edge) => ({ label: 'Removed', edge })),
          ].map(({ label, edge }, index) => (
            <small key={`${label}-${index}`}>
              {label}: {shortLock(edge.from_lock)} → {shortLock(edge.to_lock)} ·{' '}
              {edge.source_function ?? 'function unavailable'}
            </small>
          ))}
          {result.edges.changedLockIdentity.map(({ before: left, after: right }, index) => (
            <small key={`identity-${index}`}>
              Identity changed: {shortLock(left.from_lock)} → {shortLock(left.to_lock)} became{' '}
              {shortLock(right.from_lock)} → {shortLock(right.to_lock)}
            </small>
          ))}
          {result.edges.changedProvenance.map((item, index) => (
            <small key={`provenance-${index}`}>
              Source provenance changed for {item.edge.split('|').slice(0, 2).join(' → ')}
            </small>
          ))}
          {!result.edges.added.length &&
            !result.edges.removed.length &&
            !result.edges.changedLockIdentity.length &&
            !result.edges.changedProvenance.length && <small>No dependency-edge or provenance changes.</small>}
        </article>
        <article>
          <strong>Findings</strong>
          <p>
            +{result.findings.added.length} added · −{result.findings.removed.length} removed ·{' '}
            {result.findings.reclassified.length} reclassified
          </p>
          {result.findings.reclassified.map(({ before: left, after: right }, index) => (
            <small key={index}>
              {left.category} / {left.feasibility ?? 'unknown'} → {right.category} /{' '}
              {right.feasibility ?? 'unknown'}
            </small>
          ))}
          {[
            ...result.findings.added.map((finding) => `Added ${finding.category}: ${(finding.lock_sequence ?? []).map(shortLock).join(' → ')}`),
            ...result.findings.removed.map((finding) => `Removed ${finding.category}: ${(finding.lock_sequence ?? []).map(shortLock).join(' → ')}`),
          ].map((item) => (
            <small key={item}>{item}</small>
          ))}
          {!result.findings.added.length &&
            !result.findings.removed.length &&
            !result.findings.reclassified.length && <small>No finding changes.</small>}
        </article>
        <article>
          <strong>Uncertainty and diagnostics</strong>
          <p>
            Uncertainty events: {result.uncertainty.beforeEvents.toLocaleString()} →{' '}
            {result.uncertainty.afterEvents.toLocaleString()} · unique:{' '}
            {result.uncertainty.beforeUnique?.toLocaleString() ?? 'not recorded'} →{' '}
            {result.uncertainty.afterUnique?.toLocaleString() ?? 'not recorded'}
          </p>
          {result.uncertainty.categories.map((row) => (
            <small key={row.category}>
              {row.category}: {row.beforeEvents} → {row.afterEvents} events · unique{' '}
              {row.beforeUnique ?? '—'} → {row.afterUnique ?? '—'}
            </small>
          ))}
          <small>
            Diagnostics: +{result.diagnostics.added.length} · −{result.diagnostics.removed.length}
          </small>
          {result.diagnostics.added.map((item) => (
            <small key={`diag+${item}`}>Added diagnostic: {item}</small>
          ))}
          {result.diagnostics.removed.map((item) => (
            <small key={`diag-${item}`}>Removed diagnostic: {item}</small>
          ))}
        </article>
      </div>
      <p className="phase12-validation-note mt-3">
        Static candidates are evidence for review, not confirmed deadlocks.
      </p>
    </section>
  )
}

