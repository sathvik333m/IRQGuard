#include "deadlock/Output.h"

#include <iomanip>
#include <algorithm>
#include <cstdint>
#include <limits>
#include <map>
#include <regex>
#include <set>
#include <sstream>

namespace deadlock {
namespace {

struct UncertaintyRecordView {
    std::string id;
    std::string category;
    std::string reason;
    std::string stage;
    std::string impact;
    std::string severity;
    std::string explanation;
    std::string key;
    std::string sourceFile;
    unsigned line = 0;
    unsigned column = 0;
    std::string function;
    std::string api;
    std::size_t events = 0;
    std::size_t propagated = 0;
    std::vector<std::string> examples;
    std::set<std::string> findings;
};

struct UncertaintyClass {
    const char *marker;
    const char *category;
    const char *reason;
    const char *stage;
    const char *impact;
    const char *severity;
    const char *explanation;
};

const UncertaintyClass uncertaintyClasses[] = {
    {"call to external or unavailable body", "unresolved_call", "missing_body", "interprocedural",
     "potential_lock_or_irq_effect", "medium", "A called function body is unavailable, so its effects cannot be summarized."},
    {"unresolved call '", "unresolved_call", "indirect_target_unknown", "interprocedural",
     "potential_lock_or_irq_effect", "high", "The call target could not be resolved; it may change held locks or interrupt state."},
    {"lock identity unresolved", "lock_identity", "lock_expression_unresolved", "lock_extraction",
     "lock_identity_and_edges", "high", "The lock expression could not be mapped to a stable lock identity."},
    {"irqsave flags argument unresolved", "interrupt_state", "saved_flags_unresolved", "interrupt_state",
     "interrupt_state", "high", "The irqsave operation was found, but its saved interrupt-state value is unknown."},
    {"irqrestore has no matching saved state", "interrupt_state", "restore_state_unmatched", "interrupt_state",
     "interrupt_state", "high", "The restore does not match a saved-state identity in the modeled path."},
    {"local_irq_save flags expression unresolved", "interrupt_state", "saved_flags_unresolved", "interrupt_state",
     "interrupt_state", "high", "The local IRQ save value could not be identified."},
    {"local_irq_restore has no matching saved state", "interrupt_state", "restore_state_unmatched", "interrupt_state",
     "interrupt_state", "high", "The local IRQ restore does not match a saved-state identity."},
    {"unmodeled call may alter IRQ state", "interrupt_state", "unknown_call_irq_effect", "interrupt_state",
     "interrupt_state", "high", "An unmodeled call may change interrupt state."},
    {"interrupt teardown/lifecycle", "handler_lifecycle", "teardown_not_modeled", "handler_discovery",
     "handler_lifecycle", "medium", "Interrupt handler deregistration timing is not modeled."},
    {"unresolved interrupt handler registration", "handler_resolution", "registration_unresolved", "handler_discovery",
     "handler_identity", "high", "The registered interrupt handler target could not be resolved."},
    {"handler target for '", "handler_resolution", "handler_target_unresolved", "handler_discovery",
     "handler_identity", "high", "A handler argument could not be resolved to a function definition."},
    {"possibly unsupported lock/IRQ API", "unsupported_api", "api_semantics_missing", "api_model",
     "heuristic_name_match_may_be_false_positive", "medium", "An API name matched a lock/IRQ warning heuristic, but its semantics are not modeled."},
    {"call events could not be mapped into the CFG", "control_flow", "cfg_event_unmapped", "control_flow",
     "path_and_dependency_analysis", "high", "A call event is absent from the CFG mapping, limiting path and summary analysis."},
    {"IRQ-state analysis has unmapped call events", "control_flow", "cfg_event_unmapped", "control_flow",
     "interrupt_state", "high", "IRQ-state transfer could not map all calls to CFG events."},
    {"CFG unavailable", "control_flow", "cfg_unavailable", "control_flow",
     "path_and_dependency_analysis", "high", "Control-flow data is unavailable for this function."},
    {"fixed point did not converge", "analysis_limit", "summary_nonconvergence", "summary_propagation",
     "lock_and_interrupt_summaries", "high", "The bounded summary iteration did not converge."},
    {"iteration limit reached", "analysis_limit", "iteration_limit", "summary_propagation",
     "lock_and_interrupt_summaries", "high", "A bounded analysis iteration limit was reached."},
    {"capped at", "analysis_limit", "output_or_search_cap", "graph_search",
     "candidate_completeness", "high", "An output or graph search cap may omit additional results."},
};

std::string trim(std::string value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return {};
    const auto last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1);
}

std::string causeText(const std::string &message, const UncertaintyClass &classification) {
    const auto marker = message.find(classification.marker);
    std::string cause = marker == std::string::npos ? message : message.substr(marker);
    const auto held = cause.find(" while holding ");
    if (held != std::string::npos) cause.erase(held);
    const auto configHint = cause.find("; add an explicit API model");
    if (configHint != std::string::npos) cause.erase(configHint);
    return trim(std::move(cause));
}

std::string stableHash(const std::string &value) {
    std::uint64_t hash = 14695981039346656037ull;
    for (unsigned char byte : value) {
        hash ^= byte;
        hash *= 1099511628211ull;
    }
    std::ostringstream out;
    out << std::hex << std::setw(16) << std::setfill('0') << hash;
    return out.str();
}

void parseIssueLocation(UncertaintyRecordView &record) {
    static const std::regex suffix(R"(([^\s]+):([0-9]+):([0-9]+))");
    std::smatch match;
    std::string::const_iterator begin = record.key.begin();
    std::string::const_iterator end = record.key.end();
    std::smatch lastMatch;
    bool found = false;
    while (std::regex_search(begin, end, match, suffix)) {
        lastMatch = match;
        found = true;
        begin = match.suffix().first;
    }
    if (!found) return;
    try {
        record.sourceFile = lastMatch[1].str();
        record.line = static_cast<unsigned>(std::stoul(lastMatch[2].str()));
        record.column = static_cast<unsigned>(std::stoul(lastMatch[3].str()));
    } catch (...) {
        record.sourceFile.clear();
        record.line = record.column = 0;
    }
}

std::string quotedOperand(const std::string &cause) {
    const auto first = cause.find('\'');
    if (first == std::string::npos) return {};
    const auto last = cause.find('\'', first + 1);
    return last == std::string::npos ? std::string{} : cause.substr(first + 1, last - first - 1);
}

std::string enclosingFunction(const std::string &message) {
    std::string prefix = message;
    if (prefix.rfind("IRQ state ", 0) == 0) prefix.erase(0, 10);
    const auto delimiter = prefix.find(": ");
    if (delimiter == std::string::npos) return {};
    prefix.erase(delimiter);
    if (prefix.find(" at ") != std::string::npos) return {};
    const auto via = prefix.find(" via ");
    if (via != std::string::npos) prefix.erase(via);
    return prefix;
}

std::vector<UncertaintyRecordView> uncertaintyRecords(const AnalysisResult &result) {
    std::map<std::string, UncertaintyRecordView> grouped;
    std::map<std::string, std::size_t> representativeScore;
    for (const auto &message : result.uncertainties) {
        const UncertaintyClass *classification = nullptr;
        for (const auto &candidate : uncertaintyClasses) {
            if (message.find(candidate.marker) != std::string::npos) {
                classification = &candidate;
                break;
            }
        }
        static const UncertaintyClass other{
            "", "other", "unclassified", "analysis", "unknown", "medium",
            "The uncertainty was retained but did not match a known diagnostic rule."};
        if (!classification) classification = &other;
        const std::string cause = causeText(message, *classification);
        const std::string groupKey = std::string(classification->category) + "|" + cause;
        auto inserted = grouped.emplace(groupKey, UncertaintyRecordView{});
        auto &record = inserted.first->second;
        if (inserted.second) {
            record.category = classification->category;
            record.reason = classification->reason;
            record.stage = classification->stage;
            record.impact = classification->impact;
            record.severity = classification->severity;
            record.explanation = classification->explanation;
            record.key = cause;
            record.id = "U-" + stableHash(groupKey);
            parseIssueLocation(record);
            record.api = quotedOperand(cause);
            representativeScore[groupKey] = std::numeric_limits<std::size_t>::max();
        }
        ++record.events;
        if (message.find("via call ") != std::string::npos || message.find(": via ") != std::string::npos)
            ++record.propagated;
        if (record.examples.size() < 3) record.examples.push_back(message);
        const auto viaCount = static_cast<std::size_t>(std::count(message.begin(), message.end(), ':'));
        const auto score = (message.find("via call ") == std::string::npos ? 0u : 1000u) + viaCount;
        if (score < representativeScore[groupKey]) {
            representativeScore[groupKey] = score;
            record.function = enclosingFunction(message);
        }
        if (message.find(" while holding ") != std::string::npos) {
            record.severity = "high";
            record.impact = "lock_held_across_unknown_call";
        }
    }

    for (std::size_t i = 0; i < result.interruptCycles.size(); ++i) {
        const std::string findingId = "C-" + std::to_string(i + 1);
        const auto &cycle = result.interruptCycles[i];
        std::string cycleEvidence;
        for (const auto &lock : cycle.lockSequence) cycleEvidence += lock + "\n";
        for (const auto edgeIndex : cycle.edgeIndexes) {
            if (edgeIndex >= result.interruptLockEdges.size()) continue;
            const auto &edge = result.interruptLockEdges[edgeIndex];
            cycleEvidence += edge.fromLocation.expansion.file + ":" +
                std::to_string(edge.fromLocation.expansion.line) + ":" +
                std::to_string(edge.fromLocation.expansion.column) + "\n";
            cycleEvidence += edge.toLocation.expansion.file + ":" +
                std::to_string(edge.toLocation.expansion.line) + ":" +
                std::to_string(edge.toLocation.expansion.column) + "\n";
        }
        for (auto &entry : grouped) {
            auto &record = entry.second;
            if (record.sourceFile.empty() || record.line == 0) continue;
            const std::string site = record.sourceFile + ":" + std::to_string(record.line) + ":";
            if (cycleEvidence.find(site) != std::string::npos) record.findings.insert(findingId);
        }
    }

    for (auto &entry : grouped) {
        auto &record = entry.second;
        if (!record.findings.empty()) {
            record.severity = "high";
            record.impact += "; candidate evidence overlaps this uncertainty source location";
        }
        for (const auto &api : result.apiOperations) {
            const auto &location = api.location.expansion;
            if (location.valid && location.file == record.sourceFile &&
                location.line == record.line && location.column == record.column) {
                if (record.function.empty()) record.function = api.caller;
                if (record.api.empty()) record.api = api.api;
                if (api.lock && record.key.find("lock identity unresolved") != std::string::npos)
                    record.api += ": " + api.lock->text;
            }
        }
        if (record.function.empty()) {
            for (const auto &call : result.calls) {
                const auto &location = call.location.expansion;
                if (location.valid && location.file == record.sourceFile &&
                    location.line == record.line && location.column == record.column) {
                    record.function = call.caller;
                    if (record.api.empty()) record.api = call.calleeExpression;
                    break;
                }
            }
        }
    }

    std::vector<UncertaintyRecordView> records;
    records.reserve(grouped.size());
    for (auto &entry : grouped) records.push_back(std::move(entry.second));
    return records;
}

std::string quote(const std::string &value) {
    std::ostringstream out;
    out << '"';
    for (unsigned char c : value) {
        switch (c) {
        case '"': out << "\\\""; break;
        case '\\': out << "\\\\"; break;
        case '\b': out << "\\b"; break;
        case '\f': out << "\\f"; break;
        case '\n': out << "\\n"; break;
        case '\r': out << "\\r"; break;
        case '\t': out << "\\t"; break;
        default:
            if (c < 0x20) out << "\\u" << std::hex << std::setw(4)
                              << std::setfill('0') << static_cast<int>(c) << std::dec;
            else out << static_cast<char>(c);
        }
    }
    out << '"';
    return out.str();
}

void simpleLocation(std::ostringstream &out, const SourceLocation &location) {
    out << "{\"file\":" << quote(location.file) << ",\"line\":" << location.line
        << ",\"column\":" << location.column << ",\"valid\":"
        << (location.valid ? "true" : "false") << '}';
}

void locationJson(std::ostringstream &out, const LocatedSource &location) {
    out << "{\"is_macro\":" << (location.isMacro ? "true" : "false")
        << ",\"expansion\":";
    simpleLocation(out, location.expansion);
    out << ",\"spelling\":";
    simpleLocation(out, location.spelling);
    out << '}';
}

void provenanceJson(std::ostringstream &out, const std::vector<ProvenanceStep> &steps) {
    out << '[';
    for (std::size_t i = 0; i < steps.size(); ++i) {
        if (i) out << ',';
        out << "{\"function\":" << quote(steps[i].function)
            << ",\"callee\":" << quote(steps[i].callee) << ",\"location\":";
        locationJson(out, steps[i].location);
        out << '}';
    }
    out << ']';
}

void acquisitionJson(std::ostringstream &out, const AcquisitionFact &fact) {
    out << "{\"lock_identity\":" << quote(fact.lockIdentity)
        << ",\"identity_status\":" << quote(fact.identityStatus)
        << ",\"function\":" << quote(fact.function) << ",\"location\":";
    locationJson(out, fact.location);
    out << ",\"through_calls\":";
    provenanceJson(out, fact.throughCalls);
    out << ",\"provenance_truncated\":"
        << (fact.provenanceTruncated ? "true" : "false") << '}';
}

void releaseJson(std::ostringstream &out, const ReleaseFact &fact) {
    out << "{\"lock_identity\":" << quote(fact.lockIdentity)
        << ",\"identity_status\":" << quote(fact.identityStatus)
        << ",\"function\":" << quote(fact.function) << ",\"location\":";
    locationJson(out, fact.location);
    out << ",\"through_calls\":";
    provenanceJson(out, fact.throughCalls);
    out << ",\"provenance_truncated\":"
        << (fact.provenanceTruncated ? "true" : "false") << '}';
}

void dependencyJson(std::ostringstream &out, const LockDependency &dependency) {
    out << "{\"from_lock\":" << quote(dependency.fromLock)
        << ",\"to_lock\":" << quote(dependency.toLock)
        << ",\"reporting_function\":" << quote(dependency.reportingFunction)
        << ",\"origin_function\":" << quote(dependency.originFunction)
        << ",\"origin\":" << quote(dependency.origin)
        << ",\"certainty\":" << quote(dependency.certainty)
        << ",\"provenance_truncated\":" << (dependency.provenanceTruncated ? "true" : "false")
        << ",\"from_acquisition\":";
    locationJson(out, dependency.fromAcquisition);
    out << ",\"to_acquisition\":";
    locationJson(out, dependency.toAcquisition);
    out << ",\"through_calls\":";
    provenanceJson(out, dependency.throughCalls);
    out << '}';
}

template <typename Range, typename WriteItem>
void arrayJson(std::ostringstream &out, const Range &range, WriteItem writeItem) {
    out << '[';
    bool first = true;
    for (const auto &item : range) {
        if (!first) out << ',';
        first = false;
        writeItem(item);
    }
    out << ']';
}

void registrationJson(std::ostringstream &out, const InterruptRegistration &registration) {
    out << "{\"api\":" << quote(registration.api)
        << ",\"caller\":" << quote(registration.caller)
        << ",\"irq_expression\":" << quote(registration.irqExpression)
        << ",\"resolution\":" << quote(registration.resolution)
        << ",\"handler_ids\":";
    arrayJson(out, registration.handlerIds, [&](const std::string &value) { out << quote(value); });
    out << ",\"handler_names\":";
    arrayJson(out, registration.handlerNames, [&](const std::string &value) { out << quote(value); });
    out << ",\"location\":";
    locationJson(out, registration.location);
    out << '}';
}

void snapshotJson(std::ostringstream &out, const InterruptStateSnapshot &snapshot) {
    out << "{\"lock_identity\":" << quote(snapshot.lockIdentity)
        << ",\"identity_status\":" << quote(snapshot.identityStatus)
        << ",\"context\":" << quote(snapshot.context)
        << ",\"irq_state\":" << quote(snapshot.irqState)
        << ",\"source_function\":" << quote(snapshot.sourceFunction)
        << ",\"origin_function\":" << quote(snapshot.originFunction)
        << ",\"location\":";
    locationJson(out, snapshot.location);
    out << ",\"through_calls\":";
    provenanceJson(out, snapshot.throughCalls);
    out << ",\"provenance_truncated\":"
        << (snapshot.provenanceTruncated ? "true" : "false") << '}';
}

void interruptEdgeJson(std::ostringstream &out, const InterruptLockEdge &edge) {
    out << "{\"from_lock\":" << quote(edge.fromLock)
        << ",\"to_lock\":" << quote(edge.toLock)
        << ",\"kind\":" << quote(edge.kind)
        << ",\"from_context\":" << quote(edge.fromContext)
        << ",\"to_context\":" << quote(edge.toContext)
        << ",\"source_function\":" << quote(edge.sourceFunction)
        << ",\"target_function\":" << quote(edge.targetFunction)
        << ",\"handler\":" << quote(edge.handler)
        << ",\"irq_state\":" << quote(edge.irqState)
        << ",\"certainty\":" << quote(edge.certainty)
        << ",\"feasibility\":" << quote(edge.feasibility)
        << ",\"feasibility_reason\":" << quote(edge.feasibilityReason)
        << ",\"from_location\":";
    locationJson(out, edge.fromLocation);
    out << ",\"to_location\":";
    locationJson(out, edge.toLocation);
    out << ",\"registration_location\":";
    locationJson(out, edge.registrationLocation);
    out << ",\"source_provenance\":";
    provenanceJson(out, edge.sourceProvenance);
    out << ",\"target_provenance\":";
    provenanceJson(out, edge.targetProvenance);
    out << '}';
}

} // namespace

