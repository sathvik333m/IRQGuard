import type { AnalysisMetadata, AnalysisReport, GraphEdge, Finding } from './types'

export interface SemanticComparison {
  comparability: 'same_inputs' | 'inputs_differ' | 'unknown'
  comparabilityReasons: string[]
  edges: { added: GraphEdge[]; removed: GraphEdge[]; changedLockIdentity: Array<{ before: GraphEdge; after: GraphEdge }>;
    changedProvenance: Array<{ edge: string; before: string[]; after: string[] }> }
  findings: { added: Finding[]; removed: Finding[]; reclassified: Array<{ before: Finding; after: Finding }> }
  uncertainty: { beforeEvents: number; afterEvents: number; beforeUnique: number | null; afterUnique: number | null;
    categories: Array<{ category: string; beforeEvents: number; afterEvents: number; beforeUnique: number | null; afterUnique: number | null }> }
  diagnostics: { added: string[]; removed: string[] }
  metadata: { beforeSchema: number; afterSchema: number; schemaChanged: boolean;
    beforeKernelRevision: string | null; afterKernelRevision: string | null; kernelRevisionChanged: boolean | null;
    beforeToolchain: string | null; afterToolchain: string | null; toolchainChanged: boolean | null }
}

function pointKey(edge: GraphEdge | undefined, side: 'from' | 'to') {
  const location = side === 'from' ? edge?.from_location : edge?.to_location
  const point = location?.expansion?.valid ? location.expansion : location?.spelling
  return point?.file && point.line ? `${point.file}:${point.line}:${point.column ?? 0}` : 'location-unavailable'
}

function edgeKey(edge: GraphEdge) {
  return [edge.from_lock, edge.to_lock, edge.kind, edge.from_context ?? '', edge.to_context ?? '',
    edge.source_function ?? '', edge.target_function ?? ''].join('|')
}

function edgeIdentityAnchor(edge: GraphEdge) {
  return [edge.kind, edge.from_context ?? '', edge.to_context ?? '', edge.source_function ?? '',
    edge.target_function ?? '', pointKey(edge, 'from'), pointKey(edge, 'to')].join('|')
}

function edgeProvenance(edge: GraphEdge) {
  const chain = (items: GraphEdge['source_provenance']) => (items ?? []).map((step) =>
    `${step.function}->${step.callee}@${step.location?.expansion?.file ?? ''}:${step.location?.expansion?.line ?? ''}`)
  return [pointKey(edge, 'from'), pointKey(edge, 'to'), ...(edge.registration_location ? [
    `${edge.registration_location.expansion?.file ?? ''}:${edge.registration_location.expansion?.line ?? ''}`,
  ] : []), ...chain(edge.source_provenance), ...chain(edge.target_provenance)].sort()
}

function canonicalCycle(finding: Finding) {
  const locks = [...(finding.lock_sequence ?? [])]
  if (locks.length > 1 && locks[0] === locks[locks.length - 1]) locks.pop()
  if (!locks.length) return `${finding.category}|empty`
  const rotations = locks.map((_, index) => locks.slice(index).concat(locks.slice(0, index)).join('>'))
  return rotations.sort()[0]
}

function uncertainty(report: AnalysisReport) {
  const summary = report.uncertainty_summary
  const categories = new Map<string, { events: number; unique: number }>()
  if (summary?.by_category) {
    for (const [category, value] of Object.entries(summary.by_category)) {
      categories.set(category, { events: value.event_count, unique: value.unique_record_count })
    }
  } else {
    for (const record of report.uncertainty_records ?? []) {
      const current = categories.get(record.category) ?? { events: 0, unique: 0 }
      current.events += record.event_count ?? 1
      current.unique += 1
      categories.set(record.category, current)
    }
    if (!categories.size && report.uncertainties.length) {
      categories.set('unclassified_legacy', { events: report.uncertainties.length, unique: 0 })
    }
  }
  return { events: summary?.event_count ?? report.uncertainties.length,
    unique: summary?.unique_record_count ?? (report.uncertainty_records ? report.uncertainty_records.length : null), categories }
}

function sameSet(left: string[], right: string[]) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

function fingerprints(metadata: AnalysisMetadata) {
  return (metadata.analysis_provenance?.input_fingerprints ?? null)
}

function comparability(before: AnalysisMetadata, after: AnalysisMetadata) {
  const reasons: string[] = []
  if (before.source_path !== after.source_path) reasons.push('Source paths differ.')
  const a = fingerprints(before)
  const b = fingerprints(after)
  if (!a || !b) reasons.push('One or both saved runs predate input fingerprint recording.')
  else {
    for (const [label, key] of [['source contents', 'source_sha256'], ['compiler command database', 'compile_commands_sha256'],
      ['API registry', 'api_config_sha256'], ['analyzer executable', 'analyzer_sha256']] as const) {
      const left = a[key]
      const right = b[key]
      if (!left || !right) reasons.push(`${label} fingerprint is unavailable for one or both runs.`)
      else if (left !== right) reasons.push(`${label} changed.`)
    }
  }
  if (before.analyzer_schema_version !== after.analyzer_schema_version) reasons.push('Analyzer report schemas differ.')
  if (reasons.some((reason) => reason.includes('changed') || reason.includes('differ'))) return { status: 'inputs_differ' as const, reasons }
  if (reasons.length) return { status: 'unknown' as const, reasons }
  return { status: 'same_inputs' as const, reasons: ['Recorded source, build/API inputs, analyzer, and schema fingerprints match.'] }
}

