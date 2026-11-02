import type { AnalysisMetadata, AnalysisReport, KernelEvaluation, SourceSnippet } from '../types'
import interruptsRaw from './interrupts-report.json'
import basicRaw from './basic-report.json'
import kernelEvalRaw from './kernel-eval-demo.json'
import { getDemoSourceSnippet } from './sources'

export interface DemoExample {
  id: string
  name: string
  sourcePath: string
  description: string
  findingCount: number
  hasCycles: boolean
}

export const DEMO_EXAMPLES: DemoExample[] = [
  {
    id: 'demo-interrupts',
    name: 'Interrupts & preemption (tests/fixtures/interrupts.c)',
    sourcePath: 'tests/fixtures/interrupts.c',
    description: 'Demonstrates cross-context locking between process and hardirq, IRQ-disabled safety, and inconclusive paths.',
    findingCount: (interruptsRaw as any).interrupt_cycles?.length ?? 5,
    hasCycles: true,
  },
  {
    id: 'demo-basic',
    name: 'Interprocedural mutexes (examples/basic.c)',
    sourcePath: 'examples/basic.c',
    description: 'Demonstrates interprocedural lock order propagation and symbolic parameter resolution without cycles.',
    findingCount: (basicRaw as any).interrupt_cycles?.length ?? 0,
    hasCycles: false,
  },
]

export const DEMO_INTERRUPTS_REPORT: AnalysisReport = interruptsRaw as unknown as AnalysisReport
export const DEMO_BASIC_REPORT: AnalysisReport = basicRaw as unknown as AnalysisReport
export const DEMO_KERNEL_EVALUATION: KernelEvaluation = kernelEvalRaw as unknown as KernelEvaluation

export const DEMO_METADATA_LIST: AnalysisMetadata[] = [
  {
    id: 'demo-interrupts',
    created_at: '2026-10-30T18:20:00Z',
    status: 'completed',
    source_path: 'tests/fixtures/interrupts.c',
    analyzer_schema_version: 4,
    analysis_kind: 'interrupt_aware_lock_analysis',
    duration_ms: 182,
    summary: {
      functions: DEMO_INTERRUPTS_REPORT.functions?.length ?? 0,
      lock_operations: DEMO_INTERRUPTS_REPORT.api_operations?.length ?? 0,
      lock_dependencies: DEMO_INTERRUPTS_REPORT.lock_dependencies?.length ?? 0,
      graph_edges: DEMO_INTERRUPTS_REPORT.interrupt_lock_graph?.edges?.length ?? 0,
      candidate_cycles: DEMO_INTERRUPTS_REPORT.interrupt_cycles?.filter((c) => c.category === 'interrupt_aware_candidate' || c.category === 'candidate_lock_order_cycle').length ?? 0,
      rejected_candidates: DEMO_INTERRUPTS_REPORT.interrupt_cycles?.filter((c) => c.category === 'rejected_candidate').length ?? 0,
      inconclusive_findings: DEMO_INTERRUPTS_REPORT.interrupt_cycles?.filter((c) => c.category === 'inconclusive_analysis').length ?? 0,
      diagnostics: DEMO_INTERRUPTS_REPORT.diagnostics?.length ?? 0,
      uncertainties: DEMO_INTERRUPTS_REPORT.uncertainties?.length ?? 0,
    },
  },
  {
    id: 'demo-basic',
    created_at: '2026-10-28T16:52:00Z',
    status: 'completed',
    source_path: 'examples/basic.c',
    analyzer_schema_version: 4,
    analysis_kind: 'interrupt_aware_lock_analysis',
    duration_ms: 45,
    summary: {
      functions: DEMO_BASIC_REPORT.functions?.length ?? 0,
      lock_operations: DEMO_BASIC_REPORT.api_operations?.length ?? 0,
      lock_dependencies: DEMO_BASIC_REPORT.lock_dependencies?.length ?? 0,
      graph_edges: DEMO_BASIC_REPORT.interrupt_lock_graph?.edges?.length ?? 0,
      candidate_cycles: 0,
      rejected_candidates: 0,
      inconclusive_findings: 0,
      diagnostics: DEMO_BASIC_REPORT.diagnostics?.length ?? 0,
      uncertainties: DEMO_BASIC_REPORT.uncertainties?.length ?? 0,
    },
  },
]

export function getDemoReport(id: string): AnalysisReport {
  if (id === 'demo-basic') return DEMO_BASIC_REPORT
  return DEMO_INTERRUPTS_REPORT
}

export function getDemoMetadata(id: string): AnalysisMetadata {
  const found = DEMO_METADATA_LIST.find((m) => m.id === id)
  return found ?? DEMO_METADATA_LIST[0]
}

export function getDemoSource(file: string, line: number, context = 10): SourceSnippet {
  return getDemoSourceSnippet(file, line, context)
}
