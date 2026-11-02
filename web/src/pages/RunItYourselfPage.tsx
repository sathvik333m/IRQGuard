import { useState } from 'react'
import { Check, Copy, Laptop } from 'lucide-react'

function CodeSnippetCard({
  title,
  command,
  description,
}: {
  title: string
  command: string
  description?: string
}) {
  const [copied, setCopied] = useState(false)

  const copyToClipboard = () => {
    void navigator.clipboard.writeText(command)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="command-card">
      <div className="command-card-header">
        <div>
          <strong>{title}</strong>
          {description && <p className="command-desc">{description}</p>}
        </div>
        <button
          type="button"
          className="copy-btn"
          onClick={copyToClipboard}
          aria-label={`Copy command for ${title}`}
        >
          {copied ? (
            <span className="flex items-center gap-1 text-good">
              <Check size={13} /> Copied
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <Copy size={13} /> Copy
            </span>
          )}
        </button>
      </div>
      <pre className="command-code-wrap">
        <code>{command}</code>
      </pre>
    </div>
  )
}

export function RunItYourselfPage() {
  return (
    <div className="run-yourself-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">QUICKSTART & CLI</div>
          <h1>Run IRQGuard Locally</h1>
          <p className="page-caption">
            Build the C++ Clang LibTooling analyzer, run single-file analyses from your terminal, and launch the local exploration interface.
          </p>
        </div>
      </header>

      {/* Honest Prerequisites */}
      <section className="prereqs-box">
        <div className="prereqs-header">
          <Laptop size={18} className="text-accent" />
          <strong>Prerequisites & Build Environment</strong>
        </div>
        <div className="prereqs-grid">
          <div>
            <span className="prereq-label">Operating System</span>
            <strong>Ubuntu 24.04 LTS or WSL 2 on Windows</strong>
            <small>Other modern x86_64 Linux distributions with LLVM 20</small>
          </div>
          <div>
            <span className="prereq-label">Compiler & LLVM</span>
            <strong>Clang 20 + LLVM 20 Dev Libraries</strong>
            <small><code>llvm-20-dev</code>, <code>libclang-20-dev</code>, <code>clang-20</code></small>
          </div>
          <div>
            <span className="prereq-label">Build Toolchain</span>
            <strong>CMake 3.20+ & Ninja</strong>
            <small><code>build-essential</code>, <code>cmake</code>, <code>ninja-build</code></small>
          </div>
          <div>
            <span className="prereq-label">Runtime & GUI</span>
            <strong>Python 3.10+ & Node.js 20+</strong>
            <small>Node.js backend uses built-in modules only</small>
          </div>
        </div>
      </section>

      {/* Step by step commands */}
      <div className="steps-container">
        <h2>Step-by-Step Instructions</h2>

        <CodeSnippetCard
          title="1. Install Ubuntu 24.04 packages"
          description="Install the C++ toolchain, matching Clang 20 development libraries, Python, and Node.js."
          command={`sudo apt update && sudo apt install -y \\
  build-essential cmake ninja-build clang-20 llvm-20-dev libclang-20-dev \\
  zlib1g-dev libzstd-dev libedit-dev libcurl4-openssl-dev \\
  python3 python3-pip nodejs npm`}
        />

        <CodeSnippetCard
          title="2. Configure and build the C++ analyzer"
          description="Point CMake at LLVM 20's CMake package files to build the deadlock-analyzer binary."
          command={`cmake -S . -B build -G Ninja \\
  -DLLVM_DIR=/usr/lib/llvm-20/lib/cmake/llvm \\
  -DClang_DIR=/usr/lib/llvm-20/lib/cmake/clang
cmake --build build
ctest --test-dir build --output-on-failure`}
        />

        <CodeSnippetCard
          title="3. Run your first analysis (CLI)"
          description="Run the Python wrapper on the included basic mutex example."
          command={`./irqguard analyze --source examples/basic.c`}
        />

        <CodeSnippetCard
          title="4. Export a Graphviz dependency graph"
          description="Analyze the interrupt fixture and generate a DOT graph with process and preemption edges."
          command={`./irqguard graph --source tests/fixtures/interrupts.c --output /tmp/interrupts.dot
# Render with graphviz if installed:
# dot -Tsvg /tmp/interrupts.dot -o /tmp/interrupts.svg`}
        />

        <CodeSnippetCard
          title="5. Launch the local GUI"
          description="Start the Node.js API server and the Vite dev server for browser-based interactive exploration."
          command={`# Terminal 1: Node.js API backend (port 8000)
export IRQGUARD_ANALYZER="$PWD/build/deadlock-analyzer"
export IRQGUARD_WORKSPACES="$PWD"
export IRQGUARD_DATA_DIR="$HOME/.local/share/irqguard"
cd backend && npm start

# Terminal 2: Vite web interface (port 5173)
cd web && npm run dev`}
        />
      </div>

      {/* Realistic Sample Output */}
      <section className="sample-output-section">
        <h3>Sample Terminal Output</h3>
        <p className="text-dim text-xs">
          Actual output emitted by <code>./irqguard analyze --source examples/basic.c</code>:
        </p>
        <pre className="terminal-output-block">
          <code>{`Source: examples/basic.c
Functions (2):
  update_state at /home/sathvik/os_project/examples/basic.c:8:13 [update_state@...]
  worker at /home/sathvik/os_project/examples/basic.c:13:6 [worker@...]
Calls (5):
  update_state -> mutex_lock [modeled_api] at line 9
  update_state -> mutex_unlock [modeled_api] at line 10
  worker -> mutex_lock [modeled_api] at line 15
  worker -> update_state [direct] at line 16
  worker -> mutex_unlock [modeled_api] at line 17
Lock dependencies (1):
  @param[0] -> @param[1] [inferred_through_call, possible] reported in worker
Interrupt cycle candidates (0):
Cycle reports are static candidates under the process/hardirq model; they are not confirmed deadlocks.`}</code>
        </pre>
      </section>
    </div>
  )
}
