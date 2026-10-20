import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import {
  Activity, AlertCircle, ArrowRight, ArrowUpRight, BookOpen,
  Braces, Check, ChevronDown, Clock3,
  Database, FileCode2, FileJson2, FileSearch, GitBranch, Gauge,
  HardDrive, History, Info, LayoutDashboard, LoaderCircle, LockKeyhole,
  Menu, Moon, Play, RefreshCw, Search, Settings2, ShieldAlert, ShieldCheck,
  Sun, TerminalSquare, X,
} from 'lucide-react'
import { getAnalyses, getAnalysis, getHealth, getReport, getSource, startAnalysis } from './api'
import type { AnalysisMetadata, AnalysisReport, Finding, Health, SourceSnippet } from './types'

const LockGraph = lazy(() => import('./components/LockGraph').then((module) => ({ default: module.LockGraph })))
const DurationChart = lazy(() => import('./components/DurationChart'))

type Page = 'overview' | 'new' | 'history' | 'graph' | 'findings' | 'source' | 'settings' | 'runtime' | 'benchmarks'

const navItems: Array<{ id: Page; label: string; icon: typeof LayoutDashboard; section: string; unavailable?: boolean }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, section: 'Workspace' },
  { id: 'new', label: 'New analysis', icon: Play, section: 'Workspace' },
  { id: 'history', label: 'Analysis history', icon: History, section: 'Workspace' },
  { id: 'graph', label: 'Lock graph', icon: GitBranch, section: 'Analysis' },
  { id: 'findings', label: 'Findings', icon: ShieldAlert, section: 'Analysis' },
  { id: 'source', label: 'Source explorer', icon: FileSearch, section: 'Analysis' },
  { id: 'runtime', label: 'Runtime evidence', icon: Activity, section: 'Evidence', unavailable: true },
  { id: 'benchmarks', label: 'Benchmarks', icon: Gauge, section: 'Evidence', unavailable: true },
  { id: 'settings', label: 'Settings', icon: Settings2, section: 'System' },
]

function locationOf(value: { expansion?: { file?: string; line?: number; valid?: boolean } } | undefined) {
  const point = value?.expansion
  if (!point?.valid || !point.file || !point.line) return null
  return { file: point.file, line: point.line }
}

function findingId(finding: Finding, index: number, analysisId?: string) {
  return finding.finding_id ?? `${analysisId?.slice(0, 8) ?? 'finding'}-${String(index + 1).padStart(3, '0')}`
}

function statusTone(status?: string) {
  if (status === 'completed') return 'good'
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

function basename(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

const cKeywords = new Set('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Atomic _Bool _Complex _Generic'.split(' '))

function highlightCLine(source: string): ReactNode {
  if (source.trimStart().startsWith('#')) return <span className="syntax-preprocessor">{source}</span>
  const tokenPattern = /\/\/.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b[A-Za-z_]\w*\b|\b\d+(?:\.\d+)?\b/g
  const parts: ReactNode[] = []
  let offset = 0
  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0]
    const start = match.index ?? 0
    if (start > offset) parts.push(source.slice(offset, start))
    const kind = token.startsWith('//') || token.startsWith('/*') ? 'comment'
      : token.startsWith('"') || token.startsWith("'") ? 'string'
        : /^\d/.test(token) ? 'number' : cKeywords.has(token) ? 'keyword' : 'identifier'
    parts.push(<span className={`syntax-${kind}`} key={`${start}-${token}`}>{token}</span>)
    offset = start + token.length
  }
  if (offset < source.length) parts.push(source.slice(offset))
  return parts
}

