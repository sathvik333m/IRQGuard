#include "deadlock/Interprocedural.h"

#include <algorithm>
#include <deque>
#include <map>
#include <set>
#include <sstream>
#include <unordered_map>
#include <unordered_set>

namespace deadlock {
namespace {

constexpr std::size_t MaxCallChain = 4;
constexpr std::size_t MaxIdentityLength = 512;

std::string sourceKey(const LocatedSource &location) {
    const auto &source = location.expansion;
    return source.file + ":" + std::to_string(source.line) + ":" +
           std::to_string(source.column);
}

std::string stepKey(const ProvenanceStep &step) {
    return step.function + "->" + step.callee + "@" + sourceKey(step.location);
}

std::string chainKey(const std::vector<ProvenanceStep> &chain, bool truncated) {
    std::string key;
    for (const auto &step : chain)
        key += stepKey(step) + ";";
    if (truncated)
        key += "...";
    return key;
}

std::string factKey(const AcquisitionFact &fact) {
    return fact.lockIdentity + "|" + fact.identityStatus + "|" + fact.function +
           "|" + sourceKey(fact.location) + "|" +
           chainKey(fact.throughCalls, fact.provenanceTruncated);
}

std::string releaseKey(const ReleaseFact &fact) {
    return fact.lockIdentity + "|" + fact.identityStatus + "|" + fact.function +
           "|" + sourceKey(fact.location) + "|" +
           chainKey(fact.throughCalls, fact.provenanceTruncated);
}

std::string dependencyKey(const LockDependency &dependency) {
    return dependency.fromLock + "|" + dependency.toLock + "|" +
           dependency.reportingFunction + "|" + dependency.originFunction + "|" +
           sourceKey(dependency.fromAcquisition) + "|" +
           sourceKey(dependency.toAcquisition) + "|" +
           chainKey(dependency.throughCalls, dependency.provenanceTruncated) + "|" + dependency.origin;
}

struct SummaryData {
    std::map<std::string, AcquisitionFact> acquisitions;
    std::map<std::string, ReleaseFact> releases;
    std::map<std::string, AcquisitionFact> heldOnReturn;
    std::set<std::string> releasedOnAllReturns;
    std::map<std::string, LockDependency> dependencies;
    std::set<std::string> uncertainties;
};

struct FlowState {
    bool reachable = false;
    std::set<std::string> heldFactKeys;
    std::set<std::string> mustReleased;
};

bool operator==(const FlowState &left, const FlowState &right) {
    return left.reachable == right.reachable &&
           left.heldFactKeys == right.heldFactKeys &&
           left.mustReleased == right.mustReleased;
}

bool sameSummary(const SummaryData &left, const SummaryData &right) {
    if (left.acquisitions.size() != right.acquisitions.size() ||
        left.releases.size() != right.releases.size() ||
        left.heldOnReturn.size() != right.heldOnReturn.size() ||
        left.releasedOnAllReturns != right.releasedOnAllReturns ||
        left.dependencies.size() != right.dependencies.size() ||
        left.uncertainties != right.uncertainties)
        return false;
    auto keysEqual = [](const auto &a, const auto &b) {
        auto ai = a.begin(), bi = b.begin();
        for (; ai != a.end(); ++ai, ++bi)
            if (ai->first != bi->first)
                return false;
        return true;
    };
    return keysEqual(left.acquisitions, right.acquisitions) &&
           keysEqual(left.releases, right.releases) &&
           keysEqual(left.heldOnReturn, right.heldOnReturn) &&
           keysEqual(left.dependencies, right.dependencies);
}

bool instantiateIdentity(const std::string &identity,
                         const std::vector<std::string> &arguments,
                         const std::string &fallback,
                         std::string &instantiated) {
    instantiated.clear();
    for (std::size_t index = 0; index < identity.size();) {
        if (identity.compare(index, 7, "@param[") == 0) {
            std::size_t digit = index + 7;
            std::size_t end = digit;
            while (end < identity.size() && identity[end] >= '0' && identity[end] <= '9')
                ++end;
            if (end == digit || end >= identity.size() || identity[end] != ']') {
                instantiated = fallback;
                return false;
            }
            const auto parameter = static_cast<std::size_t>(std::stoul(identity.substr(digit, end - digit)));
            if (parameter >= arguments.size()) {
                instantiated = fallback;
                return false;
            }
            instantiated += arguments[parameter];
            index = end + 1;
        } else {
            instantiated.push_back(identity[index++]);
        }
        if (instantiated.size() > MaxIdentityLength) {
            instantiated = fallback;
            return false;
        }
    }
    return true;
}

ProvenanceStep callStep(const CallInfo &call) {
    return ProvenanceStep{call.caller, call.callee, call.location};
}

void prependCall(std::vector<ProvenanceStep> &chain, bool &truncated,
                 const CallInfo &call) {
    if (chain.size() < MaxCallChain)
        chain.insert(chain.begin(), callStep(call));
    else
        truncated = true;
}

std::string scopeLocalActivation(const std::string &identity,
                                 const std::vector<ProvenanceStep> &chain,
                                 bool truncated) {
    if (identity.find("local@") == std::string::npos)
        return identity;
    const std::size_t previousScope = identity.find("|activation=");
    const std::string base = identity.substr(0, previousScope);
    return base + "|activation=" + chainKey(chain, truncated);
}

AcquisitionFact instantiateFact(const AcquisitionFact &fact, const CallInfo &call) {
    AcquisitionFact result = fact;
    std::string identity;
    const std::string fallback = "unknown@" + sourceKey(call.location);
    if (!instantiateIdentity(fact.lockIdentity, call.argumentIdentities, fallback, identity))
        result.identityStatus = "unresolved";
    if (result.identityStatus == "unresolved")
        identity = "unknown-context@" + sourceKey(fact.location) + "|call@" + sourceKey(call.location);
    result.lockIdentity = std::move(identity);
    prependCall(result.throughCalls, result.provenanceTruncated, call);
    if (result.lockIdentity.find("local@") != std::string::npos) {
        result.lockIdentity = scopeLocalActivation(result.lockIdentity, result.throughCalls,
                                                   result.provenanceTruncated);
        if (result.provenanceTruncated)
            result.identityStatus = "unresolved";
    }
    return result;
}

ReleaseFact instantiateRelease(const ReleaseFact &fact, const CallInfo &call) {
    ReleaseFact result = fact;
    std::string identity;
    const std::string fallback = "unknown@" + sourceKey(call.location);
    if (!instantiateIdentity(fact.lockIdentity, call.argumentIdentities, fallback, identity))
        result.identityStatus = "unresolved";
    if (result.identityStatus == "unresolved")
        identity = "unknown-context@" + sourceKey(fact.location) + "|call@" + sourceKey(call.location);
    result.lockIdentity = std::move(identity);
    prependCall(result.throughCalls, result.provenanceTruncated, call);
    if (result.lockIdentity.find("local@") != std::string::npos) {
        result.lockIdentity = scopeLocalActivation(result.lockIdentity, result.throughCalls,
                                                   result.provenanceTruncated);
        if (result.provenanceTruncated)
            result.identityStatus = "unresolved";
    }
    return result;
}

LockDependency instantiateDependency(const LockDependency &dependency,
                                     const CallInfo &call,
                                     const std::string &reportingFunction) {
    LockDependency result = dependency;
    const std::string fallback = "unknown@" + sourceKey(call.location);
    std::string from, to;
    if (!instantiateIdentity(dependency.fromLock, call.argumentIdentities, fallback, from))
        result.certainty = "unresolved_identity";
    if (!instantiateIdentity(dependency.toLock, call.argumentIdentities, fallback, to))
        result.certainty = "unresolved_identity";
    if (dependency.fromLock.find("unknown") != std::string::npos)
        from = "unknown-context@" + sourceKey(dependency.fromAcquisition) + "|call@" + sourceKey(call.location);
    if (dependency.toLock.find("unknown") != std::string::npos)
        to = "unknown-context@" + sourceKey(dependency.toAcquisition) + "|call@" + sourceKey(call.location);
    result.fromLock = std::move(from);
    result.toLock = std::move(to);
    result.reportingFunction = reportingFunction;
    result.origin = "inferred_through_call";
    result.throughCalls.insert(result.throughCalls.begin(), callStep(call));
    if (result.throughCalls.size() > MaxCallChain) {
        result.throughCalls.resize(MaxCallChain);
        result.provenanceTruncated = true;
    }
    result.fromLock = scopeLocalActivation(result.fromLock, result.throughCalls,
                                           result.provenanceTruncated);
    result.toLock = scopeLocalActivation(result.toLock, result.throughCalls,
                                         result.provenanceTruncated);
    if (result.provenanceTruncated &&
        (result.fromLock.find("local@") != std::string::npos ||
         result.toLock.find("local@") != std::string::npos))
        result.certainty = "unresolved_identity";
    return result;
}

FlowState mergePredecessors(const std::vector<unsigned> &predecessors,
                            const std::vector<FlowState> &outStates,
                            unsigned currentBlock, unsigned entryBlock) {
    if (currentBlock == entryBlock) {
        FlowState entry;
        entry.reachable = true;
        return entry;
    }
    FlowState merged;
    bool first = true;
    for (unsigned predecessor : predecessors) {
        if (predecessor >= outStates.size() || !outStates[predecessor].reachable)
            continue;
        const FlowState &state = outStates[predecessor];
        if (first) {
            merged = state;
            first = false;
        } else {
            merged.heldFactKeys.insert(state.heldFactKeys.begin(), state.heldFactKeys.end());
            std::set<std::string> intersection;
            std::set_intersection(merged.mustReleased.begin(), merged.mustReleased.end(),
                                  state.mustReleased.begin(), state.mustReleased.end(),
                                  std::inserter(intersection, intersection.end()));
            merged.mustReleased = std::move(intersection);
        }
    }
    return merged;
}

SummaryData summarizeFunction(
    const FunctionInfo &function,
    const std::unordered_map<std::string, const CallInfo *> &calls,
    const std::unordered_map<std::size_t, const ApiOperation *> &apis,
    const std::unordered_map<std::string, SummaryData> &summaries) {
    SummaryData summary;
    if (!function.cfgAvailable || function.cfg.empty()) {
        summary.uncertainties.insert("CFG unavailable for function " + function.qualifiedName);
        return summary;
    }
    if (!function.cfgEventsComplete)
        summary.uncertainties.insert("one or more call events could not be mapped into the CFG");

    std::unordered_map<unsigned, std::vector<unsigned>> predecessors;
    std::unordered_map<unsigned, std::vector<const FunctionInfo::CFGBlock *>> blocksById;
    unsigned entry = function.entryBlock;
    for (const auto &block : function.cfg) {
        blocksById[block.id].push_back(&block);
        for (unsigned successor : block.successors)
            predecessors[successor].push_back(block.id);
    }
    unsigned exitBlock = function.cfg.back().id;
    for (const auto &block : function.cfg)
        if (block.isExit)
            exitBlock = block.id;

    unsigned maxBlock = 0;
    for (const auto &block : function.cfg)
        maxBlock = std::max(maxBlock, block.id);
    std::vector<FlowState> inStates(maxBlock + 1), outStates(maxBlock + 1);
    if (entry >= inStates.size()) {
        summary.uncertainties.insert("invalid CFG entry block for " + function.qualifiedName);
        return summary;
    }
    inStates[entry].reachable = true;
    std::deque<unsigned> worklist{entry};
    std::vector<bool> queued(maxBlock + 1, false);
    queued[entry] = true;
    std::map<std::string, AcquisitionFact> allFacts;

    auto addDependency = [&](const AcquisitionFact &from, const AcquisitionFact &to,
                             bool throughCall) {
        LockDependency dependency;
        dependency.fromLock = from.lockIdentity;
        dependency.toLock = to.lockIdentity;
        dependency.reportingFunction = function.qualifiedName;
        dependency.originFunction = to.function;
        dependency.fromAcquisition = from.location;
        dependency.toAcquisition = to.location;
        dependency.throughCalls = from.throughCalls;
        dependency.throughCalls.insert(dependency.throughCalls.end(),
                                       to.throughCalls.begin(), to.throughCalls.end());
        if (dependency.throughCalls.size() > MaxCallChain) {
            dependency.throughCalls.resize(MaxCallChain);
            dependency.provenanceTruncated = true;
        }
        dependency.origin = throughCall || !from.throughCalls.empty() || !to.throughCalls.empty()
            ? "inferred_through_call" : "direct";
        dependency.certainty = (from.identityStatus == "unresolved" ||
                                to.identityStatus == "unresolved")
            ? "unresolved_identity" : "possible";
        summary.dependencies.emplace(dependencyKey(dependency), std::move(dependency));
    };

    std::size_t processed = 0;
    const std::size_t workLimit = std::max<std::size_t>(256, function.cfg.size() * 128);
    while (!worklist.empty() && processed++ < workLimit) {
        const unsigned blockId = worklist.front();
        worklist.pop_front();
        queued[blockId] = false;
        auto blockIt = blocksById.find(blockId);
        if (blockIt == blocksById.end() || blockIt->second.empty())
            continue;
        FlowState state = inStates[blockId];
        for (const auto &blockPointer : blockIt->second) {
            const auto &block = *blockPointer;
            for (std::size_t callIndex : block.callEvents) {
                auto apiIt = apis.find(callIndex);
                if (apiIt != apis.end()) {
                    const ApiOperation &api = *apiIt->second;
                    if (!api.lock || api.lock->identityTemplate.empty())
                        continue;
                    const std::string identity = api.lock->identityTemplate;
                    if (api.kind == "lock_acquire" || api.kind == "lock_acquire_irqsave" ||
                        api.kind == "lock_acquire_softirq_disable") {
                        AcquisitionFact fact{identity, api.lock->identityStatus,
                                             function.qualifiedName, api.lock->location, {}, false};
                        const std::string key = factKey(fact);
                        allFacts[key] = fact;
                        summary.acquisitions[key] = fact;
                        for (const auto &heldKey : state.heldFactKeys) {
                            auto held = allFacts.find(heldKey);
                            if (held != allFacts.end())
                                addDependency(held->second, fact, false);
                        }
                        state.heldFactKeys.insert(key);
                        state.mustReleased.erase(identity);
                        if (api.lock->identityStatus == "unresolved")
                            summary.uncertainties.insert("lock identity unresolved at " + sourceKey(api.location));
                    } else if (api.kind == "lock_release" ||
                               api.kind == "lock_release_irqrestore") {
                        ReleaseFact release{identity, api.lock->identityStatus,
                                            function.qualifiedName, api.lock->location, {}, false};
                        summary.releases[releaseKey(release)] = release;
                        for (auto held = state.heldFactKeys.begin(); held != state.heldFactKeys.end();) {
                            auto fact = allFacts.find(*held);
                            if (fact != allFacts.end() && fact->second.lockIdentity == identity)
                                held = state.heldFactKeys.erase(held);
                            else
                                ++held;
                        }
                        state.mustReleased.insert(identity);
                    }
                    continue;
                }

                auto callIt = calls.find(std::to_string(callIndex));
                if (callIt == calls.end())
                    continue;
                const CallInfo &call = *callIt->second;
                if (call.modeledApi)
                    continue;
                if (call.targetIds.empty()) {
                    std::string uncertainty = "unresolved call '" + call.calleeExpression +
                        "' at " + sourceKey(call.location);
                    if (!state.heldFactKeys.empty())
                        uncertainty += " while holding " + std::to_string(state.heldFactKeys.size()) + " lock(s)";
                    summary.uncertainties.insert(std::move(uncertainty));
                    continue;
                }

                std::vector<const SummaryData *> candidates;
                bool hasUnknownCandidate = false;
                for (const auto &targetId : call.targetIds) {
                    if (targetId.rfind("external:", 0) == 0) {
                        hasUnknownCandidate = true;
                        continue;
                    }
                    auto targetSummary = summaries.find(targetId);
                    if (targetSummary == summaries.end()) {
                        hasUnknownCandidate = true;
                        continue;
                    }
                    candidates.push_back(&targetSummary->second);
                }
                if (hasUnknownCandidate) {
                    std::string uncertainty = "call to external or unavailable body '" + call.callee +
                        "' at " + sourceKey(call.location);
                    if (!state.heldFactKeys.empty())
                        uncertainty += " while holding " + std::to_string(state.heldFactKeys.size()) + " lock(s)";
                    summary.uncertainties.insert(std::move(uncertainty));
                }
                if (candidates.empty())
                    continue;

                std::set<std::string> releasedByEveryTarget;
                bool firstCandidate = true;
                std::map<std::string, AcquisitionFact> returnFacts;
                for (const SummaryData *candidate : candidates) {
                    for (const auto &dependencyEntry : candidate->dependencies) {
                        auto dependency = instantiateDependency(dependencyEntry.second, call,
                                                                function.qualifiedName);
                        summary.dependencies.emplace(dependencyKey(dependency), std::move(dependency));
                    }
                    for (const auto &uncertainty : candidate->uncertainties)
                        summary.uncertainties.insert("via call " + call.callee + " at " +
                                                     sourceKey(call.location) + ": " + uncertainty);
                    for (const auto &acquisitionEntry : candidate->acquisitions) {
                        auto fact = instantiateFact(acquisitionEntry.second, call);
                        const auto key = factKey(fact);
                        allFacts[key] = fact;
                        summary.acquisitions[key] = fact;
                        for (const auto &heldKey : state.heldFactKeys) {
                            auto held = allFacts.find(heldKey);
                            if (held != allFacts.end())
                                addDependency(held->second, fact, true);
                        }
                    }
                    for (const auto &releaseEntry : candidate->releases) {
                        auto release = instantiateRelease(releaseEntry.second, call);
                        summary.releases[releaseKey(release)] = std::move(release);
                    }
                    for (const auto &heldEntry : candidate->heldOnReturn) {
                        auto fact = instantiateFact(heldEntry.second, call);
                        returnFacts[factKey(fact)] = std::move(fact);
                    }
                    std::set<std::string> instantiatedReleases;
                    for (const auto &identity : candidate->releasedOnAllReturns) {
                        std::string instantiated;
                        const std::string fallback = "unknown@" + sourceKey(call.location);
                        if (instantiateIdentity(identity, call.argumentIdentities, fallback, instantiated))
                            instantiatedReleases.insert(std::move(instantiated));
                    }
                    if (firstCandidate) {
                        releasedByEveryTarget = std::move(instantiatedReleases);
                        firstCandidate = false;
                    } else {
                        std::set<std::string> intersection;
                        std::set_intersection(releasedByEveryTarget.begin(), releasedByEveryTarget.end(),
                                              instantiatedReleases.begin(),
                                              instantiatedReleases.end(),
                                              std::inserter(intersection, intersection.end()));
                        releasedByEveryTarget = std::move(intersection);
                    }
                }
                if (hasUnknownCandidate)
                    releasedByEveryTarget.clear();
                for (auto held = state.heldFactKeys.begin(); held != state.heldFactKeys.end();) {
                    auto fact = allFacts.find(*held);
                    if (fact != allFacts.end() && releasedByEveryTarget.count(fact->second.lockIdentity))
                        held = state.heldFactKeys.erase(held);
                    else
                        ++held;
                }
                state.mustReleased.insert(releasedByEveryTarget.begin(), releasedByEveryTarget.end());
                for (const auto &returnFact : returnFacts) {
                    allFacts[returnFact.first] = returnFact.second;
                    state.heldFactKeys.insert(returnFact.first);
                    state.mustReleased.erase(returnFact.second.lockIdentity);
                }
            }
        }
        if (!(outStates[blockId] == state)) {
            outStates[blockId] = state;
            for (const auto &blockPointer : blockIt->second) {
                for (unsigned successor : blockPointer->successors) {
                    if (successor >= inStates.size() || successor == entry)
                        continue;
                    auto predIt = predecessors.find(successor);
                    if (predIt == predecessors.end())
                        continue;
                    FlowState merged = mergePredecessors(predIt->second, outStates,
                                                         successor, entry);
                    if (!(merged == inStates[successor])) {
                        inStates[successor] = std::move(merged);
                        if (!queued[successor]) {
                            worklist.push_back(successor);
                            queued[successor] = true;
                        }
                    }
                }
            }
        }
    }
    if (processed >= workLimit)
        summary.uncertainties.insert("CFG dataflow iteration limit reached for " + function.qualifiedName);

    if (exitBlock < outStates.size() && outStates[exitBlock].reachable) {
        for (const auto &key : outStates[exitBlock].heldFactKeys) {
            auto fact = allFacts.find(key);
            if (fact != allFacts.end())
                summary.heldOnReturn[key] = fact->second;
        }
        summary.releasedOnAllReturns = outStates[exitBlock].mustReleased;
    }
    return summary;
}

std::string locationText(const LocatedSource &location) {
    return sourceKey(location);
}

} // namespace

void analyzeInterprocedural(AnalysisResult &result) {
    std::unordered_map<std::string, const FunctionInfo *> functions;
    std::unordered_set<std::string> functionIds;
    for (const auto &function : result.functions) {
        functions[function.id] = &function;
        functionIds.insert(function.id);
        result.callGraphNodes.push_back({function.id, function.qualifiedName, true});
    }

    std::unordered_map<std::string, const CallInfo *> calls;
    for (std::size_t index = 0; index < result.calls.size(); ++index)
        calls[std::to_string(index)] = &result.calls[index];
    std::unordered_map<std::size_t, const ApiOperation *> apis;
    for (const auto &api : result.apiOperations)
        apis[api.callIndex] = &api;

    std::unordered_map<std::string, std::string> nodeNames;
    for (const auto &node : result.callGraphNodes)
        nodeNames[node.id] = node.name;
    for (const auto &call : result.calls) {
        if (call.callerId.empty())
            continue;
        std::vector<std::string> targets = call.targetIds;
        if (targets.empty())
            targets.push_back("unresolved:" + call.callerId + "@" + locationText(call.location));
        for (std::size_t index = 0; index < targets.size(); ++index) {
            const std::string &targetId = targets[index];
            const std::string targetName = index < call.targetNames.size()
                ? call.targetNames[index] : call.calleeExpression;
            if (!nodeNames.count(targetId)) {
                nodeNames[targetId] = targetName;
                result.callGraphNodes.push_back({targetId, targetName,
                                                  functionIds.count(targetId) != 0});
            }
            result.callGraphEdges.push_back({call.callerId, targetId, targetName,
                                             call.resolution, call.location});
        }
    }

    std::unordered_map<std::string, SummaryData> summaries;
    for (const auto &function : result.functions)
        summaries.emplace(function.id, SummaryData{});

    bool converged = false;
    const std::size_t maxIterations = std::min<std::size_t>(128,
        std::max<std::size_t>(16, result.functions.size() + 8));
    for (std::size_t iteration = 0; iteration < maxIterations; ++iteration) {
        bool changed = false;
        auto next = summaries;
        for (const auto &function : result.functions) {
            SummaryData computed = summarizeFunction(function, calls, apis, summaries);
            if (!sameSummary(computed, summaries[function.id]))
                changed = true;
            next[function.id] = std::move(computed);
        }
        summaries = std::move(next);
        if (!changed) {
            converged = true;
            break;
        }
    }

    for (const auto &function : result.functions) {
        const SummaryData &summary = summaries[function.id];
        FunctionSummaryInfo output;
        output.functionId = function.id;
        output.function = function.qualifiedName;
        output.converged = converged;
        for (const auto &entry : summary.acquisitions)
            output.acquisitions.push_back(entry.second);
        for (const auto &entry : summary.releases)
            output.releases.push_back(entry.second);
        for (const auto &entry : summary.heldOnReturn)
            output.heldOnReturn.push_back(entry.second);
        output.releasedOnAllReturns.assign(summary.releasedOnAllReturns.begin(),
                                           summary.releasedOnAllReturns.end());
        for (const auto &entry : summary.dependencies) {
            output.dependencies.push_back(entry.second);
            result.lockDependencies.push_back(entry.second);
        }
        output.uncertainties.assign(summary.uncertainties.begin(), summary.uncertainties.end());
        for (const auto &uncertainty : output.uncertainties)
            result.uncertainties.push_back(function.qualifiedName + ": " + uncertainty);
        if (!converged) {
            output.uncertainties.push_back("interprocedural summary fixed point did not converge within " +
                                           std::to_string(maxIterations) + " iterations");
            result.uncertainties.push_back(function.qualifiedName +
                                           ": summary fixed point did not converge");
        }
        result.functionSummaries.push_back(std::move(output));
    }
}

} // namespace deadlock
