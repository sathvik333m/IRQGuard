import { useState, type FormEvent } from 'react'
import {
  AlertCircle,
  Braces,
  Check,
  Database,
  FileCode2,
  Info,
  LoaderCircle,
  Play,
  TerminalSquare,
} from 'lucide-react'
import type { Health } from '../types'

export function NewAnalysisPage({
  health,
  status,
  onStart,
}: {
  health: Health | null
  status: string
  onStart: (values: { source_path: string; compile_commands_path?: string; api_config_path?: string }) => Promise<void>
}) {
  const [sourcePath, setSourcePath] = useState('')
  const [compilationPath, setCompilationPath] = useState('')
  const [apiConfigPath, setApiConfigPath] = useState('')
  const [formError, setFormError] = useState('')
  const [starting, setStarting] = useState(false)
  const [requestError, setRequestError] = useState('')

  const allowed = health?.workspace_roots ?? []
  const sourceLooksInRoot = !sourcePath || allowed.some((root) => sourcePath === root || sourcePath.startsWith(`${root}/`))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setFormError('')
    setRequestError('')
    if (!sourcePath.startsWith('/')) {
      setFormError('Enter an absolute WSL/Linux path to a .c or .h file.')
      return
    }
    if (!sourceLooksInRoot) {
      setFormError('The source path is outside the configured workspace roots shown below.')
      return
    }
    setStarting(true)
    try {
      await onStart({
        source_path: sourcePath,
        ...(compilationPath ? { compile_commands_path: compilationPath } : {}),
        ...(apiConfigPath ? { api_config_path: apiConfigPath } : {}),
      })
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Could not start analysis.')
      setStarting(false)
    }
  }

  const running = starting || status === 'queued' || status === 'running'

  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">NEW RUN</div>
          <h1>Analyze source</h1>
          <p className="page-caption">Submit one C translation unit to the local Clang LibTooling analyzer.</p>
        </div>
      </div>

      <div className="analysis-layout">
        <form className="analysis-form" onSubmit={submit}>
          <div className="form-section-title">
            <span className="step-number">01</span>
            <div>
              <h2>Source input</h2>
              <p>Paths are resolved by the WSL/Linux backend, not by this browser.</p>
            </div>
          </div>

          <label className="field-label" htmlFor="source-path">
            Source file path <span>Required</span>
          </label>
          <div className="path-input-wrap">
            <FileCode2 size={16} />
            <input
              id="source-path"
              value={sourcePath}
              onChange={(event) => setSourcePath(event.target.value)}
              placeholder="/home/user/project/src/example.c"
              autoComplete="off"
              disabled={running}
            />
          </div>
          <div className={`field-hint ${!sourceLooksInRoot ? 'hint-danger' : ''}`}>
            {sourceLooksInRoot
              ? 'Absolute path inside an allowed workspace.'
              : 'The source path is outside the configured workspace roots shown below.'}
          </div>

          <div className="workspace-roots">
            <div className="workspace-roots-title">Allowed workspace roots</div>
            {allowed.length ? (
              allowed.map((root) => <code key={root}>{root}</code>)
            ) : (
              <span className="muted">Unavailable until the backend connects.</span>
            )}
          </div>

          <label className="field-label" htmlFor="compile-path">
            Compilation database <span>Optional</span>
          </label>
          <div className="path-input-wrap">
            <Database size={16} />
            <input
              id="compile-path"
              value={compilationPath}
              onChange={(event) => setCompilationPath(event.target.value)}
              placeholder="/home/user/project/build/compile_commands.json"
              autoComplete="off"
              disabled={running}
            />
          </div>
          <div className="field-hint">Accepts a build directory or the compile_commands.json file itself.</div>

          <label className="field-label" htmlFor="api-config">
            API registry JSON <span>Optional</span>
          </label>
          <div className="path-input-wrap">
            <Braces size={16} />
            <input
              id="api-config"
              value={apiConfigPath}
              onChange={(event) => setApiConfigPath(event.target.value)}
              placeholder="/home/user/project/apis.json"
              autoComplete="off"
              disabled={running}
            />
          </div>
          <div className="field-hint">Overrides or extends supported lock and interrupt API models.</div>

          {(formError || requestError) && (
            <div className="form-error" role="alert">
              <AlertCircle size={15} />
              {formError || requestError}
            </div>
          )}

          {running ? (
            <div className="running-state" role="status">
              <LoaderCircle size={17} className="spin" />
              <span>
                <strong>{status === 'queued' ? 'Queued for analysis' : 'Running analysis…'}</strong>
                <small>The backend reports no percentage progress. You can keep this page open.</small>
              </span>
            </div>
          ) : (
            <button
              type="submit"
              className="button button-primary submit-analysis"
              disabled={!health?.analyzer_available || !sourcePath}
            >
              <Play size={15} /> Start analysis
            </button>
          )}

          {!health?.analyzer_available && (
            <div className="field-hint hint-danger">
              Analyzer executable unavailable. Build the C++ analyzer before starting.
            </div>
          )}
        </form>

        <aside className="analysis-aside">
          <div className="aside-section">
            <div className="eyebrow">WHAT WILL RUN</div>
            <div className="command-preview">
              <span className="command-prompt">$</span>
              <code>
                deadlock-analyzer analyze
                <br />
                --source &lt;path&gt;
                <br />
                --format json
              </code>
            </div>
            <div className="aside-note">
              <TerminalSquare size={15} />
              <span>Started with a fixed argument list. Browser input is never interpreted as a shell command.</span>
            </div>
          </div>
          <div className="aside-section">
            <div className="eyebrow">REPORT OUTPUT</div>
            <div className="output-list">
              <span>
                <Check size={14} /> Clang AST and CFG facts
              </span>
              <span>
                <Check size={14} /> Interprocedural lock edges
              </span>
              <span>
                <Check size={14} /> Process and hardirq contexts
              </span>
              <span>
                <Check size={14} /> Schema 4 JSON with provenance
              </span>
            </div>
            <div className="field-hint">
              JSON is selected because the graph and finding views consume the versioned analyzer report.
            </div>
          </div>
          <div className="aside-warning">
            <Info size={16} />
            <p>
              One translation unit is analyzed per run. Included header definitions and full-kernel coverage are not implied.
            </p>
          </div>
        </aside>
      </div>
    </>
  )
}

