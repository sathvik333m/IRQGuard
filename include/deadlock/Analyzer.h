#pragma once

#include "deadlock/ApiRegistry.h"
#include "deadlock/Model.h"

#include <string>
#include <vector>

namespace deadlock {

struct AnalyzeOptions {
    std::string source;
    std::string compilationDatabase;
    std::vector<std::string> clangArguments;
};

// Returns a Clang tooling status. Any compiler error makes the status nonzero.
int analyzeSource(const AnalyzeOptions &options, const ApiRegistry &registry,
                  AnalysisResult &result, std::string &error);

} // namespace deadlock
