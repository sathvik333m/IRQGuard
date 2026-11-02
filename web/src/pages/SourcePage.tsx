import { useState, useMemo, type ReactNode } from 'react'
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  Braces,
  FileJson2,
  FileSearch,
  LoaderCircle,
  LockKeyhole,
  Search,
} from 'lucide-react'
import type { AnalysisReport, SourceSnippet } from '../types'
import { LoadExampleButton } from '../components/DemoBadge'

function basename(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function locationOf(value: { expansion?: { file?: string; line?: number; valid?: boolean } } | undefined) {
  const point = value?.expansion
  if (!point?.valid || !point.file || !point.line) return null
  return { file: point.file, line: point.line }
}

const cKeywords = new Set(
  'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Atomic _Bool _Complex _Generic'.split(
    ' '
  )
)

export function highlightCLine(source: string): ReactNode {
  if (source.trimStart().startsWith('#')) return <span className="syntax-preprocessor">{source}</span>
  const tokenPattern =
    /\/\/.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b[A-Za-z_]\w*\b|\b\d+(?:\.\d+)?\b/g
  const parts: ReactNode[] = []
  let offset = 0
  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0]
    const start = match.index ?? 0
    if (start > offset) parts.push(source.slice(offset, start))
    const kind =
      token.startsWith('//') || token.startsWith('/*')
        ? 'comment'
        : token.startsWith('"') || token.startsWith("'")
        ? 'string'
        : /^\d/.test(token)
        ? 'number'
        : cKeywords.has(token)
        ? 'keyword'
        : 'identifier'
    parts.push(
      <span className={`syntax-${kind}`} key={`${start}-${token}`}>
        {token}
      </span>
    )
    offset = start + token.length
  }
  if (offset < source.length) parts.push(source.slice(offset))
  return parts
}

export function SourcePage({
  report,
  snippet,
  loading,
  error,
  onOpenSource,
  onLoadExample,
}: {
  report: AnalysisReport | null
  snippet: SourceSnippet | null
  loading: boolean
  error: string
  onOpenSource: (file: string, line: number) => void
  onLoadExample?: () => void
}) {
  const [filter, setFilter] = useState('')

  const symbols = useMemo(() => {
    if (!report) return []
    const functionRows = report.functions.map((item) => ({
      type: 'Function',
      name: item.qualified_name ?? item.name ?? 'Unnamed function',
      location: locationOf(item.location),
      detail: item.cfg_available === false ? 'CFG unavailable' : 'Function definition',
    }))
    const lockRows = report.api_operations
      .filter((item) => item.lock)
      .map((item) => ({
        type: item.kind ?? 'Lock operation',
        name: item.lock?.expression ?? item.api ?? 'Lock operation',
        location: locationOf(item.lock?.location) ?? locationOf(item.location),
        detail: `${item.caller ?? 'Unknown function'} · ${item.api ?? 'API'}`,
      }))
    const callRows = report.calls.map((item) => ({
      type: 'Call',
      name: item.callee_expression ?? item.callee ?? 'Unresolved call',
      location: locationOf(item.location),
      detail: `${item.caller ?? 'Unknown function'} → ${(item.target_names ?? []).join(', ') || item.resolution || 'unresolved'}`,
    }))
    return [...functionRows, ...callRows, ...lockRows].filter((item) =>
      `${item.type} ${item.name} ${item.location?.file ?? ''} ${item.detail}`
        .toLowerCase()
        .includes(filter.toLowerCase())
    )
  }, [filter, report])

  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">SOURCE NAVIGATION</div>
          <h1>Source explorer</h1>
          <p className="page-caption">Navigate extracted function and lock locations from the selected analyzer report.</p>
        </div>
      </div>

      {!report ? (
        <div className="empty-panel">
          <FileJson2 size={21} />
          <h2>No report selected</h2>
          <p>Run an analysis or load a bundled example.</p>
          {onLoadExample && <LoadExampleButton onLoadExample={onLoadExample} label="Load bundled example" />}
        </div>
      ) : (
        <div className="source-explorer">
          <section className="source-symbols">
            <div className="source-symbol-header">
              <div>
                <div className="eyebrow">EXTRACTED SYMBOLS</div>
                <strong>{symbols.length} entries</strong>
              </div>
              <label className="symbol-search">
                <Search size={14} />
                <input
                  aria-label="Search source symbols"
                  placeholder="Filter symbols…"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </label>
            </div>
            <div className="symbol-list">
              {symbols.map((item, index) => (
                <button
                  className="symbol-row"
                  key={`${item.type}-${item.name}-${index}`}
                  disabled={!item.location}
                  onClick={() => item.location && onOpenSource(item.location.file, item.location.line)}
                >
                  <span className={`symbol-icon ${item.type === 'Function' ? 'function-icon' : ''}`}>
                    {item.type === 'Function' ? <Braces size={14} /> : <LockKeyhole size={14} />}
                  </span>
                  <span className="symbol-copy">
                    <strong>{item.name}</strong>
                    <small>{item.detail}</small>
                  </span>
                  <code>{item.location ? `${basename(item.location.file)}:${item.location.line}` : 'Location unavailable'}</code>
                  <ArrowRight size={13} />
                </button>
              ))}
              {symbols.length === 0 && <div className="table-empty">No extracted symbols match.</div>}
            </div>
          </section>

          <section className="source-viewer">
            <div className="source-viewer-heading">
              <div>
                <div className="eyebrow">SOURCE SNIPPET</div>
                <strong>{snippet ? `${snippet.file}:${snippet.requested_line}` : 'Select a symbol or finding edge'}</strong>
              </div>
              {snippet && (
                <span className="source-readonly">
                  <BookOpen size={13} /> Read only
                </span>
              )}
            </div>
            {loading ? (
              <div className="source-placeholder">
                <LoaderCircle size={18} className="spin" /> Loading source range…
              </div>
            ) : error ? (
              <div className="source-placeholder source-error">
                <AlertCircle size={18} />
                <span>{error}</span>
              </div>
            ) : snippet ? (
              <div className="code-window" role="region" aria-label={`Source at line ${snippet.requested_line}`}>
                <div className="code-lines">
                  {snippet.lines.map((line) => (
                    <div className={`code-line ${line.highlighted ? 'highlighted' : ''}`} key={line.line}>
                      <span>{line.line}</span>
                      <code>{highlightCLine(line.text || ' ')}</code>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="source-placeholder">
                <FileSearch size={22} />
                <span>Source text appears here when requested from a report location.</span>
                <small>Only bounded line ranges for files referenced in the report are served.</small>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  )
}
