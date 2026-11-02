import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  AlertCircle,
  BookOpen,
  Database,
  FileSearch,
  GitBranch,
  Gauge,
  HardDrive,
  History,
  Laptop,
  LayoutDashboard,
  LockKeyhole,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Search,
  Settings2,
  ShieldAlert,
  Sun,
  TerminalSquare,
  Zap,
} from 'lucide-react'
import {
  ApiError,
  IS_STATIC_MODE,
  deleteAnalysis,
  getAnalyses,
  getAnalysis,
  getHealth,
  getKernelEvaluation,
  getReport,
  getSource,
  startAnalysis,
} from './api'
import type {
  AnalysisMetadata,
  AnalysisReport,
  Finding,
  Health,
  KernelEvaluation,
  SourceSnippet,
} from './types'
import { compareReports } from './reportComparison'
import { DemoBadge } from './components/DemoBadge'
import {
  DEMO_KERNEL_EVALUATION,
  getDemoMetadata,
  getDemoReport,
} from './demo/demoData'

import { ProjectGuidePage } from './pages/ProjectGuidePage'
import { WalkthroughPage } from './pages/WalkthroughPage'
import { ScopeLimitsPage } from './pages/ScopeLimitsPage'
import { RunItYourselfPage } from './pages/RunItYourselfPage'
import { KernelEvaluationPage } from './pages/KernelEvaluationPage'
import { OverviewPage } from './pages/OverviewPage'
import { FindingsPage } from './pages/FindingsPage'
import { SourcePage } from './pages/SourcePage'
import { GraphPage } from './pages/GraphPage'
import { HistoryPage } from './pages/HistoryPage'
import { NewAnalysisPage } from './pages/NewAnalysisPage'
import { SettingsPage } from './pages/SettingsPage'
import { RuntimeEvidencePage } from './pages/RuntimeEvidencePage'
import { CliGuidePage } from './pages/CliGuidePage'

export type Page =
  | 'guide'
  | 'walkthrough'
  | 'scope'
  | 'overview'
  | 'graph'
  | 'findings'
  | 'source'
  | 'kernel'
  | 'runtime'
  | 'run'
  | 'new'
  | 'cli'
  | 'history'
  | 'benchmarks'
  | 'settings'

interface NavItem {
  id: Page
  label: string
  icon: typeof LayoutDashboard
  section: 'Learn' | 'Explore' | 'Evidence' | 'Run it yourself'
  requiresBackend?: boolean
}

const navItems: NavItem[] = [
  // Learn
  { id: 'guide', label: 'Project guide', icon: BookOpen, section: 'Learn' },
  { id: 'walkthrough', label: 'Walkthrough', icon: Zap, section: 'Learn' },
  { id: 'scope', label: 'Scope & limits', icon: ShieldAlert, section: 'Learn' },

  // Explore
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, section: 'Explore' },
  { id: 'graph', label: 'Lock graph', icon: GitBranch, section: 'Explore' },
  { id: 'findings', label: 'Findings', icon: ShieldAlert, section: 'Explore' },
  { id: 'source', label: 'Source explorer', icon: FileSearch, section: 'Explore' },

  // Evidence
  { id: 'kernel', label: 'Kernel evaluation', icon: HardDrive, section: 'Evidence' },
  { id: 'runtime', label: 'Runtime evidence', icon: Activity, section: 'Evidence' },

  // Run it yourself
  { id: 'run', label: 'Run it yourself', icon: Laptop, section: 'Run it yourself' },
  { id: 'new', label: 'New analysis', icon: Play, section: 'Run it yourself', requiresBackend: true },
  { id: 'cli', label: 'CLI & reports', icon: TerminalSquare, section: 'Run it yourself' },
  { id: 'history', label: 'Analysis history', icon: History, section: 'Run it yourself', requiresBackend: true },
  { id: 'benchmarks', label: 'Benchmarks', icon: Gauge, section: 'Run it yourself', requiresBackend: true },
  { id: 'settings', label: 'Settings', icon: Settings2, section: 'Run it yourself' },
]

