import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from './App'
import fixture from './test-data/report.fixture.json'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear() })

function jsonResponse(payload: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload } as Response
}

const health = {
  api_version: '1', status: 'ok', analyzer_path: '/tmp/deadlock-analyzer', analyzer_available: true,
  analyzer_report_schema: 4, workspace_roots: ['/tmp/irqguard-test'], data_directory: '/tmp/irqguard-test/data',
  runtime_evidence_available: false, benchmarks_available: false,
}

describe('IRQGuard workspace states', () => {
  it('renders the no-history dashboard without sample findings or invented metrics', async () => {
    const latestRun = {
      controlled_fixture_passed: 8, controlled_fixture_failed: 0,
      real_kernel_aggregate: { files_analyzed: 5, files_requested: 5, counts_sum_across_translation_units: { functions: 396, lock_operations: 12, lock_dependencies: 0, interrupt_cycles: 0, uncertainties: 43632 } },
      real_kernel_cases: Array.from({ length: 5 }, (_, index) => ({ measurements: { unique_uncertainty_records: index === 4 ? 986 : 984, uncertainty_by_category: { lock_identity: { unique_record_count: index === 4 ? 21 : 17 } } } })),
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/health')
      ? jsonResponse(health)
      : String(input).includes('/evaluations/linux-v6.6.87') ? jsonResponse({
        phase17_evaluation: latestRun,
        phase19_2_uncertainty: { after: {
          uncertainty_events: 36330, unique_records: 4644, unique_root_causes: 2431,
          lock_dependencies: 0, candidate_cycles: 0,
        } },
      }) : jsonResponse({ analyses: [] })))
    render(<App initialPage="overview" />)
    expect(await screen.findByRole('heading', { name: 'Start with a C source file' })).toBeInTheDocument()
    expect(screen.queryByText(/candidate lock-order cycles/i)).not.toBeInTheDocument()
    expect(screen.getByText(/absolute linux path inside an allowed workspace/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Project guide' }))
    expect(await screen.findByRole('heading', { name: /Find the lock paths that cross interrupt boundaries/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /A lock order can change meaning at an interrupt boundary/ })).toBeInTheDocument()
    expect(screen.getAllByText('tests/fixtures/interrupts.c').length).toBeGreaterThan(0)
    expect(screen.getByText(/not a confirmed Linux defect/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Built around source structure and explainable graph facts/ })).toBeInTheDocument()
    expect(screen.getByText(/Parse the program/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /Resolve lock events/i }))
    expect(screen.getAllByText(/Resolve lock events/).length).toBeGreaterThan(0)
    expect(screen.getByText(/does not reproduce Archerfish/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /See measurements and build limits/ })).toBeInTheDocument()
    const currentResult = document.querySelector('.guide-current-result')
    expect(currentResult?.textContent).toContain('0 dependencies · 0 candidate cycles · 36,330 uncertainty events · 4,644 unique records')
    expect(currentResult?.textContent).toContain('2,431 root causes after linking repeated IRQ-state effects')
  })

  it('shows a useful error when the local API cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/local irqguard api is unavailable/i)
  })

  it('shows empty and unsupported runtime evidence states without inventing events', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/health')
      ? jsonResponse({ ...health, runtime_evidence_available: false })
      : String(input).includes('/runtime/runs') ? jsonResponse({ runs: [] }) : jsonResponse({ analyses: [] })))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Runtime evidence' }))
    expect(await screen.findByRole('heading', { name: 'Runtime evidence' })).toBeInTheDocument()
    expect(screen.getByText(/Runtime tools are unavailable/)).toBeInTheDocument()
    expect(screen.getByText('No runtime runs yet.')).toBeInTheDocument()
    expect(screen.queryByText(/Observed in controlled userspace process/)).not.toBeInTheDocument()
  })

  it('compares saved report semantics and reports changed lock identity without claiming deadlock confirmation', async () => {
    const provenance = { input_fingerprints: { source_sha256: 'same-source', compile_commands_sha256: 'same-compile', api_config_sha256: 'same-api', analyzer_sha256: 'same-analyzer' } }
    const runs = ['before', 'after'].map((id) => ({ id, created_at: new Date().toISOString(), status: 'completed',
      source_path: '/tmp/irqguard-test/demo.c', analyzer_report_schema_version: 3, analysis_provenance: provenance,
      summary: { functions: 2, graph_edges: id === 'before' ? 2 : 3, candidate_cycles: 1 } }))
    const laterReport = { ...fixture, interrupt_lock_graph: { ...fixture.interrupt_lock_graph,
      edges: [...fixture.interrupt_lock_graph.edges, { ...fixture.interrupt_lock_graph.edges[0], from_lock: 'lock-C', to_lock: 'lock-D' }] } }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/health')) return jsonResponse(health)
      if (url.endsWith('/analyses')) return jsonResponse({ analyses: runs })
      if (url.endsWith('/before/report')) return jsonResponse(fixture)
      if (url.endsWith('/after/report')) return jsonResponse(laterReport)
      return jsonResponse({ analysis: runs[0] })
    }))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Analysis history' }))
    const selectors = await screen.findAllByRole('checkbox')
    fireEvent.click(selectors[0]); fireEvent.click(selectors[1])
    fireEvent.click(screen.getByRole('button', { name: 'Compare report semantics' }))
    expect(await screen.findByRole('region', { name: 'Semantic report comparison' })).toBeInTheDocument()
    const semanticDiff = screen.getByRole('region', { name: 'Semantic report comparison' })
    expect(semanticDiff).toHaveTextContent(/semantic changes/)
    expect(semanticDiff).toHaveTextContent(/Recorded inputs match/)
    expect(semanticDiff).toHaveTextContent(/Identity changed: lock-A → lock-B became lock-C → lock-D/)
    expect(screen.getByText(/Static candidates are evidence for review, not confirmed deadlocks/)).toBeInTheDocument()
  })

  it('shows current irqsave extraction status in the CLI guide caveat', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/health')
      ? jsonResponse(health) : jsonResponse({ analyses: [] })))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'CLI & reports' }))
    expect(await screen.findByText(/Extraction regression tests find both `spin_lock_irqsave` acquisitions/)).toBeInTheDocument()
    expect(screen.getByText(/does not prove the driver is deadlock-free/)).toBeInTheDocument()
    expect(screen.queryByText(/pinned kernel run missed some/)).not.toBeInTheDocument()
    expect(screen.getByText(/Schema v4 · archived v3 supported/)).toBeInTheDocument()
  })

  it('shows current kernel results without archived run history or phase labels', async () => {
    const evaluation = {
      status: 'completed',
      kernel: { release_tag: 'v6.6.87', commit: '814637ca257f4faf57a73fd4e38888cce88b5911' },
      configuration: { subsystem: 'e1000e', architecture: 'x86_64', config_base: 'x86_64_defconfig', compiler_mode: 'Clang', build_limitations: [] },
      aggregate: { files_requested: 5, files_analyzed: 5, files_skipped_or_failed: 0, functions: 396, lock_operations: 12, lock_dependencies: 0, interrupt_graph_edges: 0, interrupt_cycles: 0, uncertainties: 36330, diagnostics: 2, elapsed_seconds_sum: 6.897, peak_rss_kib_max: 236344 },
      translation_units: [],
      phase19_2_uncertainty: {
        schema_version: 1, phase: '19.2', status: 'completed',
        kernel: { release_tag: 'v6.6.87', commit: '814637ca257f4faf57a73fd4e38888cce88b5911' },
        subsystem: 'e1000e', source_files: ['netdev.c'], baseline: {},
        after: { files_analyzed: 5, files_requested: 5, functions: 396, lock_operations: 12, lock_acquisitions: 6, lock_releases: 6, lock_dependencies: 0, candidate_cycles: 0, uncertainty_events: 36330, unique_records: 4644, unique_root_causes: 2431, parser_diagnostics: 2, analysis_seconds: 6.897, peak_memory_kib: 236344,
          validation: { kernel_object_compilation: 'succeeded', objtool_object_checks: 'succeeded', orc_sections_present: true, kernel_module_link: 'not_attempted; composite object target only', stack_validation: 'not_configured_by_defconfig' },
          category_counts: { unresolved_call: { event_count: 18023, unique_record_count: 2213 }, interrupt_state: { event_count: 18023, unique_record_count: 2213 }, lock_identity: { event_count: 118, unique_record_count: 89 } } },
        per_file: [{ source_file: 'netdev.c', status: 'analyzed', functions: 154, lock_operations: 10, lock_dependencies: 0, interrupt_cycles: 0, uncertainties: 24685, elapsed_seconds: 2.558 }],
        largest_remaining_unresolved_calls: [], interpretation: 'Unknown calls remain conservative.', classification_note: 'Secondary effects retain their root cause.',
      },
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/health')
      ? jsonResponse(health)
      : String(input).endsWith('/evaluations/linux-v6.6.87') ? jsonResponse(evaluation) : jsonResponse({ analyses: [] })))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Kernel evaluation' }))
    expect(await screen.findByRole('heading', { name: 'Results by source file' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Why the analyzer remains uncertain' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'What the kernel build checked' })).toBeInTheDocument()
    expect(screen.getByText('36,330')).toBeInTheDocument()
    expect(screen.getByText(/2,431 root causes/)).toBeInTheDocument()
    expect(screen.getByText(/netdev.c/)).toBeInTheDocument()
    expect(screen.queryByText(/Historical Runs|Archived baseline|Phase [0-9]/i)).not.toBeInTheDocument()
  })

  it('allows the desktop sidebar to collapse without hiding its navigation controls', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/health')
      ? jsonResponse(health) : jsonResponse({ analyses: [] })))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse sidebar' }))
    expect(document.querySelector('.sidebar')).toHaveClass('sidebar-narrow')
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument()
  })

  it('validates an outside workspace path before sending a request', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init
      return String(input).includes('/health') ? jsonResponse(health) : jsonResponse({ analyses: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App initialPage="overview" />)
    await screen.findByRole('heading', { name: 'Start with a C source file' })
    fireEvent.click(screen.getAllByRole('button', { name: /new analysis/i })[0])
    fireEvent.change(screen.getByLabelText(/Source file path/), { target: { value: '/etc/passwd' } })
    fireEvent.click(screen.getByRole('button', { name: /start analysis/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/outside the configured workspace roots/i)
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/analyses') && init?.method === 'POST')).toBe(false)
  })

  it('paginates large finding lists instead of rendering every result at once', async () => {
    const bigReport = {
      ...fixture,
      interrupt_lock_graph: { nodes: [], edges: [] },
      interrupt_cycles: Array.from({ length: 60 }, (_, index) => ({
        ...fixture.interrupt_cycles[0], explanation: `Test-only fixture finding ${index + 1}`,
      })),
    }
    const metadata = {
      id: 'run-12345678', created_at: new Date().toISOString(), status: 'completed',
      source_path: '/tmp/irqguard-test/demo.c', analyzer_schema_version: 3,
      summary: { functions: 2, lock_operations: 2, graph_edges: 0, candidate_cycles: 60 },
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/health')) return jsonResponse(health)
      if (url.endsWith('/analyses')) return jsonResponse({ analyses: [metadata] })
      if (url.endsWith('/report')) return jsonResponse(bigReport)
      return jsonResponse({ analysis: metadata })
    }))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Findings' }))
    expect(await screen.findByText('Page 1 of 3 · showing up to 25')).toBeInTheDocument()
    expect(screen.getAllByRole('row').length).toBeLessThanOrEqual(26)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Page 2 of 3 · showing up to 25')).toBeInTheDocument()
  })

  it('shows an empty graph instead of drawing sample edges', async () => {
    const emptyReport = { ...fixture, interrupt_lock_graph: { nodes: [], edges: [] }, interrupt_cycles: [] }
    const metadata = { id: 'run-9', created_at: new Date().toISOString(), status: 'completed', source_path: '/tmp/irqguard-test/demo.c', analyzer_schema_version: 3, summary: { functions: 0, graph_edges: 0, candidate_cycles: 0 } }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/health')) return jsonResponse(health)
      if (url.endsWith('/analyses')) return jsonResponse({ analyses: [metadata] })
      if (url.endsWith('/report')) return jsonResponse(emptyReport)
      return jsonResponse({ analysis: metadata })
    }))
    render(<App initialPage="overview" />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Lock Dependency Graph' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Lock graph' }))
    expect(await screen.findByRole('heading', { name: 'No lock dependency edges' })).toBeInTheDocument()
  })

  it('shows report functions and syntax-colored source with exact line numbers', async () => {
    const metadata = { id: 'run-source', created_at: new Date().toISOString(), status: 'completed', source_path: '/tmp/irqguard-test/demo.c', analyzer_schema_version: 3, summary: { functions: 2 } }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/health')) return jsonResponse(health)
      if (url.endsWith('/analyses')) return jsonResponse({ analyses: [metadata] })
      if (url.endsWith('/report')) return jsonResponse(fixture)
      if (url.includes('/source?')) return jsonResponse({ file: '/tmp/irqguard-test/demo.c', requested_line: 4, lines: [{ line: 4, text: 'int worker(void) {', highlighted: true }] })
      return jsonResponse({ analysis: metadata })
    }))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Source explorer' }))
    fireEvent.click(await screen.findByRole('button', { name: /worker/ }))
    expect(await screen.findByRole('region', { name: 'Source at line 4' })).toBeInTheDocument()
    expect(screen.getByText('int', { selector: '.syntax-keyword' })).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
  })

  it('shows actual graph edges and makes multiple report cycles selectable', async () => {
    const evidenceEdges = fixture.interrupt_cycles[0].edges.map((edge, index) => ({
      ...edge,
      feasibility: index === 0 ? 'cfg_reachable' : 'potentially_feasible',
      feasibility_reason: 'Supported path evidence retained.',
      summary_status: 'direct',
      path_condition_status: 'compatible',
      path_conditions: index === 0 ? [{ expression: 'choose', atom: 'param@choose', truth: true, supported: true, loop_back_edge: false }] : [],
      registration_lifecycle: index === 1 ? 'matching_free_irq_arguments_order_unproven' : 'not_applicable',
      deregistration_evidence: index === 1 ? [{ isMacro: false, expansion: { file: '/tmp/irqguard-test/demo.c', line: 16, column: 3, valid: true }, spelling: { file: '/tmp/irqguard-test/demo.c', line: 16, column: 3, valid: true } }] : [],
    }))
    const multipleReport = {
      ...fixture,
      interrupt_cycles: [{ ...fixture.interrupt_cycles[0], feasibility: 'potentially_feasible', edges: evidenceEdges }, {
        ...fixture.interrupt_cycles[0], category: 'candidate_lock_order_cycle',
        lock_sequence: ['lock-B', 'lock-A', 'lock-B'],
      }],
    }
    const metadata = { id: 'run-2', created_at: new Date().toISOString(), status: 'completed', source_path: '/tmp/irqguard-test/demo.c', analyzer_schema_version: 3, summary: { functions: 2, graph_edges: 2, candidate_cycles: 2 } }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/health')) return jsonResponse(health)
      if (url.endsWith('/analyses')) return jsonResponse({ analyses: [metadata] })
      if (url.endsWith('/report')) return jsonResponse(multipleReport)
      return jsonResponse({ analysis: metadata })
    }))
    render(<App initialPage="overview" />)
    expect(await screen.findByRole('heading', { name: 'Recent analyses' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Lock Dependency Graph' })).toBeInTheDocument()
    expect(screen.getByRole('tablist', { name: 'Finding detail sections' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Execution Context' }))
    expect(screen.getAllByText(/process → hardirq/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('tab', { name: 'Analysis Evidence' }))
    expect(screen.getByText(/Path constraint: param@choose is true/)).toBeInTheDocument()
    expect(screen.getByText(/Handler lifecycle: matching_free_irq_arguments_order_unproven/)).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Lock graph' }))
    const findingSelect = await screen.findByLabelText('Highlight a finding')
    expect(findingSelect.querySelectorAll('option')).toHaveLength(3)
    expect(document.querySelector('.graph-count')?.textContent).toBe('2 / 2 edges')
    fireEvent.change(findingSelect, { target: { value: '1' } })
    expect(await screen.findByText(/Highlighting candidate lock order cycle/)).toBeInTheDocument()
  })

  it('searches report locks from the top bar and opens a filtered graph', async () => {
    const metadata = { id: 'run-search', created_at: new Date().toISOString(), status: 'completed', source_path: '/tmp/irqguard-test/demo.c', analyzer_schema_version: 3, summary: { functions: 2 } }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/health')) return jsonResponse(health)
      if (url.endsWith('/analyses')) return jsonResponse({ analyses: [metadata] })
      if (url.endsWith('/report')) return jsonResponse(fixture)
      return jsonResponse({ analysis: metadata })
    }))
    render(<App />)
    const search = await screen.findByRole('textbox', { name: 'Search current analysis' })
    fireEvent.change(search, { target: { value: 'lock-A' } })
    fireEvent.click(await screen.findByRole('option', { name: /Lock lock-A/ }))
    expect(await screen.findByRole('textbox', { name: 'Search lock graph' })).toHaveValue('lock-A')
    expect(document.querySelector('.graph-count')?.textContent).toBe('2 / 2 edges')
  })

  it('opens a selected finding in the graph with that cycle highlighted', async () => {
    const metadata = { id: 'run-finding', created_at: new Date().toISOString(), status: 'completed', source_path: '/tmp/irqguard-test/demo.c', analyzer_schema_version: 3, summary: { functions: 2, graph_edges: 2, candidate_cycles: 1 } }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/health')) return jsonResponse(health)
      if (url.endsWith('/analyses')) return jsonResponse({ analyses: [metadata] })
      if (url.endsWith('/report')) return jsonResponse(fixture)
      return jsonResponse({ analysis: metadata })
    }))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Findings' }))
    fireEvent.click(screen.getAllByRole('row')[1])
    expect(await screen.findByRole('dialog', { name: /interrupt-aware candidate/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Highlight in lock graph' }))
    expect(await screen.findByRole('heading', { name: 'Lock dependency graph' })).toBeInTheDocument()
    expect(await screen.findByText(/Highlighting interrupt aware candidate/)).toBeInTheDocument()
  })

  it('removes an already-deleted analysis when the backend returns not found', async () => {
    const analysis = {
      id: 'delete-run-123', created_at: new Date().toISOString(), status: 'completed',
      source_path: '/tmp/irqguard-test/demo.c', analyzer_report_schema_version: 4,
      summary: { functions: 4, graph_edges: 2, candidate_cycles: 1 },
    }
    let deleted = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/health')) return jsonResponse(health)
      if (url.endsWith('/analyses/delete-run-123') && init?.method === 'DELETE') { deleted = true; return jsonResponse({ detail: 'Analysis was not found' }, 404) }
      if (url.endsWith('/analyses')) return jsonResponse({ analyses: deleted ? [] : [analysis] })
      if (url.endsWith('/report')) return jsonResponse(fixture)
      return jsonResponse({ analysis })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Analysis history' }))
    expect((await screen.findAllByText('/tmp/irqguard-test/demo.c')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Delete analysis demo.c' }))

    expect(await screen.findByRole('heading', { name: 'No saved analyses' })).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/analyses/delete-run-123') && init?.method === 'DELETE')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Delete analysis demo.c' })).not.toBeInTheDocument()
  })

  it('renders proper shell layout with main-column, topbar, and styled offline badges', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/health')
      ? jsonResponse({ ...health, analyzer_available: false })
      : jsonResponse({ analyses: [] })))
    render(<App />)

    // Shell container checks
    const shell = document.querySelector('.app-shell')
    expect(shell).toBeInTheDocument()
    const sidebar = document.querySelector('.sidebar')
    expect(sidebar).toBeInTheDocument()
    const mainColumn = document.querySelector('.main-column')
    expect(mainColumn).toBeInTheDocument()
    expect(shell?.contains(sidebar!)).toBe(true)
    expect(shell?.contains(mainColumn!)).toBe(true)

    // Topbar is inside main-column
    const topbar = document.querySelector('.topbar')
    expect(topbar).toBeInTheDocument()
    expect(mainColumn?.contains(topbar!)).toBe(true)

    // Offline badges have distinct element and classes
    const offlineTags = document.querySelectorAll('.nav-backend-tag')
    expect(offlineTags.length).toBeGreaterThan(0)
    for (const tag of offlineTags) {
      expect(tag.textContent).toBe('offline')
      const parent = tag.closest('.nav-item-text')
      expect(parent).toBeInTheDocument()
      const label = parent?.querySelector('.nav-item-label')
      expect(label).toBeInTheDocument()
      expect(label?.textContent).not.toContain('offline')
    }

    // Mobile nav toggle and scrim
    const mobileBtn = screen.getByRole('button', { name: 'Open navigation' })
    fireEvent.click(mobileBtn)
    expect(sidebar).toHaveClass('sidebar-open')
    const scrim = document.querySelector('.sidebar-scrim')
    expect(scrim).toBeInTheDocument()
    fireEvent.click(scrim!)
    expect(sidebar).not.toHaveClass('sidebar-open')
  })

  it('switches between light and dark themes using theme toggle button', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/health')
      ? jsonResponse(health)
      : jsonResponse({ analyses: [] })))
    render(<App />)

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    const themeBtn = screen.getByRole('button', { name: /switch to light mode/i })
    fireEvent.click(themeBtn)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    const darkBtn = screen.getByRole('button', { name: /switch to dark mode/i })
    fireEvent.click(darkBtn)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})
