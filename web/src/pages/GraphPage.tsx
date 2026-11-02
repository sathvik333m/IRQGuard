import { Suspense } from 'react'
import { FileJson2, LoaderCircle } from 'lucide-react'
import type { AnalysisMetadata, AnalysisReport, Finding } from '../types'
import { LockGraph } from '../components/LockGraph'
import { LoadExampleButton } from '../components/DemoBadge'

function basename(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

export function GraphPage({
  report,
  active,
  selectedFinding,
  onSelectFinding,
  onOpenSource,
  searchTerm,
  onLoadExample,
}: {
  report: AnalysisReport | null
  active: AnalysisMetadata | null
  selectedFinding: Finding | null
  onSelectFinding: (finding: Finding | null) => void
  onOpenSource: (file: string, line: number) => void
  searchTerm: string
  onLoadExample?: () => void
}) {
  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">LOCK ORDER MODEL</div>
          <h1>Lock dependency graph</h1>
          <p className="page-caption">
            {active
              ? `Actual graph edges from ${basename(active.source_path)} · select an edge or node for provenance.`
              : 'Select an analysis or load a bundled example to inspect its lock graph.'}
          </p>
        </div>
      </div>

      {!report ? (
        <div className="empty-panel">
          <FileJson2 size={21} />
          <h2>No report selected</h2>
          <p>Run an analysis or load a bundled example to view the dependency graph.</p>
          {onLoadExample && <LoadExampleButton onLoadExample={onLoadExample} label="Load bundled example" />}
        </div>
      ) : (
        <div className="graph-workspace">
          <Suspense
            fallback={
              <div className="loading-line graph-loading">
                <LoaderCircle size={16} className="spin" /> Loading lock graph…
              </div>
            }
          >
            <LockGraph
              report={report}
              selectedFinding={selectedFinding}
              onSelectFinding={onSelectFinding}
              onOpenSource={onOpenSource}
              initialSearchTerm={searchTerm}
            />
          </Suspense>
        </div>
      )}
    </>
  )
}

