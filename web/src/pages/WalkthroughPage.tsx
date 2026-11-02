import { useState, useEffect, useMemo } from 'react'
import {
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  Handle,
} from '@xyflow/react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Code2,
  GitBranch,
  Info,
  LockKeyhole,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react'
import { DEMO_INTERRUPTS_REPORT } from '../demo/demoData'

function WalkthroughLockNode({ data }: { data: { label: string; active?: boolean; status?: string } }) {
  return (
    <div
      className={`lock-flow-node lock-kind-spin ${data.active ? 'node-selected' : ''}`}
      style={{
        padding: '10px 14px',
        borderRadius: '6px',
        border: data.active ? '2px solid var(--red, #ff5b56)' : '1px solid var(--line, #384454)',
        background: 'var(--surface-raised, #18202c)',
      }}
    >
      <Handle type="target" position={Position.Left} />
      <span className="lock-node-icon" style={{ color: 'var(--amber, #f59e0b)' }}>
        <LockKeyhole size={14} />
      </span>
      <span className="lock-node-copy">
        <strong style={{ fontSize: '13px', color: 'var(--text, #f4f6f8)' }}>{data.label}</strong>
        <small style={{ fontSize: '10px', color: 'var(--text-dim, #8994a3)' }}>spinlock_t</small>
      </span>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const walkthroughNodeTypes = { lock: WalkthroughLockNode }

interface StepConfig {
  title: string
  subtitle: string
  explanation: string
  codeSnippet: {
    fnName: string
    startLine: number
    highlightLines: number[]
    lines: Array<{ num: number; text: string }>
  }
}

export function WalkthroughPage() {
  const [step, setStep] = useState<number>(1)
  const [protectedMode, setProtectedMode] = useState<boolean>(false)

  // Keyboard navigation: left/right arrows
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        setStep((s) => Math.min(4, s + 1))
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        setStep((s) => Math.max(1, s - 1))
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Find ground truth data from DEMO_INTERRUPTS_REPORT
  const unprotectedCycle = useMemo(() => {
    return DEMO_INTERRUPTS_REPORT.interrupt_cycles.find((c) =>
      c.category === 'interrupt_aware_candidate' &&
      c.lock_sequence?.some((l) => l.includes('cross_a'))
    )
  }, [])

  const rejectedCycle = useMemo(() => {
    return DEMO_INTERRUPTS_REPORT.interrupt_cycles.find((c) =>
      c.category === 'rejected_candidate' &&
      c.lock_sequence?.some((l) => l.includes('blocked_a'))
    )
  }, [])

  const activeLockA = protectedMode ? 'blocked_a' : 'cross_a'
  const activeLockB = protectedMode ? 'blocked_b' : 'cross_b'

  // Step definitions
  const steps: Record<number, StepConfig> = useMemo(() => {
    if (!protectedMode) {
      return {
        1: {
          title: '1. Process context acquires cross_a then cross_b',
          subtitle: 'Normal kernel thread execution path',
          explanation: `In \`process_cross_context()\`, a kernel thread running in process context acquires \`cross_a\`, then calls \`acquire_cross_b()\` to acquire \`cross_b\`. The analyzer records a direct process-to-process lock dependency edge: \`cross_a → cross_b\`. Notice that local interrupts remain ENABLED.`,
          codeSnippet: {
            fnName: 'process_cross_context',
            startLine: 90,
            highlightLines: [91, 92],
            lines: [
              { num: 90, text: 'void process_cross_context(void) {' },
              { num: 91, text: '    spin_lock(&cross_a);' },
              { num: 92, text: '    acquire_cross_b();' },
              { num: 93, text: '    spin_unlock(&cross_b);' },
              { num: 94, text: '    spin_unlock(&cross_a);' },
              { num: 95, text: '}' },
            ],
          },
        },
        2: {
          title: '2. request_irq registers cross_handler',
          subtitle: 'Hardware interrupt registration',
          explanation: `The driver calls \`request_irq(1, cross_handler, ...)\` during device initialization. The analyzer detects this registration and models \`cross_handler\` as running in hardware interrupt context (\`hardirq\`). Because interrupts are enabled in process context, this handler can preempt process-level code on the same CPU at any instruction.`,
          codeSnippet: {
            fnName: 'register_handlers',
            startLine: 73,
            highlightLines: [75],
            lines: [
              { num: 73, text: 'void register_handlers(void) {' },
              { num: 74, text: '    irq_handler_t selected = second_handler;' },
              { num: 75, text: '    request_irq(1, cross_handler, 0, "cross", 0);' },
              { num: 76, text: '    request_irq(2, second_handler, 0, "second", 0);' },
              { num: 77, text: '    request_irq(3, blocked_handler, 0, "blocked", 0);' },
              { num: 80, text: '}' },
            ],
          },
        },
        3: {
          title: '3. Interrupt handler acquires cross_b then cross_a',
          subtitle: 'Reverse lock acquisition in hardirq context',
          explanation: `When the hardware interrupt fires, \`cross_handler()\` runs. It acquires \`cross_b\`, then \`cross_a\`. This generates a hardirq-to-hardirq lock order edge: \`cross_b → cross_a\`. Notice that this is the exact REVERSE order of the process context path.`,
          codeSnippet: {
            fnName: 'cross_handler',
            startLine: 45,
            highlightLines: [48, 49],
            lines: [
              { num: 45, text: 'static void cross_handler(int irq, void *device) {' },
              { num: 46, text: '    (void)irq;' },
              { num: 47, text: '    (void)device;' },
              { num: 48, text: '    spin_lock(&cross_b);' },
              { num: 49, text: '    spin_lock(&cross_a);' },
              { num: 50, text: '}' },
            ],
          },
        },
        4: {
          title: '4. Cycle closes: interrupt_aware_candidate',
          subtitle: 'Cross-context deadlock candidate detected',
          explanation: `The analyzer combines the process edge \`cross_a → cross_b\` and the preemption into \`cross_handler\` (\`cross_b → cross_a\`). If the thread holds \`cross_a\` when the interrupt arrives on the same CPU, the handler will spin forever waiting for \`cross_a\`, which the preempted thread cannot release! IRQGuard reports category: interrupt_aware_candidate (candidate under process/hardirq model; NOT a confirmed runtime deadlock).`,
          codeSnippet: {
            fnName: 'cross_context_cycle',
            startLine: 90,
            highlightLines: [91, 48, 49],
            lines: [
              { num: 91, text: '// [Process Thread] acquires &cross_a (IRQs enabled!)' },
              { num: 92, text: '// ---> Hardware interrupt fires on same CPU!' },
              { num: 48, text: '// [cross_handler] acquires &cross_b' },
              { num: 49, text: '// [cross_handler] waits on &cross_a (DEADLOCK!)' },
            ],
          },
        },
      }
    } else {
      return {
        1: {
          title: '1. Process disables IRQs before acquiring blocked_a',
          subtitle: 'Protected with local_irq_disable() or spin_lock_irqsave()',
          explanation: `In \`process_with_irqs_disabled()\`, the thread executes \`irq_off_wrapper()\` (which calls \`local_irq_disable()\`) BEFORE acquiring \`blocked_a\`. Then it acquires \`blocked_b\`. The analyzer records that at the acquisition of \`blocked_a\`, the CPU interrupt flag is definitely DISABLED.`,
          codeSnippet: {
            fnName: 'process_with_irqs_disabled',
            startLine: 109,
            highlightLines: [110, 111, 112],
            lines: [
              { num: 109, text: 'void process_with_irqs_disabled(void) {' },
              { num: 110, text: '    irq_off_wrapper(); // local_irq_disable()' },
              { num: 111, text: '    spin_lock(&blocked_a);' },
              { num: 112, text: '    spin_lock(&blocked_b);' },
              { num: 113, text: '    spin_unlock(&blocked_b);' },
              { num: 114, text: '    spin_unlock(&blocked_a);' },
              { num: 115, text: '    local_irq_enable();' },
              { num: 116, text: '}' },
            ],
          },
        },
        2: {
          title: '2. request_irq registers blocked_handler',
          subtitle: 'Handler registered on IRQ 3',
          explanation: `The driver registers \`blocked_handler\` via \`request_irq(3, blocked_handler, ...)\`. The handler acquires \`blocked_b\`, then \`blocked_a\`.`,
          codeSnippet: {
            fnName: 'register_handlers',
            startLine: 73,
            highlightLines: [77],
            lines: [
              { num: 73, text: 'void register_handlers(void) {' },
              { num: 75, text: '    request_irq(1, cross_handler, 0, "cross", 0);' },
              { num: 77, text: '    request_irq(3, blocked_handler, 0, "blocked", 0);' },
              { num: 80, text: '}' },
            ],
          },
        },
        3: {
          title: '3. Handler would acquire in opposite order',
          subtitle: 'blocked_b then blocked_a in hardirq',
          explanation: `Inside \`blocked_handler()\`, the lock order is \`blocked_b → blocked_a\`. Syntactically, this matches the reverse-order pattern of a deadlock.`,
          codeSnippet: {
            fnName: 'blocked_handler',
            startLine: 59,
            highlightLines: [62, 63],
            lines: [
              { num: 59, text: 'static void blocked_handler(int irq, void *device) {' },
              { num: 62, text: '    spin_lock(&blocked_b);' },
              { num: 63, text: '    spin_lock(&blocked_a);' },
              { num: 64, text: '}' },
            ],
          },
        },
        4: {
          title: '4. Feasibility check: rejected_candidate',
          subtitle: 'Preemption edge is rejected because IRQs were disabled',
          explanation: `The analyzer performs same-CPU preemption feasibility refinement. Because IRQs were verified to be disabled when \`blocked_a\` was taken, the hardware interrupt CANNOT execute on this CPU while \`blocked_a\` is held! The hypothetical preemption edge is marked 'rejected' with reason: "${rejectedCycle?.edges?.[0]?.feasibility_reason || 'local hard IRQs are definitely disabled at the process acquisition'}". IRQGuard reports: rejected_candidate (infeasible shape).`,
          codeSnippet: {
            fnName: 'feasibility_refinement',
            startLine: 110,
            highlightLines: [110, 111],
            lines: [
              { num: 110, text: '// [Process Thread] IRQs disabled by local_irq_disable()' },
              { num: 111, text: '// [Process Thread] holds &blocked_a' },
              { num: 112, text: '// ---> Hardware interrupt CANNOT preempt this CPU!' },
              { num: 113, text: '// Preemption edge is mathematically impossible in model' },
              { num: 114, text: '// Finding category: rejected_candidate (safe)' },
            ],
          },
        },
      }
    }
  }, [protectedMode, rejectedCycle])

  const currentStep = steps[step]

  // Flow graph nodes
  const nodes: Node[] = useMemo(() => {
    return [
      {
        id: activeLockA,
        type: 'lock',
        position: { x: 50, y: 110 },
        data: { label: activeLockA, active: step >= 1 },
      },
      {
        id: activeLockB,
        type: 'lock',
        position: { x: 310, y: 110 },
        data: { label: activeLockB, active: step >= 3 },
      },
    ]
  }, [activeLockA, activeLockB, step])

  // Flow graph edges
  const edges: Edge[] = useMemo(() => {
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const edgeList: Edge[] = []

    if (step >= 1) {
      // Process order edge A -> B
      edgeList.push({
        id: 'edge-process-order',
        source: activeLockA,
        target: activeLockB,
        type: 'smoothstep',
        animated: !prefersReducedMotion && step === 1,
        label: protectedMode ? 'process (irq disabled)' : 'process → process',
        labelStyle: { fill: '#8994a3', fontSize: 11 },
        labelBgStyle: { fill: '#11161d' },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#5b9ff4' },
        style: { stroke: '#5b9ff4', strokeWidth: 2 },
      })
    }

    if (step >= 3) {
      // Handler order edge B -> A
      edgeList.push({
        id: 'edge-handler-order',
        source: activeLockB,
        target: activeLockA,
        type: 'smoothstep',
        animated: !prefersReducedMotion && step === 3,
        label: 'hardirq → hardirq',
        labelStyle: { fill: '#43c8df', fontSize: 11 },
        labelBgStyle: { fill: '#11161d' },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#43c8df' },
        style: { stroke: '#43c8df', strokeWidth: 2 },
      })
    }

    if (step >= 4) {
      if (!protectedMode) {
        // Highlighting active cycle in red
        edgeList.forEach((e) => {
          e.style = { stroke: '#ff5b56', strokeWidth: 3 }
          e.animated = true
          e.markerEnd = { type: MarkerType.ArrowClosed, color: '#ff5b56' }
        })
      } else {
        // In protected mode, the preemption edge is rejected (dashed grey)
        edgeList.push({
          id: 'edge-rejected-preemption',
          source: activeLockA,
          target: activeLockB,
          type: 'smoothstep',
          label: 'preemption rejected (irq off)',
          labelStyle: { fill: '#758091', fontSize: 11 },
          labelBgStyle: { fill: '#11161d' },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#758091' },
          style: { stroke: '#758091', strokeWidth: 2, strokeDasharray: '6 5' },
        })
      }
    }

    return edgeList
  }, [activeLockA, activeLockB, protectedMode, step])

  return (
    <div className="walkthrough-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">INTERACTIVE WALKTHROUGH</div>
          <h1>How an interrupt boundary creates a deadlock candidate</h1>
          <p className="page-caption">
            Step through the real C source from <code>tests/fixtures/interrupts.c</code> and see how IRQGuard builds context-labelled edges and detects or rejects cycles.
          </p>
        </div>

        {/* Protection toggle */}
        <div className="walkthrough-controls-banner">
          <label className="toggle-label" htmlFor="protection-toggle">
            <input
              id="protection-toggle"
              type="checkbox"
              checked={protectedMode}
              onChange={(e) => {
                setProtectedMode(e.target.checked)
                setStep(1)
              }}
            />
            <span className="toggle-switch" />
            <span className="toggle-text">
              {protectedMode ? (
                <strong className="text-good flex items-center gap-1">
                  <ShieldCheck size={14} /> Protected: local_irq_disable()
                </strong>
              ) : (
                <span className="text-warn flex items-center gap-1">
                  <AlertTriangle size={14} /> Unprotected: IRQs enabled in process
                </span>
              )}
            </span>
          </label>
        </div>
      </header>

      {/* Step navigation bar */}
      <div className="walkthrough-stepper" aria-label="Walkthrough step navigation">
        <div className="stepper-pills">
          {[1, 2, 3, 4].map((s) => (
            <button
              key={s}
              type="button"
              className={`stepper-pill ${step === s ? 'active' : ''} ${step > s ? 'completed' : ''}`}
              onClick={() => setStep(s)}
            >
              <span className="pill-number">{s}</span>
              <span className="pill-title">
                {s === 1 ? 'Process order' : s === 2 ? 'Registration' : s === 3 ? 'Handler order' : 'Cycle evaluation'}
              </span>
            </button>
          ))}
        </div>

        <div className="stepper-buttons">
          <button
            type="button"
            className="secondary-button"
            disabled={step === 1}
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            aria-label="Previous step"
          >
            <ArrowLeft size={14} /> Prev
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={step === 4}
            onClick={() => setStep((s) => Math.min(4, s + 1))}
            aria-label="Next step"
          >
            Next <ArrowRight size={14} />
          </button>
        </div>
      </div>

      {/* Main Split Layout: Left Source Code, Right Dynamic Graph */}
      <div className="walkthrough-split">
        {/* Left Side: Real Source Code */}
        <div className="walkthrough-code-pane">
          <div className="pane-header">
            <span className="flex items-center gap-2">
              <Code2 size={15} />
              <strong>tests/fixtures/interrupts.c</strong>
            </span>
            <span className="text-dim text-xs">Line {currentStep.codeSnippet.startLine}</span>
          </div>

          <div className="source-code-block" tabIndex={0} aria-label="C source code viewer">
            <pre>
              <code>
                {currentStep.codeSnippet.lines.map((l) => {
                  const isHighlighted = currentStep.codeSnippet.highlightLines.includes(l.num)
                  return (
                    <div
                      key={l.num}
                      className={`source-line ${isHighlighted ? 'line-highlighted' : ''}`}
                    >
                      <span className="line-num">{l.num}</span>
                      <span className="line-text">{l.text}</span>
                    </div>
                  )
                })}
              </code>
            </pre>
          </div>

          <div className="walkthrough-explanation-card">
            <h3>{currentStep.title}</h3>
            <p className="explanation-subtitle">{currentStep.subtitle}</p>
            <p className="explanation-body">{currentStep.explanation}</p>
          </div>
        </div>

        {/* Right Side: Graph view building up */}
        <div className="walkthrough-graph-pane">
          <div className="pane-header">
            <span className="flex items-center gap-2">
              <GitBranch size={15} />
              <strong>Context-labelled Lock Graph</strong>
            </span>
            <span className="text-dim text-xs">Step {step} of 4</span>
          </div>

          <div className="walkthrough-canvas-wrap">
            <ReactFlowProvider>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={walkthroughNodeTypes}
                fitView
                fitViewOptions={{ padding: 0.35 }}
                proOptions={{ hideAttribution: true }}
                aria-label="Interactive walkthrough lock graph"
              >
                <Background color="#2d3540" gap={20} size={1} />
                <Controls showInteractive={false} />
              </ReactFlow>
            </ReactFlowProvider>
          </div>

          {/* Finding outcome card on Step 4 */}
          {step === 4 && (
            <div
              className={`walkthrough-outcome-card ${protectedMode ? 'outcome-rejected' : 'outcome-candidate'}`}
            >
              <div className="outcome-icon">
                {protectedMode ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}
              </div>
              <div className="outcome-copy">
                <div className="eyebrow">
                  {protectedMode ? 'FEASIBILITY REFINEMENT: REJECTED' : 'ANALYZER FINDING'}
                </div>
                <strong>
                  {protectedMode ? 'rejected_candidate (Infeasible in model)' : 'interrupt_aware_candidate'}
                </strong>
                <p>
                  {protectedMode
                    ? `Because local IRQs were verified as disabled at the acquisition of ${activeLockA}, same-CPU hardirq preemption cannot occur. The counterfactual cycle is formally rejected.`
                    : `Process context holds ${activeLockA} while interrupts are enabled. Preemption on the same CPU creates an unresolvable cyclic wait. Note: this is a static candidate under the process/hardirq model, NOT a confirmed runtime deadlock.`}
                </p>
                <div className="grounding-note">
                  <Info size={13} />
                  <span>
                    Report source:{' '}
                    <code>
                      {protectedMode
                        ? `interrupt_cycles[4] (${rejectedCycle?.category})`
                        : `interrupt_cycles[2] (${unprotectedCycle?.category})`}
                    </code>
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
