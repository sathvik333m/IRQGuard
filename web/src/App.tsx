import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import {
  Activity, AlertCircle, ArrowRight, ArrowUpRight, BookOpen,
  Braces, Check, ChevronDown, Clock3, Copy,
  Database, FileCode2, FileJson2, FileSearch, GitBranch, Gauge,
  HardDrive, History, Info, LayoutDashboard, LoaderCircle, LockKeyhole,
  Menu, Moon, PanelLeftClose, PanelLeftOpen, Play, RefreshCw, Search, Settings2, ShieldAlert, ShieldCheck,
  Sun, TerminalSquare, X, Timer, ListChecks,
} from 'lucide-react'
import { compareRuntimeEvidence, getAnalyses, getAnalysis, getHealth, getKernelEvaluation, getReport, getRuntimeEvidence, getRuntimeRuns, getSource, startAnalysis, startRuntimeBenchmark, startRuntimeScenario } from './api'
import type { AnalysisMetadata, AnalysisReport, Finding, Health, KernelEvaluation, RuntimeEvidence, RuntimeRun, SourceSnippet } from './types'

const LockGraph = lazy(() => import('./components/LockGraph').then((module) => ({ default: module.LockGraph })))
const DurationChart = lazy(() => import('./components/DurationChart'))

type Page = 'overview' | 'new' | 'history' | 'graph' | 'findings' | 'source' | 'kernel' | 'cli' | 'settings' | 'runtime' | 'benchmarks'

const navItems: Array<{ id: Page; label: string; icon: typeof LayoutDashboard; section: string; unavailable?: boolean }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, section: 'Workspace' },
  { id: 'new', label: 'New analysis', icon: Play, section: 'Workspace' },
  { id: 'history', label: 'Analysis history', icon: History, section: 'Workspace' },
  { id: 'graph', label: 'Lock graph', icon: GitBranch, section: 'Analysis' },
  { id: 'findings', label: 'Findings', icon: ShieldAlert, section: 'Analysis' },
  { id: 'source', label: 'Source explorer', icon: FileSearch, section: 'Analysis' },
  { id: 'kernel', label: 'Kernel evaluation', icon: HardDrive, section: 'Analysis' },
  { id: 'runtime', label: 'Runtime evidence', icon: Activity, section: 'Evidence' },
  { id: 'benchmarks', label: 'Benchmarks', icon: Gauge, section: 'Evidence' },
  { id: 'cli', label: 'CLI & reports', icon: TerminalSquare, section: 'System' },
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('irqguard-sidebar-collapsed') === 'true')
  const [graphSearchTerm, setGraphSearchTerm] = useState('')
  const [theme, setTheme] = useState<'dark' | 'light'>(() => localStorage.getItem('irqguard-theme') === 'light' ? 'light' : 'dark')
  const [selectedFindingIndex, setSelectedFindingIndex] = useState<number | null>(null)
  const [source, setSource] = useState<SourceSnippet | null>(null)
  const [sourceError, setSourceError] = useState('')
  const [sourceLoading, setSourceLoading] = useState(false)
  const [compareIds, setCompareIds] = useState<string[]>([])
  const [kernelEvaluation, setKernelEvaluation] = useState<KernelEvaluation | null>(null)
  const [kernelEvaluationError, setKernelEvaluationError] = useState('')
  const [kernelEvaluationLoading, setKernelEvaluationLoading] = useState(false)
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
      const parsed = await getReport(metadata.id)
      setReport(parsed)
      setSelectedFindingIndex(parsed.interrupt_cycles.length ? 0 : null)
      setBackendError('')
      setPage('overview')
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
  useEffect(() => { localStorage.setItem('irqguard-sidebar-collapsed', String(sidebarCollapsed)) }, [sidebarCollapsed])
  useEffect(() => {
    if (page !== 'kernel' || kernelEvaluation) return
    setKernelEvaluationLoading(true)
    getKernelEvaluation().then((result) => { setKernelEvaluation(result); setKernelEvaluationError('') })
      .catch((error) => setKernelEvaluationError(error instanceof Error ? error.message : 'Could not load the saved kernel evaluation.'))
      .finally(() => setKernelEvaluationLoading(false))
  }, [page, kernelEvaluation])

  const navigate = (next: Page) => {
    setPage(next)
    setMobileNavOpen(false)
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
      setSelectedFindingIndex(parsed.interrupt_cycles.length ? 0 : null)
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
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar page={page} navigate={navigate} mobileOpen={mobileNavOpen} closeMobile={() => setMobileNavOpen(false)} collapsed={sidebarCollapsed} health={health} active={active} />
      <div className="main-column">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}><Menu size={18} /></button>
          <button className="icon-button sidebar-toggle" aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => setSidebarCollapsed((value) => !value)}>{sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button>
          <div className="breadcrumb"><span>IRQGuard</span><span className="breadcrumb-sep">/</span><strong>{pageTitle}</strong></div>
          <WorkspaceSearch report={report} onOpenSource={openSource} onOpenFinding={(index) => { setSelectedFindingIndex(index); navigate('findings') }} onOpenGraph={(term) => { setGraphSearchTerm(term); navigate('graph') }} />
          <div className="topbar-project" title={active?.source_path ?? health?.workspace_roots[0] ?? 'Workspace unavailable'}><span className="project-label">{active ? 'ANALYZED SOURCE' : 'WORKSPACE'}</span><code>{active?.source_path ?? health?.workspace_roots[0] ?? 'Not available'}</code></div>
          <div className="topbar-target"><span>Target kernel</span><strong>{health?.environment?.target_kernel ?? 'Not reported'}</strong></div>
          <div className="topbar-right">
            <div className="top-status"><span className={`status-dot ${health?.analyzer_available ? 'online' : ''}`} />{active?.status ? active.status : health?.analyzer_available ? 'Analyzer ready' : 'API unavailable'}</div>
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
            selectedFinding={selectedFinding}
            onSelectFinding={(finding) => setSelectedFindingIndex(finding ? findings.indexOf(finding) : null)}
            onOpenSource={openSource}
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
            onOpenGraph={(index) => { setSelectedFindingIndex(index); navigate('graph') }}
          />}
          {page === 'graph' && <GraphPage
            report={report} active={active} selectedFinding={selectedFinding}
            onSelectFinding={(finding) => setSelectedFindingIndex(finding ? findings.indexOf(finding) : null)}
            onOpenSource={openSource}
            searchTerm={graphSearchTerm}
          />}
          {page === 'source' && <SourcePage
            report={report} snippet={source} loading={sourceLoading} error={sourceError}
            onOpenSource={openSource}
          />}
          {page === 'settings' && <SettingsPage health={health} onRefresh={() => void bootstrap()} />}
          {page === 'cli' && <CliGuidePage />}
          {page === 'kernel' && <KernelEvaluationPage evaluation={kernelEvaluation} loading={kernelEvaluationLoading} error={kernelEvaluationError} />}
          {(page === 'runtime' || page === 'benchmarks') && <RuntimeEvidencePage mode={page} health={health} history={history} activeAnalysis={active} />}
        </main>
        <footer className="app-footer"><span>IRQGuard · local analysis workspace</span><span>Static candidates are evidence for review, not confirmed deadlocks.</span></footer>
      </div>
    </div>
  )
}

