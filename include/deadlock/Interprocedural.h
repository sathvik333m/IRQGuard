#pragma once

#include "deadlock/Model.h"

namespace deadlock {

// Builds the graph and computes bounded, context-insensitive function summaries.
void analyzeInterprocedural(AnalysisResult &result);

} // namespace deadlock