std::string toJson(const AnalysisResult &result) {
    std::ostringstream out;
    const auto uncertaintyReport = uncertaintyRecords(result);
    std::map<std::string, std::pair<std::size_t, std::size_t>> byUncertaintyCategory;
    std::map<std::string, std::pair<std::size_t, std::size_t>> byUncertaintyStage;
    std::size_t highImpactRecords = 0;
    std::size_t lockIdentityEvents = 0;
    std::size_t interruptStateEvents = 0;
    std::size_t unresolvedCallEvents = 0;
    std::size_t candidateAffectingRecords = 0;
    std::size_t candidateRecordAssociations = 0;
    std::set<std::string> affectedCandidates;
    for (const auto &record : uncertaintyReport) {
        auto &category = byUncertaintyCategory[record.category];
        category.first += record.events;
        ++category.second;
        auto &stage = byUncertaintyStage[record.stage];
        stage.first += record.events;
        ++stage.second;
        if (record.severity == "high") ++highImpactRecords;
        if (record.category == "lock_identity") lockIdentityEvents += record.events;
        if (record.category == "interrupt_state") interruptStateEvents += record.events;
        if (record.category == "unresolved_call") unresolvedCallEvents += record.events;
        if (!record.findings.empty()) {
            ++candidateAffectingRecords;
            candidateRecordAssociations += record.findings.size();
            affectedCandidates.insert(record.findings.begin(), record.findings.end());
        }
    }

    out << "{\n  \"schema_version\":4,\n  \"source\":" << quote(result.source)
        << ",\n  \"analysis_kind\":\"interrupt_aware_lock_analysis\",\n  \"functions\":[";
    for (std::size_t i = 0; i < result.functions.size(); ++i) {
        const auto &item = result.functions[i];
        if (i) out << ',';
        out << "\n    {\"id\":" << quote(item.id) << ",\"name\":" << quote(item.name)
            << ",\"qualified_name\":" << quote(item.qualifiedName)
            << ",\"return_type\":" << quote(item.returnType) << ",\"parameters\":";
        arrayJson(out, item.parameters, [&](const std::string &value) { out << quote(value); });
        out << ",\"cfg_available\":" << (item.cfgAvailable ? "true" : "false")
            << ",\"cfg_events_complete\":" << (item.cfgEventsComplete ? "true" : "false")
            << ",\"location\":";
        locationJson(out, item.location);
        out << '}';
    }
    if (!result.functions.empty()) out << '\n' << "  ";
    out << "],\n  \"calls\":[";
    for (std::size_t i = 0; i < result.calls.size(); ++i) {
        const auto &item = result.calls[i];
        if (i) out << ',';
        out << "\n    {\"caller\":" << quote(item.caller)
            << ",\"caller_id\":" << quote(item.callerId)
            << ",\"callee\":" << quote(item.callee)
            << ",\"callee_expression\":" << quote(item.calleeExpression)
            << ",\"resolution\":" << quote(item.resolution)
            << ",\"modeled_api\":" << (item.modeledApi ? "true" : "false")
            << ",\"target_ids\":";
        arrayJson(out, item.targetIds, [&](const std::string &value) { out << quote(value); });
        out << ",\"target_names\":";
        arrayJson(out, item.targetNames, [&](const std::string &value) { out << quote(value); });
        out << ",\"argument_identities\":";
        arrayJson(out, item.argumentIdentities, [&](const std::string &value) { out << quote(value); });
        out << ",\"location\":";
        locationJson(out, item.location);
        out << '}';
    }
    if (!result.calls.empty()) out << '\n' << "  ";
    out << "],\n  \"api_operations\":[";
    for (std::size_t i = 0; i < result.apiOperations.size(); ++i) {
        const auto &item = result.apiOperations[i];
        if (i) out << ',';
        out << "\n    {\"api\":" << quote(item.api) << ",\"kind\":" << quote(item.kind)
            << ",\"caller\":" << quote(item.caller) << ",\"call_index\":" << item.callIndex
            << ",\"state_argument\":" << item.stateArgument
            << ",\"state_expression\":" << quote(item.stateExpression)
            << ",\"state_identity\":" << quote(item.stateIdentity)
            << ",\"state_identity_status\":" << quote(item.stateIdentityStatus)
            << ",\"handler_argument\":" << item.handlerArgument
            << ",\"handler_resolution\":" << quote(item.handlerResolution)
            << ",\"arguments\":";
        arrayJson(out, item.arguments, [&](const std::string &value) { out << quote(value); });
        out << ",\"lock\":";
        if (item.lock) {
            out << "{\"expression\":" << quote(item.lock->text)
                << ",\"syntax\":" << quote(item.lock->syntax)
                << ",\"identity_template\":" << quote(item.lock->identityTemplate)
                << ",\"identity_status\":" << quote(item.lock->identityStatus)
                << ",\"location\":";
            locationJson(out, item.lock->location);
            out << '}';
        } else out << "null";
        out << ",\"handler_target_ids\":";
        arrayJson(out, item.handlerTargetIds, [&](const std::string &value) { out << quote(value); });
        out << ",\"handler_target_names\":";
        arrayJson(out, item.handlerTargetNames, [&](const std::string &value) { out << quote(value); });
        out << ",\"location\":";
        locationJson(out, item.location);
        out << '}';
    }
    if (!result.apiOperations.empty()) out << '\n' << "  ";
    out << "],\n  \"control_constructs\":[";
    for (std::size_t i = 0; i < result.controls.size(); ++i) {
        const auto &item = result.controls[i];
        if (i) out << ',';
        out << "\n    {\"kind\":" << quote(item.kind) << ",\"condition\":"
            << quote(item.condition) << ",\"function\":" << quote(item.function)
            << ",\"location\":";
        locationJson(out, item.location);
        out << '}';
    }
    if (!result.controls.empty()) out << '\n' << "  ";
    out << "],\n  \"call_graph\":{\"nodes\":";
    arrayJson(out, result.callGraphNodes, [&](const CallGraphNode &node) {
        out << "{\"id\":" << quote(node.id) << ",\"name\":" << quote(node.name)
            << ",\"defined\":" << (node.defined ? "true" : "false") << '}';
    });
    out << ",\"edges\":";
    arrayJson(out, result.callGraphEdges, [&](const CallGraphEdge &edge) {
        out << "{\"caller_id\":" << quote(edge.callerId)
            << ",\"target_id\":" << quote(edge.targetId)
            << ",\"callee\":" << quote(edge.callee)
            << ",\"resolution\":" << quote(edge.resolution) << ",\"location\":";
        locationJson(out, edge.location);
        out << '}';
    });
    out << "},\n  \"function_summaries\":[";
    for (std::size_t i = 0; i < result.functionSummaries.size(); ++i) {
        const auto &summary = result.functionSummaries[i];
        if (i) out << ',';
        out << "\n    {\"function_id\":" << quote(summary.functionId)
            << ",\"function\":" << quote(summary.function)
            << ",\"converged\":" << (summary.converged ? "true" : "false")
            << ",\"acquisitions\":";
        arrayJson(out, summary.acquisitions, [&](const AcquisitionFact &fact) { acquisitionJson(out, fact); });
        out << ",\"releases\":";
        arrayJson(out, summary.releases, [&](const ReleaseFact &fact) { releaseJson(out, fact); });
        out << ",\"held_on_return\":";
        arrayJson(out, summary.heldOnReturn, [&](const AcquisitionFact &fact) { acquisitionJson(out, fact); });
        out << ",\"released_on_all_returns\":";
        arrayJson(out, summary.releasedOnAllReturns, [&](const std::string &value) { out << quote(value); });
        out << ",\"dependencies\":";
        arrayJson(out, summary.dependencies, [&](const LockDependency &dependency) { dependencyJson(out, dependency); });
        out << ",\"uncertainties\":";
        arrayJson(out, summary.uncertainties, [&](const std::string &value) { out << quote(value); });
        out << '}';
    }
    if (!result.functionSummaries.empty()) out << '\n' << "  ";
    out << "],\n  \"lock_dependencies\":";
    arrayJson(out, result.lockDependencies, [&](const LockDependency &dependency) { dependencyJson(out, dependency); });
    out << ",\n  \"interrupt_registrations\":";
    arrayJson(out, result.interruptRegistrations,
              [&](const InterruptRegistration &registration) { registrationJson(out, registration); });
    out << ",\n  \"interrupt_state_snapshots\":";
    arrayJson(out, result.interruptSnapshots,
              [&](const InterruptStateSnapshot &snapshot) { snapshotJson(out, snapshot); });
    out << ",\n  \"interrupt_lock_graph\":{\"nodes\":[";
    std::set<std::string> lockNodes;
    for (const auto &edge : result.interruptLockEdges) {
        lockNodes.insert(edge.fromLock);
        lockNodes.insert(edge.toLock);
    }
    bool firstNode = true;
    for (const auto &node : lockNodes) {
        if (!firstNode) out << ',';
        firstNode = false;
        out << "{\"lock_identity\":" << quote(node) << '}';
    }
    out << "],\"edges\":";
    arrayJson(out, result.interruptLockEdges,
              [&](const InterruptLockEdge &edge) { interruptEdgeJson(out, edge); });
    out << "},\n  \"interrupt_cycles\":";
    arrayJson(out, result.interruptCycles, [&](const InterruptCycle &cycle) {
        const auto cycleIndex = static_cast<std::size_t>(&cycle - result.interruptCycles.data());
        out << "{\"finding_id\":" << quote("C-" + std::to_string(cycleIndex + 1))
            << ",\"classification\":" << quote(cycle.classification)
            << ",\"category\":" << quote(cycle.category)
            << ",\"feasibility\":" << quote(cycle.feasibility)
            << ",\"contains_uncertain_edge\":" << (cycle.containsUncertainEdge ? "true" : "false")
            << ",\"explanation\":" << quote(cycle.explanation) << ",\"lock_sequence\":";
        arrayJson(out, cycle.lockSequence, [&](const std::string &value) { out << quote(value); });
        out << ",\"provenance_variants\":";
        arrayJson(out, cycle.provenanceVariants, [&](const std::vector<std::size_t> &variant) {
            arrayJson(out, variant, [&](std::size_t index) { out << index; });
        });
        out << ",\"edges\":[";
        bool first = true;
        for (auto index : cycle.edgeIndexes) {
            if (!first) out << ',';
            first = false;
            if (index < result.interruptLockEdges.size())
                interruptEdgeJson(out, result.interruptLockEdges[index]);
        }
        out << "]}";
    });
    out << ",\n  \"uncertainties\":";
    arrayJson(out, result.uncertainties, [&](const std::string &value) { out << quote(value); });
    out << ",\n  \"uncertainty_summary\":{\"event_count\":" << result.uncertainties.size()
        << ",\"unique_record_count\":" << uncertaintyReport.size()
        << ",\"propagated_event_count\":";
    std::size_t propagatedEvents = 0;
    for (const auto &record : uncertaintyReport) propagatedEvents += record.propagated;
    out << propagatedEvents << ",\"high_impact_unique_records\":" << highImpactRecords
        << ",\"lock_identity_events\":" << lockIdentityEvents
        << ",\"interrupt_state_events\":" << interruptStateEvents
        << ",\"unresolved_call_events\":" << unresolvedCallEvents
        << ",\"candidate_affecting_unique_records\":" << candidateAffectingRecords
        << ",\"candidate_record_association_count\":" << candidateRecordAssociations
        << ",\"affected_candidate_count\":" << affectedCandidates.size()
        << ",\"proven_non_affecting_event_count\":0,\"non_affecting_count_note\":"
        << quote("No uncertainty is marked non-affecting unless that can be established; none are proven non-affecting by this classifier.")
        << ",\"by_category\":{";
    bool firstCount = true;
    for (const auto &entry : byUncertaintyCategory) {
        if (!firstCount) out << ',';
        firstCount = false;
        out << quote(entry.first) << ":{\"event_count\":" << entry.second.first
            << ",\"unique_record_count\":" << entry.second.second << '}';
    }
    out << "},\"by_stage\":{";
    firstCount = true;
    for (const auto &entry : byUncertaintyStage) {
        if (!firstCount) out << ',';
        firstCount = false;
        out << quote(entry.first) << ":{\"event_count\":" << entry.second.first
            << ",\"unique_record_count\":" << entry.second.second << '}';
    }
    out << "}},\n  \"uncertainty_records\":[";
    for (std::size_t i = 0; i < uncertaintyReport.size(); ++i) {
        const auto &record = uncertaintyReport[i];
        if (i) out << ',';
        out << "\n    {\"id\":" << quote(record.id)
            << ",\"category\":" << quote(record.category)
            << ",\"reason\":" << quote(record.reason)
            << ",\"analysis_stage\":" << quote(record.stage)
            << ",\"severity\":" << quote(record.severity)
            << ",\"impact\":" << quote(record.impact)
            << ",\"explanation\":" << quote(record.explanation)
            << ",\"root_cause\":" << quote(record.key)
            << ",\"source_location\":{" << "\"file\":" << quote(record.sourceFile)
            << ",\"line\":" << record.line << ",\"column\":" << record.column
            << ",\"valid\":" << (!record.sourceFile.empty() ? "true" : "false") << '}'
            << ",\"enclosing_function\":" << quote(record.function)
            << ",\"api_or_expression\":" << quote(record.api)
            << ",\"event_count\":" << record.events
            << ",\"direct_event_count\":" << (record.events - record.propagated)
            << ",\"propagated_event_count\":" << record.propagated
            << ",\"has_repeated_propagation\":" << (record.propagated ? "true" : "false")
            << ",\"unique_record\":true,\"cause_identity_is_heuristic\":true,\"associated_findings\":[";
        bool firstFinding = true;
        for (const auto &finding : record.findings) {
            if (!firstFinding) out << ',';
            firstFinding = false;
            out << quote(finding);
        }
        out << "],\"example_events\":";
        arrayJson(out, record.examples, [&](const std::string &value) { out << quote(value); });
        out << '}';
    }
    if (!uncertaintyReport.empty()) out << '\n' << "  ";
    out << ']';
    out << ",\n  \"diagnostics\":";
    arrayJson(out, result.diagnostics, [&](const std::string &value) { out << quote(value); });
    out << "\n}\n";
    return out.str();
}

