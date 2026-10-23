#include "deadlock/InterruptAnalysis.h"

#include <algorithm>
#include <cctype>
#include <deque>
#include <functional>
#include <map>
#include <set>
#include <sstream>
#include <unordered_map>
#include <unordered_set>

namespace deadlock {
namespace {

constexpr std::size_t MaxCallChain = 4;
constexpr std::size_t MaxIdentityLength = 512;
constexpr std::size_t MaxInterruptEdges = 100000;
constexpr std::size_t MaxCycles = 256;
constexpr unsigned MaxCycleDepth = 24;

std::string sourceKey(const LocatedSource &location) {
    const auto &source = location.expansion;
    return source.file + ":" + std::to_string(source.line) + ":" +
           std::to_string(source.column);
}

std::string stepKey(const ProvenanceStep &step) {
    return step.function + "->" + step.callee + "@" + sourceKey(step.location);
}

std::string chainKey(const std::vector<ProvenanceStep> &chain, bool truncated) {
    std::string result;
    for (const auto &step : chain)
        result += stepKey(step) + ";";
    if (truncated)
        result += "...";
    return result;
}

// Formal parameter identities are local to a function summary. Namespace them
// when the summaries become graph nodes so unrelated `@param[n]` values do
// not collapse into one symbolic lock.
std::string graphIdentity(const std::string &identity, const std::string &function) {
    std::string result;
    for (std::size_t position = 0; position < identity.size();) {
        if (identity.compare(position, 7, "@param[") == 0) {
            const auto end = identity.find(']', position + 7);
            if (end != std::string::npos) {
                result += "@param[" + function + "#" +
                    identity.substr(position + 7, end - position - 7) + "]";
                position = end + 1;
                continue;
            }
        }
        result.push_back(identity[position++]);
    }
    return result;
}

ProvenanceStep makeStep(const CallInfo &call) {
    return {call.caller, call.callee, call.location};
}

void prependCall(std::vector<ProvenanceStep> &chain, bool &truncated,
                 const CallInfo &call) {
    if (chain.size() < MaxCallChain)
        chain.insert(chain.begin(), makeStep(call));
    else
        truncated = true;
}

std::string instantiateIdentity(const std::string &identity,
                                const std::vector<std::string> &arguments,
                                bool &resolved) {
    std::string output;
    resolved = true;
    for (std::size_t position = 0; position < identity.size();) {
        if (identity.compare(position, 7, "@param[") == 0) {
            const std::size_t firstDigit = position + 7;
            std::size_t end = firstDigit;
            while (end < identity.size() && std::isdigit(static_cast<unsigned char>(identity[end])))
                ++end;
            if (firstDigit == end || end >= identity.size() || identity[end] != ']') {
                resolved = false;
                return "unknown-identity";
            }
            const auto index = static_cast<std::size_t>(std::stoul(identity.substr(firstDigit, end - firstDigit)));
            if (index >= arguments.size()) {
                resolved = false;
                return "unknown-identity";
            }
            output += arguments[index];
            position = end + 1;
        } else {
            output.push_back(identity[position++]);
        }
        if (output.size() > MaxIdentityLength) {
            resolved = false;
            return "unknown-identity";
        }
    }
    return output;
}

std::string scopeAutomaticLock(const std::string &identity,
                              const std::vector<ProvenanceStep> &chain,
                              bool truncated) {
    if (identity.find("local@") == std::string::npos)
        return identity;
    const auto oldScope = identity.find("|activation=");
    return identity.substr(0, oldScope) + "|activation=" + chainKey(chain, truncated);
}

std::string mergeTerm(const std::string &left, const std::string &right) {
    return left == right ? left : "unknown";
}

struct FlowState {
    bool reachable = false;
    std::string irq = "unknown";
    std::map<std::string, std::string> flags;
};

bool operator==(const FlowState &left, const FlowState &right) {
    return left.reachable == right.reachable && left.irq == right.irq &&
           left.flags == right.flags;
}

FlowState mergeStates(const FlowState &left, const FlowState &right) {
    if (!left.reachable) return right;
    if (!right.reachable) return left;
    FlowState output;
    output.reachable = true;
    output.irq = mergeTerm(left.irq, right.irq);
    std::set<std::string> keys;
    for (const auto &entry : left.flags) keys.insert(entry.first);
    for (const auto &entry : right.flags) keys.insert(entry.first);
    for (const auto &key : keys) {
        auto l = left.flags.find(key), r = right.flags.find(key);
        if (l == left.flags.end() || r == right.flags.end())
            output.flags[key] = "unknown";
        else
            output.flags[key] = mergeTerm(l->second, r->second);
    }
    return output;
}

struct LockSnapshot {
    std::string lock;
    std::string identityStatus;
    std::string originFunction;
    std::string reportingFunction;
    std::string irqTerm;
    LocatedSource location;
    std::vector<ProvenanceStep> throughCalls;
    bool provenanceTruncated = false;
};

std::string snapshotKey(const LockSnapshot &snapshot) {
    return snapshot.lock + "|" + snapshot.identityStatus + "|" +
           snapshot.originFunction + "|" + snapshot.reportingFunction + "|" +
           sourceKey(snapshot.location) + "|" +
           chainKey(snapshot.throughCalls, snapshot.provenanceTruncated);
}

struct IRQSummary {
    std::string irqOut = "$in_irq";
    std::map<std::string, std::string> flagOut;
    std::map<std::string, LockSnapshot> snapshots;
    std::set<std::string> uncertainties;
};

bool sameSummary(const IRQSummary &left, const IRQSummary &right) {
    if (left.irqOut != right.irqOut || left.flagOut != right.flagOut ||
        left.uncertainties != right.uncertainties ||
        left.snapshots.size() != right.snapshots.size())
        return false;
    auto l = left.snapshots.begin(), r = right.snapshots.begin();
    for (; l != left.snapshots.end(); ++l, ++r)
        if (l->first != r->first || l->second.irqTerm != r->second.irqTerm)
            return false;
    return true;
}

std::string replaceAll(std::string text, const std::string &pattern,
                       const std::string &replacement) {
    if (pattern.empty()) return text;
    std::size_t position = 0;
    while ((position = text.find(pattern, position)) != std::string::npos) {
        text.replace(position, pattern.size(), replacement);
        position += replacement.size();
    }
    return text;
}

std::string instantiateTerm(const std::string &term, const std::string &irq,
                            const std::vector<std::string> &arguments,
                            const std::map<std::string, std::string> &flags) {
    if (term == "$in_irq") return irq;
    std::string output = term;
    for (std::size_t i = 0; i < arguments.size(); ++i) {
        const std::string marker = "$in_flag[" + std::to_string(i) + "]";
        auto found = flags.find(arguments[i]);
        output = replaceAll(std::move(output), marker,
                            found == flags.end() ? "unknown" : found->second);
    }
    return output.find("$in_flag[") == std::string::npos ? output : "unknown";
}

std::string evaluateEntryTerm(const std::string &term, const std::string &entryIRQ) {
    if (term == "$in_irq") return entryIRQ;
    return term.find("$in_flag[") == std::string::npos ? term : "unknown";
}

std::string callArgument(const CallInfo &call, int index) {
    return index >= 0 && static_cast<std::size_t>(index) < call.argumentIdentities.size()
        ? call.argumentIdentities[static_cast<std::size_t>(index)] : std::string{};
}

void mergeSnapshot(std::map<std::string, LockSnapshot> &snapshots,
                   LockSnapshot snapshot) {
    const auto key = snapshotKey(snapshot);
    auto found = snapshots.find(key);
    if (found == snapshots.end()) {
        snapshots.emplace(key, std::move(snapshot));
    } else {
        found->second.irqTerm = mergeTerm(found->second.irqTerm, snapshot.irqTerm);
    }
}

IRQSummary summarizeFunction(
    const FunctionInfo &function,
    const std::unordered_map<std::size_t, const CallInfo *> &calls,
    const std::unordered_map<std::size_t, const ApiOperation *> &apis,
    const std::unordered_map<std::string, IRQSummary> &summaries) {
    IRQSummary summary;
    if (!function.cfgAvailable || function.cfg.empty()) {
        summary.irqOut = "unknown";
        summary.uncertainties.insert("IRQ-state CFG unavailable for " + function.qualifiedName);
        return summary;
    }
    if (!function.cfgEventsComplete)
        summary.uncertainties.insert("IRQ-state analysis has unmapped call events");

    std::unordered_map<unsigned, std::vector<unsigned>> predecessors;
    unsigned maxBlock = 0;
    unsigned exitBlock = function.cfg.back().id;
    for (const auto &block : function.cfg) {
        maxBlock = std::max(maxBlock, block.id);
        if (block.isExit) exitBlock = block.id;
        for (unsigned successor : block.successors)
            predecessors[successor].push_back(block.id);
    }
    std::vector<FlowState> in(maxBlock + 1), out(maxBlock + 1);
    if (function.entryBlock >= in.size()) {
        summary.irqOut = "unknown";
        summary.uncertainties.insert("invalid CFG entry for IRQ-state analysis");
        return summary;
    }
    in[function.entryBlock].reachable = true;
    in[function.entryBlock].irq = "$in_irq";
    for (std::size_t callIndex = 0; callIndex < calls.size(); ++callIndex) {
        auto api = apis.find(callIndex);
        auto call = calls.find(callIndex);
        if (api == apis.end() || call == calls.end() ||
            call->second->callerId != function.id ||
            api->second->kind != "lock_release_irqrestore")
            continue;
        const std::string flagExpression = callArgument(*call->second, api->second->stateArgument);
        for (std::size_t parameter = 0; parameter < function.parameters.size(); ++parameter) {
            const std::string marker = "@param[" + std::to_string(parameter) + "]";
            if (flagExpression.find(marker) != std::string::npos)
                in[function.entryBlock].flags[flagExpression] =
                    "$in_flag[" + std::to_string(parameter) + "]";
        }
    }
    std::deque<unsigned> work{function.entryBlock};
    std::vector<bool> queued(maxBlock + 1, false);
    queued[function.entryBlock] = true;
    std::unordered_map<std::string, const FunctionInfo::CFGBlock *> blocks;
    for (const auto &block : function.cfg) blocks[std::to_string(block.id)] = &block;
    std::size_t iterations = 0;
    const std::size_t workLimit = std::max<std::size_t>(512, function.cfg.size() * 256);

    while (!work.empty() && iterations++ < workLimit) {
        const unsigned blockId = work.front();
        work.pop_front();
        queued[blockId] = false;
        auto blockIt = blocks.find(std::to_string(blockId));
        if (blockIt == blocks.end()) continue;
        FlowState state = in[blockId];
        for (std::size_t callIndex : blockIt->second->callEvents) {
            auto callIt = calls.find(callIndex);
            const CallInfo *call = callIt == calls.end() ? nullptr : callIt->second;
            auto apiIt = apis.find(callIndex);
            if (apiIt != apis.end()) {
                const ApiOperation &api = *apiIt->second;
                const bool recognizedKind = api.kind == "lock_acquire" ||
                    api.kind == "lock_release" || api.kind == "lock_acquire_irqsave" ||
                    api.kind == "lock_release_irqrestore" ||
                    api.kind == "lock_acquire_softirq_disable" || api.kind == "irq_disable" ||
                    api.kind == "irq_enable" || api.kind == "interrupt_register" ||
                    api.kind == "interrupt_unregister";
                if (!recognizedKind) {
                    state.irq = "unknown";
                    for (auto &flag : state.flags) flag.second = "unknown";
                    summary.uncertainties.insert("unsupported API model kind '" + api.kind +
                        "' for '" + api.api + "' at " + sourceKey(api.location));
                }
                if (api.kind == "irq_disable") {
                    state.irq = "disabled";
                } else if (api.kind == "irq_enable") {
                    state.irq = "enabled";
                } else if (api.kind == "lock_acquire_irqsave") {
                    const std::string flag = call ? callArgument(*call, api.stateArgument) : "";
                    if (flag.empty()) {
                        state.irq = "unknown";
                        summary.uncertainties.insert("irqsave flags argument unresolved at " + sourceKey(api.location));
                    } else {
                        state.flags[flag] = state.irq;
                        state.irq = "disabled";
                    }
                } else if (api.kind == "lock_release_irqrestore") {
                    const std::string flag = call ? callArgument(*call, api.stateArgument) : "";
                    auto saved = state.flags.find(flag);
                    if (flag.empty() || saved == state.flags.end()) {
                        state.irq = "unknown";
                        summary.uncertainties.insert("irqrestore has no matching saved state for flags '" +
                            (flag.empty() ? std::string("<unresolved>") : flag) + "' at " + sourceKey(api.location));
                    } else {
                        state.irq = saved->second;
                    }
                } else if (api.kind == "interrupt_unregister") {
                    summary.uncertainties.insert("interrupt teardown/lifecycle for '" + api.api +
                        "' is not modeled at " + sourceKey(api.location) +
                        "; registered handlers remain possible targets");
                }
                if ((api.kind == "lock_acquire" || api.kind == "lock_acquire_irqsave" ||
                     api.kind == "lock_acquire_softirq_disable") && api.lock) {
                    LockSnapshot snapshot;
                    snapshot.lock = api.lock->identityTemplate;
                    snapshot.identityStatus = api.lock->identityStatus;
                    snapshot.originFunction = api.caller;
                    snapshot.reportingFunction = function.qualifiedName;
                    snapshot.irqTerm = state.irq;
                    snapshot.location = api.lock->location;
                    mergeSnapshot(summary.snapshots, std::move(snapshot));
                }
                continue;
            }
            if (!call || call->modeledApi) continue;
            bool unknownTarget = call->targetIds.empty();
            std::vector<const IRQSummary *> targetSummaries;
            for (const auto &targetId : call->targetIds) {
                auto target = summaries.find(targetId);
                if (target == summaries.end() || targetId.rfind("external:", 0) == 0)
                    unknownTarget = true;
                else
                    targetSummaries.push_back(&target->second);
            }
            if (unknownTarget || targetSummaries.empty()) {
                state.irq = "unknown";
                for (auto &flag : state.flags) flag.second = "unknown";
                summary.uncertainties.insert("unmodeled call may alter IRQ state: '" + call->callee +
                                             "' at " + sourceKey(call->location));
            }
            bool firstTarget = true;
            std::string mergedIRQ = "unknown";
            std::map<std::string, std::string> mergedFlags;
            for (const IRQSummary *target : targetSummaries) {
                const std::string targetIRQ = instantiateTerm(target->irqOut, state.irq,
                                                               call->argumentIdentities, state.flags);
                mergedIRQ = firstTarget ? targetIRQ : mergeTerm(mergedIRQ, targetIRQ);
                std::map<std::string, std::string> targetFlags;
                for (const auto &entry : target->flagOut) {
                    bool resolved = false;
                    std::string key = instantiateIdentity(entry.first, call->argumentIdentities, resolved);
                    if (resolved && entry.first.find("@param[") != std::string::npos)
                        targetFlags[key] = instantiateTerm(entry.second, state.irq,
                                                           call->argumentIdentities, state.flags);
                }
                if (firstTarget) {
                    mergedFlags = std::move(targetFlags);
                } else {
                    std::set<std::string> flagKeys;
                    for (const auto &entry : mergedFlags) flagKeys.insert(entry.first);
                    for (const auto &entry : targetFlags) flagKeys.insert(entry.first);
                    for (const auto &key : flagKeys) {
                        auto old = mergedFlags.find(key), next = targetFlags.find(key);
                        if (old == mergedFlags.end() || next == targetFlags.end())
                            mergedFlags[key] = "unknown";
                        else
                            old->second = mergeTerm(old->second, next->second);
                    }
                }
                for (const auto &entry : target->snapshots) {
                    LockSnapshot nested = entry.second;
                    bool identityResolved = false;
                    nested.lock = instantiateIdentity(nested.lock, call->argumentIdentities,
                                                      identityResolved);
                    nested.irqTerm = instantiateTerm(nested.irqTerm, state.irq,
                                                     call->argumentIdentities, state.flags);
                    if (!identityResolved) nested.identityStatus = "unresolved";
                    prependCall(nested.throughCalls, nested.provenanceTruncated, *call);
                    nested.lock = scopeAutomaticLock(nested.lock, nested.throughCalls,
                                                     nested.provenanceTruncated);
                    nested.reportingFunction = function.qualifiedName;
                    mergeSnapshot(summary.snapshots, std::move(nested));
                }
                for (const auto &uncertainty : target->uncertainties)
                    summary.uncertainties.insert("via " + call->callee + " at " +
                                                 sourceKey(call->location) + ": " + uncertainty);
                firstTarget = false;
            }
            if (!targetSummaries.empty())
                state.irq = unknownTarget ? "unknown" : mergedIRQ;
            for (const auto &entry : mergedFlags) state.flags[entry.first] = entry.second;
            // Known targets are only a subset of the possible behaviors when
            // any indirect target is unresolved. Do not let their definite
            // state/flag effects overwrite the unknown alternative above.
            if (unknownTarget)
                for (auto &flag : state.flags) flag.second = "unknown";
        }
        if (!(out[blockId] == state)) {
            out[blockId] = state;
            for (unsigned successor : blockIt->second->successors) {
                if (successor >= in.size() || successor == function.entryBlock) continue;
                auto pred = predecessors.find(successor);
                if (pred == predecessors.end()) continue;
                FlowState joined;
                for (unsigned predId : pred->second)
                    if (predId < out.size()) joined = mergeStates(joined, out[predId]);
                if (!(joined == in[successor])) {
                    in[successor] = std::move(joined);
                    if (!queued[successor]) {
                        work.push_back(successor);
                        queued[successor] = true;
                    }
                }
            }
        }
    }
    if (iterations >= workLimit)
        summary.uncertainties.insert("IRQ-state CFG iteration limit reached in " + function.qualifiedName);
    if (exitBlock < out.size() && out[exitBlock].reachable) {
        summary.irqOut = out[exitBlock].irq;
        summary.flagOut = out[exitBlock].flags;
    } else {
        summary.irqOut = "unknown";
        summary.uncertainties.insert("no reachable CFG exit for IRQ-state summary");
    }
    return summary;
}

std::vector<std::string> cycleNodes(const std::vector<std::size_t> &edgeIndexes,
                                    const std::vector<InterruptLockEdge> &edges) {
    std::vector<std::string> nodes;
    if (edgeIndexes.empty()) return nodes;
    nodes.push_back(edges[edgeIndexes.front()].fromLock);
    for (auto index : edgeIndexes) nodes.push_back(edges[index].toLock);
    return nodes;
}

// Validate direct, same-function dependencies with an event-level CFG search.
// The state means the source lock remains held after its acquisition. A path
// that releases it before acquiring the target cannot justify that edge.
void refineDirectDependencies(AnalysisResult &result) {
    struct EventPosition { unsigned block = 0; std::size_t event = 0; };
    auto findPosition = [&](const FunctionInfo &function, std::size_t callIndex,
                            EventPosition &position) {
        for (const auto &block : function.cfg) {
            for (std::size_t event = 0; event < block.callEvents.size(); ++event) {
                if (block.callEvents[event] == callIndex) {
                    position = {block.id, event};
                    return true;
                }
            }
        }
        return false;
    };
    auto apiAt = [&](std::size_t callIndex) -> const ApiOperation * {
        for (const auto &api : result.apiOperations)
            if (api.callIndex == callIndex) return &api;
        return nullptr;
    };
    for (auto &edge : result.interruptLockEdges) {
        if (edge.kind != "regular") continue;
        const LockDependency *dependency = nullptr;
        for (const auto &candidate : result.lockDependencies) {
            if (candidate.origin == "direct" && candidate.throughCalls.empty() &&
                graphIdentity(candidate.fromLock, candidate.reportingFunction) == edge.fromLock &&
                graphIdentity(candidate.toLock, candidate.reportingFunction) == edge.toLock &&
                sourceKey(candidate.fromAcquisition) == sourceKey(edge.fromLocation) &&
                sourceKey(candidate.toAcquisition) == sourceKey(edge.toLocation)) {
                dependency = &candidate;
                break;
            }
        }
        if (!dependency) continue; // interprocedural paths are retained, with their provenance.
        auto function = std::find_if(result.functions.begin(), result.functions.end(),
            [&](const FunctionInfo &item) { return item.qualifiedName == dependency->reportingFunction; });
        if (function == result.functions.end() || !function->cfgAvailable || !function->cfgEventsComplete) {
            edge.feasibility = "inconclusive";
            edge.feasibilityReason = "direct dependency could not be checked because CFG events are unavailable or incomplete";
            continue;
        }
        std::size_t fromCall = result.calls.size(), toCall = result.calls.size();
        for (const auto &api : result.apiOperations) {
            if (api.caller != function->qualifiedName || !api.lock) continue;
            if (api.lock->identityTemplate == dependency->fromLock &&
                sourceKey(api.lock->location) == sourceKey(dependency->fromAcquisition)) fromCall = api.callIndex;
            if (api.lock->identityTemplate == dependency->toLock &&
                sourceKey(api.lock->location) == sourceKey(dependency->toAcquisition)) toCall = api.callIndex;
        }
        EventPosition from, to;
        if (fromCall == result.calls.size() || toCall == result.calls.size() ||
            !findPosition(*function, fromCall, from) || !findPosition(*function, toCall, to)) {
            edge.feasibility = "inconclusive";
            edge.feasibilityReason = "direct acquisition events could not be mapped to CFG blocks";
            continue;
        }
        std::unordered_map<unsigned, const FunctionInfo::CFGBlock *> blocks;
        for (const auto &block : function->cfg) blocks[block.id] = &block;
        std::deque<std::pair<unsigned, std::size_t>> queue{{from.block, from.event + 1}};
        std::set<std::pair<unsigned, std::size_t>> seen;
        bool reachable = false;
        std::size_t steps = 0;
        const std::size_t limit = std::max<std::size_t>(256, function->cfg.size() * 128);
        while (!queue.empty() && steps++ < limit) {
            auto state = queue.front(); queue.pop_front();
            if (!seen.insert(state).second) continue;
            auto block = blocks.find(state.first);
            if (block == blocks.end()) continue;
            bool held = true;
            for (std::size_t event = state.second; event < block->second->callEvents.size(); ++event) {
                const auto callIndex = block->second->callEvents[event];
                if (callIndex == toCall) { reachable = true; break; }
                const auto *api = apiAt(callIndex);
                if (api && api->lock && api->lock->identityTemplate == dependency->fromLock &&
                    (api->kind == "lock_release" || api->kind == "lock_release_irqrestore")) {
                    held = false;
                    break;
                }
            }
            if (reachable) break;
            if (!held) continue;
            for (unsigned successor : block->second->successors)
                queue.emplace_back(successor, 0);
        }
        if (steps >= limit) {
            edge.feasibility = "inconclusive";
            edge.feasibilityReason = "bounded CFG path search reached its step limit";
        } else if (reachable) {
            edge.feasibility = "cfg_reachable";
            edge.feasibilityReason = "control-flow graph path reaches the target acquisition while the source lock remains held; branch predicate feasibility is not proven";
        } else {
            edge.feasibility = "rejected";
            edge.feasibilityReason = "no CFG path reaches the target acquisition before releasing the source lock";
        }
    }
}

void detectCycles(AnalysisResult &result) {
    bool depthTruncated = false;
    std::vector<std::size_t> normalEdges;
    std::map<std::pair<std::string, std::string>, std::vector<std::size_t>> hardirqOutgoing;
    std::vector<std::size_t> interruptEdges;
    for (std::size_t i = 0; i < result.interruptLockEdges.size(); ++i) {
        const auto &edge = result.interruptLockEdges[i];
        if (edge.kind == "regular" && edge.fromContext == "process" && edge.toContext == "process")
            normalEdges.push_back(i);
        if (edge.kind == "regular" && edge.fromContext == "hardirq" && edge.toContext == "hardirq")
            hardirqOutgoing[{edge.handler, edge.fromLock}].push_back(i);
        if (edge.kind == "interrupt_preemption") interruptEdges.push_back(i);
    }

    auto record = [&](std::string classification, std::vector<std::size_t> indexes,
                      std::string explanation, bool) {
        auto nodes = cycleNodes(indexes, result.interruptLockEdges);
        // One-edge self-cycles matter for non-recursive Linux mutexes and
        // spinlocks: reacquiring the same lock can deadlock.
        if (nodes.size() < 2) return;
        const auto &cycleEdges = result.interruptLockEdges;
        // Canonicalize by rotation of the ordered (lock, context, edge-kind)
        // sequence. Reverse order remains distinct because it is a different acquisition order.
        std::string canonical;
        for (std::size_t rotation = 0; rotation < indexes.size(); ++rotation) {
            std::string candidate = classification + ":";
            for (std::size_t offset = 0; offset < indexes.size(); ++offset) {
                const auto &edge = cycleEdges[indexes[(rotation + offset) % indexes.size()]];
                candidate += edge.fromLock + "[" + edge.fromContext + ">" + edge.toContext + "," + edge.kind + "]>";
            }
            if (canonical.empty() || candidate < canonical) canonical = std::move(candidate);
        }
        auto existing = std::find_if(result.interruptCycles.begin(), result.interruptCycles.end(),
            [&](const InterruptCycle &cycle) {
                if (cycle.edgeIndexes.empty()) return false;
                std::string other;
                for (std::size_t rotation = 0; rotation < cycle.edgeIndexes.size(); ++rotation) {
                    std::string candidate = cycle.classification + ":";
                    for (std::size_t offset = 0; offset < cycle.edgeIndexes.size(); ++offset) {
                        const auto &edge = cycleEdges[cycle.edgeIndexes[(rotation + offset) % cycle.edgeIndexes.size()]];
                        candidate += edge.fromLock + "[" + edge.fromContext + ">" + edge.toContext + "," + edge.kind + "]>";
                    }
                    if (other.empty() || candidate < other) other = std::move(candidate);
                }
                return other == canonical;
            });
        if (existing != result.interruptCycles.end()) {
            if (std::find(existing->provenanceVariants.begin(), existing->provenanceVariants.end(), indexes) ==
                existing->provenanceVariants.end()) {
                bool variantRejected = false, variantUncertain = false;
                for (auto index : indexes) {
                    const auto &edge = cycleEdges[index];
                    variantRejected |= edge.feasibility == "rejected";
                    variantUncertain |= edge.certainty == "uncertain" || edge.feasibility == "inconclusive";
                }
                existing->containsUncertainEdge |= variantUncertain;
                const bool representativeRejected = existing->feasibility == "rejected";
                const bool representativeUncertain = existing->feasibility == "inconclusive";
                if ((variantRejected != representativeRejected) || variantUncertain || representativeUncertain) {
                    existing->category = "inconclusive_analysis";
                    existing->feasibility = "inconclusive";
                } else if (variantRejected) {
                    existing->category = "rejected_candidate";
                    existing->feasibility = "rejected";
                }
                existing->provenanceVariants.push_back(std::move(indexes));
            }
            return;
        }
        if (result.interruptCycles.size() >= MaxCycles) return;
        InterruptCycle cycle;
        cycle.classification = classification;
        cycle.edgeIndexes = indexes;
        cycle.provenanceVariants.push_back(std::move(indexes));
        cycle.lockSequence = std::move(nodes);
        cycle.explanation = std::move(explanation);
        bool rejected = classification == "rejected_interrupt_preemption";
        for (auto index : cycle.edgeIndexes) {
            const auto &edge = result.interruptLockEdges[index];
            cycle.containsUncertainEdge |= edge.certainty == "uncertain" || edge.feasibility == "inconclusive";
            rejected |= edge.feasibility == "rejected";
        }
        const bool interrupt = classification == "interrupt_preemption_candidate" || rejected;
        cycle.category = rejected ? "rejected_candidate" :
            (cycle.containsUncertainEdge ? "inconclusive_analysis" :
             (interrupt ? "interrupt_aware_candidate" : "candidate_lock_order_cycle"));
        cycle.feasibility = rejected ? "rejected" :
            (cycle.containsUncertainEdge ? "inconclusive" : "candidate");
        if (rejected)
            for (auto index : cycle.edgeIndexes)
                if (result.interruptLockEdges[index].feasibility == "rejected")
                    cycle.explanation += " Feasibility check: " + result.interruptLockEdges[index].feasibilityReason + ".";
        result.interruptCycles.push_back(std::move(cycle));
    };

    std::map<std::string, std::vector<std::size_t>> normalOutgoing;
    for (auto index : normalEdges)
        normalOutgoing[result.interruptLockEdges[index].fromLock].push_back(index);
    for (auto &entry : normalOutgoing)
        std::sort(entry.second.begin(), entry.second.end(), [&](auto a, auto b) {
            return result.interruptLockEdges[a].toLock < result.interruptLockEdges[b].toLock;
        });
    std::set<std::string> normalNodes;
    for (auto index : normalEdges) {
        normalNodes.insert(result.interruptLockEdges[index].fromLock);
        normalNodes.insert(result.interruptLockEdges[index].toLock);
    }
    for (const auto &start : normalNodes) {
        std::vector<std::size_t> path;
        std::set<std::string> visited{start};
        std::function<void(const std::string &)> visit = [&](const std::string &current) {
            if (result.interruptCycles.size() >= MaxCycles) return;
            if (path.size() >= MaxCycleDepth) { depthTruncated = true; return; }
            for (auto edgeIndex : normalOutgoing[current]) {
                const auto &edge = result.interruptLockEdges[edgeIndex];
                if (edge.toLock == start && (path.size() >= 1 || edge.fromLock == start)) {
                    auto candidate = path;
                    candidate.push_back(edgeIndex);
                    record("normal_lock_cycle", std::move(candidate),
                           "Possible process-context lock-order cycle; this is a static candidate, not a confirmed deadlock.",
                           true);
                } else if (edge.toLock > start && !visited.count(edge.toLock)) {
                    visited.insert(edge.toLock);
                    path.push_back(edgeIndex);
                    visit(edge.toLock);
                    path.pop_back();
                    visited.erase(edge.toLock);
                }
            }
        };
        visit(start);
    }

    for (auto interruptIndex : interruptEdges) {
        if (result.interruptCycles.size() >= MaxCycles) break;
        const auto &interrupt = result.interruptLockEdges[interruptIndex];
        std::vector<std::size_t> path{interruptIndex};
        std::set<std::string> visited{interrupt.toLock};
        std::function<void(const std::string &)> visitHandler = [&](const std::string &current) {
            if (result.interruptCycles.size() >= MaxCycles) return;
            if (path.size() >= MaxCycleDepth) { depthTruncated = true; return; }
            auto outgoing = hardirqOutgoing.find({interrupt.handler, current});
            if (outgoing == hardirqOutgoing.end()) return;
            for (auto edgeIndex : outgoing->second) {
                const auto &edge = result.interruptLockEdges[edgeIndex];
                if (edge.toLock == interrupt.fromLock) {
                    path.push_back(edgeIndex);
                    record("interrupt_preemption_candidate", path,
                           "Possible same-CPU hardirq preemption cycle: the process may hold the source lock with hard IRQs enabled, and the registered handler may request locks along the remaining path. Not a confirmed deadlock.",
                           false);
                    path.pop_back();
                } else if (!visited.count(edge.toLock)) {
                    visited.insert(edge.toLock);
                    path.push_back(edgeIndex);
                    visitHandler(edge.toLock);
                    path.pop_back();
                    visited.erase(edge.toLock);
                }
            }
        };
        visitHandler(interrupt.toLock);
    }

    // Preserve the counterfactual cycle when the process-side acquisition is
    // definitely protected from local hardirq preemption. This is useful as
    // an explicit rejected finding rather than silently omitting the shape.
    for (const auto &snapshot : result.interruptSnapshots) {
        if (snapshot.context != "process" || snapshot.irqState != "disabled") continue;
        std::set<std::string> held{graphIdentity(snapshot.lockIdentity, snapshot.sourceFunction)};
        for (const auto &dependency : result.lockDependencies) {
            if (dependency.reportingFunction == snapshot.sourceFunction &&
                dependency.toLock == snapshot.lockIdentity &&
                sourceKey(dependency.toAcquisition) == sourceKey(snapshot.location) &&
                chainKey(dependency.throughCalls, dependency.provenanceTruncated) ==
                    chainKey(snapshot.throughCalls, snapshot.provenanceTruncated))
                held.insert(graphIdentity(dependency.fromLock, dependency.reportingFunction));
        }
        if (held.empty()) continue;
        for (const auto &registration : result.interruptRegistrations) {
            for (const auto &handler : registration.handlerNames) {
                for (const auto &entry : hardirqOutgoing) {
                    if (entry.first.first != handler) continue;
                    for (auto firstEdge : entry.second) {
                        std::vector<std::size_t> path;
                        std::set<std::string> visited;
                        std::function<void(const std::string &)> seek = [&](const std::string &current) {
                            if (path.size() >= MaxCycleDepth) { depthTruncated = true; return; }
                            auto outgoing = hardirqOutgoing.find({handler, current});
                            if (outgoing == hardirqOutgoing.end()) return;
                            for (auto edgeIndex : outgoing->second) {
                                const auto &edge = result.interruptLockEdges[edgeIndex];
                                path.push_back(edgeIndex);
                                if (held.count(edge.toLock)) {
                                    InterruptLockEdge rejected;
                                    rejected.fromLock = edge.toLock;
                                    rejected.toLock = result.interruptLockEdges[firstEdge].fromLock;
                                    rejected.kind = "interrupt_preemption_rejected";
                                    rejected.fromContext = "process";
                                    rejected.toContext = "hardirq";
                                    rejected.sourceFunction = snapshot.sourceFunction;
                                    rejected.targetFunction = handler;
                                    rejected.irqState = "disabled";
                                    rejected.certainty = "possible";
                                    rejected.fromLocation = snapshot.location;
                                    rejected.toLocation = result.interruptLockEdges[firstEdge].fromLocation;
                                    rejected.registrationLocation = registration.location;
                                    rejected.handler = handler;
                                    rejected.feasibility = "rejected";
                                    rejected.feasibilityReason = "local hard IRQs are definitely disabled at the process acquisition; same-CPU hardirq preemption is unavailable in the modeled context";
                                    const auto virtualIndex = result.interruptLockEdges.size();
                                    result.interruptLockEdges.push_back(std::move(rejected));
                                    std::vector<std::size_t> cycle{virtualIndex};
                                    cycle.insert(cycle.end(), path.begin(), path.end());
                                    record("rejected_interrupt_preemption", std::move(cycle),
                                           "Counterfactual process/hardirq lock cycle rejected because local hard IRQs are definitely disabled at the process acquisition.",
                                           false);
                                    path.pop_back();
                                    continue;
                                }
                                if (visited.insert(edge.toLock).second) {
                                    seek(edge.toLock);
                                    visited.erase(edge.toLock);
                                }
                                path.pop_back();
                            }
                        };
                        visited.insert(result.interruptLockEdges[firstEdge].fromLock);
                        seek(result.interruptLockEdges[firstEdge].fromLock);
                    }
                }
            }
        }
    }
    if (result.interruptCycles.size() >= MaxCycles)
        result.uncertainties.push_back("interrupt cycle output capped at " +
            std::to_string(MaxCycles) + " candidates");
    if (depthTruncated)
        result.uncertainties.push_back("one or more cycle searches reached depth cap " +
            std::to_string(MaxCycleDepth));
}

} // namespace

void analyzeInterrupts(AnalysisResult &result) {
    std::unordered_map<std::string, const FunctionInfo *> functions;
    std::unordered_map<std::string, std::string> functionIdByName;
    for (const auto &function : result.functions) {
        functions[function.id] = &function;
        functionIdByName[function.qualifiedName] = function.id;
    }
    std::unordered_map<std::size_t, const CallInfo *> calls;
    for (std::size_t i = 0; i < result.calls.size(); ++i) calls[i] = &result.calls[i];
    std::unordered_map<std::size_t, const ApiOperation *> apis;
    for (const auto &api : result.apiOperations) apis[api.callIndex] = &api;

    for (const auto &api : result.apiOperations) {
        if (api.kind != "interrupt_register") continue;
        InterruptRegistration registration;
        registration.api = api.api;
        registration.caller = api.caller;
        registration.location = api.location;
        registration.resolution = api.handlerResolution.empty() ? "unresolved_handler" : api.handlerResolution;
        if (!api.arguments.empty()) registration.irqExpression = api.arguments.front();
        registration.handlerIds = api.handlerTargetIds;
        registration.handlerNames = api.handlerTargetNames;
        if (registration.handlerIds.empty())
            result.uncertainties.push_back("unresolved interrupt handler registration at " + sourceKey(api.location));
        result.interruptRegistrations.push_back(std::move(registration));
    }

    std::unordered_map<std::string, IRQSummary> summaries;
    for (const auto &function : result.functions) {
        summaries.emplace(function.id, IRQSummary{});
    }
    bool converged = false;
    const std::size_t maxIterations = std::min<std::size_t>(128,
        std::max<std::size_t>(16, result.functions.size() + 8));
    for (std::size_t iteration = 0; iteration < maxIterations; ++iteration) {
        bool changed = false;
        auto next = summaries;
        for (const auto &function : result.functions) {
            IRQSummary computed = summarizeFunction(function, calls, apis, summaries);
            if (!sameSummary(computed, summaries[function.id])) changed = true;
            next[function.id] = std::move(computed);
        }
        summaries = std::move(next);
        if (!changed) { converged = true; break; }
    }
    if (!converged)
        result.uncertainties.push_back("interrupt-state summary fixed point did not converge");

    std::unordered_set<std::string> registeredHandlers;
    for (const auto &registration : result.interruptRegistrations)
        for (const auto &id : registration.handlerIds)
            if (functions.count(id)) registeredHandlers.insert(id);
    std::unordered_map<std::string, std::vector<std::string>> outgoing;
    std::unordered_set<std::string> calledFunctions;
    for (const auto &call : result.calls) {
        if (call.modeledApi) continue;
        for (const auto &target : call.targetIds) {
            if (functions.count(target)) {
                outgoing[call.callerId].push_back(target);
                calledFunctions.insert(target);
            }
        }
    }
    std::unordered_map<std::string, std::set<std::string>> contexts;
    std::unordered_map<std::string, std::set<std::string>> hardirqRootsForFunction;
    auto propagate = [&](const std::vector<std::string> &roots, const std::string &context) {
        for (const auto &root : roots) {
            std::deque<std::string> queue{root};
            std::unordered_set<std::string> seen;
            while (!queue.empty()) {
                const std::string current = queue.front(); queue.pop_front();
                if (!seen.insert(current).second) continue;
                contexts[current].insert(context);
                if (context == "hardirq") hardirqRootsForFunction[current].insert(root);
                for (const auto &target : outgoing[current]) queue.push_back(target);
            }
        }
    };
    std::vector<std::string> processRoots;
    for (const auto &entry : functions)
        if (!calledFunctions.count(entry.first) && !registeredHandlers.count(entry.first))
            processRoots.push_back(entry.first);
    if (processRoots.empty())
        for (const auto &entry : functions)
            if (!registeredHandlers.count(entry.first)) processRoots.push_back(entry.first);
    propagate(processRoots, "process");
    std::vector<std::string> handlerRoots(registeredHandlers.begin(), registeredHandlers.end());
    propagate(handlerRoots, "hardirq");
    for (const auto &entry : functions)
        if (contexts[entry.first].empty()) contexts[entry.first].insert("unknown");

    for (const auto &entry : summaries) {
        for (const auto &uncertainty : entry.second.uncertainties)
            result.uncertainties.push_back("IRQ state " + entry.first + ": " + uncertainty);
    }

    // Context-specific lock acquisitions become snapshots. A hardirq starts
    // with local hard IRQs disabled; process context starts enabled.
    for (const auto &functionEntry : result.functions) {
        const FunctionInfo *function = &functionEntry;
        const auto &functionSummary = summaries[function->id];
        for (const auto &context : contexts[function->id]) {
            const std::string entryIRQ = context == "hardirq" ? "disabled" : "enabled";
            for (const auto &snapshotEntry : functionSummary.snapshots) {
                const auto &snapshot = snapshotEntry.second;
                InterruptStateSnapshot output;
                output.lockIdentity = snapshot.lock;
                output.identityStatus = snapshot.identityStatus;
                output.context = context;
                output.irqState = evaluateEntryTerm(snapshot.irqTerm, entryIRQ);
                output.sourceFunction = function->qualifiedName;
                output.originFunction = snapshot.originFunction;
                output.location = snapshot.location;
                output.throughCalls = snapshot.throughCalls;
                output.provenanceTruncated = snapshot.provenanceTruncated;
                result.interruptSnapshots.push_back(std::move(output));
            }
        }
    }

    // Preserve Phase 2 dependencies as ordinary context-labelled edges.
    bool edgeLimitReached = false;
    for (const auto &dependency : result.lockDependencies) {
        auto id = functionIdByName.find(dependency.reportingFunction);
        if (id == functionIdByName.end()) continue;
        for (const auto &context : contexts[id->second]) {
            if (context != "process" && context != "hardirq") continue;
            const auto handlers = context == "hardirq"
                ? hardirqRootsForFunction[id->second] : std::set<std::string>{};
            const std::size_t count = context == "hardirq" ? handlers.size() : 1;
            auto handlerId = handlers.begin();
            for (std::size_t copy = 0; copy < count; ++copy) {
                InterruptLockEdge edge;
                edge.fromLock = graphIdentity(dependency.fromLock, dependency.reportingFunction);
                edge.toLock = graphIdentity(dependency.toLock, dependency.reportingFunction);
                edge.kind = "regular";
                edge.fromContext = context;
                edge.toContext = context;
                edge.sourceFunction = dependency.reportingFunction;
                edge.targetFunction = dependency.originFunction;
                edge.irqState = "not_applicable";
                edge.certainty = dependency.certainty == "possible" ? "possible" : "uncertain";
                edge.fromLocation = dependency.fromAcquisition;
                edge.toLocation = dependency.toAcquisition;
                edge.sourceProvenance = dependency.throughCalls;
                edge.targetProvenance = dependency.throughCalls;
                if (context == "hardirq" && handlerId != handlers.end()) {
                    auto handler = functions.find(*handlerId++);
                    if (handler != functions.end()) edge.handler = handler->second->qualifiedName;
                }
                if (result.interruptLockEdges.size() >= MaxInterruptEdges) {
                    edgeLimitReached = true;
                    break;
                }
                result.interruptLockEdges.push_back(std::move(edge));
            }
            if (edgeLimitReached) break;
        }
        if (edgeLimitReached) break;
    }

    // For each process-context acquisition, Phase 2 dependencies identify
    // locks already held. The newly acquired lock is held immediately after
    // the call. If IRQs may be enabled, each registered hardirq acquisition
    // may be attempted before process execution resumes.
    for (const auto &source : result.interruptSnapshots) {
        if (result.interruptLockEdges.size() >= MaxInterruptEdges) {
            edgeLimitReached = true;
            break;
        }
        if (source.context != "process" || source.irqState == "disabled") continue;
        std::set<std::string> held{graphIdentity(source.lockIdentity, source.sourceFunction)};
        for (const auto &dependency : result.lockDependencies) {
            if (dependency.reportingFunction != source.sourceFunction ||
                dependency.toLock != source.lockIdentity ||
                sourceKey(dependency.toAcquisition) != sourceKey(source.location) ||
                chainKey(dependency.throughCalls, dependency.provenanceTruncated) !=
                    chainKey(source.throughCalls, source.provenanceTruncated))
                continue;
            held.insert(graphIdentity(dependency.fromLock, dependency.reportingFunction));
        }
        for (const auto &registration : result.interruptRegistrations) {
            if (edgeLimitReached) break;
            for (const auto &handlerId : registration.handlerIds) {
                if (edgeLimitReached) break;
                auto handlerSummary = summaries.find(handlerId);
                auto handlerFunction = functions.find(handlerId);
                if (handlerSummary == summaries.end() || handlerFunction == functions.end()) continue;
                for (const auto &handlerAcquisition : handlerSummary->second.snapshots) {
                    if (edgeLimitReached) break;
                    const auto &target = handlerAcquisition.second;
                    for (const auto &heldLock : held) {
                        if (result.interruptLockEdges.size() >= MaxInterruptEdges) {
                            edgeLimitReached = true;
                            break;
                        }
                        InterruptLockEdge edge;
                        edge.fromLock = heldLock;
                        edge.toLock = graphIdentity(target.lock, handlerFunction->second->qualifiedName);
                        edge.kind = "interrupt_preemption";
                        edge.fromContext = "process";
                        edge.toContext = "hardirq";
                        edge.sourceFunction = source.sourceFunction;
                        edge.targetFunction = handlerFunction->second->qualifiedName;
                        edge.irqState = source.irqState;
                        edge.certainty = (source.irqState == "unknown" ||
                                          source.identityStatus == "unresolved" ||
                                          target.identityStatus == "unresolved" ||
                                          !converged) ? "uncertain" : "possible";
                        edge.fromLocation = source.location;
                        edge.toLocation = target.location;
                        edge.registrationLocation = registration.location;
                        edge.handler = handlerFunction->second->qualifiedName;
                        edge.sourceProvenance = source.throughCalls;
                        edge.targetProvenance = target.throughCalls;
                        result.interruptLockEdges.push_back(std::move(edge));
                    }
                }
            }
        }
    }
    if (edgeLimitReached)
        result.uncertainties.push_back("interrupt lock edge output capped at " +
            std::to_string(MaxInterruptEdges) + " edges");

    for (const auto &call : result.calls) {
        if (call.modeledApi) continue;
        std::string lowered = call.callee;
        std::transform(lowered.begin(), lowered.end(), lowered.begin(), [](unsigned char c) {
            return static_cast<char>(std::tolower(c));
        });
        if (lowered.find("lock") != std::string::npos || lowered.find("irq") != std::string::npos)
            result.uncertainties.push_back("possibly unsupported lock/IRQ API '" + call.callee +
                "' at " + sourceKey(call.location) + "; add an explicit API model if applicable");
    }

    refineDirectDependencies(result);
    detectCycles(result);
}

} // namespace deadlock