export default function App() {
  const [page, setPage] = useState<Page>('overview')
  const [health, setHealth] = useState<Health | null>(null)
  const [history, setHistory] = useState<AnalysisMetadata[]>([])
  const [active, setActive] = useState<AnalysisMetadata | null>(null)
  const [report, setReport] = useState<AnalysisReport | null>(null)
  const [backendError, setBackendError] = useState('')
  const [loadingReport, setLoadingReport] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => localStorage.getItem('irqguard-theme') === 'light' ? 'light' : 'dark')
  const [selectedFindingIndex, setSelectedFindingIndex] = useState<number | null>(null)
  const [source, setSource] = useState<SourceSnippet | null>(null)
  const [sourceError, setSourceError] = useState('')
  const [sourceLoading, setSourceLoading] = useState(false)
  const [compareIds, setCompareIds] = useState<string[]>([])
  const findings = report?.interrupt_cycles ?? []
  const selectedFinding = selectedFindingIndex == null ? null : findings[selectedFindingIndex] ?? null

  const refreshHistory = useCallback(async () => {
    const items = await getAnalyses()
    setHistory(items)
    return items
  }, [])

  const openAnalysis = useCallback(async (metadata: AnalysisMetadata) => {
    setActive(metadata)
    setReport(null)
    setSelectedFindingIndex(null)
    if (metadata.status !== 'completed') return
    setLoadingReport(true)
    try {
      setReport(await getReport(metadata.id))
      setBackendError('')
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : 'Could not load the saved analyzer report.')
    } finally {
      setLoadingReport(false)
    }
  }, [])

  const bootstrap = useCallback(async () => {
    try {
      const [server, items] = await Promise.all([getHealth(), getAnalyses()])
      setHealth(server)
      setHistory(items)
      setBackendError('')
      const lastCompleted = items.find((item) => item.status === 'completed')
      if (lastCompleted) await openAnalysis(lastCompleted)
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : 'The local API could not be reached.')
    }
  }, [openAnalysis])

  useEffect(() => { void bootstrap() }, [bootstrap])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('irqguard-theme', theme)
  }, [theme])

  const navigate = (next: Page) => {
    setPage(next)
    setMobileNavOpen(false)
    setSelectedFindingIndex(null)
  }

  const openSource = useCallback(async (file: string, line: number) => {
    if (!active) return
    setPage('source')
    setSource(null)
    setSourceError('')
    setSourceLoading(true)
    try {
      setSource(await getSource(active.id, file, line))
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : 'Source text is unavailable.')
    } finally {
      setSourceLoading(false)
    }
  }, [active])

  const completeAnalysis = useCallback(async (metadata: AnalysisMetadata) => {
    setActive(metadata)
    setLoadingReport(true)
    try {
      const parsed = await getReport(metadata.id)
      setReport(parsed)
      setBackendError('')
      setPage('overview')
      setSelectedFindingIndex(null)
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : 'The analyzer report could not be loaded.')
    } finally {
      setLoadingReport(false)
    }
    await refreshHistory().catch(() => undefined)
  }, [refreshHistory])

  const activeStatus = active?.status ?? 'idle'
  const pageTitle = navItems.find((item) => item.id === page)?.label ?? 'Overview'

  return (
    <div className="app-shell">
      <Sidebar page={page} navigate={navigate} mobileOpen={mobileNavOpen} closeMobile={() => setMobileNavOpen(false)} />
      <div className="main-column">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Menu size={18} /></button>
          <div className="breadcrumb"><span>IRQGuard</span><span className="breadcrumb-sep">/</span><strong>{pageTitle}</strong></div>
          <div className="topbar-right">
            <div className="top-status"><span className={`status-dot ${health?.analyzer_available ? 'online' : ''}`} />{health?.analyzer_available ? 'Analyzer ready' : 'API status'}</div>
            <button className="icon-button theme-toggle" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button className="button button-primary button-small" onClick={() => navigate('new')}><Play size={14} />New analysis</button>
          </div>
        </header>

        <main className="main-content" key={page}>
          {backendError && <div className="alert alert-error" role="alert"><AlertCircle size={17} /><span>{backendError}</span><button className="icon-button alert-close" aria-label="Dismiss error" onClick={() => setBackendError('')}><X size={15} /></button></div>}

          {page === 'overview' && <OverviewPage
            active={active} report={report} history={history} health={health} loading={loadingReport}
            onNew={() => navigate('new')} onOpenHistory={() => navigate('history')}
            onOpenFinding={(index) => { setSelectedFindingIndex(index); navigate('findings') }}
            onOpenGraph={() => navigate('graph')}
            onSelectAnalysis={openAnalysis}
          />}
          {page === 'new' && <NewAnalysisPage health={health} status={activeStatus} onStart={async (values) => {
            setBackendError('')
            const started = await startAnalysis(values)
            const initial: AnalysisMetadata = {
              id: started.id, created_at: new Date().toISOString(), status: 'queued', source_path: values.source_path,
            }
            setActive(initial)
            setReport(null)
            setPage('new')
            await refreshHistory().catch(() => undefined)
            for (let attempt = 0; attempt < 185; attempt += 1) {
              await new Promise((resolve) => window.setTimeout(resolve, 1000))
              const latest = await getAnalysis(started.id)
              setActive(latest)
              if (latest.status === 'completed') { await completeAnalysis(latest); return }
              if (latest.status === 'failed') {
                setBackendError(latest.error ?? 'Analysis failed. See the run record for details.')
                await refreshHistory().catch(() => undefined)
                return
              }
            }
            setBackendError('The analysis is still running. You can reopen it from Analysis history.')
            await refreshHistory().catch(() => undefined)
          }} />}
          {page === 'history' && <HistoryPage
            history={history} activeId={active?.id} compareIds={compareIds}
            onRefresh={() => void refreshHistory().catch((error) => setBackendError(error.message))}
            onOpen={openAnalysis}
            onToggleCompare={(id) => setCompareIds((old) => old.includes(id) ? old.filter((item) => item !== id) : old.length < 2 ? [...old, id] : [old[1], id])}
          />}
          {page === 'findings' && <FindingsPage
            report={report} analysis={active} selectedIndex={selectedFindingIndex}
            onSelect={setSelectedFindingIndex} onOpenSource={openSource}
          />}
          {page === 'graph' && <GraphPage
            report={report} active={active} selectedFinding={selectedFinding}
            onSelectFinding={(finding) => setSelectedFindingIndex(finding ? findings.indexOf(finding) : null)}
            onOpenSource={openSource}
          />}
          {page === 'source' && <SourcePage
            report={report} snippet={source} loading={sourceLoading} error={sourceError}
            onOpenSource={openSource}
          />}
          {page === 'settings' && <SettingsPage health={health} onRefresh={() => void bootstrap()} />}
          {page === 'runtime' && <UnavailablePage title="Runtime evidence" icon={<Activity size={19} />} detail="No runtime instrumentation records are available in this project yet. This page will display recorded lock events only after a runtime evidence phase produces them." />}
          {page === 'benchmarks' && <UnavailablePage title="Benchmarks" icon={<Gauge size={19} />} detail="No benchmark record format or benchmark runner is implemented yet. Analysis time shown in history is measured by the local backend for each real run; it is not a benchmark result." />}
        </main>
        <footer className="app-footer"><span>IRQGuard · local analysis workspace</span><span>Static candidates are evidence for review, not confirmed deadlocks.</span></footer>
      </div>
    </div>
  )
}

