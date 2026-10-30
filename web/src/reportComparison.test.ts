import { describe, expect, it } from 'vitest'
import fixture from './test-data/report.fixture.json'
import type { AnalysisMetadata, AnalysisReport } from './types'
import { compareReports } from './reportComparison'

const metadata = (overrides: Partial<AnalysisMetadata> = {}): AnalysisMetadata => ({
  id: 'run', created_at: '2026-01-01T00:00:00Z', status: 'completed', source_path: '/src/demo.c', analyzer_schema_version: 3,
  analysis_provenance: { input_fingerprints: { source_sha256: 'source', compile_commands_sha256: 'compile', api_config_sha256: 'api', analyzer_sha256: 'analyzer' } },
  ...overrides,
})

const report = (changes: Partial<AnalysisReport> = {}) => ({ ...fixture, ...changes }) as AnalysisReport

describe('semantic report comparison', () => {
  it('normalizes edge ordering and reports no changes for semantically identical runs', () => {
    const first = report()
    const second = report({ interrupt_lock_graph: { ...first.interrupt_lock_graph, edges: [...first.interrupt_lock_graph.edges].reverse() } })
    const result = compareReports(metadata(), first, metadata({ id: 'run-2' }), second)
    expect(result.comparability).toBe('same_inputs')
    expect(result.edges.added).toHaveLength(0)
    expect(result.edges.removed).toHaveLength(0)
    expect(result.findings.reclassified).toHaveLength(0)
    expect(result.findings.added).toHaveLength(0)
  })

  it('reports added and removed directed dependencies', () => {
    const first = report()
    const edges = first.interrupt_lock_graph.edges
    const second = report({ interrupt_lock_graph: { nodes: [], edges: [edges[0], {
      ...edges[1], from_lock: 'lock-C', to_lock: 'lock-D', from_context: 'process', to_context: 'process',
    }] } })
    const result = compareReports(metadata(), first, metadata({ id: 'run-2' }), second)
    expect(result.edges.added).toHaveLength(1)
    expect(result.edges.removed).toHaveLength(1)
  })

  it('matches lock changes at a stable provenance anchor and detects finding reclassification', () => {
    const first = report()
    const changedEdge = { ...first.interrupt_lock_graph.edges[0], from_lock: 'lock-X', to_lock: 'lock-Y' }
    const second = report({
      interrupt_lock_graph: { nodes: [], edges: [changedEdge, first.interrupt_lock_graph.edges[1]] },
      interrupt_cycles: [{ ...first.interrupt_cycles[0], category: 'inconclusive_analysis', feasibility: 'inconclusive' }],
    })
    const result = compareReports(metadata(), first, metadata({ id: 'run-2' }), second)
    expect(result.edges.changedLockIdentity).toHaveLength(1)
    expect(result.edges.added).toHaveLength(0)
    expect(result.edges.removed).toHaveLength(0)
    expect(result.findings.reclassified).toHaveLength(1)
  })

  it('distinguishes changed source provenance on the same dependency from a new edge', () => {
    const first = report()
    const shifted = { ...first.interrupt_lock_graph.edges[0],
      from_location: { expansion: { file: '/src/demo.c', line: 60, column: 5, valid: true } } }
    const second = report({ interrupt_lock_graph: { ...first.interrupt_lock_graph,
      edges: [shifted, first.interrupt_lock_graph.edges[1]] } })
    const result = compareReports(metadata(), first, metadata({ id: 'run-2' }), second)
    expect(result.edges.changedProvenance).toHaveLength(1)
    expect(result.edges.added).toHaveLength(0)
    expect(result.edges.removed).toHaveLength(0)
  })

  it('marks old reports with missing input fingerprints as unknown, not comparable', () => {
    const result = compareReports(metadata({ analysis_provenance: null }), report(),
      metadata({ id: 'legacy', analysis_provenance: null }), report())
    expect(result.comparability).toBe('unknown')
    expect(result.comparabilityReasons.join(' ')).toMatch(/predate input fingerprint/i)
    expect(result.metadata.beforeToolchain).toBeNull()
  })

  it('marks a recorded kernel or compiler change as materially different inputs', () => {
    const result = compareReports(metadata({ analysis_provenance: { ...metadata().analysis_provenance, kernel_revision: 'rev-a', toolchain: 'clang-20' } }), report(),
      metadata({ id: 'run-2', analysis_provenance: { ...metadata().analysis_provenance, kernel_revision: 'rev-b', toolchain: 'clang-21' } }), report())
    expect(result.comparability).toBe('inputs_differ')
    expect(result.comparabilityReasons.join(' ')).toMatch(/kernel revision changed/i)
    expect(result.metadata.kernelRevisionChanged).toBe(true)
    expect(result.metadata.toolchainChanged).toBe(true)
  })

  it('keeps unique uncertainty counts unavailable for schema-v3 reports without grouped records', () => {
    const result = compareReports(metadata(), report(), metadata({ id: 'run-2' }), report())
    expect(result.uncertainty.beforeEvents).toBe(0)
    expect(result.uncertainty.beforeUnique).toBeNull()
  })
})
