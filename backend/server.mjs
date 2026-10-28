import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants, accessSync } from 'node:fs'
import { mkdir, readFile, realpath, rename, stat, writeFile, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const analyzerPath = path.resolve(process.env.IRQGUARD_ANALYZER || path.join(repoRoot, 'build/deadlock-analyzer'))
const dataDir = path.resolve(process.env.IRQGUARD_DATA_DIR || path.join(os.homedir(), '.local/share/irqguard'))
const reportDir = path.join(dataDir, 'reports')
const historyPath = path.join(dataDir, 'history.json')
const apiVersion = '1'
const reportSchema = 3
const runtimeScript = path.join(repoRoot, 'runtime/runtime_evidence.py')
const runtimeProgram = path.join(repoRoot, 'build/irqguard-runtime-demo')
const runtimeDir = path.join(dataDir, 'runtime')
const runtimeHistoryPath = path.join(runtimeDir, 'history.json')
const maxSourceBytes = 20 * 1024 * 1024
const maxOutputBytes = 16 * 1024 * 1024
const maxContextLines = 80
const timeoutSeconds = Math.max(5, Number.parseInt(process.env.IRQGUARD_TIMEOUT_SECONDS || '180', 10) || 180)
const port = Number.parseInt(process.env.IRQGUARD_PORT || '8000', 10)

async function configuredRoots() {
  const candidates = process.env.IRQGUARD_WORKSPACES
    ? process.env.IRQGUARD_WORKSPACES.split(path.delimiter).filter(Boolean)
    : [repoRoot]
  const roots = []
  for (const candidate of candidates) {
    try {
      const root = await realpath(candidate.replace(/^~/, os.homedir()))
      if ((await stat(root)).isDirectory() && !roots.includes(root)) roots.push(root)
    } catch { /* Missing workspace roots are omitted and shown as such in health. */ }
  }
  return roots
}

const workspaceRoots = await configuredRoots()
await mkdir(reportDir, { recursive: true })
await mkdir(runtimeDir, { recursive: true })
let analyses = []
try {
  const saved = JSON.parse(await readFile(historyPath, 'utf8'))
  if (Array.isArray(saved)) analyses = saved.filter((item) => item && typeof item === 'object')
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error(`Could not read IRQGuard history at ${historyPath}: ${error.message}`)
}
let saveQueue = Promise.resolve()
function saveHistory() {
  saveQueue = saveQueue.then(async () => {
    const temporary = `${historyPath}.tmp`
    await writeFile(temporary, `${JSON.stringify(analyses)}\n`, 'utf8')
    await rename(temporary, historyPath)
  })
  return saveQueue
}
let runtimeRuns = []
try {
  const saved = JSON.parse(await readFile(runtimeHistoryPath, 'utf8'))
  if (Array.isArray(saved)) runtimeRuns = saved.filter((item) => item && typeof item === 'object')
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error(`Could not read IRQGuard runtime history at ${runtimeHistoryPath}: ${error.message}`)
}
let runtimeSaveQueue = Promise.resolve()
function saveRuntimeHistory() {
  runtimeSaveQueue = runtimeSaveQueue.then(async () => {
    const temporary = `${runtimeHistoryPath}.tmp`
    await writeFile(temporary, `${JSON.stringify(runtimeRuns)}\n`, 'utf8')
    await rename(temporary, runtimeHistoryPath)
  })
  return runtimeSaveQueue
}

const allowedOrigins = new Set([
  'http://localhost:5173', 'http://127.0.0.1:5173',
  'http://localhost:4173', 'http://127.0.0.1:4173',
])
const activeRuns = new Set()
const activeRuntimeRuns = new Set()

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

function insideWorkspace(file) {
  return workspaceRoots.some((root) => {
    const relative = path.relative(root, file)
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  })
}

async function validatedPath(value, label, mustExist = true) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096) throw new HttpError(400, `${label} must be a path string`)
  const expanded = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value
  if (!path.isAbsolute(expanded)) throw new HttpError(400, `${label} must be an absolute WSL/Linux path`)
  let resolved
  try { resolved = mustExist ? await realpath(expanded) : path.resolve(expanded) }
  catch { throw new HttpError(400, `${label} does not exist or cannot be resolved`) }
  if (!insideWorkspace(resolved)) throw new HttpError(403, `${label} is outside the configured workspace roots`)
  return resolved
}

