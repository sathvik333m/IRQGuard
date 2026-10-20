import { useEffect, useMemo, useState } from 'react'
import {
  Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow,
  ReactFlowProvider, useReactFlow,
  type Edge, type Node,
} from '@xyflow/react'
import { FileCode2, Focus, GitBranch, Info, LockKeyhole, Search, X } from 'lucide-react'
import type { AnalysisReport, Finding, GraphEdge } from '../types'

type LockNodeData = { label: string; identity: string; degree: number; apiTypes: string[] }
type LockFlowNode = Node<LockNodeData, 'lock'>

function pointOf(location: GraphEdge['from_location']) {
  const point = location?.expansion
  return point?.valid && point.file && point.line ? { file: point.file, line: point.line } : null
}

function lockLabel(identity: string) {
  const match = identity.match(/:([^:)]+)\)?$/)
  if (match) return match[1]
  const finalPart = identity.split('/').at(-1) ?? identity
  return finalPart.length > 27 ? `${finalPart.slice(0, 24)}…` : finalPart
}

export function edgeKey(edge: GraphEdge) {
  return [edge.from_lock, edge.to_lock, edge.kind, edge.from_context, edge.to_context,
    pointOf(edge.from_location)?.file, pointOf(edge.from_location)?.line,
    pointOf(edge.to_location)?.file, pointOf(edge.to_location)?.line, edge.handler].join('|')
}

function LockNode({ data, selected }: { data: LockNodeData; selected?: boolean }) {
  const lockKind = data.apiTypes.some((api) => api.includes('mutex')) ? 'lock-kind-mutex'
    : data.apiTypes.some((api) => api.includes('rwlock')) ? 'lock-kind-rwlock'
      : data.apiTypes.some((api) => api.includes('spin')) ? 'lock-kind-spin' : 'lock-kind-unknown'
  return <div className={`lock-flow-node ${lockKind} ${selected ? 'node-selected' : ''}`} title={data.identity}>
    <Handle type="target" position={Position.Left} />
    <span className="lock-node-icon"><LockKeyhole size={13} /></span>
    <span className="lock-node-copy"><strong>{data.label}</strong><small>{data.apiTypes.length ? data.apiTypes.join(', ') : 'Lock API not reported'} · {data.degree} edges</small></span>
    <Handle type="source" position={Position.Right} />
  </div>
}

const nodeTypes = { lock: LockNode }

