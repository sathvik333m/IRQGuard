#include "deadlock/Output.h"

#include <iomanip>
#include <set>
#include <sstream>

namespace deadlock {
namespace {

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
    out << "{\n  \"schema_version\":3,\n  \"source\":" << quote(result.source)
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
        out << "{\"classification\":" << quote(cycle.classification)
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
