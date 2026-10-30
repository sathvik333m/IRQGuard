export type Category =
  | 'candidate_lock_order_cycle'
  | 'interrupt_aware_candidate'
  | 'rejected_candidate'
  | 'inconclusive_analysis'
  | string

export interface SourcePoint {
  file?: string
  line?: number
  column?: number
  valid?: boolean
}

export interface LocatedSource {
  expansion?: SourcePoint
  spelling?: SourcePoint
  is_macro?: boolean
}

export interface GraphEdge {
  from_lock: string
  to_lock: string
  kind: string
  from_context?: string
  to_context?: string
  source_function?: string
  target_function?: string
  irq_state?: string
  certainty?: string
  feasibility?: string
  feasibility_reason?: string
  summary_status?: string
  path_condition_status?: string
  path_conditions?: Array<{ expression: string; atom: string; truth: boolean; supported: boolean; loop_back_edge: boolean; location?: LocatedSource }>
  registration_lifecycle?: string
  deregistration_evidence?: LocatedSource[]
  handler?: string
  from_location?: LocatedSource
  to_location?: LocatedSource
  registration_location?: LocatedSource
  source_provenance?: Array<{ function: string; callee: string; location?: LocatedSource }>
  target_provenance?: Array<{ function: string; callee: string; location?: LocatedSource }>
}

export interface Finding {
  finding_id?: string
  classification?: string
  category: Category
  feasibility?: string
  contains_uncertain_edge?: boolean
  explanation?: string
  lock_sequence?: string[]
  provenance_variants?: number[][]
  edges?: GraphEdge[]
}

export interface FunctionRecord {
  name?: string
  qualified_name?: string
  id?: string
  location?: LocatedSource
  cfg_available?: boolean
}

export interface CallRecord {
  caller?: string
  caller_id?: string
  callee?: string
  callee_expression?: string
  resolution?: string
  modeled_api?: boolean
  target_names?: string[]
  location?: LocatedSource
}

export interface ApiOperation {
  api?: string
  kind?: string
  caller?: string
  lock?: { expression?: string; identity_template?: string; identity_status?: string; location?: LocatedSource } | null
  location?: LocatedSource
}

export interface LockDependency {
  from_lock?: string
  to_lock?: string
  reporting_function?: string
  origin_function?: string
  origin?: string
  certainty?: string
  from_acquisition?: LocatedSource
  to_acquisition?: LocatedSource
  through_calls?: Array<{ function: string; callee: string; location?: LocatedSource }>
}

export interface AnalysisReport {
  schema_version: number
  analysis_kind: string
  source?: string
  functions: FunctionRecord[]
  calls: CallRecord[]
  api_operations: ApiOperation[]
  lock_dependencies: LockDependency[]
  interrupt_registrations: Array<Record<string, unknown>>
  interrupt_deregistrations?: Array<Record<string, unknown>>
  interrupt_state_snapshots: Array<Record<string, unknown>>
  interrupt_lock_graph: { nodes: Array<{ lock_identity: string }>; edges: GraphEdge[] }
  interrupt_cycles: Finding[]
  uncertainties: string[]
  uncertainty_records?: UncertaintyRecord[]
  uncertainty_summary?: UncertaintySummary
  diagnostics: string[]
}

export interface UncertaintyRecord {
  id: string
  category: string
  reason: string
  analysis_stage: string
  severity: 'high' | 'medium' | 'low' | string
  impact: string
  explanation: string
  root_cause: string
  source_location: SourcePoint
  enclosing_function: string
  api_or_expression: string
  event_count: number
  direct_event_count: number
  propagated_event_count: number
  has_repeated_propagation: boolean
  unique_record: boolean
  cause_identity_is_heuristic: boolean
  associated_findings: string[]
  example_events: string[]
}

export interface UncertaintySummary {
  event_count: number
  unique_record_count: number
  propagated_event_count: number
  high_impact_unique_records: number
  lock_identity_events: number
  interrupt_state_events: number
  unresolved_call_events: number
  candidate_affecting_unique_records: number
  affected_candidate_count: number
  proven_non_affecting_event_count: number
  by_category: Record<string, { event_count: number; unique_record_count: number }>
  by_stage: Record<string, { event_count: number; unique_record_count: number }>
}

export interface AnalysisSummary {
  translation_units?: number | null
  functions?: number | null
  lock_operations?: number | null
  lock_dependencies?: number | null
  graph_edges?: number | null
  candidate_cycles?: number | null
  rejected_candidates?: number | null
  inconclusive_findings?: number | null
  finding_categories?: Record<string, number>
  diagnostics?: number | null
  uncertainties?: number | null
}

export interface AnalysisMetadata {
  id: string
  created_at: string
  status: 'queued' | 'running' | 'completed' | 'failed' | string
  source_path: string
  configuration?: Record<string, unknown>
  analysis_provenance?: {
    captured_at?: string
    input_fingerprints?: {
      source_sha256?: string | null
      compile_commands_sha256?: string | null
      api_config_sha256?: string | null
      analyzer_sha256?: string | null
    } | null
    kernel_revision?: string | null
    toolchain?: string | null
  } | null
  analyzer_schema_version?: number | null
  analysis_kind?: string | null
  duration_ms?: number | null
  return_code?: number | null
  summary?: AnalysisSummary | null
  error?: string | null
}