export function LockGraph({ report, selectedFinding, onSelectFinding, onOpenSource, initialSearchTerm = '', compact = false }: {
  report: AnalysisReport; selectedFinding: Finding | null; onSelectFinding: (finding: Finding | null) => void; onOpenSource: (file: string, line: number) => void; initialSearchTerm?: string; compact?: boolean;
}) {
  const rawEdges = report.interrupt_lock_graph.edges
  const [search, setSearch] = useState(initialSearchTerm)
  const [context, setContext] = useState('all')
  const [relationship, setRelationship] = useState('all')
  const [lockApi, setLockApi] = useState('all')
  const [focusedEdge, setFocusedEdge] = useState<GraphEdge | null>(null)
  const [focusedLock, setFocusedLock] = useState<string | null>(null)
  const cycles = report.interrupt_cycles
  const lockApis = useMemo(() => {
    const result = new Map<string, Set<string>>()
    for (const operation of report.api_operations) {
      const identity = operation.lock?.identity_template
      if (!identity || !operation.api) continue
      const apis = result.get(identity) ?? new Set<string>()
      apis.add(operation.api)
      result.set(identity, apis)
    }
    return result
  }, [report.api_operations])
  const filteredEdges = useMemo(() => rawEdges.filter((edge) => {
    const matchesSearch = !search || `${edge.from_lock} ${edge.to_lock} ${edge.source_function ?? ''} ${edge.target_function ?? ''}`.toLowerCase().includes(search.toLowerCase())
    const matchesContext = context === 'all' || edge.from_context === context || edge.to_context === context
    const isInterrupt = edge.kind.includes('interrupt')
    const isRejected = edge.feasibility === 'rejected' || edge.kind === 'interrupt_preemption_rejected'
    const matchesRelationship = relationship === 'all' || (relationship === 'interrupt' && isInterrupt) || (relationship === 'lock-order' && !isInterrupt) || (relationship === 'rejected' && isRejected)
    const matchesApi = lockApi === 'all' || [...(lockApis.get(edge.from_lock) ?? []), ...(lockApis.get(edge.to_lock) ?? [])].includes(lockApi)
    return matchesSearch && matchesContext && matchesRelationship && matchesApi
  }), [context, lockApi, lockApis, rawEdges, relationship, search])
  const nodes = useMemo<LockFlowNode[]>(() => {
    const ids = new Set<string>()
    for (const node of report.interrupt_lock_graph.nodes) if (node?.lock_identity) ids.add(node.lock_identity)
    for (const edge of filteredEdges) { if (edge.from_lock) ids.add(edge.from_lock); if (edge.to_lock) ids.add(edge.to_lock) }
    const locks = [...ids]
    const width = 880
    const height = Math.max(460, Math.min(760, locks.length * 38))
    const degrees = new Map<string, number>()
    filteredEdges.forEach((edge) => {
      degrees.set(edge.from_lock, (degrees.get(edge.from_lock) ?? 0) + 1)
      degrees.set(edge.to_lock, (degrees.get(edge.to_lock) ?? 0) + 1)
    })
    return locks.map((identity, index) => {
      const angle = (2 * Math.PI * index) / Math.max(locks.length, 1) - Math.PI / 2
      const x = width / 2 + Math.cos(angle) * Math.min(350, 70 + locks.length * 21)
      const y = height / 2 + Math.sin(angle) * Math.min(245, 60 + locks.length * 15)
      return { id: identity, type: 'lock', position: { x, y }, data: { label: lockLabel(identity), identity, degree: degrees.get(identity) ?? 0, apiTypes: [...(lockApis.get(identity) ?? [])] } }
    })
  }, [filteredEdges, lockApis, report.interrupt_lock_graph.nodes])
  const highlighted = useMemo(() => new Set((selectedFinding?.edges ?? []).map(edgeKey)), [selectedFinding])
  const edges = useMemo<Edge[]>(() => filteredEdges.map((edge, index) => {
    const rejected = edge.feasibility === 'rejected' || edge.kind === 'interrupt_preemption_rejected'
    const interrupt = edge.kind.includes('interrupt')
    const active = selectedFinding ? highlighted.has(edgeKey(edge)) : false
    const color = active ? '#ff5b56' : rejected ? '#758091' : interrupt ? '#43c8df' : '#5b9ff4'
    return {
      id: `edge-${index}-${edge.kind}-${index}`,
      source: edge.from_lock,
      target: edge.to_lock,
      type: 'smoothstep',
      animated: active && !rejected,
      label: `${edge.from_context ?? 'unknown'} → ${edge.to_context ?? 'unknown'}`,
      labelStyle: { fill: active ? '#f4f6f8' : '#8994a3', fontSize: 12 },
      labelBgStyle: { fill: '#11161d', fillOpacity: 0.92 },
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: { stroke: color, strokeWidth: active ? 2.8 : 1.55, strokeDasharray: rejected ? '6 5' : undefined, opacity: selectedFinding && !active ? 0.28 : 0.9 },
      data: { raw: edge },
    }
  }), [filteredEdges, highlighted, selectedFinding])
  const visibleNodeIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes])

  return <ReactFlowProvider>
    <div className={`graph-toolbar ${compact ? 'graph-toolbar-compact' : ''}`}>
      <label className="graph-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find lock, function, or symbol…" aria-label="Search lock graph" /></label>
      <label className="graph-context-filter"><span>Context</span><select aria-label="Filter graph by execution context" value={context} onChange={(event) => setContext(event.target.value)}><option value="all">All contexts</option><option value="process">Process</option><option value="hardirq">Hard IRQ</option></select></label>
      <label className="graph-context-filter"><span>Relationship</span><select aria-label="Filter graph relationship" value={relationship} onChange={(event) => setRelationship(event.target.value)}><option value="all">All edges</option><option value="lock-order">Lock order</option><option value="interrupt">Interrupt</option><option value="rejected">Rejected</option></select></label>
      <label className="graph-context-filter"><span>Lock API</span><select aria-label="Filter graph by lock API" value={lockApi} onChange={(event) => setLockApi(event.target.value)}><option value="all">All APIs</option>{[...new Set([...lockApis.values()].flatMap((items) => [...items]))].sort().map((api) => <option key={api} value={api}>{api}</option>)}</select></label>
      <label className="graph-finding-filter"><span>Highlight finding</span><select aria-label="Highlight a finding" value={selectedFinding ? cycles.indexOf(selectedFinding) : ''} onChange={(event) => {
        const index = Number(event.target.value)
        if (event.target.value === '') return
        const cycle = cycles[index]
        if (cycle) onSelectFinding(cycle)
      }}><option value="">None</option>{cycles.map((finding, index) => <option key={`${finding.category}-${index}`} value={index}>{finding.category.replaceAll('_', ' ')} · {lockLabel(finding.lock_sequence?.[0] ?? `Finding ${index + 1}`)}</option>)}</select></label>
      <div className="graph-count"><strong>{filteredEdges.length}</strong> / {rawEdges.length} edges</div>
    </div>
    {rawEdges.length === 0 ? <div className="graph-empty"><GitBranch size={22} /><h2>No lock dependency edges</h2><p>The analyzer report contains an empty graph for this source file.</p></div> : filteredEdges.length === 0 ? <div className="graph-empty"><Search size={20} /><h2>No matching edges</h2><p>Change the lock search or context filter.</p></div> : <div className="graph-canvas-wrap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.22 }}
        minZoom={0.12}
        maxZoom={1.7}
        proOptions={{ hideAttribution: true }}
        onEdgeClick={(_event, edge) => { setFocusedLock(null); setFocusedEdge((edge.data as { raw: GraphEdge }).raw) }}
        onNodeClick={(_event, node) => { setFocusedEdge(null); setFocusedLock(node.id) }}
        onPaneClick={() => { setFocusedEdge(null); setFocusedLock(null) }}
        aria-label="Lock dependency graph"
      >
        <CycleFocus finding={selectedFinding} />
        <Background color="#2d3540" gap={22} size={1} />
        <MiniMap nodeColor="#596b81" maskColor="rgba(8, 11, 15, .72)" pannable zoomable />
        <Controls position="bottom-left" showInteractive={false} />
        <FitGraphButton />
      </ReactFlow>
      {selectedFinding && <div className="graph-selection-note"><Focus size={14} /><span>Highlighting {selectedFinding.category.replaceAll('_', ' ')}</span><button className="text-button" onClick={() => onSelectFinding(null)}>Clear</button></div>}
      {focusedEdge && <EdgeInspector edge={focusedEdge} onClose={() => setFocusedEdge(null)} onOpenSource={onOpenSource} />}
      {focusedLock && <NodeInspector lock={focusedLock} apiTypes={[...(lockApis.get(focusedLock) ?? [])]} edges={filteredEdges.filter((edge) => edge.from_lock === focusedLock || edge.to_lock === focusedLock)} onClose={() => setFocusedLock(null)} onSelectEdge={(edge) => { setFocusedLock(null); setFocusedEdge(edge) }} onOpenSource={onOpenSource} />}
      {selectedFinding && !selectedFinding.edges?.some((edge) => highlighted.has(edgeKey(edge)) && visibleNodeIds.has(edge.from_lock) && visibleNodeIds.has(edge.to_lock)) && <div className="graph-filter-note"><Info size={13} />The selected finding is outside the current graph filters.</div>}
      {!compact && <div className="graph-legend"><span><i className="legend-line normal-line" />Lock order</span><span><i className="legend-line irq-line" />Interrupt preemption</span><span><i className="legend-line candidate-line" />Selected candidate</span><span><i className="legend-line rejected-line" />Rejected shape</span></div>}
    </div>}
  </ReactFlowProvider>
}

