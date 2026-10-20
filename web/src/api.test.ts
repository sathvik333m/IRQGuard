import { describe, expect, it, vi } from 'vitest'
import fixture from './test-data/report.fixture.json'
import { getSource, parseReport } from './api'

describe('schema-v3 report adapter', () => {
  it('accepts optional missing collections as empty lists', () => {
    const report = parseReport({ schema_version: 3, analysis_kind: 'interrupt_aware_lock_analysis' })
    expect(report.functions).toEqual([])
    expect(report.interrupt_lock_graph.edges).toEqual([])
    expect(report.interrupt_cycles).toEqual([])
  })

  it('rejects incompatible schema versions instead of guessing field meanings', () => {
    expect(() => parseReport({ ...fixture, schema_version: 99 })).toThrow(/expects schema 3/)
  })

  it('rejects malformed report arrays and graph objects', () => {
    expect(() => parseReport({ ...fixture, functions: {} })).toThrow(/functions must be an array/)
    expect(() => parseReport({ ...fixture, interrupt_lock_graph: { edges: {} } })).toThrow(/graph edges/)
  })
})

it('shows a useful source error when a source snippet is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false, status: 404, json: async () => ({ detail: 'Requested source line is unavailable' }),
  }))
  await expect(getSource('run-1', '/tmp/irqguard-test/demo.c', 999)).rejects.toThrow(/source line is unavailable/i)
  vi.unstubAllGlobals()
})