function parseJson(text, message) {
  try { return JSON.parse(text) } catch { throw new HttpError(500, message) }
}

function rowReport(row) {
  if (!row.report_json) return null
  const report = parseJson(row.report_json, 'Stored analysis report is malformed')
  return report && typeof report === 'object' && !Array.isArray(report) ? report : null
}

function summarize(report) {
  if (!report) return null
  const functions = Array.isArray(report.functions) ? report.functions : []
  const operations = Array.isArray(report.api_operations) ? report.api_operations : []
  const dependencies = Array.isArray(report.lock_dependencies) ? report.lock_dependencies : []
  const graphEdges = Array.isArray(report.interrupt_lock_graph?.edges) ? report.interrupt_lock_graph.edges : []
  const cycles = Array.isArray(report.interrupt_cycles) ? report.interrupt_cycles : []
  const categories = {}
  for (const cycle of cycles) {
    const category = cycle?.category || 'inconclusive_analysis'
    categories[category] = (categories[category] || 0) + 1
  }
  return {
    translation_units: 1,
    functions: functions.length,
    lock_operations: operations.filter((item) => item && item.lock).length,
    lock_dependencies: dependencies.length,
    graph_edges: graphEdges.length,
    candidate_cycles: (categories.candidate_lock_order_cycle || 0) + (categories.interrupt_aware_candidate || 0),
    rejected_candidates: categories.rejected_candidate || 0,
    inconclusive_findings: categories.inconclusive_analysis || 0,
    finding_categories: categories,
    diagnostics: Array.isArray(report.diagnostics) ? report.diagnostics.length : null,
    uncertainties: Array.isArray(report.uncertainties) ? report.uncertainties.length : null,
  }
}

function metadata(row) {
  const report = rowReport(row)
  return {
    id: row.id,
    created_at: row.created_at,
    status: row.status,
    source_path: row.source_path,
    configuration: parseJson(row.config_json, 'Stored analysis configuration is malformed'),
    analyzer_schema_version: report?.schema_version ?? null,
    analysis_kind: report?.analysis_kind ?? null,
    duration_ms: row.duration_ms,
    return_code: row.return_code,
    summary: summarize(report),
    error: row.error,
  }
}

function readRun(id) {
  if (!/^[a-f0-9-]{1,64}$/i.test(id)) throw new HttpError(404, 'Analysis was not found')
  const row = analyses.find((item) => item.id === id)
  if (!row) throw new HttpError(404, 'Analysis was not found')
  return row
}

function reportForRun(id) {
  const report = rowReport(readRun(id))
  if (!report) throw new HttpError(409, 'Analysis has no completed report yet')
  return report
}

function json(response, status, body) {
  const data = JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' })
  response.end(data)
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new HttpError(413, 'Request body exceeds 64 KiB')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new HttpError(400, 'Request body must be valid JSON') }
}

async function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Request body must be a JSON object')
  const permitted = new Set(['source_path', 'compile_commands_path', 'api_config_path'])
  if (Object.keys(body).some((key) => !permitted.has(key))) throw new HttpError(422, 'Unexpected request field')
  const source = await validatedPath(body.source_path, 'source_path')
  const sourceInfo = await stat(source)
  if (!sourceInfo.isFile() || !['.c', '.h'].includes(path.extname(source).toLowerCase())) throw new HttpError(400, 'source_path must identify a C source or header file')
  if (sourceInfo.size > maxSourceBytes) throw new HttpError(413, 'source file exceeds the 20 MiB analysis limit')

  let compilation = null
  if (body.compile_commands_path) {
    const supplied = await validatedPath(body.compile_commands_path, 'compile_commands_path')
    const info = await stat(supplied)
    compilation = info.isDirectory() ? supplied : info.isFile() && path.basename(supplied) === 'compile_commands.json' ? path.dirname(supplied) : null
    if (!compilation) throw new HttpError(400, 'compile_commands_path must be a build directory or compile_commands.json')
    try {
      const database = await stat(path.join(compilation, 'compile_commands.json'))
      if (!database.isFile()) throw new Error()
    }
    catch { throw new HttpError(400, 'compilation database has no compile_commands.json') }
  }

  let apiConfig = null
  if (body.api_config_path) {
    apiConfig = await validatedPath(body.api_config_path, 'api_config_path')
    if (!(await stat(apiConfig)).isFile() || path.extname(apiConfig).toLowerCase() !== '.json') throw new HttpError(400, 'api_config_path must identify a JSON file')
  }
  return { source, compilation, apiConfig }
}