function basename(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

export default function App({ initialPage = 'guide' }: { initialPage?: Page } = {}) {
  const [page, setPage] = useState<Page>(initialPage)
  const [health, setHealth] = useState<Health | null>(null)
  const [history, setHistory] = useState<AnalysisMetadata[]>([])
  const [active, setActive] = useState<AnalysisMetadata | null>(null)
  const [report, setReport] = useState<AnalysisReport | null>(null)
  const [backendError, setBackendError] = useState('')
  const [loadingReport, setLoadingReport] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('irqguard-sidebar-collapsed') === 'true'
  )
  const [graphSearchTerm, setGraphSearchTerm] = useState('')
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null)
  const [sourceSnippet, setSourceSnippet] = useState<SourceSnippet | null>(null)
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceError, setSourceError] = useState('')
  const [kernelEvaluation, setKernelEvaluation] = useState<KernelEvaluation | null>(null)
  const [kernelLoading, setKernelLoading] = useState(false)
  const [kernelError, setKernelError] = useState('')
  const [compareIds, setCompareIds] = useState<string[]>([])
  const [analysisStatus, setAnalysisStatus] = useState<string>('idle')
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('irqguard-theme') as 'dark' | 'light') || 'dark'
  )

  // Demo mode state
  const [isDemoMode, setIsDemoMode] = useState<boolean>(false)
  const [activeDemoId, setActiveDemoId] = useState<string>('demo-interrupts')

  // Theme application
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('irqguard-theme', theme)
  }, [theme])

  const toggleTheme = () => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  }

  // Load demo example
  const loadDemoExample = useCallback((exampleId = 'demo-interrupts') => {
    setIsDemoMode(true)
    setActiveDemoId(exampleId)
    const demoMeta = getDemoMetadata(exampleId)
    const demoRep = getDemoReport(exampleId)
    setActive(demoMeta)
    setReport(demoRep)
    setSelectedFinding(demoRep.interrupt_cycles[0] ?? null)
    setSourceSnippet(null)
  }, [])

  // Health and backend connection check
  const loadHealth = useCallback(async () => {
    try {
      const data = await getHealth()
      setHealth(data)
      setBackendError('')
    } catch (error) {
      setHealth(null)
      setBackendError('The local IRQGuard API is unavailable. Demo mode is active with bundled reports.')
    }
  }, [])

  // Load history and active analysis
  const loadAnalyses = useCallback(
    async (selectId?: string) => {
      try {
        const items = await getAnalyses()
        setHistory(items)
        const target = selectId ? items.find((item) => item.id === selectId) : items[0]
        if (target) {
          setActive(target)
          setReport(null)
          setLoadingReport(true)
          const detailed = await getAnalysis(target.id)
          setActive(detailed)
          const rep = await getReport(target.id)
          setReport(rep)
          setSelectedFinding(rep.interrupt_cycles[0] ?? null)
        } else {
          // If no history on backend, we stay in no-history or can offer demo
        }
      } catch (error) {
        if (error instanceof ApiError) {
          setBackendError(error.message)
        } else {
          setBackendError('The local IRQGuard API is unavailable.')
        }
      } finally {
        setLoadingReport(false)
      }
    },
    []
  )

  // Load kernel evaluation data
  const loadKernel = useCallback(async () => {
    setKernelLoading(true)
    setKernelError('')
    try {
      const data = await getKernelEvaluation()
      setKernelEvaluation(data)
    } catch (error) {
      // In demo/offline mode, fallback to bundled evaluation
      setKernelEvaluation(DEMO_KERNEL_EVALUATION)
    } finally {
      setKernelLoading(false)
    }
  }, [])

  useEffect(() => {
    if (IS_STATIC_MODE) {
      loadDemoExample('demo-interrupts')
      setKernelEvaluation(DEMO_KERNEL_EVALUATION)
      return
    }
    void loadHealth()
    void loadAnalyses()
    void loadKernel()
  }, [loadHealth, loadAnalyses, loadKernel, loadDemoExample])

  const openSource = useCallback(
    async (file: string, line: number) => {
      setSourceLoading(true)
      setSourceError('')
      setPage('source')
      try {
        const id = active?.id ?? (isDemoMode ? activeDemoId : 'demo-interrupts')
        const snippet = await getSource(id, file, line)
        setSourceSnippet(snippet)
      } catch (error) {
        setSourceError(error instanceof Error ? error.message : 'Could not load source snippet.')
      } finally {
        setSourceLoading(false)
      }
    },
    [active, isDemoMode, activeDemoId]
  )

  const handleSelectAnalysis = async (metadata: AnalysisMetadata) => {
    setIsDemoMode(false)
    setActive(metadata)
    setReport(null)
    setLoadingReport(true)
    try {
      const detailed = await getAnalysis(metadata.id)
      setActive(detailed)
      const rep = await getReport(metadata.id)
      setReport(rep)
      setSelectedFinding(rep.interrupt_cycles[0] ?? null)
      setSourceSnippet(null)
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : 'Could not open report.')
    } finally {
      setLoadingReport(false)
    }
  }

  const handleDeleteAnalysis = async (metadata: AnalysisMetadata) => {
    try {
      await deleteAnalysis(metadata.id)
    } catch (error) {
      const alreadyMissing =
        error instanceof ApiError &&
        error.status === 404 &&
        /analysis was not found/i.test(error.message)
      if (!alreadyMissing) throw error
    }
    const refreshed = await getAnalyses().catch(() => null)
    if (refreshed) setHistory(refreshed.filter((item) => item.id !== metadata.id))
    else setHistory((current) => current.filter((item) => item.id !== metadata.id))
    setCompareIds((current) => current.filter((id) => id !== metadata.id))
    if (active?.id === metadata.id) {
      setActive(null)
      setReport(null)
      setSelectedFinding(null)
    }
  }

  const handleStartAnalysis = async (values: {
    source_path: string
    compile_commands_path?: string
    api_config_path?: string
  }) => {
    setAnalysisStatus('running')
    try {
      const result = await startAnalysis(values)
      setAnalysisStatus('completed')
      await loadAnalyses(result.id)
      setPage('overview')
    } catch (e) {
      setAnalysisStatus('failed')
      throw e
    }
  }

  const handleCompareReports = async (beforeMeta: AnalysisMetadata, afterMeta: AnalysisMetadata) => {
    const beforeReport = await getReport(beforeMeta.id)
    const afterReport = await getReport(afterMeta.id)
    return compareReports(beforeMeta, beforeReport, afterMeta, afterReport)
  }

  const toggleCompare = (id: string) => {
    setCompareIds((ids) => (ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id].slice(-2)))
  }

  const navigate = (target: Page) => {
    setPage(target)
    setMobileNavOpen(false)
  }

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev
      localStorage.setItem('irqguard-sidebar-collapsed', String(next))
      return next
    })
  }

  const backendUnavailable = !health || !health.analyzer_available

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      {mobileNavOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          onClick={() => setMobileNavOpen(false)}
          aria-label="Close navigation overlay"
        />
      )}

      {/* Sidebar */}
      <aside className={`sidebar ${sidebarCollapsed ? 'sidebar-narrow' : ''} ${mobileNavOpen ? 'sidebar-open' : ''}`}>
        <div className="brand-lockup">
          <button
            type="button"
            className="brand-mark"
            onClick={() => {
              navigate('guide')
              setMobileNavOpen(false)
            }}
            aria-label="Go to Project guide"
            style={{ border: 'none', cursor: 'pointer' }}
          >
            <LockKeyhole size={16} />
          </button>
          <div className="brand-text">
            <div className="brand-name">IRQGuard</div>
            <div className="brand-caption">STATIC LOCK ANALYZER</div>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Primary navigation">
          {(['Learn', 'Explore', 'Evidence', 'Run it yourself'] as const).map((section) => (
            <div className="nav-section" key={section}>
              {!sidebarCollapsed && <div className="nav-section-title">{section}</div>}
              {navItems
                .filter((item) => item.section === section)
                .filter((item) => !(IS_STATIC_MODE && item.requiresBackend))
                .map((item) => {
                  const Icon = item.icon
                  const isDisabled = Boolean(item.requiresBackend && backendUnavailable)
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`nav-item ${page === item.id ? 'active' : ''} ${isDisabled ? 'disabled' : ''}`}
                      onClick={() => {
                        navigate(item.id)
                        setMobileNavOpen(false)
                      }}
                      disabled={isDisabled}
                      title={
                        isDisabled
                          ? `${item.label} (requires running local Node backend)`
                          : item.label
                      }
                    >
                      <Icon size={16} />
                      {!sidebarCollapsed && (
                        <span className="nav-item-text">
                          <span className="nav-item-label">{item.label}</span>
                          {isDisabled && <span className="nav-backend-tag">offline</span>}
                        </span>
                      )}
                    </button>
                  )
                })}
            </div>
          ))}
        </nav>

        <div className="sidebar-bottom">
          {!sidebarCollapsed && (
            <div className="sidebar-demo-box">
              <span className="text-dim text-xs">Need to explore?</span>
              <button
                type="button"
                className="text-button text-xs"
                onClick={() => loadDemoExample()}
              >
                <Database size={12} /> {isDemoMode ? 'Reload demo' : 'Load demo data'}
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main Column */}
      <div className="main-column">
        <header className="topbar">
          <button
            type="button"
            className="icon-button mobile-menu"
            onClick={() => setMobileNavOpen(!mobileNavOpen)}
            aria-label="Open navigation"
          >
            <Menu size={18} />
          </button>
          <button
            type="button"
            className="icon-button sidebar-toggle"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>

          <div className="breadcrumb">
            <span>IRQGuard</span>
            <span className="breadcrumb-sep">/</span>
            <strong>{navItems.find((n) => n.id === page)?.label ?? page}</strong>
          </div>

          {report && (
            <div className="workspace-search">
              <Search size={14} />
              <input
                aria-label="Search current analysis"
                placeholder="Search locks, functions, or findings…"
                value={graphSearchTerm}
                onChange={(e) => setGraphSearchTerm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    navigate('graph')
                  }
                }}
              />
              {graphSearchTerm && (
                <div className="search-results">
                  {report.interrupt_lock_graph.nodes
                    .filter((n) => n.lock_identity.toLowerCase().includes(graphSearchTerm.toLowerCase()))
                    .slice(0, 5)
                    .map((n) => (
                      <button
                        key={n.lock_identity}
                        type="button"
                        role="option"
                        aria-selected={false}
                        onClick={() => {
                          navigate('graph')
                        }}
                      >
                        <span className="search-result-kind">Lock</span>
                        <span>
                          <strong>{basename(n.lock_identity)}</strong>
                          <small>{n.lock_identity}</small>
                        </span>
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}

          <div className="topbar-right">
            {isDemoMode ? (
              <span className="demo-pill">Demo mode</span>
            ) : (
              <div className="top-status">
                <span className={`status-dot ${backendUnavailable ? 'status-bad' : 'online'}`} />
                <span>{backendUnavailable ? 'Backend offline' : 'Connected'}</span>
              </div>
            )}
            <button
              type="button"
              className="icon-button theme-toggle"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button
              type="button"
              className="button button-primary button-small"
              onClick={() => navigate('walkthrough')}
            >
              <Zap size={13} /> Walkthrough
            </button>
          </div>
        </header>

        {/* Demo Data Banner when Demo Data is active */}
        {isDemoMode && (
          <DemoBadge
            activeExampleId={activeDemoId}
            onSelectExample={(id) => loadDemoExample(id)}
          />
        )}

        {/* Backend Error Alert Banner */}
        {backendError && !isDemoMode && (
          <div className="alert alert-warning" role="alert" style={{ margin: '12px 20px 0' }}>
            <AlertCircle size={15} />
            <span>{backendError}</span>
            <button
              type="button"
              className="text-button ml-auto"
              onClick={() => loadDemoExample()}
            >
              Load bundled demo
            </button>
          </div>
        )}

        {/* Main Content Area */}
        <main className="main-content" id="main-content" key={page}>
          <div className="content-container">
            {page === 'guide' && (
              <ProjectGuidePage
                latestRun={kernelEvaluation?.phase17_evaluation ?? null}
                onOpenWorkspace={() => navigate('overview')}
                onNew={() => navigate('new')}
                onKernel={() => navigate('kernel')}
                onRuntime={() => navigate('runtime')}
                onCli={() => navigate('cli')}
                onWalkthrough={() => navigate('walkthrough')}
                onScope={() => navigate('scope')}
              />
            )}

            {page === 'walkthrough' && <WalkthroughPage />}

            {page === 'scope' && <ScopeLimitsPage />}

            {page === 'run' && <RunItYourselfPage />}

            {page === 'overview' && (
              <OverviewPage
                active={active}
                report={report}
                history={history}
                health={health}
                loading={loadingReport}
                isDemoMode={isDemoMode}
                onLoadExample={() => loadDemoExample()}
                onNew={() => navigate('new')}
                onOpenHistory={() => navigate('history')}
                onOpenGuide={() => navigate('guide')}
                onOpenFinding={(index) => {
                  setSelectedFinding(report?.interrupt_cycles[index] ?? null)
                  navigate('findings')
                }}
                onOpenGraph={() => navigate('graph')}
                onSelectAnalysis={handleSelectAnalysis}
                selectedFinding={selectedFinding}
                onSelectFinding={setSelectedFinding}
                onOpenSource={openSource}
              />
            )}

            {page === 'graph' && (
              <GraphPage
                report={report}
                active={active}
                selectedFinding={selectedFinding}
                onSelectFinding={setSelectedFinding}
                onOpenSource={openSource}
                searchTerm={graphSearchTerm}
                onLoadExample={() => loadDemoExample()}
              />
            )}

            {page === 'findings' && (
              <FindingsPage
                report={report}
                analysis={active}
                selectedIndex={selectedFinding && report ? report.interrupt_cycles.indexOf(selectedFinding) : null}
                onSelect={(index) => setSelectedFinding(index != null && report ? report.interrupt_cycles[index] : null)}
                onOpenSource={openSource}
                onOpenGraph={(index) => {
                  if (report && report.interrupt_cycles[index]) {
                    setSelectedFinding(report.interrupt_cycles[index])
                  }
                  navigate('graph')
                }}
                onLoadExample={() => loadDemoExample()}
              />
            )}

            {page === 'source' && (
              <SourcePage
                report={report}
                snippet={sourceSnippet}
                loading={sourceLoading}
                error={sourceError}
                onOpenSource={openSource}
                onLoadExample={() => loadDemoExample()}
              />
            )}

            {page === 'kernel' && (
              <KernelEvaluationPage
                evaluation={kernelEvaluation}
                loading={kernelLoading}
                error={kernelError}
              />
            )}

            {page === 'runtime' && (
              <RuntimeEvidencePage
                mode="runtime"
                health={health}
                history={history}
                activeAnalysis={active}
              />
            )}

            {page === 'benchmarks' && (
              <RuntimeEvidencePage
                mode="benchmarks"
                health={health}
                history={history}
                activeAnalysis={active}
              />
            )}

            {page === 'cli' && <CliGuidePage />}

            {page === 'history' && (
              <HistoryPage
                history={history}
                activeId={active?.id}
                compareIds={compareIds}
                onRefresh={loadAnalyses}
                onOpen={handleSelectAnalysis}
                onDelete={handleDeleteAnalysis}
                onCompareReports={handleCompareReports}
                onToggleCompare={toggleCompare}
              />
            )}

            {page === 'new' && (
              <NewAnalysisPage
                health={health}
                status={analysisStatus}
                onStart={handleStartAnalysis}
              />
            )}

            {page === 'settings' && (
              <SettingsPage health={health} onRefresh={loadHealth} />
            )}
          </div>
        </main>

        <footer className="app-footer">
          <span>IRQGuard · Static Deadlock & Interrupt Analysis</span>
          <span>Candidates are static hypotheses, not confirmed runtime deadlocks.</span>
        </footer>
      </div>
    </div>
  )
}