std::string toText(const AnalysisResult &result) {
    std::ostringstream out;
    out << "Source: " << result.source << "\nFunctions (" << result.functions.size() << "):\n";
    for (const auto &function : result.functions)
        out << "  " << function.qualifiedName << " at " << function.location.expansion.file
            << ':' << function.location.expansion.line << ':' << function.location.expansion.column
            << " [" << function.id << "]\n";
    out << "Calls (" << result.calls.size() << "):\n";
    for (const auto &call : result.calls) {
        out << "  " << call.caller << " -> " << call.callee << " [" << call.resolution << "] at "
            << call.location.expansion.file << ':' << call.location.expansion.line << ':'
            << call.location.expansion.column << (call.location.isMacro ? " [macro]" : "") << '\n';
    }
    out << "API operations (" << result.apiOperations.size() << "):\n";
    for (const auto &operation : result.apiOperations) {
        out << "  " << operation.caller << ": " << operation.api << " [" << operation.kind << ']';
        if (operation.lock)
            out << " lock=" << operation.lock->text << " (" << operation.lock->syntax
                << ", identity=" << operation.lock->identityTemplate << ')';
        if (!operation.stateExpression.empty())
            out << " saved-state=" << operation.stateExpression << " (" <<
                operation.stateIdentityStatus << ", identity=" << operation.stateIdentity << ')';
        out << " at " << operation.location.expansion.file << ':'
            << operation.location.expansion.line << ':' << operation.location.expansion.column
            << (operation.location.isMacro ? " [macro]" : "") << '\n';
    }
    out << "Call graph edges (" << result.callGraphEdges.size() << "):\n";
    for (const auto &edge : result.callGraphEdges)
        out << "  " << edge.callerId << " -> " << edge.targetId << " [" << edge.resolution
            << "] at " << edge.location.expansion.line << ':' << edge.location.expansion.column << '\n';
    out << "Lock dependencies (" << result.lockDependencies.size() << "):\n";
    for (const auto &dependency : result.lockDependencies) {
        out << "  " << dependency.fromLock << " -> " << dependency.toLock << " ["
            << dependency.origin << ", " << dependency.certainty << "] reported in "
            << dependency.reportingFunction << " (origin " << dependency.originFunction << ")"
            << " at " << dependency.fromAcquisition.expansion.line << " -> "
            << dependency.toAcquisition.expansion.line;
        if (!dependency.throughCalls.empty()) {
            out << " via";
            for (const auto &step : dependency.throughCalls)
                out << ' ' << step.function << "->" << step.callee << '@'
                    << step.location.expansion.line;
        }
        out << '\n';
    }
    out << "Interrupt registrations (" << result.interruptRegistrations.size() << "):\n";
    for (const auto &registration : result.interruptRegistrations) {
        out << "  " << registration.api << " in " << registration.caller << " -> ";
        if (registration.handlerNames.empty()) out << "<unresolved>";
        else for (std::size_t i = 0; i < registration.handlerNames.size(); ++i) {
            if (i) out << ", ";
            out << registration.handlerNames[i];
        }
        out << " [" << registration.resolution << "] at "
            << registration.location.expansion.file << ':'
            << registration.location.expansion.line << '\n';
    }
    out << "Interrupt-aware lock edges (" << result.interruptLockEdges.size() << "):\n";
    for (const auto &edge : result.interruptLockEdges)
        out << "  " << edge.fromLock << " -> " << edge.toLock << " [" << edge.kind << ", "
            << edge.fromContext << "->" << edge.toContext << ", irq=" << edge.irqState
            << ", " << edge.certainty << "]\n";
    out << "Interrupt cycle candidates (" << result.interruptCycles.size() << "):\n";
    for (const auto &cycle : result.interruptCycles)
    {
        out << "  " << cycle.category << " [" << cycle.feasibility << "] locks=";
        for (std::size_t i = 0; i < cycle.lockSequence.size(); ++i)
            out << (i ? " -> " : "") << cycle.lockSequence[i];
        out << "\n    " << cycle.explanation << '\n';
        for (auto index : cycle.edgeIndexes) if (index < result.interruptLockEdges.size()) {
            const auto &edge = result.interruptLockEdges[index];
            out << "    " << edge.fromLock << " -> " << edge.toLock << " ["
                << edge.fromContext << "->" << edge.toContext << ", " << edge.kind << "] "
                << edge.sourceFunction << '@' << edge.fromLocation.expansion.file << ':'
                << edge.fromLocation.expansion.line << " -> " << edge.targetFunction << '@'
                << edge.toLocation.expansion.file << ':' << edge.toLocation.expansion.line << '\n';
        }
    }
    for (const auto &uncertainty : result.uncertainties)
        out << "Uncertainty: " << uncertainty << '\n';
    for (const auto &diagnostic : result.diagnostics)
        out << "Diagnostic: " << diagnostic << '\n';
    out << "Cycle reports are static candidates under the process/hardirq model; they are not confirmed deadlocks.\n";
    return out.str();
}