function Sidebar({ page, navigate, mobileOpen, closeMobile, collapsed, health, active }: { page: Page; navigate: (page: Page) => void; mobileOpen: boolean; closeMobile: () => void; collapsed: boolean; health: Health | null; active: AnalysisMetadata | null }) {
  const sections = ['Workspace', 'Analysis', 'Evidence', 'System']
  return <>
    {mobileOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={closeMobile} />}
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''} ${collapsed ? 'sidebar-narrow' : ''}`}>
      <div className="brand-lockup"><div className="brand-mark"><LockKeyhole size={17} strokeWidth={2.2} /></div><div className="brand-text"><div className="brand-name">IRQGuard</div><div className="brand-caption">KERNEL ANALYSIS</div></div></div>
      <div className="workspace-switcher" title={health?.workspace_roots[0] ?? 'Workspace unavailable'}><div className="workspace-avatar"><HardDrive size={14} /></div><div className="workspace-copy"><strong>Workspace</strong><span>{health?.workspace_roots[0] ? basename(health.workspace_roots[0]) : 'Not available'}</span></div><ChevronDown size={15} /></div>
      <nav aria-label="Primary navigation" className="sidebar-nav">
        {sections.map((section) => <div className="nav-section" key={section}>
          <div className="nav-section-title">{section}</div>
          {navItems.filter((item) => item.section === section).map((item) => {
            const Icon = item.icon
            return <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''} ${item.unavailable ? 'nav-planned' : ''}`}
              onClick={() => navigate(item.id)}
              title={collapsed || item.unavailable ? `${item.label}${item.unavailable ? ' is not implemented yet' : ''}` : undefined}>
              <Icon size={16} strokeWidth={1.8} /><span>{item.label}</span>{item.unavailable && <span className="nav-soon">Unavailable</span>}
            </button>
          })}
        </div>)}
      </nav>
      <div className="sidebar-environment"><div className="eyebrow">SYSTEM INFORMATION</div><div><span>Operating system</span><strong title={health?.environment?.operating_system ?? undefined}>{health?.environment?.operating_system ?? 'Not available'}</strong></div><div><span>WSL</span><strong>{health?.environment?.wsl === true ? 'Detected' : health?.environment?.wsl === false ? 'Not detected' : 'Not available'}</strong></div><div><span>Analyzer</span><strong className={health?.analyzer_available ? 'value-good' : 'value-bad'}>{health?.analyzer_available ? 'Ready' : 'Unavailable'}</strong></div><div><span>Version</span><strong>{health?.environment?.analyzer_version ?? 'Not reported'}</strong></div><div><span>Run</span><strong>{active?.status ?? 'Idle'}</strong></div></div>
      <div className="sidebar-bottom"><div className="local-only"><span className="local-dot" /><span>Loopback API</span><span className="local-tag">v{health?.api_version ?? '—'}</span></div><div className="sidebar-version">Report schema {health?.analyzer_report_schema ?? '—'}</div></div>
    </aside>
  </>
}