function Sidebar({ page, navigate, mobileOpen, closeMobile }: { page: Page; navigate: (page: Page) => void; mobileOpen: boolean; closeMobile: () => void }) {
  const sections = ['Workspace', 'Analysis', 'Evidence', 'System']
  return <>
    {mobileOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={closeMobile} />}
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
      <div className="brand-lockup"><div className="brand-mark"><LockKeyhole size={17} strokeWidth={2.2} /></div><div><div className="brand-name">IRQGuard</div><div className="brand-caption">STATIC ANALYSIS</div></div></div>
      <div className="workspace-switcher"><div className="workspace-avatar">OS</div><div className="workspace-copy"><strong>Local workspace</strong><span>WSL · Ubuntu</span></div><ChevronDown size={15} /></div>
      <nav aria-label="Primary navigation" className="sidebar-nav">
        {sections.map((section) => <div className="nav-section" key={section}>
          <div className="nav-section-title">{section}</div>
          {navItems.filter((item) => item.section === section).map((item) => {
            const Icon = item.icon
            return <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''} ${item.unavailable ? 'nav-planned' : ''}`}
              onClick={() => navigate(item.id)}
              title={item.unavailable ? `${item.label} is not implemented yet` : undefined}>
              <Icon size={16} strokeWidth={1.8} /><span>{item.label}</span>{item.unavailable && <span className="nav-soon">Unavailable</span>}
            </button>
          })}
        </div>)}
      </nav>
      <div className="sidebar-bottom"><div className="local-only"><span className="local-dot" /><span>Local-only API</span><span className="local-tag">127.0.0.1</span></div><div className="sidebar-version">Analyzer report schema 3</div></div>
    </aside>
  </>
}

function PageHeading({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>{action && <div className="heading-action">{action}</div>}</div>
}

function OverviewPage({ active, report, history, health, loading, onNew, onOpenHistory, onOpenFinding, onOpenGraph, onSelectAnalysis }: {
  active: AnalysisMetadata | null; report: AnalysisReport | null; history: AnalysisMetadata[]; health: Health | null; loading: boolean;
  onNew: () => void; onOpenHistory: () => void; onOpenFinding: (index: number) => void; onOpenGraph: () => void; onSelectAnalysis: (item: AnalysisMetadata) => void;
}) {
  const summary = active?.summary
  const successful = active?.status === 'completed' && report
  const metrics = [
    { label: 'Translation units', value: summary?.translation_units, icon: FileCode2, note: 'Submitted source units' },
    { label: 'Functions', value: summary?.functions, icon: Braces, note: 'Definitions extracted' },
    { label: 'Lock operations', value: summary?.lock_operations, icon: LockKeyhole, note: 'Configured API calls' },
    { label: 'Dependency edges', value: summary?.graph_edges, icon: GitBranch, note: 'Context-labelled graph' },
    { label: 'Potential cycles', value: summary?.candidate_cycles, icon: ShieldAlert, note: 'Static candidates' },
  ]
  const chartRuns = [...history].filter((item) => item.status === 'completed' && item.duration_ms != null).slice(0, 8).reverse().map((item) => ({ name: basename(item.source_path), duration: item.duration_ms }))
  return <>
    <PageHeading eyebrow="WORKSPACE OVERVIEW" title="Analysis overview" subtitle={active ? `Latest report · ${basename(active.source_path)}` : 'Run a source analysis to inspect lock behavior and interrupt-aware findings.'}
      action={<button className="button button-primary" onClick={onNew}><Play size={15} />New analysis</button>} />
    {!health?.analyzer_available && <div className="inline-notice"><AlertCircle size={16} /><span>The local analyzer executable is unavailable. Build it with CMake, then refresh this page.</span></div>}
    {active && <div className="run-strip"><span className={`status-dot status-${statusTone(active.status)}`} /><span className="run-strip-label">{active.status === 'completed' ? 'Latest analysis' : active.status === 'running' ? 'Analysis running' : active.status === 'queued' ? 'Analysis queued' : active.status === 'failed' ? 'Analysis failed' : 'No run selected'}</span><code>{active.source_path}</code><span className="run-time">{new Date(active.created_at).toLocaleString()}</span><span className={`status-pill ${statusTone(active.status)}`}>{active.status}</span></div>}
    {loading && <div className="loading-line"><LoaderCircle size={16} className="spin" />Loading report from local history…</div>}
    {!active && history.length === 0 && !loading ? <div className="empty-workspace">
      <div className="empty-glyph"><TerminalSquare size={24} /></div><div className="eyebrow">NO ANALYSIS RUNS</div><h2>Start with a C source file</h2>
      <p>IRQGuard invokes the Clang-based analyzer on your WSL workspace and stores the resulting JSON report locally.</p>
      <button className="button button-primary" onClick={onNew}><Play size={15} />Configure analysis</button>
      <div className="empty-help"><Info size={14} />The browser cannot browse your WSL files. Enter an absolute path from an allowed workspace.</div>
    </div> : null}
    {active && !successful && !loading && <div className="empty-workspace compact-empty">
      {active.status === 'failed' ? <><div className="empty-glyph danger-glyph"><AlertCircle size={23} /></div><div className="eyebrow">RUN FAILED</div><h2>Analyzer did not produce a report</h2><p>{active.error ?? 'Open analysis history for the recorded process status.'}</p><button className="button button-secondary" onClick={onOpenHistory}>View analysis history</button></> : <><div className="empty-glyph"><LoaderCircle size={23} className="spin" /></div><div className="eyebrow">ANALYSIS IN PROGRESS</div><h2>Waiting for the analyzer</h2><p>The backend reports status only. It does not provide percentage progress.</p></>}
    </div>}
    {successful && <>
      <section className="metrics-row" aria-label="Analysis metrics">
        {metrics.map(({ label, value, icon: Icon, note }) => <div className="metric" key={label}><div className="metric-head"><span>{label}</span><Icon size={15} /></div><strong>{value == null ? 'Not available' : value.toLocaleString()}</strong><small>{note}</small></div>)}
      </section>
      <section className="overview-grid">
        <div className="panel findings-preview">
          <div className="panel-heading"><div><div className="eyebrow">REVIEW QUEUE</div><h2>Recent findings</h2></div><button className="text-button" onClick={() => onOpenFinding(0)} disabled={!report.interrupt_cycles.length}>View all <ArrowRight size={14} /></button></div>
          {report.interrupt_cycles.length === 0 ? <div className="panel-empty"><Check size={17} /><span>No cycles were reported for this translation unit.</span></div> : <div className="finding-preview-list">
            {report.interrupt_cycles.slice(0, 4).map((finding, index) => <button className="preview-row" key={findingId(finding, index, active.id)} onClick={() => onOpenFinding(index)}>
              <span className={`finding-mark ${finding.category}`}><LockKeyhole size={14} /></span><span className="preview-copy"><strong>{categoryLabel(finding.category)}</strong><small>{finding.lock_sequence?.map((lock) => shortLock(lock)).join(' → ') ?? 'Cycle sequence unavailable'}</small></span><ArrowRight size={14} className="row-arrow" />
            </button>)}
          </div>}
        </div>
        <div className="panel graph-preview-panel">
          <div className="panel-heading"><div><div className="eyebrow">DEPENDENCY GRAPH</div><h2>Lock relationships</h2></div><button className="icon-button" aria-label="Open lock graph" onClick={onOpenGraph}><ArrowUpRight size={16} /></button></div>
          <GraphPreview report={report} onOpen={onOpenGraph} />
          <div className="graph-preview-foot"><span><i className="legend-dot normal" />Lock order</span><span><i className="legend-dot irq" />IRQ preemption</span><button className="text-button" onClick={onOpenGraph}>Explore graph <ArrowRight size={13} /></button></div>
        </div>
      </section>
      <section className="panel recent-runs-panel">
        <div className="panel-heading"><div><div className="eyebrow">LOCAL HISTORY</div><h2>Recent analyses</h2></div><button className="text-button" onClick={onOpenHistory}>All runs <ArrowRight size={14} /></button></div>
        <div className="recent-runs-list">{history.slice(0, 4).map((item) => <button className={`recent-run-row ${item.id === active.id ? 'selected' : ''}`} key={item.id} onClick={() => onSelectAnalysis(item)}><span className={`status-dot status-${statusTone(item.status)}`} /><span className="recent-run-copy"><strong>{basename(item.source_path)}</strong><small>{item.source_path}</small></span><span className="recent-run-date">{new Date(item.created_at).toLocaleString()}</span><span className={`status-pill ${statusTone(item.status)}`}>{item.status}</span><ArrowRight size={13} /></button>)}{history.length === 0 && <div className="panel-empty"><Info size={16} />No runs have been stored yet.</div>}</div>
      </section>
      <section className="overview-grid lower-grid">
        <div className="panel run-summary-panel">
          <div className="panel-heading"><div><div className="eyebrow">REPORT QUALITY</div><h2>Analysis notes</h2></div><span className="schema-tag">JSON schema {report.schema_version}</span></div>
          <div className="quality-row"><span>Candidate lock-order cycles</span><strong>{summary?.finding_categories?.candidate_lock_order_cycle ?? 'Not available'}</strong></div>
          <div className="quality-row"><span>Interrupt-aware candidates</span><strong>{summary?.finding_categories?.interrupt_aware_candidate ?? 'Not available'}</strong></div>
          <div className="quality-row"><span>Rejected candidates</span><strong>{summary?.rejected_candidates ?? 'Not available'}</strong></div>
          <div className="quality-row"><span>Inconclusive findings</span><strong>{summary?.inconclusive_findings ?? 'Not available'}</strong></div>
          <div className="quality-row"><span>Uncertainties in report</span><strong>{summary?.uncertainties ?? 'Not available'}</strong></div>
          <p className="panel-note">Cycle categories are static-analysis outcomes, not calibrated probabilities or confirmed runtime deadlocks.</p>
        </div>
        <div className="panel duration-panel">
          <div className="panel-heading"><div><div className="eyebrow">LOCAL RUN METADATA</div><h2>Analysis duration</h2></div><Clock3 size={16} className="subtle-icon" /></div>
          {chartRuns.length > 0 ? <><div className="duration-current">{formatDuration(active.duration_ms)}<span>current run · backend measured</span></div><div className="duration-chart"><Suspense fallback={<div className="chart-unavailable">Loading duration chart…</div>}><DurationChart data={chartRuns} /></Suspense></div></> : <div className="chart-unavailable"><Info size={15} /><span>Not available until a completed run records backend duration.</span></div>}
        </div>
      </section>
      <div className="overview-bottomline"><span><Check size={14} />Report loaded from the local analysis history</span><button className="text-button" onClick={onOpenHistory}>All runs <ArrowRight size={14} /></button></div>
    </>}
  </>
}

function GraphPreview({ report, onOpen }: { report: AnalysisReport; onOpen: () => void }) {
  const edges = report.interrupt_lock_graph.edges.slice(0, 5)
  if (!edges.length) return <button className="mini-empty" onClick={onOpen}><GitBranch size={20} /><span>No lock dependencies in this report</span><small>Open graph view</small></button>
  const ids = [...new Set(edges.flatMap((edge) => [edge.from_lock, edge.to_lock]))]
  const points = new Map(ids.map((id, index) => {
    const angle = 2 * Math.PI * index / Math.max(ids.length, 1) - Math.PI / 2
    return [id, [200 + Math.cos(angle) * Math.min(145, 55 + ids.length * 17), 74 + Math.sin(angle) * 42] as [number, number]]
  }))
  return <button className="mini-graph" onClick={onOpen} aria-label="Open lock dependency graph">
    <svg viewBox="0 0 400 148" role="img" aria-label={`${edges.length} lock edges preview`}>
      <defs><marker id="miniArrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 z" fill="#596678" /></marker><marker id="miniRedArrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 z" fill="#f0786e" /></marker></defs>
      {edges.map((edge, index) => {
        const from = points.get(edge.from_lock) ?? [0, 0]
        const to = points.get(edge.to_lock) ?? [0, 0]
        const interrupt = edge.kind.includes('interrupt')
        return <g key={`${edge.from_lock}-${edge.to_lock}-${index}`}><path d={`M${from[0]} ${from[1]} Q${(from[0] + to[0]) / 2} ${(from[1] + to[1]) / 2 - 11} ${to[0]} ${to[1]}`} stroke={interrupt ? '#f0786e' : '#566274'} strokeWidth="1.4" fill="none" strokeDasharray={edge.feasibility === 'rejected' ? '4 4' : undefined} markerEnd={interrupt ? 'url(#miniRedArrow)' : 'url(#miniArrow)'} /></g>
      })}
      {ids.map((id) => { const point = points.get(id) ?? [0, 0]; return <g key={id}><rect x={point[0] - 39} y={point[1] - 14} width="78" height="28" rx="5" fill="#161c23" stroke="#394553" /><text x={point[0]} y={point[1] + 3} textAnchor="middle" fill="#c9d2de" fontSize="9" fontFamily="monospace">{shortLock(id).slice(0, 12)}</text></g> })}
    </svg>
  </button>
}

function NewAnalysisPage({ health, status, onStart }: { health: Health | null; status: string; onStart: (values: { source_path: string; compile_commands_path?: string; api_config_path?: string }) => Promise<void> }) {
  const [sourcePath, setSourcePath] = useState('')
  const [compilationPath, setCompilationPath] = useState('')
  const [apiConfigPath, setApiConfigPath] = useState('')
  const [formError, setFormError] = useState('')
  const [starting, setStarting] = useState(false)
  const [requestError, setRequestError] = useState('')
  const allowed = health?.workspace_roots ?? []
  const sourceLooksInRoot = !sourcePath || allowed.some((root) => sourcePath === root || sourcePath.startsWith(`${root}/`))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setFormError(''); setRequestError('')
    if (!sourcePath.startsWith('/')) { setFormError('Enter an absolute WSL/Linux path to a .c or .h file.'); return }
    if (!sourceLooksInRoot) { setFormError('The source path is outside the configured workspace roots shown below.'); return }
    setStarting(true)
    try {
      await onStart({ source_path: sourcePath, ...(compilationPath ? { compile_commands_path: compilationPath } : {}), ...(apiConfigPath ? { api_config_path: apiConfigPath } : {}) })
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Could not start analysis.')
      setStarting(false)
    }
  }
  const running = starting || status === 'queued' || status === 'running'
  return <>
    <PageHeading eyebrow="NEW RUN" title="Analyze source" subtitle="Submit one C translation unit to the local Clang analyzer." />
    <div className="analysis-layout">
      <form className="analysis-form" onSubmit={submit}>
        <div className="form-section-title"><span className="step-number">01</span><div><h2>Source input</h2><p>Paths are resolved by the WSL backend, not by this browser.</p></div></div>
        <label className="field-label" htmlFor="source-path">Source file path <span>Required</span></label>
        <div className="path-input-wrap"><FileCode2 size={16} /><input id="source-path" value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="/home/user/project/src/example.c" autoComplete="off" disabled={running} /></div>
        <div className={`field-hint ${!sourceLooksInRoot ? 'hint-danger' : ''}`}>{sourceLooksInRoot ? 'Absolute path inside an allowed workspace.' : 'This path does not start with an allowed workspace root.'}</div>
        <div className="workspace-roots"><div className="workspace-roots-title">Allowed workspace roots</div>{allowed.length ? allowed.map((root) => <code key={root}>{root}</code>) : <span className="muted">Unavailable until the backend connects.</span>}</div>
        <label className="field-label" htmlFor="compile-path">Compilation database <span>Optional</span></label>
        <div className="path-input-wrap"><Database size={16} /><input id="compile-path" value={compilationPath} onChange={(event) => setCompilationPath(event.target.value)} placeholder="/home/user/project/build/compile_commands.json" autoComplete="off" disabled={running} /></div>
        <div className="field-hint">Accepts a build directory or the compile_commands.json file itself.</div>
        <label className="field-label" htmlFor="api-config">API registry JSON <span>Optional</span></label>
        <div className="path-input-wrap"><Braces size={16} /><input id="api-config" value={apiConfigPath} onChange={(event) => setApiConfigPath(event.target.value)} placeholder="/home/user/project/apis.json" autoComplete="off" disabled={running} /></div>
        <div className="field-hint">Overrides or extends supported lock and interrupt API models.</div>
        {(formError || requestError) && <div className="form-error" role="alert"><AlertCircle size={15} />{formError || requestError}</div>}
        {running ? <div className="running-state" role="status"><LoaderCircle size={17} className="spin" /><span><strong>{status === 'queued' ? 'Queued for analysis' : 'Running analysis…'}</strong><small>The backend reports no percentage progress. You can keep this page open.</small></span></div> : <button type="submit" className="button button-primary submit-analysis" disabled={!health?.analyzer_available || !sourcePath}><Play size={15} />Start analysis</button>}
        {!health?.analyzer_available && <div className="field-hint hint-danger">Analyzer executable unavailable. Build the C++ analyzer before starting.</div>}
      </form>
      <aside className="analysis-aside">
        <div className="aside-section"><div className="eyebrow">WHAT WILL RUN</div><div className="command-preview"><span className="command-prompt">$</span><code>deadlock-analyzer analyze<br />--source &lt;path&gt;<br />--format json</code></div><div className="aside-note"><TerminalSquare size={15} /><span>Started with a fixed argument list. Browser input is never interpreted as a shell command.</span></div></div>
        <div className="aside-section"><div className="eyebrow">REPORT OUTPUT</div><div className="output-list"><span><Check size={14} />Clang AST and CFG facts</span><span><Check size={14} />Interprocedural lock edges</span><span><Check size={14} />Process and hardirq contexts</span><span><Check size={14} />Schema 3 JSON with provenance</span></div></div>
        <div className="aside-warning"><Info size={16} /><p>One translation unit is analyzed per run. Included header definitions and full-kernel coverage are not implied.</p></div>
      </aside>
    </div>
  </>
}

function HistoryPage({ history, activeId, compareIds, onRefresh, onOpen, onToggleCompare }: {
  history: AnalysisMetadata[]; activeId?: string; compareIds: string[]; onRefresh: () => void; onOpen: (metadata: AnalysisMetadata) => void; onToggleCompare: (id: string) => void;
}) {
  const selected = history.filter((item) => compareIds.includes(item.id))
  return <>
    <PageHeading eyebrow="LOCAL RUNS" title="Analysis history" subtitle="Completed reports and failures are stored in your local IRQGuard data directory." action={<button className="button button-secondary" onClick={onRefresh}><RefreshCw size={14} />Refresh</button>} />
    {!history.length ? <div className="empty-panel"><History size={20} /><h2>No saved analyses</h2><p>Completed reports and failed run metadata will appear here.</p></div> : <div className="history-surface">
      <div className="table-toolbar"><div><strong>{history.length}</strong> stored runs <span className="muted">· newest first</span></div><span className="muted">Select up to two compatible reports to compare summary counts.</span></div>
      <div className="history-list">
        {history.map((item) => <div className={`history-row ${item.id === activeId ? 'selected' : ''}`} key={item.id}>
          <label className="compare-check" title="Select for summary comparison"><input type="checkbox" checked={compareIds.includes(item.id)} onChange={() => onToggleCompare(item.id)} /><span /></label>
          <span className={`history-status ${statusTone(item.status)}`}><span className="status-dot" /></span>
          <div className="history-main"><div className="history-title"><strong>{basename(item.source_path)}</strong><code>{item.source_path}</code></div><div className="history-meta"><span>{new Date(item.created_at).toLocaleString()}</span><span>schema {item.analyzer_schema_version ?? 'not available'}</span>{item.duration_ms != null && <span>{formatDuration(item.duration_ms)}</span>}</div></div>
          <div className="history-counts"><span><Braces size={13} />{item.summary?.functions ?? '—'}</span><span><GitBranch size={13} />{item.summary?.graph_edges ?? '—'}</span><span><ShieldAlert size={13} />{item.summary?.candidate_cycles ?? '—'}</span></div>
          <span className={`status-pill ${statusTone(item.status)}`}>{item.status}</span>
          <button className="icon-button open-run" onClick={() => onOpen(item)} aria-label={`Open analysis ${basename(item.source_path)}`}><ArrowRight size={15} /></button>
        </div>)}
      </div>
    </div>}
    {selected.length === 2 && <div className="compare-panel"><div className="panel-heading"><div><div className="eyebrow">RUN COMPARISON</div><h2>Summary counts</h2></div><span className="schema-tag">{selected[0].analyzer_schema_version === selected[1].analyzer_schema_version ? `Schema ${selected[0].analyzer_schema_version ?? 'unknown'}` : 'Incompatible schemas'}</span></div>
      {selected[0].analyzer_schema_version !== selected[1].analyzer_schema_version ? <div className="inline-notice"><Info size={16} />Report schemas differ. Counts are shown separately and should not be compared directly.</div> : null}
      <div className="compare-grid"><span>Metric</span><strong>{basename(selected[0].source_path)}</strong><strong>{basename(selected[1].source_path)}</strong>{[['Functions', 'functions'], ['Lock operations', 'lock_operations'], ['Graph edges', 'graph_edges'], ['Candidate cycles', 'candidate_cycles'], ['Rejected', 'rejected_candidates'], ['Inconclusive', 'inconclusive_findings']].map(([label, key]) => <Fragment key={key}><span>{label}</span><span>{compareMetric(selected[0], key)}</span><span>{compareMetric(selected[1], key)}</span></Fragment>)}</div>
    </div>}
  </>
}

function FindingsPage({ report, analysis, selectedIndex, onSelect, onOpenSource }: {
  report: AnalysisReport | null; analysis: AnalysisMetadata | null; selectedIndex: number | null; onSelect: (index: number | null) => void; onOpenSource: (file: string, line: number) => void;
}) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [sort, setSort] = useState<'category' | 'file'>('category')
  const [page, setPage] = useState(0)
  const [exportMessage, setExportMessage] = useState('')
  const cycles = report?.interrupt_cycles ?? []
  const filtered = cycles.map((finding, index) => ({ finding, index, id: findingId(finding, index, analysis?.id) })).filter(({ finding, id }) => {
    const text = [id, finding.category, finding.explanation, ...(finding.lock_sequence ?? [])].join(' ').toLowerCase()
    return (category === 'all' || finding.category === category) && text.includes(search.toLowerCase())
  }).sort((a, b) => sort === 'category' ? a.finding.category.localeCompare(b.finding.category) : firstFindingFile(a.finding).localeCompare(firstFindingFile(b.finding)))
  const pageSize = 25
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const visible = filtered.slice(page * pageSize, (page + 1) * pageSize)
  const categories = [...new Set(cycles.map((finding) => finding.category))]
  const exportJson = () => {
    if (!report) return
    const blob = new Blob([JSON.stringify({ schema_version: report.schema_version, source: report.source, interrupt_cycles: report.interrupt_cycles }, null, 2)], { type: 'application/json' })
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `irqguard-findings-${analysis?.id ?? 'report'}.json`; link.click(); URL.revokeObjectURL(link.href)
    setExportMessage('Findings JSON exported.')
  }
  return <>
    <PageHeading eyebrow="STATIC ANALYSIS" title="Findings" subtitle="Review candidate lock cycles and the source evidence included in the analyzer report." action={<button className="button button-secondary" onClick={exportJson} disabled={!report}><FileJson2 size={15} />Export JSON</button>} />
    {!report ? <AnalysisEmpty /> : <>
      <div className="finding-countline"><span><strong>{filtered.length}</strong> of {cycles.length} findings</span><span>Static candidates are not confirmed deadlocks.</span></div>
      <FindingsTable findings={visible.map(({ finding, index, id }) => ({ finding, index, id }))} selectedIndex={selectedIndex}
        search={search} onSearch={(value) => { setSearch(value); setPage(0) }} category={category} onCategory={(value) => { setCategory(value); setPage(0) }} categories={categories} sort={sort} onSort={setSort} onSelect={onSelect} />
      {filtered.length === 0 && <div className="table-empty"><Search size={17} /><span>No findings match these filters.</span></div>}
      {pageCount > 1 && <div className="pagination"><span>Page {page + 1} of {pageCount} · showing up to 25</span><div><button className="button button-small button-secondary" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={page === 0}>Previous</button><button className="button button-small button-secondary" onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} disabled={page + 1 >= pageCount}>Next</button></div></div>}
      {selectedIndex != null && cycles[selectedIndex] && <FindingDetail finding={cycles[selectedIndex]} id={findingId(cycles[selectedIndex], selectedIndex, analysis?.id)} onClose={() => onSelect(null)} onOpenSource={onOpenSource} />}
      {exportMessage && <div className="toast" role="status"><Check size={14} />{exportMessage}<button onClick={() => setExportMessage('')} aria-label="Dismiss export message"><X size={13} /></button></div>}
    </>}
  </>
}

function FindingsTable({ findings, selectedIndex, search, onSearch, category, onCategory, categories, sort, onSort, onSelect }: {
  findings: Array<{ finding: Finding; index: number; id: string }>; selectedIndex: number | null; search: string; onSearch: (value: string) => void;
  category: string; onCategory: (value: string) => void; categories: string[]; sort: 'category' | 'file'; onSort: (value: 'category' | 'file') => void; onSelect: (index: number) => void;
}) {
  return <div className="findings-table-wrap">
    <div className="table-toolbar"><div className="toolbar-search"><Search size={15} /><input aria-label="Search findings" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search findings, locks, explanations…" /></div>
      <div className="toolbar-filters"><label><span>Category</span><select aria-label="Filter findings by category" value={category} onChange={(event) => onCategory(event.target.value)}><option value="all">All categories</option>{categories.map((item) => <option value={item} key={item}>{categoryLabel(item)}</option>)}</select></label><label><span>Sort</span><select aria-label="Sort findings" value={sort} onChange={(event) => onSort(event.target.value as 'category' | 'file')}><option value="category">Category</option><option value="file">Source file</option></select></label></div>
    </div>
    <div className="finding-table" role="table" aria-label="Analyzer findings"><div className="finding-table-header" role="row"><span>Finding</span><span>Lock sequence</span><span>Evidence location</span><span>Feasibility</span><span /></div>
      {findings.map(({ finding, index, id }) => {
        const place = firstFindingLocation(finding)
        return <button role="row" className={`finding-table-row ${selectedIndex === index ? 'row-selected' : ''}`} key={id} onClick={() => onSelect(index)}>
          <span className="finding-table-title"><i className={`finding-mini-dot ${finding.category}`} /><span><strong>{categoryLabel(finding.category)}</strong><small>{id}</small></span></span>
          <span className="lock-sequence-cell">{finding.lock_sequence?.slice(0, 4).map(shortLock).join(' → ') ?? 'Unavailable'}</span>
          <span className="location-cell"><code>{place ? `${basename(place.file)}:${place.line}` : 'Not available'}</code></span>
          <span className={`feasibility-label ${finding.feasibility ?? 'unknown'}`}>{finding.feasibility ?? 'Not available'}</span><ArrowRight size={14} className="row-arrow" />
        </button>
      })}
    </div>
  </div>
}

function FindingDetail({ finding, id, onClose, onOpenSource }: { finding: Finding; id: string; onClose: () => void; onOpenSource: (file: string, line: number) => void }) {
  const edges = finding.edges ?? []
  return <div className="detail-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="finding-detail" role="dialog" aria-modal="true" aria-labelledby="finding-detail-title">
      <header className="detail-header"><div><div className="eyebrow">FINDING EVIDENCE · {id}</div><h2 id="finding-detail-title">{categoryLabel(finding.category)}</h2></div><button className="icon-button" aria-label="Close finding details" onClick={onClose}><X size={17} /></button></header>
      <div className={`detail-status-line ${finding.category}`}><ShieldCheck size={15} /><span>{finding.feasibility ?? 'Feasibility not reported'}</span><span>{finding.contains_uncertain_edge ? 'Contains uncertain edge' : 'No uncertain edge recorded'}</span></div>
      <p className="detail-explanation">{finding.explanation ?? 'The analyzer did not provide an explanation for this finding.'}</p>
      <div className="detail-section"><div className="eyebrow">ORDERED LOCK SEQUENCE</div><div className="cycle-sequence">{(finding.lock_sequence ?? []).map((lock, index) => <span key={`${lock}-${index}`}><code>{shortLock(lock)}</code>{index < (finding.lock_sequence?.length ?? 0) - 1 && <ArrowRight size={13} />}</span>)}</div></div>
      <div className="detail-section"><div className="eyebrow">EDGE PROVENANCE · {edges.length}</div><div className="detail-edge-list">{edges.map((edge, index) => {
        const sourcePoint = locationOf(edge.from_location)
        const targetPoint = locationOf(edge.to_location)
        return <article className="detail-edge" key={`${edge.kind}-${index}`}><div className="detail-edge-top"><span className="edge-order">{String(index + 1).padStart(2, '0')}</span><strong>{shortLock(edge.from_lock)} <ArrowRight size={12} /> {shortLock(edge.to_lock)}</strong><span className={`edge-kind ${edge.kind}`}>{edge.kind}</span></div><div className="edge-meta"><span>{edge.from_context ?? 'context unavailable'} → {edge.to_context ?? 'context unavailable'}</span><span>{edge.source_function ?? 'function unavailable'} → {edge.target_function ?? 'function unavailable'}</span></div>
          <div className="edge-locations">{[[sourcePoint, 'Acquisition from'], [targetPoint, 'Acquisition to']].map(([place, label], locationIndex) => place ? <button className="source-link" key={locationIndex} onClick={() => onOpenSource((place as {file:string;line:number}).file, (place as {file:string;line:number}).line)}><FileCode2 size={12} />{label as string} · {basename((place as {file:string}).file)}:{(place as {line:number}).line}</button> : null)}{edge.registration_location && locationOf(edge.registration_location) && <span className="registration-location">Handler registration · {basename(locationOf(edge.registration_location)!.file)}:{locationOf(edge.registration_location)!.line}</span>}</div>
          {(edge.irq_state && edge.irq_state !== 'not_applicable') && <div className="irq-state-line">IRQ state: <strong>{edge.irq_state}</strong>{edge.handler && <span>· handler {edge.handler}</span>}</div>}
          {edge.feasibility_reason && <div className="edge-reason"><Info size={13} />{edge.feasibility_reason}</div>}
        </article>
      })}</div></div>
      {finding.provenance_variants && finding.provenance_variants.length > 1 && <div className="variant-note"><GitBranch size={14} />{finding.provenance_variants.length} equivalent provenance paths are grouped in this finding.</div>}
      <div className="detail-footnote"><Info size={14} /><span>A cycle is a static candidate. It does not establish that the locks alias at runtime, that the handler will run, or that a deadlock occurred.</span></div>
    </section>
  </div>
}

function GraphPage({ report, active, selectedFinding, onSelectFinding, onOpenSource }: {
  report: AnalysisReport | null; active: AnalysisMetadata | null; selectedFinding: Finding | null; onSelectFinding: (finding: Finding | null) => void; onOpenSource: (file: string, line: number) => void;
}) {
  return <>
    <PageHeading eyebrow="LOCK ORDER MODEL" title="Lock dependency graph" subtitle={active ? `Actual graph edges from ${basename(active.source_path)} · select an edge for provenance.` : 'Select a completed analysis to inspect its graph.'} />
    {!report ? <AnalysisEmpty /> : <div className="graph-workspace"><Suspense fallback={<div className="loading-line graph-loading"><LoaderCircle size={16} className="spin" />Loading lock graph…</div>}><LockGraph report={report} selectedFinding={selectedFinding} onSelectFinding={onSelectFinding} onOpenSource={onOpenSource} /></Suspense></div>}
  </>
}

function SourcePage({ report, snippet, loading, error, onOpenSource }: { report: AnalysisReport | null; snippet: SourceSnippet | null; loading: boolean; error: string; onOpenSource: (file: string, line: number) => void }) {
  const [filter, setFilter] = useState('')
  const symbols = useMemo(() => {
    if (!report) return []
    const functionRows = report.functions.map((item) => ({ type: 'Function', name: item.qualified_name ?? item.name ?? 'Unnamed function', location: locationOf(item.location), detail: item.cfg_available === false ? 'CFG unavailable' : 'Function definition' }))
    const lockRows = report.api_operations.filter((item) => item.lock).map((item) => ({ type: item.kind ?? 'Lock operation', name: item.lock?.expression ?? item.api ?? 'Lock operation', location: locationOf(item.lock?.location) ?? locationOf(item.location), detail: `${item.caller ?? 'Unknown function'} · ${item.api ?? 'API'}` }))
    const callRows = report.calls.map((item) => ({ type: 'Call', name: item.callee_expression ?? item.callee ?? 'Unresolved call', location: locationOf(item.location), detail: `${item.caller ?? 'Unknown function'} → ${(item.target_names ?? []).join(', ') || item.resolution || 'unresolved'}` }))
    return [...functionRows, ...callRows, ...lockRows].filter((item) => `${item.type} ${item.name} ${item.location?.file ?? ''} ${item.detail}`.toLowerCase().includes(filter.toLowerCase()))
  }, [filter, report])
  return <>
    <PageHeading eyebrow="SOURCE NAVIGATION" title="Source explorer" subtitle="Navigate extracted function and lock locations from the selected analyzer report." />
    {!report ? <AnalysisEmpty /> : <div className="source-explorer">
      <section className="source-symbols"><div className="source-symbol-header"><div><div className="eyebrow">EXTRACTED SYMBOLS</div><strong>{symbols.length} entries</strong></div><label className="symbol-search"><Search size={14} /><input aria-label="Search source symbols" placeholder="Filter symbols…" value={filter} onChange={(event) => setFilter(event.target.value)} /></label></div>
        <div className="symbol-list">{symbols.map((item, index) => <button className="symbol-row" key={`${item.type}-${item.name}-${index}`} disabled={!item.location} onClick={() => item.location && onOpenSource(item.location.file, item.location.line)}><span className={`symbol-icon ${item.type === 'Function' ? 'function-icon' : ''}`}>{item.type === 'Function' ? <Braces size={14} /> : <LockKeyhole size={14} />}</span><span className="symbol-copy"><strong>{item.name}</strong><small>{item.detail}</small></span><code>{item.location ? `${basename(item.location.file)}:${item.location.line}` : 'Location unavailable'}</code><ArrowRight size={13} /></button>)}{symbols.length === 0 && <div className="table-empty">No extracted symbols match.</div>}</div>
      </section>
      <section className="source-viewer"><div className="source-viewer-heading"><div><div className="eyebrow">SOURCE SNIPPET</div><strong>{snippet ? `${snippet.file}:${snippet.requested_line}` : 'Select a symbol or finding edge'}</strong></div>{snippet && <span className="source-readonly"><BookOpen size={13} />Read only</span>}</div>
        {loading ? <div className="source-placeholder"><LoaderCircle size={18} className="spin" />Loading source range…</div> : error ? <div className="source-placeholder source-error"><AlertCircle size={18} /><span>{error}</span></div> : snippet ? <div className="code-window" role="region" aria-label={`Source at line ${snippet.requested_line}`}><div className="code-lines">{snippet.lines.map((line) => <div className={`code-line ${line.highlighted ? 'highlighted' : ''}`} key={line.line}><span>{line.line}</span><code>{highlightCLine(line.text || ' ')}</code></div>)}</div></div> : <div className="source-placeholder"><FileSearch size={22} /><span>Source text appears here when requested from a report location.</span><small>Only bounded line ranges for files referenced in the report are served.</small></div>}
      </section>
    </div>}
  </>
}

function SettingsPage({ health, onRefresh }: { health: Health | null; onRefresh: () => void }) {
  return <>
    <PageHeading eyebrow="LOCAL CONFIGURATION" title="Settings" subtitle="Backend roots and analyzer paths are configured in the local service environment." action={<button className="button button-secondary" onClick={onRefresh}><RefreshCw size={14} />Refresh status</button>} />
    <div className="settings-layout"><section className="settings-section"><div className="eyebrow">ANALYZER CONNECTION</div><div className="settings-row"><span>Local API</span><strong className={health ? 'value-good' : 'value-bad'}>{health ? 'Connected' : 'Unavailable'}</strong></div><div className="settings-row"><span>Analyzer executable</span><code>{health?.analyzer_path ?? 'Not available'}</code></div><div className="settings-row"><span>Analyzer status</span><strong className={health?.analyzer_available ? 'value-good' : 'value-bad'}>{health?.analyzer_available ? 'Ready' : 'Not available'}</strong></div><div className="settings-row"><span>Accepted JSON schema</span><strong>{health?.analyzer_report_schema ?? 'Not available'}</strong></div><div className="settings-row"><span>API version</span><strong>{health?.api_version ?? 'Not available'}</strong></div></section>
      <section className="settings-section"><div className="eyebrow">FILESYSTEM ACCESS</div><p className="settings-description">Analysis paths are restricted by the backend to these explicitly configured workspace roots. Symlinks are resolved before validation.</p>{health?.workspace_roots.length ? health.workspace_roots.map((root) => <div className="root-row" key={root}><HardDrive size={15} /><code>{root}</code></div>) : <div className="field-hint hint-danger">Workspace roots are unavailable because the backend is not connected.</div>}<div className="settings-row"><span>Report and history storage</span><code>{health?.data_directory ?? 'Not available'}</code></div></section>
      <section className="settings-section settings-capabilities"><div className="eyebrow">FEATURE AVAILABILITY</div><div className="settings-row"><span>Static source analysis</span><strong className="value-good">Available</strong></div><div className="settings-row"><span>Runtime evidence</span><strong>{health?.runtime_evidence_available ? 'Available' : 'Not implemented yet'}</strong></div><div className="settings-row"><span>Benchmarks</span><strong>{health?.benchmarks_available ? 'Available' : 'Not implemented yet'}</strong></div></section></div>
  </>
}

function UnavailablePage({ title, icon, detail }: { title: string; icon: ReactNode; detail: string }) {
  return <><PageHeading eyebrow="CAPABILITY STATUS" title={title} subtitle="This area is not represented as implemented functionality." /><div className="unavailable-panel"><div className="unavailable-icon">{icon}</div><div><div className="eyebrow">NOT IMPLEMENTED YET</div><h2>{title} data is not available</h2><p>{detail}</p><div className="required-contract"><strong>Required backend contract</strong><code>{title === 'Runtime evidence' ? 'runtime_events[] · observed_lock_orders[]' : 'benchmark_runs[] · measured_duration · peak_memory'}</code></div></div></div></>
}

function AnalysisEmpty() {
  return <div className="empty-panel"><FileJson2 size={21} /><h2>No report selected</h2><p>Run an analysis or open a completed report from Analysis history.</p></div>
}

function shortLock(lock: string) {
  if (!lock) return 'Unknown lock'
  const named = lock.match(/:([^:)]+)\)?$/)?.[1]
  if (named) return named
  const suffix = lock.split('/').at(-1) ?? lock
  return suffix.length > 30 ? `${suffix.slice(0, 27)}…` : suffix
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

function compareMetric(metadata: AnalysisMetadata, key: string) {
  const value = metadata.summary?.[key as keyof NonNullable<AnalysisMetadata['summary']>]
  return typeof value === 'string' || typeof value === 'number' ? value : 'Not available'
}