export function compareReports(beforeMeta: AnalysisMetadata, before: AnalysisReport,
  afterMeta: AnalysisMetadata, after: AnalysisReport): SemanticComparison {
  const beforeEdges = before.interrupt_lock_graph.edges
  const afterEdges = after.interrupt_lock_graph.edges
  const beforeByKey = new Map(beforeEdges.map((edge) => [edgeKey(edge), edge]))
  const afterByKey = new Map(afterEdges.map((edge) => [edgeKey(edge), edge]))
  const removed = beforeEdges.filter((edge) => !afterByKey.has(edgeKey(edge)))
  const added = afterEdges.filter((edge) => !beforeByKey.has(edgeKey(edge)))
  const beforeAnchors = new Map(beforeEdges.map((edge) => [edgeIdentityAnchor(edge), edge]))
  const afterAnchors = new Map(afterEdges.map((edge) => [edgeIdentityAnchor(edge), edge]))
  const changedLockIdentity = [...beforeAnchors.entries()].flatMap(([anchor, left]) => {
    const right = afterAnchors.get(anchor)
    return right && (left.from_lock !== right.from_lock || left.to_lock !== right.to_lock) ? [{ before: left, after: right }] : []
  })
  const changedProvenance = [...beforeByKey.entries()].flatMap(([key, left]) => {
    const right = afterByKey.get(key)
    if (!right) return []
    const leftEvidence = edgeProvenance(left)
    const rightEvidence = edgeProvenance(right)
    return sameSet(leftEvidence, rightEvidence) ? [] : [{ edge: key, before: leftEvidence, after: rightEvidence }]
  })

  const beforeFindingMap = new Map(before.interrupt_cycles.map((finding) => [canonicalCycle(finding), finding]))
  const afterFindingMap = new Map(after.interrupt_cycles.map((finding) => [canonicalCycle(finding), finding]))
  const reclassified = [...beforeFindingMap.entries()].flatMap(([key, left]) => {
    const right = afterFindingMap.get(key)
    return right && (left.category !== right.category || left.feasibility !== right.feasibility) ? [{ before: left, after: right }] : []
  })
  const findingsAdded = after.interrupt_cycles.filter((finding) => !beforeFindingMap.has(canonicalCycle(finding)))
  const findingsRemoved = before.interrupt_cycles.filter((finding) => !afterFindingMap.has(canonicalCycle(finding)))

  const beforeUncertainty = uncertainty(before)
  const afterUncertainty = uncertainty(after)
  const categoryNames = [...new Set([...beforeUncertainty.categories.keys(), ...afterUncertainty.categories.keys()])].sort()
  const diagnosticsBefore = [...new Set(before.diagnostics)].sort()
  const diagnosticsAfter = [...new Set(after.diagnostics)].sort()
  const revisionA = beforeMeta.analysis_provenance?.kernel_revision ?? null
  const revisionB = afterMeta.analysis_provenance?.kernel_revision ?? null
  const toolchainA = beforeMeta.analysis_provenance?.toolchain ?? null
  const toolchainB = afterMeta.analysis_provenance?.toolchain ?? null
  return {
    comparability: comparability(beforeMeta, afterMeta).status,
    comparabilityReasons: comparability(beforeMeta, afterMeta).reasons,
    edges: { added, removed, changedLockIdentity, changedProvenance },
    findings: { added: findingsAdded, removed: findingsRemoved, reclassified },
    uncertainty: {
      beforeEvents: beforeUncertainty.events, afterEvents: afterUncertainty.events,
      beforeUnique: beforeUncertainty.unique, afterUnique: afterUncertainty.unique,
      categories: categoryNames.map((category) => ({ category,
        beforeEvents: beforeUncertainty.categories.get(category)?.events ?? 0,
        afterEvents: afterUncertainty.categories.get(category)?.events ?? 0,
        beforeUnique: beforeUncertainty.categories.get(category)?.unique ?? null,
        afterUnique: afterUncertainty.categories.get(category)?.unique ?? null })),
    },
    diagnostics: { added: diagnosticsAfter.filter((item) => !diagnosticsBefore.includes(item)),
      removed: diagnosticsBefore.filter((item) => !diagnosticsAfter.includes(item)) },
    metadata: { beforeSchema: before.schema_version, afterSchema: after.schema_version,
      schemaChanged: before.schema_version !== after.schema_version,
      beforeKernelRevision: revisionA, afterKernelRevision: revisionB,
      kernelRevisionChanged: revisionA && revisionB ? revisionA !== revisionB : null,
      beforeToolchain: toolchainA, afterToolchain: toolchainB,
      toolchainChanged: toolchainA && toolchainB ? toolchainA !== toolchainB : null },
  }
}
