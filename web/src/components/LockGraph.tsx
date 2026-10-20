import { useMemo, useState } from 'react'
import {
  Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow,
  ReactFlowProvider, useReactFlow,
  type Edge, type Node,
} from '@xyflow/react'
import { FileCode2, Focus, GitBranch, Info, Search, X } from 'lucide-react'
import type { AnalysisReport, Finding, GraphEdge } from '../types'

type LockNodeData = { label: string; identity: string; degree: number }
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
  return <div className={`lock-flow-node ${selected ? 'node-selected' : ''}`} title={data.identity}>
    <Handle type="target" position={Position.Left} />
    <span className="lock-node-icon"><GitBranch size={13} /></span>
    <span className="lock-node-copy"><strong>{data.label}</strong><small>{data.degree} adjacent {data.degree === 1 ? 'edge' : 'edges'}</small></span>
    <Handle type="source" position={Position.Right} />
  </div>
}

const nodeTypes = { lock: LockNode }

export function LockGraph({ report, selectedFinding, onSelectFinding, onOpenSource }: {
  report: AnalysisReport; selectedFinding: Finding | null; onSelectFinding: (finding: Finding | null) => void; onOpenSource: (file: string, line: number) => void;
}) {
  const rawEdges = report.interrupt_lock_graph.edges
  const [search, setSearch] = useState('')
  const [context, setContext] = useState('all')
  const [focusedEdge, setFocusedEdge] = useState<GraphEdge | null>(null)
  const [focusedLock, setFocusedLock] = useState<string | null>(null)
  const cycles = report.interrupt_cycles
  const filteredEdges = useMemo(() => rawEdges.filter((edge) => {
    const matchesSearch = !search || `${edge.from_lock} ${edge.to_lock} ${edge.source_function ?? ''} ${edge.target_function ?? ''}`.toLowerCase().includes(search.toLowerCase())
    const matchesContext = context === 'all' || edge.from_context === context || edge.to_context === context
    return matchesSearch && matchesContext
  }), [context, rawEdges, search])
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
      return { id: identity, type: 'lock', position: { x, y }, data: { label: lockLabel(identity), identity, degree: degrees.get(identity) ?? 0 } }
    })
  }, [filteredEdges, report.interrupt_lock_graph.nodes])
  const highlighted = useMemo(() => new Set((selectedFinding?.edges ?? []).map(edgeKey)), [selectedFinding])
  const edges = useMemo<Edge[]>(() => filteredEdges.map((edge, index) => {
    const rejected = edge.feasibility === 'rejected' || edge.kind === 'interrupt_preemption_rejected'
    const interrupt = edge.kind.includes('interrupt')
    const active = selectedFinding ? highlighted.has(edgeKey(edge)) : false
    const color = rejected ? '#758091' : interrupt ? '#f0786e' : '#718096'
    return {
      id: `edge-${index}-${edge.kind}-${index}`,
      source: edge.from_lock,
      target: edge.to_lock,
      type: 'smoothstep',
      animated: active && !rejected,
      label: `${edge.from_context ?? 'unknown'} → ${edge.to_context ?? 'unknown'}`,
      labelStyle: { fill: active ? '#f4f6f8' : '#8994a3', fontSize: 10 },
      labelBgStyle: { fill: '#11161d', fillOpacity: 0.92 },
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: { stroke: color, strokeWidth: active ? 2.8 : 1.55, strokeDasharray: rejected ? '6 5' : undefined, opacity: selectedFinding && !active ? 0.28 : 0.9 },
      data: { raw: edge },
    }
  }), [filteredEdges, highlighted, selectedFinding])
  const visibleNodeIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes])

  return <ReactFlowProvider>
    <div className="graph-toolbar">
      <label className="graph-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find lock, function, or symbol…" aria-label="Search lock graph" /></label>
      <label className="graph-context-filter"><span>Context</span><select aria-label="Filter graph by execution context" value={context} onChange={(event) => setContext(event.target.value)}><option value="all">All contexts</option><option value="process">Process</option><option value="hardirq">Hard IRQ</option></select></label>
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
        <Background color="#2d3540" gap={22} size={1} />
        <MiniMap nodeColor="#596b81" maskColor="rgba(8, 11, 15, .72)" pannable zoomable />
        <Controls position="bottom-left" showInteractive={false} />
        <FitGraphButton />
      </ReactFlow>
      {selectedFinding && <div className="graph-selection-note"><Focus size={14} /><span>Highlighting {selectedFinding.category.replaceAll('_', ' ')}</span><button className="text-button" onClick={() => onSelectFinding(null)}>Clear</button></div>}
      {focusedEdge && <EdgeInspector edge={focusedEdge} onClose={() => setFocusedEdge(null)} onOpenSource={onOpenSource} />}
      {focusedLock && <NodeInspector lock={focusedLock} edges={filteredEdges.filter((edge) => edge.from_lock === focusedLock || edge.to_lock === focusedLock)} onClose={() => setFocusedLock(null)} onSelectEdge={(edge) => { setFocusedLock(null); setFocusedEdge(edge) }} />}
      {selectedFinding && !selectedFinding.edges?.some((edge) => highlighted.has(edgeKey(edge)) && visibleNodeIds.has(edge.from_lock) && visibleNodeIds.has(edge.to_lock)) && <div className="graph-filter-note"><Info size={13} />The selected finding is outside the current graph filters.</div>}
      <div className="graph-legend"><span><i className="legend-line" />Lock order</span><span><i className="legend-line irq-line" />Interrupt preemption</span><span><i className="legend-line rejected-line" />Rejected shape</span></div>
    </div>}
  </ReactFlowProvider>
}

function NodeInspector({ lock, edges, onClose, onSelectEdge }: { lock: string; edges: GraphEdge[]; onClose: () => void; onSelectEdge: (edge: GraphEdge) => void }) {
  return <aside className="edge-inspector"><header><div><div className="eyebrow">LOCK NODE</div><strong>{lockLabel(lock)}</strong></div><button className="icon-button" onClick={onClose} aria-label="Close lock details"><X size={15} /></button></header>
    <div className="node-inspector-identity"><span>Identity</span><code>{lock}</code><span>Adjacent relationships</span><strong>{edges.length}</strong></div>
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