function updateRun(id, fields) {
  const row = analyses.find((item) => item.id === id)
  if (!row) throw new Error(`Analysis ${id} disappeared from history`)
  Object.assign(row, {
    status: fields.status,
    return_code: fields.return_code ?? null,
    duration_ms: fields.duration_ms ?? null,
    report_path: fields.report_path ?? null,
    report_json: fields.report_json ?? null,
    error: fields.error ?? null,
  })
  return saveHistory()
}

function executeAnalyzer(command, cwd) {
  return new Promise((resolve) => {
    let child
    try { child = spawn(command[0], command.slice(1), { cwd, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (error) { resolve({ code: 127, stdout: '', stderr: '', error: `Could not start the analyzer: ${error.message}` }); return }
    const buffers = { stdout: [], stderr: [] }
    const sizes = { stdout: 0, stderr: 0 }
    let failure = null
    let settled = false
    let timedOut = false
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    const timer = setTimeout(() => { timedOut = true; failure = `Analyzer exceeded the ${timeoutSeconds} second timeout`; killGroup() }, timeoutSeconds * 1000)
    for (const name of ['stdout', 'stderr']) child[name].on('data', (chunk) => {
      sizes[name] += chunk.length
      if (sizes[name] > maxOutputBytes) {
        failure = `Analyzer ${name} exceeded the 16 MiB output limit`
        killGroup()
      } else buffers[name].push(chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      resolve({ code: 127, stdout: '', stderr: '', error: `Could not start the analyzer: ${error.message}` })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(buffers.stdout).toString('utf8'),
        stderr: Buffer.concat(buffers.stderr).toString('utf8'),
        error: failure,
        timedOut,
      })
    })
  })
}

function executeRuntime(command, cwd, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let child
    try { child = spawn(command[0], command.slice(1), { cwd, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (error) { resolve({ code: 127, stdout: '', stderr: '', error: `Could not start runtime evidence tool: ${error.message}` }); return }
    const buffers = { stdout: [], stderr: [] }
    let failure = null
    let settled = false
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    const timer = setTimeout(() => { failure = 'Runtime evidence command exceeded its time limit'; killGroup() }, timeoutMs)
    for (const name of ['stdout', 'stderr']) child[name].on('data', (chunk) => {
      buffers[name].push(chunk)
      if (Buffer.concat(buffers[name]).length > maxOutputBytes) { failure = `Runtime evidence ${name} exceeded the output limit`; killGroup() }
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      resolve({ code: 127, stdout: '', stderr: '', error: `Could not start runtime evidence tool: ${error.message}` })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      resolve({ code: code ?? 1, stdout: Buffer.concat(buffers.stdout).toString('utf8'), stderr: Buffer.concat(buffers.stderr).toString('utf8'), error: failure })
    })
  })
}

function runtimeMetadata(run) {
  return { id: run.id, created_at: run.created_at, kind: run.kind, status: run.status,
    scenario: run.scenario ?? null, termination: run.summary?.termination ?? null,
    deadlock_reproduction: run.summary?.deadlock_reproduction ?? null,
    event_count: run.summary?.event_count ?? null, error: run.error ?? null }
}

function runtimeRun(id) {
  if (!/^[a-f0-9-]{1,64}$/i.test(id)) throw new HttpError(404, 'Runtime evidence run was not found')
  const run = runtimeRuns.find((item) => item.id === id)
  if (!run) throw new HttpError(404, 'Runtime evidence run was not found')
  return run
}

async function readRuntimeTrace(run) {
  if (!run.trace_path) return []
  try {
    const text = await readFile(run.trace_path, 'utf8')
    return text.split(/\r?\n/).filter(Boolean).slice(-5000).map((line) => JSON.parse(line))
  } catch { return [] }
}

function validateRuntimeInputs(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.has(key))) throw new HttpError(422, 'Unexpected runtime request fields')
}

function runtimeFilesAvailable() {
  try { accessSync(runtimeProgram, constants.X_OK); accessSync(runtimeScript, constants.R_OK); return true } catch { return false }
}

async function runRuntimeScenario(id, run, scenario, timeout) {
  const tracePath = path.join(runtimeDir, `${id}.jsonl`)
  const summaryPath = path.join(runtimeDir, `${id}.summary.json`)
  const result = await executeRuntime(['python3', runtimeScript, 'run', '--program', runtimeProgram,
    '--scenario', scenario, '--timeout', String(timeout), '--trace', tracePath, '--summary', summaryPath], repoRoot, Math.max(15000, (timeout + 8) * 1000))
  const row = runtimeRuns.find((item) => item.id === id)
  if (result.error || result.code !== 0) Object.assign(row, { status: 'failed', error: (result.error || result.stderr || `Runtime command exited ${result.code}`).slice(-4000) })
  else {
    try { Object.assign(row, { status: 'completed', trace_path: tracePath, summary: JSON.parse(await readFile(summaryPath, 'utf8')) }) }
    catch (error) { Object.assign(row, { status: 'failed', error: `Could not load runtime summary: ${error.message}` }) }
  }
  await saveRuntimeHistory()
}

async function runAnalysis(id, source, compilation, apiConfig) {
  const started = performance.now()
  updateRun(id, { status: 'running' })
  const command = [analyzerPath, 'analyze', '--source', source, '--format', 'json']
  if (compilation) command.push('--compile-commands', compilation)
  if (apiConfig) command.push('--api-config', apiConfig)
  const result = await executeAnalyzer(command, path.dirname(source))
  const duration = Math.round(performance.now() - started)
  if (result.error) {
    updateRun(id, { status: 'failed', return_code: result.code, duration_ms: duration, error: result.error + (result.stderr ? `\n${result.stderr.slice(-4000)}` : '') })
    return
  }
  if (result.code !== 0) {
    updateRun(id, { status: 'failed', return_code: result.code, duration_ms: duration, error: (result.stderr.trim() || `Analyzer exited with status ${result.code}`).slice(-8000) })
    return
  }
  let report
  try { report = JSON.parse(result.stdout) }
  catch (error) {
    updateRun(id, { status: 'failed', return_code: result.code, duration_ms: duration, error: `Analyzer output was not valid JSON: ${error.message}` })
    return
  }
  if (!report || typeof report !== 'object' || Array.isArray(report) || report.schema_version !== reportSchema || report.analysis_kind !== 'interrupt_aware_lock_analysis') {
    updateRun(id, { status: 'failed', return_code: result.code, duration_ms: duration, error: `Unsupported analyzer report schema ${report?.schema_version ?? 'unknown'}; expected schema ${reportSchema}` })
    return
  }
  const reportText = JSON.stringify(report)
  const reportPath = path.join(reportDir, `${id}.json`)
  const temporary = `${reportPath}.tmp`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await rename(temporary, reportPath)
  updateRun(id, { status: 'completed', return_code: result.code, duration_ms: duration, report_path: reportPath, report_json: reportText })
}

function sourcePathsInReport(report) {
  const found = new Set()
  const visit = (value) => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (!value || typeof value !== 'object') return
    if (value.valid === true && typeof value.file === 'string' && value.file) found.add(value.file)
    for (const child of Object.values(value)) visit(child)
  }
  if (typeof report.source === 'string') found.add(report.source)
  visit(report)
  return found
}

