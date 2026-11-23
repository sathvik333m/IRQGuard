#pragma once

#include "deadlock/Model.h"

#include <string>

namespace deadlock {
std::string toJson(const AnalysisResult &result);
std::string toText(const AnalysisResult &result, bool verbose = false);
std::string toDot(const AnalysisResult &result);
}
