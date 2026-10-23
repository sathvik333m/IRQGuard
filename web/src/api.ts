import type { AnalysisMetadata, AnalysisReport, Health, KernelEvaluation, RuntimeEvidence, RuntimeRun, SourceSnippet } from './types'

export class ApiError extends Error {
  status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch {
    throw new ApiError('The local IRQGuard API is unavailable. Start the backend and retry.')
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) {
    const detail = payload?.detail
    throw new ApiError(typeof detail === 'string' ? detail : `Request failed (${response.status})`, response.status)
  }
  return payload as T
}

export function parseReport(value: unknown): AnalysisReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('The analyzer report is not a JSON object.')
  }
  const raw = value as Record<string, unknown>
  if (raw.schema_version !== 3 || raw.analysis_kind !== 'interrupt_aware_lock_analysis') {
    throw new ApiError(`Unsupported analyzer report schema (${String(raw.schema_version)}). IRQGuard UI expects schema 3.`)
  }
  const array = (name: string) => {
    const item = raw[name]
    if (item === undefined || item === null) return []
    if (!Array.isArray(item)) throw new ApiError(`Malformed analyzer report: ${name} must be an array.`)
    return item
  }
  const graph = raw.interrupt_lock_graph
  let nodes: Array<{ lock_identity: string }> = []
  let edges: AnalysisReport['interrupt_lock_graph']['edges'] = []
  if (graph !== undefined && graph !== null) {
    if (typeof graph !== 'object' || Array.isArray(graph)) {
      throw new ApiError('Malformed analyzer report: interrupt_lock_graph must be an object.')
    }
    const rawGraph = graph as Record<string, unknown>
    if (rawGraph.nodes !== undefined && !Array.isArray(rawGraph.nodes)) throw new ApiError('Malformed lock graph nodes.')
    if (rawGraph.edges !== undefined && !Array.isArray(rawGraph.edges)) throw new ApiError('Malformed lock graph edges.')
    nodes = (rawGraph.nodes ?? []) as typeof nodes
    edges = (rawGraph.edges ?? []) as typeof edges
  }
  return {
    ...raw,
    functions: array('functions'),
    calls: array('calls'),
    api_operations: array('api_operations'),
    lock_dependencies: array('lock_dependencies'),
    interrupt_registrations: array('interrupt_registrations'),
    interrupt_state_snapshots: array('interrupt_state_snapshots'),
    interrupt_lock_graph: { nodes, edges },
    interrupt_cycles: array('interrupt_cycles'),
    uncertainties: array('uncertainties'),
    diagnostics: array('diagnostics'),
  } as AnalysisReport
}

export const getHealth = () => request<Health>('/api/v1/health')

export const getKernelEvaluation = () => request<KernelEvaluation>('/api/v1/evaluations/linux-v6.6.87')

export async function getAnalyses(): Promise<AnalysisMetadata[]> {
  const result = await request<{ analyses: AnalysisMetadata[] }>('/api/v1/analyses')
  return result.analyses
}

export async function getAnalysis(id: string): Promise<AnalysisMetadata> {
  const result = await request<{ analysis: AnalysisMetadata }>(`/api/v1/analyses/${encodeURIComponent(id)}`)
  return result.analysis
}

export async function getReport(id: string): Promise<AnalysisReport> {
  return parseReport(await request<unknown>(`/api/v1/analyses/${encodeURIComponent(id)}/report`))
}

export async function startAnalysis(input: {
  source_path: string
  compile_commands_path?: string
  api_config_path?: string
}): Promise<{ id: string; status: string }> {
  return request('/api/v1/analyses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function getSource(id: string, file: string, line: number): Promise<SourceSnippet> {
  const query = new URLSearchParams({ file, line: String(line), context: '10' })
  return request(`/api/v1/analyses/${encodeURIComponent(id)}/source?${query}`)
}

export async function getGraph(id: string) {
  return request<{ nodes: Array<{ lock_identity: string }>; edges: AnalysisReport['interrupt_lock_graph']['edges'] }>(
    `/api/v1/analyses/${encodeURIComponent(id)}/graph`,
  )
}

export async function getRuntimeRuns(): Promise<RuntimeRun[]> {
  const result = await request<{ runs: RuntimeRun[] }>('/api/v1/runtime/runs')
  return result.runs
}

export async function getRuntimeEvidence(id: string): Promise<RuntimeEvidence> {
  return request(`/api/v1/runtime/runs/${encodeURIComponent(id)}`)
}

export async function startRuntimeScenario(scenario: string): Promise<RuntimeRun> {
  const result = await request<{ run: RuntimeRun }>('/api/v1/runtime/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario }),
  })
  return result.run
}

export async function startRuntimeBenchmark(): Promise<RuntimeRun> {
  const result = await request<{ run: RuntimeRun }>('/api/v1/runtime/benchmarks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })
  return result.run
}

export async function compareRuntimeEvidence(input: { analysis_id: string; runtime_run_ids: string[]; static_to_runtime: Record<string, string> }) {
  return request<{ run: RuntimeRun; comparison: Record<string, any> }>('/api/v1/runtime/compare', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  })
}