async function sourceSnippet(id, url) {
  const report = reportForRun(id)
  const requestedLine = Number(url.searchParams.get('line'))
  const context = Number(url.searchParams.get('context') ?? '8')
  if (!url.searchParams.get('file') || url.searchParams.get('file').length > 4096) throw new HttpError(422, 'file is required')
  if (!Number.isInteger(requestedLine) || requestedLine < 1) throw new HttpError(422, 'line must be a positive integer')
  if (!Number.isInteger(context) || context < 0 || context > maxContextLines) throw new HttpError(422, `context must be between 0 and ${maxContextLines}`)
  const file = await validatedPath(url.searchParams.get('file'), 'file')
  let referenced = false
  for (const candidate of sourcePathsInReport(report)) {
    try { if (await realpath(candidate) === file) { referenced = true; break } } catch { /* Ignore stale paths. */ }
  }
  if (!referenced) throw new HttpError(403, 'Source file is not referenced by this analysis report')
  const info = await stat(file)
  if (!info.isFile() || info.size > maxSourceBytes) throw new HttpError(404, 'Source file is unavailable or exceeds the size limit')
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/)
  const start = Math.max(1, requestedLine - context)
  const end = Math.min(lines.length, requestedLine + context)
  if (requestedLine > lines.length) throw new HttpError(404, 'Requested source line is unavailable')
  const selected = []
  for (let line = start; line <= end; line++) selected.push({ line, text: lines[line - 1], highlighted: line === requestedLine })
  return { api_version: apiVersion, analysis_id: id, file, requested_line: requestedLine, start_line: start, end_line: end, lines: selected }
}