function PageHeading({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>{action && <div className="heading-action">{action}</div>}</div>
}

function WorkspaceSearch({ report, onOpenSource, onOpenFinding, onOpenGraph }: { report: AnalysisReport | null; onOpenSource: (file: string, line: number) => void; onOpenFinding: (index: number) => void; onOpenGraph: (term: string) => void }) {
  const [query, setQuery] = useState('')
  const matches = useMemo(() => {
    if (!report || !query.trim()) return []
    const normalized = query.toLowerCase()
    const results: Array<{ kind: string; label: string; detail: string; action: () => void }> = []
    const files = new Map<string, number>()
    if (report.source) files.set(report.source, 1)
    report.functions.forEach((fn) => { const point = locationOf(fn.location); if (point) files.set(point.file, point.line) })
    report.api_operations.forEach((operation) => { const point = locationOf(operation.location); if (point) files.set(point.file, point.line) })
    report.interrupt_lock_graph.edges.forEach((edge) => [edge.from_location, edge.to_location].forEach((location) => { const point = locationOf(location); if (point) files.set(point.file, point.line) }))
    for (const [file, line] of files) if (file.toLowerCase().includes(normalized)) results.push({ kind: 'File', label: basename(file), detail: file, action: () => onOpenSource(file, line) })
    report.functions.forEach((fn) => {
      const name = fn.qualified_name ?? fn.name ?? ''
      const point = locationOf(fn.location)
      if (name.toLowerCase().includes(normalized) && point) results.push({ kind: 'Function', label: name, detail: `${basename(point.file)}:${point.line}`, action: () => onOpenSource(point.file, point.line) })
    })
    const locks = new Set(report.interrupt_lock_graph.nodes.map((node) => node.lock_identity))
    report.interrupt_lock_graph.edges.forEach((edge) => { locks.add(edge.from_lock); locks.add(edge.to_lock) })
    ;[...locks].filter((lock) => lock.toLowerCase().includes(normalized)).slice(0, 8).forEach((lock) => results.push({ kind: 'Lock', label: shortLock(lock), detail: lock, action: () => onOpenGraph(lock) }))
    report.interrupt_cycles.forEach((finding, index) => {
      const text = `${finding.category} ${finding.explanation ?? ''} ${(finding.lock_sequence ?? []).join(' ')} ${finding.edges?.map((edge) => `${edge.from_location?.expansion?.file ?? ''} ${edge.to_location?.expansion?.file ?? ''}`).join(' ') ?? ''}`
      if (text.toLowerCase().includes(normalized)) results.push({ kind: 'Finding', label: categoryLabel(finding.category), detail: finding.lock_sequence?.map(shortLock).join(' → ') ?? 'Cycle sequence unavailable', action: () => onOpenFinding(index) })
    })
    return results.slice(0, 10)
  }, [onOpenFinding, onOpenGraph, onOpenSource, query, report])
  return <div className="workspace-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files, functions, locks…" aria-label="Search current analysis" aria-expanded={!!query} />{query && <button className="search-clear" aria-label="Clear search" onClick={() => setQuery('')}><X size={13} /></button>}{query && <div className="search-results" role="listbox" aria-label="Search results">{matches.length ? matches.map((item, index) => <button role="option" aria-selected="false" key={`${item.kind}-${item.label}-${index}`} onClick={() => { setQuery(''); item.action() }}><span className="search-result-kind">{item.kind}</span><span><strong>{item.label}</strong><small>{item.detail}</small></span><ArrowUpRight size={13} /></button>) : <div className="search-no-results">No matches in the selected report.</div>}</div>}</div>
}

function OverviewPage({ active, report, history, health, loading, onNew, onOpenHistory, onOpenFinding, onOpenGraph, onSelectAnalysis, selectedFinding, onSelectFinding, onOpenSource }: {
  active: AnalysisMetadata | null; report: AnalysisReport | null; history: AnalysisMetadata[]; health: Health | null; loading: boolean;
  onNew: () => void; onOpenHistory: () => void; onOpenFinding: (index: number) => void; onOpenGraph: () => void; onSelectAnalysis: (item: AnalysisMetadata) => void;
  selectedFinding: Finding | null; onSelectFinding: (finding: Finding | null) => void; onOpenSource: (file: string, line: number) => void;
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
  const activeFinding = selectedFinding
  const graphSize = report?.interrupt_lock_graph.edges.length ?? 0
  const durationRuns = history.filter((item) => item.status === 'completed' && item.duration_ms != null).slice(0, 8).reverse().map((item) => ({ name: basename(item.source_path), duration: item.duration_ms! }))
  return <>
    <div className="observatory-heading"><div><div className="eyebrow">IRQGUARD / LOCAL WORKSPACE</div><h1>Kernel lock observatory</h1><p>{active ? active.source_path : 'Analyze a C translation unit to explore lock dependencies and interrupt contexts.'}</p></div><div className="observatory-heading-actions"><span className={`status-pill ${statusTone(active?.status)}`}><i className={`status-dot status-${statusTone(active?.status)}`} />{active?.status ?? 'No run selected'}</span><button className="button button-primary" onClick={onNew}><Play size={14} />New analysis</button></div></div>
    {!health?.analyzer_available && <div className="inline-notice"><AlertCircle size={16} /><span>The local analyzer executable is unavailable. Build it with CMake, then refresh this page.</span></div>}
    {active?.status === 'failed' && <div className="alert alert-error" role="alert"><AlertCircle size={16} /><span>{active.error ?? 'The analyzer did not produce a report.'}</span></div>}
    {loading && <div className="loading-line"><LoaderCircle size={16} className="spin" />Loading report from local history…</div>}
    {!active && history.length === 0 && !loading ? <div className="empty-workspace">
      <div className="empty-glyph"><TerminalSquare size={24} /></div><div className="eyebrow">NO ANALYSIS RUNS</div><h2>Start with a C source file</h2>
      <p>IRQGuard invokes the Clang-based analyzer on your WSL workspace and stores the resulting JSON report locally.</p>
      <button className="button button-primary" onClick={onNew}><Play size={15} />Run your first analysis</button>
      <div className="empty-help"><Info size={14} />Enter an absolute Linux path inside an allowed workspace.</div>
    </div> : null}
    {active && !completed && !loading && active.status !== 'failed' && <div className="empty-workspace compact-empty">
      <div className="empty-glyph"><LoaderCircle size={23} className="spin" /></div><div className="eyebrow">ANALYSIS {active.status.toUpperCase()}</div><h2>Waiting for the analyzer</h2><p>The local service reports status without percentage progress. This run remains available in history.</p>
    </div>}
    {completed && <>
      <section className="metrics-row observatory-metrics" aria-label="Analysis metrics">
        {metrics.map(({ label, value, icon: Icon, tone, note }) => <div className={`metric metric-${tone}`} key={label}><div className="metric-head"><span>{label}</span><Icon size={15} /></div><strong>{value == null ? 'Not available' : typeof value === 'number' ? value.toLocaleString() : value}</strong><small>{note}</small></div>)}
      </section>
      <section className="observatory-workspace">
        <div className="panel observatory-graph-panel">
          <div className="observatory-panel-heading"><div><div className="eyebrow">LIVE REPORT · SCHEMA {report.schema_version}</div><h2><GitBranch size={17} />Lock Dependency Graph</h2><p>Actual lock relationships across the analyzer’s modeled execution contexts</p></div><div className="graph-heading-actions"><span className="graph-edge-count"><strong>{graphSize.toLocaleString()}</strong> edges</span><button className="text-button" onClick={onOpenGraph}>Full graph <ArrowUpRight size={14} /></button></div></div>
          <div className="observatory-legend"><span><i className="legend-line normal-line" />Normal context</span><span><i className="legend-line irq-line" />Interrupt relationship</span><span><i className="legend-line candidate-line" />Selected candidate</span><span><i className="legend-line rejected-line" />Rejected edge</span></div>
          <div className="observatory-graph-canvas"><Suspense fallback={<div className="graph-loading"><LoaderCircle size={16} className="spin" />Loading report graph…</div>}><LockGraph report={report} selectedFinding={activeFinding} onSelectFinding={onSelectFinding} onOpenSource={onOpenSource} compact /></Suspense></div>
          <div className="graph-preview-foot"><span>{report.interrupt_lock_graph.nodes.length.toLocaleString()} lock nodes</span><span>{report.interrupt_cycles.length.toLocaleString()} findings</span><span>Lock type metadata: {report.api_operations.some((item) => item.api) ? 'API labels available' : 'Not reported'}</span><button className="text-button" onClick={onOpenGraph}>Open graph workspace <ArrowRight size={13} /></button></div>
        </div>
        <FindingInspector finding={activeFinding} index={activeFinding ? report.interrupt_cycles.indexOf(activeFinding) : -1} report={report} analysisId={active.id} onOpenSource={onOpenSource} onOpenAll={onOpenFinding} />
      </section>
      <section className="observatory-support-grid">
        <div className="panel observatory-findings-panel"><div className="panel-heading"><div><div className="eyebrow">REVIEW QUEUE</div><h2>Recent findings</h2></div><button className="text-button" onClick={() => onOpenFinding(0)} disabled={!report.interrupt_cycles.length}>All findings <ArrowRight size={13} /></button></div>
          {report.interrupt_cycles.length ? <div className="observatory-finding-list">{report.interrupt_cycles.slice(0, 5).map((finding, index) => { const place = firstFindingLocation(finding); return <button className={`observatory-finding-row ${activeFinding === finding ? 'selected' : ''}`} key={findingId(finding, index, active.id)} onClick={() => onSelectFinding(finding)}><code>{findingId(finding, index, active.id)}</code><span className={`finding-classification ${finding.category}`}>{categoryLabel(finding.category)}</span><span className="finding-locks">{finding.lock_sequence?.map(shortLock).join(' ↔ ') ?? 'Lock sequence unavailable'}</span><code className="finding-source-location">{place ? `${basename(place.file)}:${place.line}` : 'Location unavailable'}</code><ArrowRight size={13} /></button> })}</div> : <div className="panel-empty"><Check size={16} />No cycles were reported for this translation unit.</div>}
        </div>
        <LockApiMix operations={report.api_operations} />
        <AnalysisActivity report={report} active={active} />
      </section>
      <section className="panel recent-runs-panel"><div className="panel-heading"><div><div className="eyebrow">LOCAL HISTORY</div><h2>Recent analyses</h2></div><button className="text-button" onClick={onOpenHistory}>All runs <ArrowRight size={14} /></button></div>
        <div className="recent-runs-list">{history.slice(0, 3).map((item) => <button className={`recent-run-row ${item.id === active.id ? 'selected' : ''}`} key={item.id} onClick={() => onSelectAnalysis(item)}><span className={`status-dot status-${statusTone(item.status)}`} /><span className="recent-run-copy"><strong>{basename(item.source_path)}</strong><small>{item.source_path}</small></span><span className="recent-run-date">{new Date(item.created_at).toLocaleString()}</span><span className={`status-pill ${statusTone(item.status)}`}>{item.status}</span><ArrowRight size={13} /></button>)}</div>
        {durationRuns.length > 1 && <div className="duration-history"><div className="eyebrow">MEASURED RUN DURATION · HISTORY</div><Suspense fallback={<div className="chart-unavailable">Loading duration history…</div>}><DurationChart data={durationRuns} /></Suspense></div>}
      </section>
      <div className="overview-bottomline"><span><Info size={14} />Static candidates are not runtime-confirmed deadlocks. Severity classification is not provided by the analyzer.</span><span>Analyzer version · {health?.environment?.analyzer_version ?? 'Not reported'}</span></div>
    </>}
  </>
}

function FindingInspector({ finding, index, report, analysisId, onOpenSource, onOpenAll }: { finding: Finding | null; index: number; report: AnalysisReport; analysisId: string; onOpenSource: (file: string, line: number) => void; onOpenAll: (index: number) => void }) {
  const [tab, setTab] = useState<'Overview' | 'Source Code' | 'Execution Context' | 'Analysis Evidence'>('Overview')
  if (!finding) return <aside className="panel finding-inspector empty-inspector"><div className="eyebrow">FINDING INSPECTOR</div><ShieldCheck size={22} /><h2>No finding selected</h2><p>Select a reported candidate or graph edge to inspect its source evidence.</p></aside>
  const tabs = ['Overview', 'Source Code', 'Execution Context', 'Analysis Evidence'] as const
  const edges = finding.edges ?? []
  const id = findingId(finding, index, analysisId)
  const relatedUncertainties = (report.uncertainty_records ?? []).filter((item) => item.associated_findings.includes(id))
  return <aside className="panel finding-inspector"><div className="inspector-head"><div><div className="eyebrow">FINDING INSPECTOR · {findingId(finding, index, analysisId)}</div><h2>{categoryLabel(finding.category)}</h2></div><button className="icon-button" aria-label="Open all findings" onClick={() => onOpenAll(Math.max(index, 0))}><ArrowUpRight size={15} /></button></div>
    <div className={`inspector-status ${finding.category}`}><ShieldAlert size={14} /><span>{finding.category === 'rejected_candidate' ? 'Rejected by feasibility check' : finding.category === 'inconclusive_analysis' ? 'Inconclusive analysis' : 'Potential deadlock candidate'}</span><span className="status-pill">{finding.feasibility ?? 'Not reported'}</span></div>
    <div className="inspector-tabs" role="tablist" aria-label="Finding detail sections">{tabs.map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}</div>
    <div className="inspector-body" role="tabpanel">
      {tab === 'Overview' && <><p className="inspector-explanation">{finding.explanation ?? 'The analyzer did not provide an explanation.'}</p><div className="inspector-section-title">Lock order cycle</div><div className="inspector-cycle">{(finding.lock_sequence ?? []).map((lock, itemIndex) => <div className="inspector-cycle-row" key={`${lock}-${itemIndex}`}><b>{itemIndex + 1}</b><code>{shortLock(lock)}</code>{itemIndex < (finding.lock_sequence?.length ?? 0) - 1 && <ArrowRight size={12} />}</div>)}</div><div className="inspector-facts"><span>Classification</span><strong>{finding.classification ?? finding.category}</strong><span>Confidence</span><strong>Not reported</strong><span>Severity</span><strong>Not reported</strong><span>Uncertain edge</span><strong>{finding.contains_uncertain_edge ? 'Yes' : 'No'}</strong></div></>}
      {tab === 'Source Code' && <SourceEvidence edges={edges} onOpenSource={onOpenSource} />}
      {tab === 'Execution Context' && <div className="inspector-evidence-list">{edges.map((edge, edgeIndex) => <div className="inspector-context-row" key={edgeIndex}><span className="context-step">{edgeIndex + 1}</span><span><strong>{edge.from_context ?? 'Context not reported'} → {edge.to_context ?? 'Context not reported'}</strong><small>{edge.source_function ?? 'Function unavailable'} → {edge.target_function ?? 'Function unavailable'}</small><small>IRQ state · {edge.irq_state ?? 'Not reported'}{edge.handler ? ` · handler ${edge.handler}` : ''}</small></span></div>)}</div>}
      {tab === 'Analysis Evidence' && <div className="inspector-evidence-list">{edges.map((edge, edgeIndex) => <div className="inspector-context-row" key={edgeIndex}><span className="context-step">{edgeIndex + 1}</span><span><strong>{shortLock(edge.from_lock)} → {shortLock(edge.to_lock)}</strong><small>{edge.kind} · {edge.certainty ?? 'certainty not reported'}</small><small>{edge.feasibility_reason ?? 'No feasibility explanation attached to this edge.'}</small></span></div>)}{relatedUncertainties.length > 0 ? <section className="finding-uncertainties"><strong>Uncertainty records affecting {id}</strong>{relatedUncertainties.map((item) => <article key={item.id}><code>{item.id} · {item.category.replaceAll('_', ' ')}</code><small>{item.explanation}</small><small>{item.source_location.file ? `${item.source_location.file}:${item.source_location.line}:${item.source_location.column}` : item.enclosing_function || item.reason}</small></article>)}</section> : report.uncertainties.length > 0 && <div className="inspector-limitation"><Info size={13} /><span>No structured uncertainty record is linked to this finding. Review report diagnostics separately.</span></div>}</div>}
    </div>
    <button className="inspector-open-findings" onClick={() => onOpenAll(Math.max(index, 0))}>Open finding in explorer <ArrowRight size={13} /></button>
  </aside>
}

function SourceEvidence({ edges, onOpenSource }: { edges: Finding['edges']; onOpenSource: (file: string, line: number) => void }) {
  const locations: Array<{ place: ReturnType<typeof locationOf>; label: string; lock: string }> = (edges ?? []).flatMap((edge) => [
    { place: locationOf(edge.from_location), label: 'Acquisition from', lock: edge.from_lock },
    { place: locationOf(edge.to_location), label: 'Acquisition to', lock: edge.to_lock },
  ])
  const available = locations.filter((item): item is { place: { file: string; line: number }; label: string; lock: string } => item.place !== null)
  return <div className="inspector-evidence-list">{available.map(({ place, label, lock }, index) => <button className="inspector-source-row" key={`${place.file}-${place.line}-${index}`} onClick={() => onOpenSource(place.file, place.line)}><FileCode2 size={14} /><span><strong>{label} · {shortLock(lock)}</strong><small>{place.file}:{place.line}</small></span><ArrowUpRight size={13} /></button>)}{available.length < locations.length && <p className="inspector-muted">{locations.length - available.length} source location(s) are unavailable in the report.</p>}{locations.length === 0 && <p className="inspector-muted">No source locations were provided for this finding.</p>}</div>
}

function LockApiMix({ operations }: { operations: AnalysisReport['api_operations'] }) {
  const counts = useMemo(() => { const result = new Map<string, number>(); operations.filter((operation) => operation.lock && operation.api).forEach((operation) => result.set(operation.api!, (result.get(operation.api!) ?? 0) + 1)); return [...result.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6) }, [operations])
  const total = counts.reduce((sum, [, count]) => sum + count, 0)
  return <section className="panel mix-panel"><div className="panel-heading"><div><div className="eyebrow">API EVENTS</div><h2>Lock API mix</h2></div><LockKeyhole size={15} className="subtle-icon" /></div>{total ? <div className="api-mix-list">{counts.map(([name, count], index) => <div className="api-mix-row" key={name}><div><code>{name}</code><span>{Math.round(count / total * 100)}%</span></div><div className="api-mix-track"><i style={{ width: `${count / total * 100}%`, ['--mix-index' as string]: index }} /></div><small>{count} recorded API operation{count === 1 ? '' : 's'}</small></div>)}</div> : <div className="unavailable-mini"><Info size={15} /><span>Lock API distribution is not reported for this analysis.</span></div>}<div className="panel-footnote">Counts are grouped from actual lock-bearing API events.</div></section>
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
  return <section className="panel activity-panel"><div className="panel-heading"><div><div className="eyebrow">REPORT RECORD</div><h2>Analysis activity</h2></div><span className="status-pill good">{active.status}</span></div><div className="activity-meta"><span><Clock3 size={12} />{formatDuration(active.duration_ms)}</span><code>{active.return_code === 0 ? 'exit 0' : `exit ${active.return_code ?? 'not reported'}`}</code></div><div className="activity-summary"><div><span>Functions</span><strong>{active.summary?.functions ?? 'Not available'}</strong></div><div><span>Operations</span><strong>{active.summary?.lock_operations ?? 'Not available'}</strong></div><div><span>Diagnostics</span><strong>{report.diagnostics.length}</strong></div></div>{uncertaintySummary && <div className="activity-uncertainty-overview"><div><strong>{uncertaintySummary.event_count.toLocaleString()}</strong><span>events</span></div><div><strong>{uncertaintySummary.unique_record_count.toLocaleString()}</strong><span>unique causes</span></div><div><strong>{uncertaintySummary.propagated_event_count.toLocaleString()}</strong><span>propagated</span></div><div><strong>{uncertaintySummary.high_impact_unique_records.toLocaleString()}</strong><span>high impact</span></div></div>}{highImpact.length > 0 && <div className="activity-high-impact"><span>HIGH IMPACT UNCERTAINTIES</span>{highImpact.map((item) => <div key={item.id}><strong>{item.category.replaceAll('_', ' ')}</strong><code>{item.source_location.file ? `${item.source_location.file}:${item.source_location.line}:${item.source_location.column}` : item.enclosing_function || item.reason}</code></div>)}</div>}<div className="activity-filters"><button className={filter === 'all' ? 'selected' : ''} onClick={() => { setFilter('all'); setCleared(false) }}>All {entries.length}</button><button className={filter === 'diagnostic' ? 'selected' : ''} onClick={() => { setFilter('diagnostic'); setCleared(false) }}>Diagnostics {report.diagnostics.length}</button><button className={filter === 'uncertainty' ? 'selected' : ''} onClick={() => { setFilter('uncertainty'); setCleared(false) }}>Uncertainty {report.uncertainties.length}</button><button className="activity-clear" onClick={() => setCleared((value) => !value)}>{cleared ? 'Restore view' : 'Clear view'}</button></div><div className="activity-log" aria-label="Analyzer report diagnostics">{cleared ? <div className="activity-clean">Visible entries cleared. The saved report is unchanged.</div> : visibleEntries.length ? visibleEntries.map((entry, index) => <div className={`activity-line ${entry.kind}`} key={`${entry.kind}-${index}`}><span>{entry.kind === 'diagnostic' ? 'DIAG' : 'NOTE'}</span><code>{entry.message}</code></div>) : <div className="activity-clean">{entries.length ? 'No entries in this filter.' : <><Check size={13} />The report contains no diagnostics or uncertainty notes.</>}</div>}</div><div className="panel-footnote">Summary from the final report. No live process log is available.</div></section>
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
        <div className="aside-section"><div className="eyebrow">REPORT OUTPUT</div><div className="output-list"><span><Check size={14} />Clang AST and CFG facts</span><span><Check size={14} />Interprocedural lock edges</span><span><Check size={14} />Process and hardirq contexts</span><span><Check size={14} />Schema 3 JSON with provenance</span></div><div className="field-hint">JSON is selected because the graph and finding views consume the versioned analyzer report.</div></div>
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

function FindingsPage({ report, analysis, selectedIndex, onSelect, onOpenSource, onOpenGraph }: {
  report: AnalysisReport | null; analysis: AnalysisMetadata | null; selectedIndex: number | null; onSelect: (index: number | null) => void; onOpenSource: (file: string, line: number) => void; onOpenGraph: (index: number) => void;
}) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [sort, setSort] = useState<'category' | 'file'>('category')
  const [page, setPage] = useState(0)
  const [exportMessage, setExportMessage] = useState('')
  const cycles = report?.interrupt_cycles ?? []
  const filtered = cycles.map((finding, index) => ({ finding, index, id: findingId(finding, index, analysis?.id) })).filter(({ finding, id }) => {
    const text = [id, finding.category, finding.explanation, ...(finding.lock_sequence ?? []), ...(finding.edges ?? []).flatMap((edge) => [edge.from_context ?? '', edge.to_context ?? '', edge.source_function ?? '', edge.target_function ?? ''])].join(' ').toLowerCase()
    return (category === 'all' || finding.category === category) && text.includes(search.toLowerCase())
  }).sort((a, b) => sort === 'category' ? a.finding.category.localeCompare(b.finding.category) : firstFindingFile(a.finding).localeCompare(firstFindingFile(b.finding)))
  const pageSize = 25
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const visible = filtered.slice(page * pageSize, (page + 1) * pageSize)
  const categories = [...new Set(cycles.map((finding) => finding.category))]
  const exportJson = () => {
    if (!report) return
    const exportedFindings = report.interrupt_cycles.map((finding, index) => {
      const id = findingId(finding, index, analysis?.id)
      return { ...finding, review_classification: finding.category === 'inconclusive_analysis' ? 'inconclusive' : finding.category === 'rejected_candidate' ? 'rejected_by_feasibility_checks' : 'candidate', uncertainty_records: (report.uncertainty_records ?? []).filter((item) => item.associated_findings.includes(id)) }
    })
    const blob = new Blob([JSON.stringify({ schema_version: report.schema_version, source: report.source, interrupt_cycles: exportedFindings }, null, 2)], { type: 'application/json' })
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `irqguard-findings-${analysis?.id ?? 'report'}.json`; link.click(); URL.revokeObjectURL(link.href)
    setExportMessage('Findings JSON exported.')
  }
  return <>
    <PageHeading eyebrow="STATIC ANALYSIS" title="Findings" subtitle="Review candidate lock cycles and the source evidence included in the analyzer report." action={<button className="button button-secondary" onClick={exportJson} disabled={!report}><FileJson2 size={15} />Export JSON</button>} />
    {!report ? <AnalysisEmpty /> : <>
      <div className="finding-countline"><span><strong>{filtered.length}</strong> of {cycles.length} findings</span><span>Severity is not reported by the analyzer; static candidates are not confirmed deadlocks.</span></div>
      <FindingsTable findings={visible.map(({ finding, index, id }) => ({ finding, index, id }))} selectedIndex={selectedIndex}
        search={search} onSearch={(value) => { setSearch(value); setPage(0) }} category={category} onCategory={(value) => { setCategory(value); setPage(0) }} categories={categories} sort={sort} onSort={setSort} onSelect={onSelect} />
      {filtered.length === 0 && <div className="table-empty"><Search size={17} /><span>No findings match these filters.</span></div>}
      {pageCount > 1 && <div className="pagination"><span>Page {page + 1} of {pageCount} · showing up to 25</span><div><button className="button button-small button-secondary" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={page === 0}>Previous</button><button className="button button-small button-secondary" onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} disabled={page + 1 >= pageCount}>Next</button></div></div>}
      {selectedIndex != null && cycles[selectedIndex] && <FindingDetail finding={cycles[selectedIndex]} id={findingId(cycles[selectedIndex], selectedIndex, analysis?.id)} onClose={() => onSelect(null)} onOpenSource={onOpenSource} onOpenGraph={() => onOpenGraph(selectedIndex)} />}
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
    <div className="finding-table" role="table" aria-label="Analyzer findings"><div className="finding-table-header" role="row"><span>Finding</span><span>Lock sequence</span><span>Execution context</span><span>Evidence location</span><span>Feasibility</span><span /></div>
      {findings.map(({ finding, index, id }) => {
        const place = firstFindingLocation(finding)
        const contexts = [...new Set((finding.edges ?? []).map((edge) => `${edge.from_context ?? 'unknown'} → ${edge.to_context ?? 'unknown'}`))]
        return <button role="row" className={`finding-table-row ${selectedIndex === index ? 'row-selected' : ''}`} key={id} onClick={() => onSelect(index)}>
          <span className="finding-table-title"><i className={`finding-mini-dot ${finding.category}`} /><span><strong>{categoryLabel(finding.category)}</strong><small>{id}</small></span></span>
          <span className="lock-sequence-cell">{finding.lock_sequence?.slice(0, 4).map(shortLock).join(' → ') ?? 'Unavailable'}</span>
          <span className="finding-context-cell">{contexts.length ? contexts.slice(0, 2).join(' · ') : 'Not reported'}</span>
          <span className="location-cell"><code>{place ? `${basename(place.file)}:${place.line}` : 'Not available'}</code></span>
          <span className={`feasibility-label ${finding.feasibility ?? 'unknown'}`}>{finding.feasibility ?? 'Not available'}</span><ArrowRight size={14} className="row-arrow" />
        </button>
      })}
    </div>
  </div>
}

function FindingDetail({ finding, id, onClose, onOpenSource, onOpenGraph }: { finding: Finding; id: string; onClose: () => void; onOpenSource: (file: string, line: number) => void; onOpenGraph: () => void }) {
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
      <button className="button button-primary finding-open-graph" onClick={onOpenGraph}><GitBranch size={14} />Highlight in lock graph</button>
    </section>
  </div>
}

function GraphPage({ report, active, selectedFinding, onSelectFinding, onOpenSource, searchTerm }: {
  report: AnalysisReport | null; active: AnalysisMetadata | null; selectedFinding: Finding | null; onSelectFinding: (finding: Finding | null) => void; onOpenSource: (file: string, line: number) => void; searchTerm: string;
}) {
  return <>
    <PageHeading eyebrow="LOCK ORDER MODEL" title="Lock dependency graph" subtitle={active ? `Actual graph edges from ${basename(active.source_path)} · select an edge for provenance.` : 'Select a completed analysis to inspect its graph.'} />
    {!report ? <AnalysisEmpty /> : <div className="graph-workspace"><Suspense fallback={<div className="loading-line graph-loading"><LoaderCircle size={16} className="spin" />Loading lock graph…</div>}><LockGraph report={report} selectedFinding={selectedFinding} onSelectFinding={onSelectFinding} onOpenSource={onOpenSource} initialSearchTerm={searchTerm} /></Suspense></div>}
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
      <section className="settings-section settings-capabilities"><div className="eyebrow">FEATURE AVAILABILITY</div><div className="settings-row"><span>Static source analysis</span><strong className="value-good">Available</strong></div><div className="settings-row"><span>Runtime evidence</span><strong>{health?.runtime_evidence_available ? 'Available' : 'Build required'}</strong></div><div className="settings-row"><span>Benchmarks</span><strong>{health?.benchmarks_available ? 'Available' : 'Build required'}</strong></div></section></div>
  </>
}

function RuntimeEvidencePage({ mode, health, history, activeAnalysis }: { mode: 'runtime' | 'benchmarks'; health: Health | null; history: AnalysisMetadata[]; activeAnalysis: AnalysisMetadata | null }) {
  const [runs, setRuns] = useState<RuntimeRun[]>([])
  const [selected, setSelected] = useState<RuntimeEvidence | null>(null)
  const [scenario, setScenario] = useState('deadlock')
  const [analysisId, setAnalysisId] = useState(activeAnalysis?.status === 'completed' ? activeAnalysis.id : history.find((item) => item.status === 'completed')?.id ?? '')
  const [mapping, setMapping] = useState('{}')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const available = health?.runtime_evidence_available === true
  const refresh = useCallback(async () => {
    const list = await getRuntimeRuns()
    setRuns(list)
    if (selected) {
      const current = list.find((item) => item.id === selected.run.id)
      if (current && current.status !== selected.run.status) setSelected(await getRuntimeEvidence(current.id))
    }
    return list
  }, [selected])
  useEffect(() => { void refresh().catch((error) => setMessage(error.message)) }, [])
  useEffect(() => {
    if (!runs.some((item) => item.status === 'running')) return
    const timer = window.setInterval(() => { void refresh().catch(() => undefined) }, 1000)
    return () => window.clearInterval(timer)
  }, [refresh, runs])
  const launchScenario = async () => {
    setBusy(true); setMessage('')
    try {
      const started = await startRuntimeScenario(scenario)
      setRuns((old) => [started, ...old])
      setSelected(await getRuntimeEvidence(started.id))
      setMessage(`Started ${scenario} scenario. Results are written to local runtime history.`)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not start runtime scenario.') }
    finally { setBusy(false) }
  }
  const launchBenchmark = async () => {
    setBusy(true); setMessage('')
    try {
      const started = await startRuntimeBenchmark()
      setRuns((old) => [started, ...old]); setSelected(await getRuntimeEvidence(started.id))
      setMessage('Benchmark started. It compares the instrumented and baseline mutex-pair loops.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not start benchmark.') }
    finally { setBusy(false) }
  }
  const openRun = async (run: RuntimeRun) => {
    try { setSelected(await getRuntimeEvidence(run.id)); setMessage('') }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not load runtime run.') }
  }
  const compare = async () => {
    if (!selected || selected.run.kind !== 'scenario' || !analysisId) return
    setBusy(true); setMessage('')
    try {
      const parsed = JSON.parse(mapping)
      const result = await compareRuntimeEvidence({ analysis_id: analysisId, runtime_run_ids: [selected.run.id], static_to_runtime: parsed })
      setRuns((old) => [result.run, ...old]); setSelected(await getRuntimeEvidence(result.run.id)); setMessage('Static/runtime comparison saved.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Comparison input must be a JSON object.') }
    finally { setBusy(false) }
  }
  const summary = selected?.summary
  const benchmark = selected?.benchmark
  const comparison = selected?.comparison
  return <>
    <PageHeading eyebrow={mode === 'runtime' ? 'CONTROLLED USERSPACE TRACES' : 'MEASURED OVERHEAD'} title={mode === 'runtime' ? 'Runtime evidence' : 'Benchmarks'} subtitle={mode === 'runtime' ? 'Run the bundled pthread harness, inspect structured events, and compare observations with a static report.' : 'Measure wrapper and trace logging cost against the same uninstrumented mutex-pair workload.'} action={mode === 'benchmarks' ? <button className="button button-primary" disabled={!available || busy} onClick={() => void launchBenchmark()}><Gauge size={14} />Run benchmark</button> : undefined} />
    {!available && <div className="inline-notice"><AlertCircle size={16} /><span>Runtime tools are unavailable. Configure and build the project with CMake to enable the controlled userspace harness.</span></div>}
    {message && <div className="inline-notice runtime-message" role="status"><Info size={15} /><span>{message}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setMessage('')}><X size={14} /></button></div>}
    <div className="runtime-layout">
      <section className="runtime-primary">
        {mode === 'runtime' && <div className="panel runtime-control"><div className="panel-heading"><div><div className="eyebrow">CONTROLLED FIXTURE</div><h2>Collect a runtime trace</h2></div><span className="runtime-scope"><Activity size={13} />Userspace pthreads</span></div>
          <div className="runtime-control-row"><label className="field-label" htmlFor="runtime-scenario">Scenario<select id="runtime-scenario" value={scenario} onChange={(event) => setScenario(event.target.value)}><option value="safe">Safe lock order</option><option value="contention">Concurrent contention</option><option value="deadlock">Reproducible deadlock</option><option value="opposite-order">Opposite order · sequential</option><option value="reverse-only">Reverse order only</option><option value="static-only">Static candidate · unexercised</option></select></label><button className="button button-primary" disabled={!available || busy} onClick={() => void launchScenario()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}Run scenario</button></div>
          <p className="runtime-caveat"><Info size={14} />The deadlock fixture runs in a disposable process group. A watchdog kills it after the selected timeout; this does not model hardware interrupts.</p>
        </div>}
        {mode === 'benchmarks' && <div className="panel runtime-control"><div className="panel-heading"><div><div className="eyebrow">INSTRUMENTATION COST</div><h2>Baseline vs instrumented</h2></div><span className="runtime-scope"><Timer size={13} />Process timing</span></div><p className="runtime-caveat benchmark-note">Each sample runs the same lock-pair loop. Results include event serialization, synchronization, and flush costs and are specific to this machine.</p></div>}
        {mode === 'runtime' && selected?.run.kind === 'scenario' && summary && <>
          <div className="metrics-row runtime-metrics"><div className="metric"><div className="metric-head"><span>Trace events</span><Activity size={15} /></div><strong>{summary.event_count ?? '—'}</strong><small>Structured JSONL records</small></div><div className="metric"><div className="metric-head"><span>Threads</span><ListChecks size={15} /></div><strong>{summary.thread_count ?? '—'}</strong><small>Observed in this process</small></div><div className="metric"><div className="metric-head"><span>Contention</span><LockKeyhole size={15} /></div><strong>{summary.observed_contention_count ?? '—'}</strong><small>trylock returned EBUSY</small></div><div className="metric"><div className="metric-head"><span>Termination</span><ShieldAlert size={15} /></div><strong className="runtime-status-text">{summary.deadlock_reproduction === 'watchdog_timeout_with_persistent_wait_for_cycle' ? 'Reproduced' : summary.termination ?? '—'}</strong><small>Bounded fixture result</small></div></div>
          <section className="panel runtime-result"><div className="panel-heading"><div><div className="eyebrow">SELECTED TRACE</div><h2>{selected.run.scenario} <span className={`status-pill ${statusTone(selected.run.status)}`}>{selected.run.status}</span></h2></div><code>{selected.run.id.slice(0, 12)}</code></div>
            <div className="runtime-interpretation">{summary.interpretation ?? 'Summary is still being collected.'}</div>
            {!!summary.terminal_wait_for_cycles?.length && <div className="runtime-cycle"><strong>Persistent wait-for cycle</strong>{summary.terminal_wait_for_cycles.map((cycle: any, index: number) => <div key={index}><code>{cycle.threads?.join(' → ')}</code><span>Locks: {(cycle.locks_involved ?? []).join(', ')}</span></div>)}</div>}
            <div className="runtime-event-heading"><strong>Event trace</strong><span>{selected.events.length} shown · latest 5,000</span></div>
            <div className="runtime-table-wrap"><table className="data-table runtime-event-table"><thead><tr><th>Sequence</th><th>Event</th><th>Thread</th><th>Lock</th><th>Monotonic time</th></tr></thead><tbody>{selected.events.map((event, index) => <tr key={`${event.sequence}-${index}`}><td>{event.sequence}</td><td><span className={`event-kind event-${event.event}`}>{String(event.event).replaceAll('_', ' ')}</span></td><td>{event.thread_id}</td><td><code>{event.lock_id}</code></td><td>{event.timestamp_monotonic_ns}</td></tr>)}</tbody></table>{!selected.events.length && <div className="panel-empty">No events in this run yet.</div>}</div>
          </section>
          {selected.run.kind === 'scenario' && <section className="panel runtime-compare"><div className="panel-heading"><div><div className="eyebrow">STATIC / RUNTIME COMPARISON</div><h2>Compare with a static candidate</h2></div></div><div className="runtime-compare-form"><label className="field-label">Static analysis<select value={analysisId} onChange={(event) => setAnalysisId(event.target.value)}>{history.filter((item) => item.status === 'completed').map((item) => <option key={item.id} value={item.id}>{basename(item.source_path)} · {item.id.slice(0, 8)}</option>)}</select></label><label className="field-label mapping-field">Exact lock identity map<textarea aria-label="Exact static to runtime lock identity map" spellCheck={false} value={mapping} onChange={(event) => setMapping(event.target.value)} placeholder={'{\n  "exact static lock identity": "A"\n}'} /></label><div className="runtime-caveat"><Info size={14} />Map each static lock identity exactly to runtime IDs such as A, B, C, or D. Unobserved candidates remain unproven, not disproved.</div><button className="button button-secondary" disabled={!analysisId || busy} onClick={() => void compare()}><GitBranch size={14} />Compare selected trace</button></div></section>}
        </>}
        {mode === 'benchmarks' && benchmark && <section className="panel runtime-result"><div className="panel-heading"><div><div className="eyebrow">BENCHMARK REPORT</div><h2>Instrumentation overhead</h2></div><span className="status-pill good">Measured</span></div><div className="benchmark-metrics"><div><span>Baseline median</span><strong>{Number(benchmark.median_ns?.baseline ?? 0).toLocaleString()} ns</strong></div><div><span>Instrumented median</span><strong>{Number(benchmark.median_ns?.instrumented ?? 0).toLocaleString()} ns</strong></div><div><span>Overhead</span><strong>{typeof benchmark.overhead_percent === 'number' ? `${benchmark.overhead_percent.toFixed(1)}%` : 'Not available'}</strong></div></div><p className="runtime-caveat">{benchmark.limitations}</p><pre className="benchmark-environment">{JSON.stringify(benchmark.environment, null, 2)}</pre></section>}
        {mode === 'runtime' && comparison && <section className="panel runtime-result"><div className="panel-heading"><div><div className="eyebrow">COMPARISON</div><h2>Static findings against selected traces</h2></div></div><div className="comparison-findings">{(comparison.findings ?? []).map((finding: any) => <div className="comparison-row" key={finding.finding_id}><span>{finding.finding_id}</span><strong>{String(finding.runtime_status).replaceAll('_', ' ')}</strong><p>{finding.explanation}</p></div>)}</div><p className="runtime-caveat">{comparison.interpretation}</p></section>}
      </section>
      <aside className="panel runtime-history"><div className="panel-heading"><div><div className="eyebrow">LOCAL RECORDS</div><h2>Recent evidence</h2></div><button className="icon-button" aria-label="Refresh runtime records" onClick={() => void refresh()}><RefreshCw size={14} /></button></div><div className="runtime-run-list">{runs.filter((run) => mode === 'runtime' ? run.kind !== 'benchmark' : run.kind === 'benchmark').map((run) => <button key={run.id} className={`runtime-run-item ${selected?.run.id === run.id ? 'selected' : ''}`} onClick={() => void openRun(run)}><span className={`status-dot status-${statusTone(run.status)}`} /><span><strong>{run.kind === 'scenario' ? run.scenario : run.kind}</strong><small>{new Date(run.created_at).toLocaleString()}</small></span><span className={`status-pill ${statusTone(run.status)}`}>{run.status}</span></button>)}{!runs.some((run) => mode === 'runtime' ? run.kind !== 'benchmark' : run.kind === 'benchmark') && <div className="panel-empty">No {mode === 'runtime' ? 'runtime runs' : 'benchmark runs'} yet.</div>}</div>{selected?.run.error && <div className="runtime-error"><AlertCircle size={14} />{selected.run.error}</div>}</aside>
    </div>
  </>
}

function CliGuidePage() {
  const [copied, setCopied] = useState('')
  const [copyError, setCopyError] = useState('')
  const commands = [
    { title: 'Analyze C source', detail: 'Parse real C with Clang and print the readable report.', command: './irqguard analyze --source examples/basic.c' },
    { title: 'Export JSON', detail: 'Write schema-v4 facts, dependency edges, locations, findings, and grouped uncertainty records.', command: './irqguard analyze --source examples/basic.c --format json --output /tmp/basic.json' },
    { title: 'Export Graphviz', detail: 'Generate a dependency graph that can be opened with Graphviz.', command: './irqguard graph --source tests/fixtures/interrupts.c --output /tmp/interrupts.dot' },
    { title: 'Validate API registry', detail: 'Check custom API names, event kinds, and argument indexes.', command: './irqguard api-registry validate --config config/apis.example.json' },
    { title: 'Run runtime evidence', detail: 'Run a controlled userspace scenario; this does not emulate kernel IRQs.', command: './irqguard runtime run --scenario deadlock --timeout 1.5 --trace /tmp/deadlock.jsonl' },
    { title: 'Measure runtime overhead', detail: 'Compare the wrapped pthread loop with its uninstrumented baseline.', command: './irqguard benchmark runtime --iterations 1000 --repeats 5 --output /tmp/overhead.json' },
    { title: 'Evaluate pinned kernel source', detail: 'Reproduce the selected Linux v6.6.87 e1000e evaluation.', command: './irqguard benchmark kernel --kernel /tmp/linux-v6.6.87 --output evaluation/results/linux-v6.6.87' },
  ]
  const copyCommand = async (title: string, command: string) => {
    setCopyError('')
    try { await navigator.clipboard.writeText(command); setCopied(title) }
    catch { setCopyError('Clipboard access is unavailable here. Select and copy the command text instead.') }
  }
  return <>
    <PageHeading eyebrow="PHASE 7 / INTEGRATED WORKFLOW" title="CLI & report guide" subtitle="The command line is the primary interface. The GUI is an optional view over analysis and evidence." />
    <div className="cli-guide-layout">
      <section className="cli-command-list" aria-label="IRQGuard commands">
        {commands.map((item) => <article className="cli-command" key={item.title}><div className="cli-command-heading"><div><h2>{item.title}</h2><p>{item.detail}</p></div><button className="icon-button cli-copy" onClick={() => void copyCommand(item.title, item.command)} aria-label={`Copy ${item.title} command`}>{copied === item.title ? <Check size={15} /> : <Copy size={15} />}</button></div><pre><code>{item.command}</code></pre></article>)}
        {copyError && <p className="cli-copy-error" role="status">{copyError}</p>}
      </section>
      <aside className="cli-guide-aside">
        <section className="cli-note"><span className="eyebrow">REPORT CONTRACT</span><strong>Schema version 3</strong><p>JSON includes extracted functions, calls, lock operations, dependencies, IRQ contexts, findings, source locations, uncertainty, and diagnostics.</p></section>
        <section className="cli-note"><span className="eyebrow">FINDING CATEGORIES</span><dl><dt>Lock-order candidate</dt><dd>Process-context dependency cycle.</dd><dt>Interrupt-aware candidate</dt><dd>Cycle involving modeled hardirq preemption.</dd><dt>Rejected candidate</dt><dd>Modeled IRQ state rejects the cycle shape.</dd><dt>Inconclusive</dt><dd>Analysis lacks enough information to decide feasibility.</dd></dl></section>
        <section className="cli-caveat"><AlertCircle size={15} /><p>A candidate is not a confirmed deadlock. No severity score is reported. The pinned kernel run missed some `spin_lock_irqsave` acquisitions, so zero findings do not prove absence of bugs.</p></section>
      </aside>
    </div>
  </>
}

function KernelEvaluationPage({ evaluation, loading, error }: { evaluation: KernelEvaluation | null; loading: boolean; error: string }) {
  if (loading) return <div className="kernel-eval-state"><LoaderCircle className="spin" size={17} />Loading the recorded Linux evaluation…</div>
  if (!evaluation) return <><PageHeading eyebrow="PHASE 6 / REAL SOURCE EVALUATION" title="Linux kernel evaluation" subtitle="Recorded analysis of a pinned Linux kernel driver selection." /><div className="alert alert-error" role="alert"><AlertCircle size={16} /><span>{error || 'Evaluation data is unavailable.'}</span></div></>
  const { aggregate, kernel, configuration } = evaluation
  const metrics = [
    ['Files parsed', `${aggregate.files_analyzed} / ${aggregate.files_requested}`],
    ['Functions', aggregate.functions.toLocaleString()],
    ['Lock operations', aggregate.lock_operations.toLocaleString()],
    ['Dependencies', aggregate.lock_dependencies.toLocaleString()],
    ['Total analysis', `${aggregate.elapsed_seconds_sum?.toFixed(3) ?? '—'} s`],
    ['Peak memory', aggregate.peak_rss_kib_max == null ? '—' : `${(aggregate.peak_rss_kib_max / 1024).toFixed(1)} MiB`],
  ]
  return <>
    <PageHeading eyebrow="PHASE 6 / REAL SOURCE EVALUATION" title={`Linux ${kernel.release_tag}`} subtitle={`${configuration.subsystem} · pinned kernel revision ${kernel.commit}`} action={<span className={`status-pill ${evaluation.status === 'completed' ? 'good' : 'muted'}`}>{evaluation.status}</span>} />
    <div className="kernel-eval-warning" role="note"><AlertCircle size={17} /><div><strong>Coverage limitation</strong><p>{evaluation.interpretation}</p></div></div>
    <section className="kernel-eval-metrics" aria-label="Kernel evaluation measurements">
      {metrics.map(([label, value]) => <div className="kernel-eval-metric" key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </section>
    <section className="panel kernel-eval-panel"><div className="panel-heading"><div><div className="eyebrow">PER TRANSLATION UNIT</div><h2>Selected e1000e source files</h2></div><span className="runtime-scope">{aggregate.files_skipped_or_failed} skipped or failed</span></div>
      <div className="runtime-table-wrap"><table className="data-table kernel-eval-table"><thead><tr><th>Source file</th><th>Status</th><th>Functions</th><th>Lock ops</th><th>Dependencies</th><th>Time</th><th>Peak RSS</th></tr></thead><tbody>{evaluation.translation_units.map((unit) => <tr key={unit.file}><td><code>{unit.file}</code></td><td><span className={`status-pill ${statusTone(unit.status)}`}>{unit.status}</span></td><td>{unit.counts.functions}</td><td>{unit.counts.lock_operations}</td><td>{unit.counts.lock_dependencies}</td><td>{unit.elapsed_seconds?.toFixed(3) ?? '—'} s</td><td>{unit.peak_rss_kib == null ? '—' : `${(unit.peak_rss_kib / 1024).toFixed(1)} MiB`}</td></tr>)}</tbody></table></div>
    </section>
    <section className="kernel-eval-details"><div><span className="eyebrow">ANALYSIS SIGNALS</span><dl><dt>Interrupt graph edges</dt><dd>{aggregate.interrupt_graph_edges}</dd><dt>Candidate cycles</dt><dd>{aggregate.interrupt_cycles}</dd><dt>Uncertainties</dt><dd>{aggregate.uncertainties.toLocaleString()}</dd><dt>Parser diagnostics</dt><dd>{aggregate.diagnostics}</dd></dl></div><div><span className="eyebrow">BUILD CONFIGURATION</span><dl><dt>Architecture</dt><dd>{configuration.architecture}</dd><dt>Base config</dt><dd>{configuration.config_base}</dd><dt>Compiler</dt><dd>{configuration.compiler_mode}</dd><dt>Revision</dt><dd><code>{kernel.commit}</code></dd></dl></div></section>
    {evaluation.phase13_comparison && <Phase13Comparison comparison={evaluation.phase13_comparison} />}
    {evaluation.phase12_validation && <Phase12Validation evidence={evaluation.phase12_validation} />}
    {!!configuration.build_limitations.length && <section className="kernel-eval-build-note"><Info size={15} /><div><strong>Build limitation</strong>{configuration.build_limitations.map((item) => <p key={item}>{item}</p>)}</div></section>}
    {evaluation.cycle_review && <section className="panel kernel-cycle-review"><div className="panel-heading"><div><div className="eyebrow">PHASE 11 · ARCHIVED CYCLE REVIEW</div><h2>Candidate validation</h2></div><span className="status-pill muted">{evaluation.cycle_review.status.replaceAll('_', ' ')}</span></div><p className="kernel-cycle-caveat">{evaluation.cycle_review.current_analysis.reason}</p><div className="kernel-cycle-list">{evaluation.cycle_review.findings.map((finding) => <article key={finding.finding_id}><div className="kernel-cycle-title"><strong>{finding.finding_id}</strong><span className="finding-classification inconclusive_analysis">{finding.classification}</span><code>{basename(finding.source_file)} · {finding.edges?.[0]?.from_location?.expansion?.line ?? 'line unavailable'}</code></div><p><b>Cycle:</b> {finding.cycle_path.map(shortLock).join(' → ')}</p><p><b>Call path:</b> {finding.call_path.map((step) => `${step.caller} → ${step.callee} (${basename(step.file ?? '')}:${step.line ?? '?'})`).join(' · ')}</p><p><b>Lock operations:</b> {finding.lock_operation_evidence.map((operation) => `${operation.api} ${operation.kind} ${operation.lock?.expression ?? ''} (${operation.function}, line ${operation.location?.expansion?.line ?? '?'}, identity ${operation.lock?.identity_status ?? 'unknown'})`).join(' · ') || 'No lock operation records attached.'}</p><p><b>Context:</b> {finding.interrupt_evidence.from_context} → {finding.interrupt_evidence.to_context}; {finding.interrupt_evidence.interpretation}</p><p><b>IRQ state:</b> {finding.irq_state.saved_flags_relation}. {finding.irq_state.interpretation}</p><p><b>Uncertainty:</b> {finding.uncertainties.map((item) => `${item.id} ${item.category} @ ${basename(item.source_file)}:${item.line}`).join(' · ')}</p><ul>{finding.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><details><summary>Manual validation steps</summary><ol>{finding.manual_validation.map((step) => <li key={step}>{step}</li>)}</ol></details></article>)}</div><small className="kernel-review-provenance">Archived input SHA-256: <code>{evaluation.cycle_review.input.sha256}</code>. Finding classifications and evidence are from the linked JSON review artifact; they do not describe a fresh post-fix run.</small></section>}
    <p className="kernel-eval-footnote">Results cover these five translation units only. They are measurements of this run, not a whole-kernel evaluation. No precision or recall is available without independently labeled kernel ground truth.</p>
  </>
}

function Phase13Comparison({ comparison }: { comparison: NonNullable<KernelEvaluation['phase13_comparison']> }) {
  const fields: Array<[string, string, string]> = [
    ['Functions analyzed', 'functions', 'number'],
    ['Lock acquisitions / releases', 'lock_acquisitions', 'pair'],
    ['Lock dependencies', 'lock_dependencies', 'number'],
    ['Interrupt graph edges', 'interrupt_graph_edges', 'number'],
    ['Candidate cycles', 'candidate_cycles', 'number'],
    ['Raw uncertainty events', 'uncertainty_events', 'number'],
    ['Unique uncertainty records', 'unique_uncertainty_records', 'number'],
  ]
  const value = (record: Record<string, any>, key: string, kind: string) => kind === 'pair'
    ? `${record.lock_acquisitions} / ${record.lock_releases}`
    : Number(record[key] ?? 0).toLocaleString()
  return <section className="panel phase13-comparison"><div className="panel-heading"><div><div className="eyebrow">PHASE 13 · BEFORE / AFTER</div><h2>Post-fix comparison</h2></div><span className="runtime-scope">same kernel revision and config</span></div><div className="runtime-table-wrap"><table className="data-table"><thead><tr><th>Measure</th><th>Phase 9.0 baseline</th><th>Post-fix run</th></tr></thead><tbody>{fields.map(([label, key, kind]) => <tr key={key}><th>{label}</th><td>{value(comparison.before, key, kind)}</td><td>{value(comparison.after, key, kind)}</td></tr>)}</tbody></table></div><p className="phase12-validation-note">{comparison.metrics_warning}</p></section>
}

function Phase12Validation({ evidence }: { evidence: NonNullable<KernelEvaluation['phase12_validation']> }) {
  const full = evidence.full_validation
  const initial = evidence.pre_install_attempt
  const source = evidence.source_only
  const stages: Array<[string, string]> = full ? [
    ['C object compilation', String(full.validation.kernel_object_compilation ?? 'not recorded')],
    ['Source analysis', String(full.validation.source_analysis ?? 'not recorded')],
    ['Objtool build', String(full.validation.objtool_build ?? 'not recorded')],
    ['Deferred objtool checks', String(full.validation.objtool_object_checks ?? 'not recorded')],
    ['ORC sections in composite object', String(full.validation.orc_sections_present ?? 'not recorded')],
    ['Final module link', String(full.validation.kernel_module_link ?? 'not recorded')],
    ['Separate stack validation', String(full.validation.stack_validation ?? 'not recorded')],
  ] : []
  return <section className="panel phase12-validation"><div className="panel-heading"><div><div className="eyebrow">PHASE 12 · BUILD VALIDATION</div><h2>Kernel validation stages</h2></div><span className="status-pill muted">bounded subsystem validation</span></div>
    {full && <div className="phase12-source-result"><strong>Post-install run · {full.status.replaceAll('_', ' ')}</strong><span>{String(full.validation.objtool_invocations ?? 0)} deferred objtool invocation · {Array.isArray(full.validation.objtool_options) ? full.validation.objtool_options.join(' ') : ''}</span><table><tbody>{stages.map(([label, value]) => <tr key={label}><th>{label}</th><td>{String(value ?? 'not recorded').replaceAll('_', ' ')}</td></tr>)}</tbody></table></div>}
    {initial && <div className="phase12-attempt"><strong>Earlier pre-install attempt · {initial.status.replaceAll('_', ' ')}</strong><p>{initial.blocker ?? 'libelf development headers were missing at that time.'}</p></div>}
    {source && <div className="phase12-attempt"><strong>Source-only comparison · {source.status.replaceAll('_', ' ')}</strong><p>{source.aggregate.files_analyzed ?? 0}/{source.aggregate.files_requested ?? 0} files analyzed; objtool was explicitly skipped for this run. The post-install run above generated ORC metadata. Zero reported cycles do not prove deadlock freedom.</p></div>}
    {evidence.build_limitations.map((item) => <p className="phase12-validation-note" key={item}>{item}</p>)}
  </section>
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