function CycleFocus({ finding }: { finding: Finding | null }) {
  const { fitView } = useReactFlow()
  useEffect(() => {
    if (!finding?.lock_sequence?.length) return
    const nodes = [...new Set(finding.lock_sequence)].map((id) => ({ id }))
    void fitView({ nodes, padding: 0.35, duration: 320 })
  }, [finding, fitView])
  return null
}

function NodeInspector({ lock, apiTypes, edges, onClose, onSelectEdge, onOpenSource }: { lock: string; apiTypes: string[]; edges: GraphEdge[]; onClose: () => void; onSelectEdge: (edge: GraphEdge) => void; onOpenSource: (file: string, line: number) => void }) {
  const locations = edges.flatMap((edge) => [pointOf(edge.from_location), pointOf(edge.to_location)]).filter((point): point is { file: string; line: number } => !!point)
  return <aside className="edge-inspector"><header><div><div className="eyebrow">LOCK NODE</div><strong>{lockLabel(lock)}</strong></div><button className="icon-button" onClick={onClose} aria-label="Close lock details"><X size={15} /></button></header>
    <div className="node-inspector-identity"><span>Identity</span><code>{lock}</code><span>Lock API type</span><strong>{apiTypes.length ? apiTypes.join(', ') : 'Not reported'}</strong><span>Adjacent relationships</span><strong>{edges.length}</strong></div>
    {locations.length > 0 && <div className="inspector-source">{locations.slice(0, 4).map((place, index) => <button className="source-link" key={`${place.file}:${place.line}:${index}`} onClick={() => onOpenSource(place.file, place.line)}><FileCode2 size={13} />{place.file.split('/').at(-1)}:{place.line}</button>)}</div>}
    <div className="node-edge-shortcuts">{edges.slice(0, 8).map((edge, index) => <button key={`${edgeKey(edge)}-${index}`} onClick={() => onSelectEdge(edge)}><span>{lockLabel(edge.from_lock)} → {lockLabel(edge.to_lock)}</span><small>{edge.kind} · {edge.from_context ?? 'unknown'}</small></button>)}</div>
    {edges.length > 8 && <p className="inspector-reason">Showing 8 of {edges.length} adjacent edges. Use search or context filters to narrow the graph.</p>}
  </aside>
}

