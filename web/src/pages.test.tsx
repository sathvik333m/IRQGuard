import { describe, expect, it, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WalkthroughPage } from './pages/WalkthroughPage'
import { ScopeLimitsPage } from './pages/ScopeLimitsPage'
import { RunItYourselfPage } from './pages/RunItYourselfPage'
import { KernelEvaluationPage } from './pages/KernelEvaluationPage'
import { DemoBadge } from './components/DemoBadge'
import { DEMO_KERNEL_EVALUATION } from './demo/demoData'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('WalkthroughPage', () => {
  it('renders step 1 with process context edge by default', () => {
    render(<WalkthroughPage />)
    expect(screen.getByRole('heading', { name: /How an interrupt boundary creates a deadlock candidate/i })).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
    expect(screen.getByText(/Process context acquires cross_a then cross_b/)).toBeInTheDocument()
    expect(screen.getAllByText(/cross_a/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/cross_b/).length).toBeGreaterThan(0)
  })

  it('navigates through steps 1 to 4 with next and previous buttons', () => {
    render(<WalkthroughPage />)
    const nextBtn = screen.getByRole('button', { name: /Next step/i })
    const prevBtn = screen.getByRole('button', { name: /Previous step/i })

    expect(prevBtn).toBeDisabled()

    // Step 2
    fireEvent.click(nextBtn)
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument()
    expect(screen.getByText(/request_irq registers cross_handler/)).toBeInTheDocument()

    // Step 3
    fireEvent.click(nextBtn)
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument()
    expect(screen.getByText(/Interrupt handler acquires cross_b then cross_a/)).toBeInTheDocument()

    // Step 4
    fireEvent.click(nextBtn)
    expect(screen.getByText('Step 4 of 4')).toBeInTheDocument()
    expect(screen.getByText(/Cycle closes: interrupt_aware_candidate/)).toBeInTheDocument()
    expect(screen.getAllByText(/interrupt_aware_candidate/).length).toBeGreaterThan(0)
    expect(nextBtn).toBeDisabled()

    // Step 4 shows honest framing: not confirmed deadlock
    expect(screen.getAllByText(/NOT a confirmed runtime deadlock/i).length).toBeGreaterThan(0)

    // Back to Step 3
    fireEvent.click(prevBtn)
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument()
  })

  it('toggles protection with irqsave/local_irq_disable showing rejected candidate', () => {
    render(<WalkthroughPage />)
    const toggle = screen.getByRole('checkbox', { name: /Unprotected: IRQs enabled in process/i })
    expect(toggle).not.toBeChecked()

    fireEvent.click(toggle)
    expect(toggle).toBeChecked()

    // Advances or switches to blocked_a / blocked_b
    expect(screen.getAllByText(/blocked_a/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/blocked_b/).length).toBeGreaterThan(0)

    // Advance to step 4 in protected mode
    const nextBtn = screen.getByRole('button', { name: /Next step/i })
    fireEvent.click(nextBtn)
    fireEvent.click(nextBtn)
    fireEvent.click(nextBtn)

    expect(screen.getAllByText(/rejected_candidate/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Preemption edge is rejected because IRQs were disabled/)).toBeInTheDocument()
  })

  it('supports keyboard ArrowRight and ArrowLeft navigation', () => {
    render(<WalkthroughPage />)
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
  })
})

describe('ScopeLimitsPage', () => {
  it('renders modeled scope matrix and tool comparisons', () => {
    render(<ScopeLimitsPage />)
    expect(screen.getByRole('heading', { name: 'Scope, Assumptions & Limits' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Modeled Scope Matrix' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Comparison with Established Linux Tools' })).toBeInTheDocument()

    // Honest framing
    expect(screen.getByText(/not confirmed runtime deadlocks/)).toBeInTheDocument()
    expect(screen.getByText(/not proof of deadlock freedom/)).toBeInTheDocument()

    // Supported & unsupported features
    expect(screen.getByText(/Hardware Interrupts \(hardirq\)/)).toBeInTheDocument()
    expect(screen.getByText(/Soft IRQ \/ Bottom Halves/)).toBeInTheDocument()
    expect(screen.getByText(/Non-Maskable Interrupts \(NMI\)/)).toBeInTheDocument()
    expect(screen.getByText(/Whole-Kernel Call Graph/)).toBeInTheDocument()
    expect(screen.getByText(/General Pointer Aliasing/)).toBeInTheDocument()

    // Comparison tools
    expect(screen.getByText(/Linux lockdep/)).toBeInTheDocument()
    expect(screen.getByText('locktorture')).toBeInTheDocument()
    expect(screen.getByText('KCSAN')).toBeInTheDocument()
    expect(screen.getByText('Archerfish')).toBeInTheDocument()
  })
})

describe('RunItYourselfPage', () => {
  it('renders prerequisites and copy-paste commands with honest requirements', () => {
    render(<RunItYourselfPage />)
    expect(screen.getByRole('heading', { name: 'Run IRQGuard Locally' })).toBeInTheDocument()
    expect(screen.getByText('Prerequisites & Build Environment')).toBeInTheDocument()
    expect(screen.getByText(/Clang 20 \+ LLVM 20 Dev Libraries/)).toBeInTheDocument()
    expect(screen.getByText(/Node\.js 20\+/)).toBeInTheDocument()
    expect(screen.getAllByText(/\.\/irqguard analyze --source examples\/basic\.c/).length).toBeGreaterThan(0)
  })
})

describe('KernelEvaluationPage', () => {
  it('shows acquire and release totals from saved kernel operation records', () => {
    render(<KernelEvaluationPage evaluation={DEMO_KERNEL_EVALUATION} />)
    expect(screen.getByText('6 acquires · 6 releases')).toBeInTheDocument()
    expect(screen.queryByText('10 acquires · 2 releases')).not.toBeInTheDocument()
  })

  it('shows current root-cause measurements and remaining unresolved calls', () => {
    render(<KernelEvaluationPage evaluation={DEMO_KERNEL_EVALUATION} />)
    expect(screen.getByRole('heading', { name: 'Why the analyzer remains uncertain' })).toBeInTheDocument()
    expect(screen.getByText(/2,213 IRQ-state records are linked to unresolved-call root causes/)).toBeInTheDocument()
    expect(screen.getByText(/__const_udelay/)).toBeInTheDocument()
    expect(screen.getAllByText(/Zero cycles do not prove deadlock freedom/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Historical Runs|Archived baseline|Phase [0-9]/i)).not.toBeInTheDocument()
  })
})

describe('DemoBadge', () => {
  it('renders demo data indicator and allows switching demo examples', () => {
    const handleSelect = vi.fn()
    render(<DemoBadge activeExampleId="demo-interrupts" onSelectExample={handleSelect} />)

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByText('Demo data')).toBeInTheDocument()
    expect(screen.getByText(/Bundled example from repo — not a live analysis/)).toBeInTheDocument()

    const select = screen.getByRole('combobox', { name: 'Select demo example' })
    expect(select).toHaveValue('demo-interrupts')

    fireEvent.change(select, { target: { value: 'demo-basic' } })
    expect(handleSelect).toHaveBeenCalledWith('demo-basic')
  })
})
