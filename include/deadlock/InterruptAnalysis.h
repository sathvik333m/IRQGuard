#pragma once

#include "deadlock/Model.h"

namespace deadlock {

// Adds scoped hardirq registration, IRQ-state snapshots, context-labelled
// dependencies, and bounded cycle candidates over Phase 2 summaries.
void analyzeInterrupts(AnalysisResult &result);

} // namespace deadlock
