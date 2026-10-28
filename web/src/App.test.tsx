import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from './App'
import fixture from './test-data/report.fixture.json'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

function jsonResponse(payload: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload } as Response
}

const health = {
  api_version: '1', status: 'ok', analyzer_path: '/tmp/deadlock-analyzer', analyzer_available: true,
  analyzer_report_schema: 3, workspace_roots: ['/tmp/irqguard-test'], data_directory: '/tmp/irqguard-test/data',
  runtime_evidence_available: false, benchmarks_available: false,
}

describe('IRQGuard workspace states', () => {
  it('renders the no-history dashboard without sample findings or invented metrics', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/health')
      ? jsonResponse(health) : jsonResponse({ analyses: [] })))
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Start with a C source file' })).toBeInTheDocument()
    expect(screen.queryByText(/candidate lock-order cycles/i)).not.toBeInTheDocument()
    expect(screen.getByText(/absolute linux path inside an allowed workspace/i)).toBeInTheDocument()
  })

  it('shows a useful error when the local API cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/local irqguard api is unavailable/i)
  })

  it('shows the archived kernel cycle classifications and linked evidence from the review response', async () => {
    const evaluation = {
      status: 'completed',
      kernel: { release_tag: 'v6.6.87', commit: '814637ca257f4faf57a73fd4e38888cce88b5911' },
      configuration: { subsystem: 'e1000e', architecture: 'x86_64', config_base: 'x86_64_defconfig', compiler_mode: 'Clang', build_limitations: [] },
      aggregate: { files_requested: 5, files_analyzed: 5, files_skipped_or_failed: 0, functions: 396, lock_operations: 12, lock_dependencies: 6, interrupt_graph_edges: 6, interrupt_cycles: 3, uncertainties: 43705, diagnostics: 2, elapsed_seconds_sum: 6.644, peak_rss_kib_max: 192312 },
      translation_units: [], precision_recall: null,
      interpretation: 'Archived run predates the lock API fix.',
      cycle_review: {
        status: 'archived_review_with_current_source_scan',
        input: { report: 'netdev.json', schema_version: 3, sha256: 'abc123' },
        current_analysis: { status: 'completed_with_validation_skips', reason: 'Fresh source-only analysis found no current cycles; objtool was skipped.' },
        findings: [{
          finding_id: 'C-1', classification: 'inconclusive', archived_analyzer_category: 'inconclusive_analysis', archived_feasibility: 'inconclusive',
          cycle_path: ['lock at 501', 'lock at 501'], source_file: '/kernel/netdev.c', functions: { source: 'rx_cleaner', target: 'clock_helper' },
          call_path: [{ caller: 'rx_cleaner', callee: 'clock_helper', file: '/kernel/netdev.c', line: 1032 }],
          edges: [{ from_location: { expansion: { file: '/kernel/netdev.c', line: 501 } } }],
          interrupt_evidence: { from_context: 'process', to_context: 'process', handler: null, interpretation: 'No handler evidence is attached.' },
          lock_operation_evidence: [], irq_state: { edge_state: 'not_applicable', saved_flags_relation: 'unresolved', interpretation: 'Saved state unknown.' },
          uncertainties: [{ id: 'U-1', category: 'lock_identity', reason: 'unknown lock', source_file: '/kernel/netdev.c', line: '501', explanation: 'Identity unavailable.' }],
          reasons: ['Archived edge is an unresolved self-edge.'], manual_validation: ['Rerun with the pinned tree.'],
        }],
      },
      phase12_validation: {
        full_validation: { status: 'completed', blocker: null, validation: { objtool_build: 'succeeded', objtool_object_checks: 'succeeded', objtool_invocations: 1, objtool_options: ['--orc', '--ibt', '--module', '--link'], orc_sections_present: true, kernel_object_compilation: 'succeeded', source_analysis: 'completed', kernel_module_link: 'not_attempted; composite object target only', stack_validation: 'not_configured_by_defconfig' } },
        pre_install_attempt: { status: 'kernel_build_failed', blocker: "Kernel build stage 'prepare' failed; missing libelf headers.", validation: { objtool_build: 'failed' } },
        source_only: { status: 'completed_with_validation_skips', validation: { kernel_object_compilation: 'succeeded', source_analysis: 'completed', objtool_build: 'skipped_by_request', objtool_object_checks: 'skipped_by_request', unwinder_orc_configured: true, stack_validation: 'not_configured_by_defconfig' }, aggregate: { files_requested: 5, files_analyzed: 5, counts_sum_across_translation_units: { functions: 396, lock_operations: 12, interrupt_cycles: 0 } } },
        build_limitations: ['Final .ko link and full kernel build were not attempted.'],
      },
      phase13_comparison: {
        before: { functions: 396, lock_acquisitions: 6, lock_releases: 6, lock_dependencies: 6, interrupt_graph_edges: 6, candidate_cycles: 3, uncertainty_events: 43705, unique_uncertainty_records: 4872 },
        after: { functions: 396, lock_acquisitions: 6, lock_releases: 6, lock_dependencies: 0, interrupt_graph_edges: 0, candidate_cycles: 0, uncertainty_events: 43514, unique_uncertainty_records: 4833 },
        metrics_warning: 'Counts are not accuracy metrics.',
      },
      phase13_latest_rerun: {
        status: 'completed', environment: { analyzer_sha256: 'abc' },
        validation: { objtool_object_checks: 'succeeded', orc_sections_present: true, stack_validation: 'not_configured_by_defconfig', kernel_module_link: 'not_attempted; composite object target only' },
        aggregate: { files_analyzed: 5, files_requested: 5, analysis_elapsed_seconds_sum: 6.491, peak_rss_kib_max_across_separate_runs: 192924, counts_sum_across_translation_units: { functions: 396, lock_operations: 12, lock_dependencies: 0, interrupt_cycles: 0, uncertainties: 43514, diagnostics: 2 } },
      },
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/health')
      ? jsonResponse(health)
      : String(input).endsWith('/evaluations/linux-v6.6.87') ? jsonResponse(evaluation) : jsonResponse({ analyses: [] })))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Kernel evaluation' }))
    expect(await screen.findByRole('heading', { name: 'Candidate validation' })).toBeInTheDocument()
    expect(screen.getByText('inconclusive')).toBeInTheDocument()
    expect(screen.getByText(/rx_cleaner → clock_helper/)).toBeInTheDocument()
    expect(screen.getByText(/U-1 lock_identity/)).toBeInTheDocument()
    expect(screen.getByText(/Fresh source-only analysis found no current cycles/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Kernel validation stages' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Post-fix comparison' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Current analyzer results' })).toBeInTheDocument()
    expect(screen.getByText(/6.491s/)).toBeInTheDocument()
    expect(screen.getAllByText('43,705')).toHaveLength(2)
    expect(screen.getAllByText('43,514')).toHaveLength(2)
    expect(screen.getByText(/Earlier pre-install attempt/)).toBeInTheDocument()
    expect(screen.getByText(/missing libelf headers/)).toBeInTheDocument()
    expect(screen.getByText(/C object compilation/)).toBeInTheDocument()
    expect(screen.getByText(/objtool was explicitly skipped/)).toBeInTheDocument()
    expect(screen.getByText(/ORC sections in composite object/)).toBeInTheDocument()
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
    render(<App />)
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
    render(<App />)
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
    const multipleReport = {
      ...fixture,
      interrupt_cycles: [fixture.interrupt_cycles[0], {
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
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Recent analyses' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Lock Dependency Graph' })).toBeInTheDocument()
    expect(screen.getByRole('tablist', { name: 'Finding detail sections' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Execution Context' }))
    expect(screen.getByText(/process → hardirq/)).toBeInTheDocument()
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
})
