#pragma once

#include <string>

namespace deadlock {

// Exact compiler intrinsics and Linux helpers reviewed for the selected
// Linux v6.6.87 source whose semantics cannot acquire/release a lock or change
// local interrupt state. The Linux entries are exact APIs, not a rule for
// arbitrary wrappers. Ordinary external functions, device accessors, and
// helpers with callbacks remain unknown unless a body or explicit model is
// available.
inline bool hasKnownNoLockOrIRQEffects(const std::string &callee) {
    return callee == "__builtin_constant_p" || callee == "__builtin_ffsll" ||
           callee == "__builtin_bswap16" || callee == "__builtin_expect" ||
           callee == "__builtin_prefetch" || callee == "ktime_to_ns" ||
           callee == "timecounter_cyc2time";
}

} // namespace deadlock