async function route(request, response) {
  const origin = request.headers.origin
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' })
    response.end(); return
  }
  const url = new URL(request.url, 'http://localhost')
  const pathname = url.pathname
  if (request.method === 'GET' && pathname === '/api/v1/health') {
    const release = os.release()
    let analyzerAvailable = false
    try { accessSync(analyzerPath, constants.X_OK); analyzerAvailable = true } catch { /* Report accurately. */ }
    const runtimeAvailable = runtimeFilesAvailable()
    json(response, 200, {
      api_version: apiVersion, status: 'ok', analyzer_path: analyzerPath, analyzer_available: analyzerAvailable,
      analyzer_report_schema: reportSchema, workspace_roots: workspaceRoots,
      environment: { operating_system: `${os.type()} ${os.release()} ${os.arch()}`, wsl: /microsoft/i.test(release) || Boolean(process.env.WSL_DISTRO_NAME), analyzer_version: null, target_kernel: null },
      data_directory: dataDir, runtime_evidence_available: runtimeAvailable, benchmarks_available: runtimeAvailable,
    }); return
  }
  if (request.method === 'GET' && pathname === '/api/v1/evaluations/linux-v6.6.87') {
    const measurementPath = path.join(repoRoot, 'evaluation/results/linux-v6.6.87/raw-measurements.json')
    const cycleReviewPath = path.join(repoRoot, 'evaluation/results/linux-v6.6.87/cycle-review-phase11.json')
    let measurement
    try { measurement = JSON.parse(await readFile(measurementPath, 'utf8')) }
    catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(404, 'The recorded Linux v6.6.87 evaluation is not available in this checkout')
      throw new HttpError(500, `Could not read the recorded kernel evaluation: ${error.message}`)
    }
    let cycleReview = null
    try { cycleReview = JSON.parse(await readFile(cycleReviewPath, 'utf8')) }
    catch (error) {
      if (error.code !== 'ENOENT') throw new HttpError(500, `Could not read the archived cycle review: ${error.message}`)
    }
    const aggregate = measurement.aggregate ?? {}
    const counts = aggregate.counts_sum_across_translation_units ?? {}
    json(response, 200, {
      api_version: apiVersion,
      status: measurement.status,
      kernel: measurement.kernel,
      configuration: {
        architecture: measurement.configuration?.architecture,
        compiler_mode: measurement.configuration?.compiler_mode,
        config_base: measurement.configuration?.config_base,
        subsystem: measurement.configuration?.subsystem,
        build_limitations: measurement.configuration?.build_limitations ?? [],
      },
      aggregate: {
        files_requested: aggregate.files_requested ?? 0,
        files_analyzed: aggregate.files_analyzed ?? 0,
        files_skipped_or_failed: aggregate.files_skipped_or_failed ?? 0,
        functions: counts.functions ?? 0,
        lock_operations: counts.lock_operations ?? 0,
        lock_dependencies: counts.lock_dependencies ?? 0,
        interrupt_graph_edges: counts.interrupt_graph_edges ?? 0,
        interrupt_cycles: counts.interrupt_cycles ?? 0,
        uncertainties: counts.uncertainties ?? 0,
        diagnostics: counts.diagnostics ?? 0,
        elapsed_seconds_sum: aggregate.analysis_elapsed_seconds_sum ?? null,
        peak_rss_kib_max: aggregate.peak_rss_kib_max_across_separate_runs ?? null,
      },
      translation_units: (measurement.translation_units ?? []).map((unit) => ({
        file: path.basename(unit.file ?? ''),
        status: unit.status,
        skip_reason: unit.skip_reason ?? null,
        elapsed_seconds: unit.elapsed_seconds ?? null,
        peak_rss_kib: unit.peak_rss_kib ?? null,
        counts: {
          functions: unit.counts?.functions ?? 0,
          lock_operations: unit.counts?.lock_operations ?? 0,
          lock_dependencies: unit.counts?.lock_dependencies ?? 0,
          interrupt_graph_edges: unit.counts?.interrupt_graph_edges ?? 0,
          interrupt_cycles: unit.counts?.interrupt_cycles ?? 0,
          uncertainties: unit.counts?.uncertainties ?? 0,
          diagnostics: unit.counts?.diagnostics ?? 0,
        },
      })),
      interpretation: 'These measurements and saved findings predate the Phase 9 lock extraction fix. The three archived netdev cycles are unresolved self-edges, not confirmed deadlocks. Current post-fix findings have not been recomputed in this checkout.',
      cycle_review: cycleReview,
      precision_recall: measurement.precision_recall ?? null,
    }); return
  }
  if (request.method === 'GET' && pathname === '/api/v1/runtime/runs') {
    json(response, 200, { api_version: apiVersion, runs: [...runtimeRuns].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50).map(runtimeMetadata) }); return
  }
  const runtimeMatch = pathname.match(/^\/api\/v1\/runtime\/runs\/([^/]+)$/)
  if (request.method === 'GET' && runtimeMatch) {
    const run = runtimeRun(decodeURIComponent(runtimeMatch[1]))
    json(response, 200, { api_version: apiVersion, run: runtimeMetadata(run), summary: run.summary ?? null,
      events: await readRuntimeTrace(run), comparison: run.comparison ?? null, benchmark: run.benchmark ?? null }); return
  }
  if (request.method === 'POST' && pathname === '/api/v1/runtime/runs') {
    if (!runtimeFilesAvailable()) throw new HttpError(503, 'Runtime evidence executable is unavailable; configure and build with CMake first')
    if (activeRuntimeRuns.size >= 1) throw new HttpError(429, 'A runtime evidence scenario is already running')
    const body = await readBody(request)
    validateRuntimeInputs(body, new Set(['scenario', 'timeout']))
    const scenarios = new Set(['safe', 'reverse-only', 'opposite-order', 'contention', 'deadlock', 'static-only'])
    if (!scenarios.has(body.scenario)) throw new HttpError(422, 'scenario must be one of the controlled Phase 5 scenarios')
    const timeout = body.timeout === undefined ? 2.5 : Number(body.timeout)
    if (!Number.isFinite(timeout) || timeout < 0.5 || timeout > 10) throw new HttpError(422, 'timeout must be between 0.5 and 10 seconds')
    const id = randomUUID().replaceAll('-', '')
    const row = { id, created_at: new Date().toISOString(), kind: 'scenario', scenario: body.scenario, status: 'running', summary: null, error: null }
    runtimeRuns.unshift(row)
    activeRuntimeRuns.add(id)
    await saveRuntimeHistory()
    json(response, 202, { api_version: apiVersion, run: runtimeMetadata(row) })
    runRuntimeScenario(id, row, body.scenario, timeout).catch(async (error) => {
      Object.assign(row, { status: 'failed', error: `Runtime task failed: ${error.message}` }); await saveRuntimeHistory()
    }).finally(() => activeRuntimeRuns.delete(id))
    return
  }
  if (request.method === 'POST' && pathname === '/api/v1/runtime/benchmarks') {
    if (!runtimeFilesAvailable()) throw new HttpError(503, 'Runtime benchmark executable is unavailable; build it with CMake first')
    if (activeRuntimeRuns.size >= 1) throw new HttpError(429, 'A runtime evidence task is already running')
    const body = await readBody(request)
    validateRuntimeInputs(body, new Set(['iterations', 'repeats']))
    const iterations = body.iterations === undefined ? 1000 : Number(body.iterations)
    const repeats = body.repeats === undefined ? 5 : Number(body.repeats)
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 2000 || !Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new HttpError(422, 'iterations must be 1–2000 and repeats 1–5')
    const id = randomUUID().replaceAll('-', '')
    const row = { id, created_at: new Date().toISOString(), kind: 'benchmark', status: 'running' }
    runtimeRuns.unshift(row); activeRuntimeRuns.add(id); await saveRuntimeHistory()
    json(response, 202, { api_version: apiVersion, run: runtimeMetadata(row) })
    executeRuntime(['python3', runtimeScript, 'benchmark', '--program', runtimeProgram, '--iterations', String(iterations), '--repeats', String(repeats), '--timeout', '30'], repoRoot, 45000).then(async (result) => {
      if (result.error || result.code !== 0) Object.assign(row, { status: 'failed', error: (result.error || result.stderr || `Benchmark exited ${result.code}`).slice(-4000) })
      else { try { Object.assign(row, { status: 'completed', benchmark: JSON.parse(result.stdout) }) } catch { Object.assign(row, { status: 'failed', error: 'Benchmark returned invalid JSON' }) } }
      await saveRuntimeHistory()
    }).catch(async (error) => { Object.assign(row, { status: 'failed', error: error.message }); await saveRuntimeHistory() }).finally(() => activeRuntimeRuns.delete(id))
    return
  }
  if (request.method === 'POST' && pathname === '/api/v1/runtime/compare') {
    if (!runtimeFilesAvailable()) throw new HttpError(503, 'Runtime comparison tool is unavailable')
    const body = await readBody(request)
    validateRuntimeInputs(body, new Set(['analysis_id', 'runtime_run_ids', 'static_to_runtime']))
    if (typeof body.analysis_id !== 'string' || !Array.isArray(body.runtime_run_ids) || !body.runtime_run_ids.length || body.runtime_run_ids.length > 20 || !body.runtime_run_ids.every((id) => typeof id === 'string')) throw new HttpError(422, 'analysis_id and one or more runtime_run_ids are required')
    if (!body.static_to_runtime || typeof body.static_to_runtime !== 'object' || Array.isArray(body.static_to_runtime) || Object.keys(body.static_to_runtime).length > 1000 || !Object.entries(body.static_to_runtime).every(([key, value]) => typeof key === 'string' && typeof value === 'string')) throw new HttpError(422, 'static_to_runtime must map exact static identities to runtime lock IDs')
    const analysis = readRun(body.analysis_id)
    if (!analysis.report_path || analysis.status !== 'completed') throw new HttpError(409, 'Selected static analysis has no completed report')
    const summaries = body.runtime_run_ids.map((id) => {
      const run = runtimeRun(id)
      if (run.kind !== 'scenario' || run.status !== 'completed' || !run.summary) throw new HttpError(409, `Runtime run ${id} has no completed scenario summary`)
      return run
    })
    const id = randomUUID().replaceAll('-', '')
    const lockMapPath = path.join(runtimeDir, `${id}.map.json`)
    const outputPath = path.join(runtimeDir, `${id}.comparison.json`)
    await writeFile(lockMapPath, `${JSON.stringify({ static_to_runtime: body.static_to_runtime })}\n`, { mode: 0o600 })
    const result = await executeRuntime(['python3', runtimeScript, 'compare', '--static-report', analysis.report_path, '--lock-map', lockMapPath,
      ...summaries.flatMap((run) => ['--summary', path.join(runtimeDir, `${run.id}.summary.json`)]), '--output', outputPath], repoRoot)
    await unlink(lockMapPath).catch(() => undefined)
    if (result.error || result.code !== 0) throw new HttpError(500, (result.stderr || result.error || 'Runtime comparison failed').slice(-4000))
    const comparison = JSON.parse(await readFile(outputPath, 'utf8'))
    const row = { id, created_at: new Date().toISOString(), kind: 'comparison', status: 'completed', comparison,
      analysis_id: analysis.id, runtime_run_ids: body.runtime_run_ids }
    runtimeRuns.unshift(row); await saveRuntimeHistory()
    json(response, 201, { api_version: apiVersion, run: runtimeMetadata(row), comparison }); return
  }
  if (request.method === 'GET' && pathname === '/api/v1/analyses') {
    const limit = Number(url.searchParams.get('limit') || '50')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(422, 'limit must be between 1 and 100')
    const rows = [...analyses].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit)
    json(response, 200, { api_version: apiVersion, analyses: rows.map(metadata) }); return
  }
  if (request.method === 'POST' && pathname === '/api/v1/analyses') {
    let available = false
    try { accessSync(analyzerPath, constants.X_OK); available = true } catch { /* Validated below. */ }
    if (!available) throw new HttpError(503, 'Analyzer executable is unavailable; build it with CMake first')
    if (activeRuns.size >= 2) throw new HttpError(429, 'Two analyses are already running; retry when one finishes')
    const body = await readBody(request)
    const { source, compilation, apiConfig } = await validateRequest(body)
    const id = randomUUID().replaceAll('-', '')
    const createdAt = new Date().toISOString()
    const config = { source_path: source, compile_commands_path: compilation, api_config_path: apiConfig, format: 'json' }
    analyses.push({
      id, created_at: createdAt, status: 'queued', source_path: source,
      compile_commands_path: compilation, api_config_path: apiConfig,
      config_json: JSON.stringify(config), return_code: null, duration_ms: null,
      report_path: null, report_json: null, error: null,
    })
    activeRuns.add(id)
    try { await saveHistory() }
    catch (error) {
      activeRuns.delete(id)
      analyses = analyses.filter((item) => item.id !== id)
      throw error
    }
    json(response, 202, { api_version: apiVersion, id, status: 'queued', created_at: createdAt })
    runAnalysis(id, source, compilation, apiConfig).catch((error) => {
      updateRun(id, { status: 'failed', error: `Backend analysis task failed: ${error.message}` })
    }).finally(() => activeRuns.delete(id))
    return
  }
  const match = pathname.match(/^\/api\/v1\/analyses\/([^/]+)(?:\/(report|findings|graph|source))?$/)
  if (request.method === 'GET' && match) {
    const id = decodeURIComponent(match[1])
    const action = match[2]
    if (!action) { json(response, 200, { api_version: apiVersion, analysis: metadata(readRun(id)) }); return }
    if (action === 'report') { json(response, 200, reportForRun(id)); return }
    if (action === 'findings') {
      const report = reportForRun(id)
      const cycles = Array.isArray(report.interrupt_cycles) ? report.interrupt_cycles : []
      json(response, 200, { api_version: apiVersion, analysis_id: id, schema_version: report.schema_version, findings: cycles.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map((item, index) => ({ ...item, finding_id: `${id.slice(0, 8)}-${String(index + 1).padStart(3, '0')}` })) }); return
    }
    if (action === 'graph') {
      const report = reportForRun(id)
      const graph = report.interrupt_lock_graph
      if (!graph || typeof graph !== 'object' || Array.isArray(graph)) throw new HttpError(422, 'Analyzer report has no lock graph')
      json(response, 200, { api_version: apiVersion, analysis_id: id, schema_version: report.schema_version, nodes: graph.nodes || [], edges: graph.edges || [] }); return
    }
    json(response, 200, await sourceSnippet(id, url)); return
  }
  throw new HttpError(404, 'Not found')
}

const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    if (response.headersSent) { response.destroy(); return }
    const status = error instanceof HttpError ? error.status : 500
    json(response, status, { detail: error instanceof HttpError ? error.message : 'Internal server error' })
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`IRQGuard Node API listening at http://127.0.0.1:${port}`)
  console.log(`Allowed workspaces: ${workspaceRoots.length ? workspaceRoots.join(path.delimiter) : '(none; set IRQGUARD_WORKSPACES)'}`)
  console.log(`Analyzer: ${analyzerPath}`)
})

function shutdown() {
  server.close(() => { saveHistory().finally(() => process.exit(0)) })
  setTimeout(() => process.exit(1), 5000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