std::string toDot(const AnalysisResult &result) {
    auto dotQuote = [](const std::string &value) {
        std::string output;
        for (char c : value) {
            if (c == '\\' || c == '"') output.push_back('\\');
            if (c == '\n' || c == '\r') output.push_back(' ');
            else output.push_back(c);
        }
        return output;
    };
    std::ostringstream out;
    out << "digraph interrupt_lock_dependencies {\n  rankdir=LR;\n  node [shape=box];\n";
    std::set<std::string> nodes;
    for (const auto &edge : result.interruptLockEdges) {
        nodes.insert(edge.fromLock); nodes.insert(edge.toLock);
    }
    for (const auto &node : nodes)
        out << "  \"" << dotQuote(node) << "\";\n";
    for (const auto &edge : result.interruptLockEdges) {
        const bool rejected = edge.feasibility == "rejected";
        out << "  \"" << dotQuote(edge.fromLock) << "\" -> \"" << dotQuote(edge.toLock)
            << "\" [label=\"" << dotQuote(edge.kind + " " + edge.fromContext + "->" +
                edge.toContext + " @" + edge.fromLocation.expansion.file + ":" +
                std::to_string(edge.fromLocation.expansion.line)) << "\", color=\""
            << (rejected ? "gray" : edge.kind == "interrupt_preemption" ? "red" : "black")
            << "\", style=\"" << (rejected ? "dashed" : "solid") << "\"];\n";
    }
    out << "}\n";
    return out.str();
}

} // namespace deadlock