export interface Health {
  api_version: string
  status: string
  analyzer_path: string
  analyzer_available: boolean
  analyzer_report_schema: number
  workspace_roots: string[]
  environment?: {
    operating_system?: string | null
    wsl?: boolean | null
    analyzer_version?: string | null
    target_kernel?: string | null
  }
  data_directory: string
  runtime_evidence_available: boolean
  benchmarks_available: boolean
}

export interface RuntimeRun {
  id: string
  created_at: string
  kind: 'scenario' | 'benchmark' | 'comparison' | string
  status: string
  scenario?: string | null
  termination?: string | null
  deadlock_reproduction?: string | null
  event_count?: number | null
  analysis_id?: string | null
  runtime_run_ids?: string[]
  error?: string | null
}

export interface RuntimeEvidence {
  run: RuntimeRun
  summary: Record<string, any> | null
  events: RuntimeEvent[]
  comparison: Record<string, any> | null
  benchmark: Record<string, any> | null
}

export interface RuntimeEvent {
  schema_version?: number
  run_id?: string
  sequence?: number
  timestamp_monotonic_ns?: number
  process_id?: number
  thread_id?: number | string
  lock_id?: string
  event?: 'acquire_attempt' | 'contention_observed' | 'acquire_success' | 'release' | string
  [key: string]: unknown
}

export interface Phase17Evaluation {
  schema_version: number
  dataset_id: string
  analyzer_sha256: string
  kernel_pin: { release?: string; commit?: string; subsystem?: string }
  kernel_pin_validation: { status: string; path?: string; expected_commit?: string; actual_commit?: string | null }
  controlled_fixture_passed: number
  controlled_fixture_failed: number
  controlled_fixture_cases: Array<Record<string, any>>
  real_kernel_cases: Array<Record<string, any>>
  real_kernel_aggregate: Record<string, any> | null
  kernel_configuration?: Record<string, any> | null
  kernel_validation?: Record<string, any> | null
  archived_kernel_environment?: Record<string, any> | null
  ground_truth: { independent_bug_cases: number; precision: number | null; recall: number | null; reason: string }
}

export interface SourceSnippet {
  file: string
  requested_line: number
  lines: Array<{ line: number; text: string; highlighted: boolean }>
}

export interface KernelEvaluation {
  status: string
  kernel: { release_tag: string; commit: string; checkout_commit: string; git_describe: string }
  configuration: {
    architecture: string
    compiler_mode: string
    config_base: string
    subsystem: string
    build_limitations: string[]
  }
  aggregate: {
    files_requested: number
    files_analyzed: number
    files_skipped_or_failed: number
    functions: number
    lock_operations: number
    lock_dependencies: number
    interrupt_graph_edges: number
    interrupt_cycles: number
    uncertainties: number
    diagnostics: number
    elapsed_seconds_sum: number | null
    peak_rss_kib_max: number | null
  }
  translation_units: Array<{
    file: string
    status: string
    skip_reason: string | null
    elapsed_seconds: number | null
    peak_rss_kib: number | null
    counts: {
      functions: number
      lock_operations: number
      lock_dependencies: number
      interrupt_graph_edges: number
      interrupt_cycles: number
      uncertainties: number
      diagnostics: number
    }
  }>
  interpretation: string
  cycle_review?: {
    status: string
    input: { report: string; schema_version: number; sha256: string }
    current_analysis: { status: string; reason: string }
    findings: Array<{
      finding_id: string
      classification: string
      archived_analyzer_category: string
      archived_feasibility: string
      cycle_path: string[]
      edges: GraphEdge[]
      source_file: string
      functions: { source?: string; target?: string }
      call_path: Array<{ caller?: string; callee?: string; file?: string; line?: number; column?: number }>
      interrupt_evidence: { from_context?: string; to_context?: string; handler?: string | null; interpretation: string }
      lock_operation_evidence: Array<{ api?: string; kind?: string; function?: string; lock?: { expression?: string; identity_status?: string }; location?: LocatedSource; arguments?: string[] }>
      irq_state: { edge_state?: string; saved_flags_relation: string; interpretation: string }
      uncertainties: Array<{ id: string; category: string; reason: string; source_file: string; line: string; explanation: string }>
      reasons: string[]
      manual_validation: string[]
    }>
  } | null
  phase13_comparison?: {
    before: Record<string, any>
    after: Record<string, any>
    metrics_warning: string
  } | null
  phase13_latest_rerun?: {
    status: string
    environment: Record<string, any>
    validation: Record<string, any>
    aggregate: Record<string, any>
  } | null
  phase15_latest_run?: {
    status: string
    kernel: { release_tag: string; commit: string }
    source_files: string[]
    configuration: Record<string, any>
    environment: Record<string, any>
    aggregate: Record<string, any>
    validation: Record<string, any>
    uncertainty_summary: Record<string, any>
    comparison_to_phase13: Record<string, any>
    irqsave_pairs: Array<Record<string, any>>
  } | null
  phase17_evaluation?: Phase17Evaluation | null
  phase12_validation?: {
    full_validation: {
      status: string
      blocker: string | null
      validation: Record<string, unknown>
    } | null
    pre_install_attempt?: {
      status: string
      blocker: string | null
      validation: Record<string, unknown>
    } | null
    source_only: {
      status: string
      validation: Record<string, unknown>
      aggregate: Record<string, any>
    } | null
    build_limitations: string[]
  } | null
  precision_recall: Record<string, unknown> | null
}
