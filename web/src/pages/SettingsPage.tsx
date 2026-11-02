import { HardDrive, RefreshCw } from 'lucide-react'
import type { Health } from '../types'

export function SettingsPage({
  health,
  onRefresh,
}: {
  health: Health | null
  onRefresh: () => void
}) {
  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">LOCAL CONFIGURATION</div>
          <h1>Settings</h1>
          <p className="page-caption">Backend roots and analyzer paths are configured in the local service environment.</p>
        </div>
        <button className="button button-secondary" onClick={onRefresh}>
          <RefreshCw size={14} /> Refresh status
        </button>
      </div>

      <div className="settings-layout">
        <section className="settings-section">
          <div className="eyebrow">ANALYZER CONNECTION</div>
          <div className="settings-row">
            <span>Local API</span>
            <strong className={health ? 'value-good' : 'value-bad'}>
              {health ? 'Connected' : 'Unavailable'}
            </strong>
          </div>
          <div className="settings-row">
            <span>Analyzer executable</span>
            <code>{health?.analyzer_path ?? 'Not available'}</code>
          </div>
          <div className="settings-row">
            <span>Analyzer status</span>
            <strong className={health?.analyzer_available ? 'value-good' : 'value-bad'}>
              {health?.analyzer_available ? 'Ready' : 'Not available'}
            </strong>
          </div>
          <div className="settings-row">
            <span>Accepted JSON schema</span>
            <strong>{health?.analyzer_report_schema ?? 'Not available'}</strong>
          </div>
          <div className="settings-row">
            <span>API version</span>
            <strong>{health?.api_version ?? 'Not available'}</strong>
          </div>
        </section>

        <section className="settings-section">
          <div className="eyebrow">FILESYSTEM ACCESS</div>
          <p className="settings-description">
            Analysis paths are restricted by the backend to these explicitly configured workspace roots. Symlinks are resolved before validation.
          </p>
          {health?.workspace_roots.length ? (
            health.workspace_roots.map((root) => (
              <div className="root-row" key={root}>
                <HardDrive size={15} />
                <code>{root}</code>
              </div>
            ))
          ) : (
            <div className="field-hint hint-danger">
              Workspace roots are unavailable because the backend is not connected.
            </div>
          )}
          <div className="settings-row">
            <span>Report and history storage</span>
            <code>{health?.data_directory ?? 'Not available'}</code>
          </div>
        </section>

        <section className="settings-section settings-capabilities">
          <div className="eyebrow">FEATURE AVAILABILITY</div>
          <div className="settings-row">
            <span>Static source analysis</span>
            <strong className="value-good">Available</strong>
          </div>
          <div className="settings-row">
            <span>Runtime evidence</span>
            <strong>{health?.runtime_evidence_available ? 'Available' : 'Build required'}</strong>
          </div>
          <div className="settings-row">
            <span>Benchmarks</span>
            <strong>{health?.benchmarks_available ? 'Available' : 'Build required'}</strong>
          </div>
        </section>
      </div>
    </>
  )
}