function FitGraphButton() {
  const { fitView } = useReactFlow()
  return <button className="fit-graph-button" onClick={() => void fitView({ padding: 0.22, duration: 250 })}><Focus size={14} />Fit view</button>
}

function EdgeInspector({ edge, onClose, onOpenSource }: { edge: GraphEdge; onClose: () => void; onOpenSource: (file: string, line: number) => void }) {
  const from = pointOf(edge.from_location)
  const to = pointOf(edge.to_location)
  return <aside className="edge-inspector"><header><div><div className="eyebrow">EDGE EVIDENCE</div><strong>{lockLabel(edge.from_lock)} → {lockLabel(edge.to_lock)}</strong></div><button className="icon-button" onClick={onClose} aria-label="Close edge details"><X size={15} /></button></header>
    <div className="inspector-facts"><span>Type</span><strong>{edge.kind}</strong><span>Context</span><strong>{edge.from_context ?? 'unknown'} → {edge.to_context ?? 'unknown'}</strong><span>Certainty</span><strong>{edge.certainty ?? 'not reported'}</strong><span>IRQ state</span><strong>{edge.irq_state ?? 'not reported'}</strong>{edge.handler && <><span>Handler</span><strong>{edge.handler}</strong></>}</div>
    <div className="inspector-source">{from && <button className="source-link" onClick={() => onOpenSource(from.file, from.line)}><FileCode2 size={13} />From · {from.file.split('/').at(-1)}:{from.line}</button>}{to && <button className="source-link" onClick={() => onOpenSource(to.file, to.line)}><FileCode2 size={13} />To · {to.file.split('/').at(-1)}:{to.line}</button>}</div>
    {edge.feasibility_reason && <p className="inspector-reason">{edge.feasibility_reason}</p>}
  </aside>
}
