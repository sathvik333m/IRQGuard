import { Database } from 'lucide-react'
import { DEMO_EXAMPLES, type DemoExample } from '../demo/demoData'

export function DemoBadge({
  activeExampleId,
  onSelectExample,
}: {
  activeExampleId?: string
  onSelectExample?: (exampleId: string) => void
}) {
  return (
    <div className="demo-banner-badge" role="status" aria-label="Demo mode indicator">
      <div className="demo-badge-header">
        <span className="demo-pill">
          <Database size={12} />
          Demo data
        </span>
        <span className="demo-badge-text">
          Bundled example from repo — not a live analysis
        </span>
      </div>
      {onSelectExample && (
        <div className="demo-example-selector">
          <label htmlFor="demo-example-select">Example:</label>
          <select
            id="demo-example-select"
            value={activeExampleId ?? DEMO_EXAMPLES[0].id}
            onChange={(e) => onSelectExample(e.target.value)}
            aria-label="Select demo example"
          >
            {DEMO_EXAMPLES.map((ex: DemoExample) => (
              <option key={ex.id} value={ex.id}>
                {ex.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

export function LoadExampleButton({
  onLoadExample,
  label = 'Load bundled example',
  variant = 'button',
}: {
  onLoadExample: () => void
  label?: string
  variant?: 'button' | 'link'
}) {
  return (
    <button
      type="button"
      className={variant === 'button' ? 'primary-button' : 'text-button'}
      onClick={onLoadExample}
    >
      <Database size={14} />
      {label}
    </button>
  )
}
