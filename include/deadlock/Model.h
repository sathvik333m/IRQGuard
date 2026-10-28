#pragma once

#include <optional>
#include <set>
#include <string>
#include <vector>

namespace deadlock {

struct SourceLocation {
    std::string file;
    unsigned line = 0;
    unsigned column = 0;
    bool valid = false;
};

struct LocatedSource {
    SourceLocation expansion;
    SourceLocation spelling;
    bool isMacro = false;
};

struct FunctionInfo {
    std::string id;
    std::string name;
    std::string qualifiedName;
    std::string returnType;
    LocatedSource location;
    std::vector<std::string> parameters;
    struct CFGBlock {
        unsigned id = 0;
        bool isExit = false;
        std::vector<unsigned> successors;
        // Indexes into AnalysisResult::calls, in source evaluation order.
        std::vector<std::size_t> callEvents;
    };
    std::vector<CFGBlock> cfg;
    bool cfgAvailable = false;
    bool cfgEventsComplete = true;
    unsigned entryBlock = 0;
};

struct CallInfo {
    std::string caller;
    std::string callerId;
    std::string callee;
    std::string calleeExpression;
    std::string resolution;
    std::vector<std::string> targetIds;
    std::vector<std::string> targetNames;
    std::vector<std::string> argumentIdentities;
    bool modeledApi = false;
    LocatedSource location;
};

struct LockExpression {
    std::string text;
    std::string syntax;
    std::string identityTemplate;
    // Symbolic identities use declaration identity plus formal-parameter slots.
    std::string identityStatus = "unresolved";
    LocatedSource location;
};

struct ApiOperation {
    std::string api;
    std::string kind;
    std::size_t callIndex = 0;
    std::optional<LockExpression> lock;
    std::vector<std::string> arguments;
    std::string caller;
    LocatedSource location;
    int stateArgument = -1;
    // Resolved flags lvalue identity when it is an ordinary API argument or
    // recoverable from an irqsave macro's assignment AST.
    std::string stateIdentity;
    std::string stateExpression;
    std::string stateIdentityStatus = "not_applicable";
    int handlerArgument = -1;
    std::string handlerResolution;
    std::vector<std::string> handlerTargetIds;
    std::vector<std::string> handlerTargetNames;
};

struct ControlConstruct {
    std::string kind;
    std::string condition;
    std::string function;
    LocatedSource location;
};

struct CallGraphNode {
    std::string id;
    std::string name;
    bool defined = false;
};

struct CallGraphEdge {
    std::string callerId;
    std::string targetId;
    std::string callee;
    std::string resolution;
    LocatedSource location;
};

struct ProvenanceStep {
    std::string function;
    std::string callee;
    LocatedSource location;
};

struct AcquisitionFact {
    std::string lockIdentity;
    std::string identityStatus;
    std::string function;
    LocatedSource location;
    std::vector<ProvenanceStep> throughCalls;
    bool provenanceTruncated = false;
};

struct ReleaseFact {
    std::string lockIdentity;
    std::string identityStatus;
    std::string function;
    LocatedSource location;
    std::vector<ProvenanceStep> throughCalls;
    bool provenanceTruncated = false;
};

struct LockDependency {
    std::string fromLock;
    std::string toLock;
    std::string reportingFunction;
    std::string originFunction;
    LocatedSource fromAcquisition;
    LocatedSource toAcquisition;
    std::vector<ProvenanceStep> throughCalls;
    bool provenanceTruncated = false;
    std::string origin; // direct or inferred_through_call
    std::string certainty; // possible or unresolved_identity
};

struct FunctionSummaryInfo {
    std::string functionId;
    std::string function;
    std::vector<AcquisitionFact> acquisitions;
    std::vector<ReleaseFact> releases;
    std::vector<AcquisitionFact> heldOnReturn;
    std::vector<std::string> releasedOnAllReturns;
    std::vector<LockDependency> dependencies;
    std::vector<std::string> uncertainties;
    bool converged = true;
};

struct InterruptRegistration {
    std::string api;
    std::string caller;
    std::string irqExpression;
    std::string resolution;
    std::vector<std::string> handlerIds;
    std::vector<std::string> handlerNames;
    LocatedSource location;
};

struct InterruptStateSnapshot {
    std::string lockIdentity;
    std::string identityStatus;
    std::string context;
    std::string irqState;
    std::string sourceFunction;
    std::string originFunction;
    LocatedSource location;
    std::vector<ProvenanceStep> throughCalls;
    bool provenanceTruncated = false;
};

struct InterruptLockEdge {
    std::string fromLock;
    std::string toLock;
    std::string kind; // regular or interrupt_preemption
    std::string fromContext;
    std::string toContext;
    std::string sourceFunction;
    std::string targetFunction;
    std::string irqState; // enabled, disabled, unknown, or not_applicable
    std::string certainty; // possible or uncertain
    LocatedSource fromLocation;
    LocatedSource toLocation;
    LocatedSource registrationLocation;
    std::string handler;
    std::string feasibility = "unrefined"; // cfg_reachable, rejected, inconclusive
    std::string feasibilityReason;
    std::vector<ProvenanceStep> sourceProvenance;
    std::vector<ProvenanceStep> targetProvenance;
};

struct InterruptCycle {
    std::string classification; // legacy search shape, including rejected_interrupt_preemption
    std::string category; // candidate_lock_order_cycle, interrupt_aware_candidate, rejected_candidate, inconclusive_analysis
    std::string feasibility = "inconclusive";
    std::vector<std::size_t> edgeIndexes;
    std::vector<std::string> lockSequence;
    // Equivalent cycles are grouped; each variant retains a distinct edge/provenance chain.
    std::vector<std::vector<std::size_t>> provenanceVariants;
    bool containsUncertainEdge = false;
    std::string explanation;
};

struct AnalysisResult {
    std::string source;
    std::vector<FunctionInfo> functions;
    std::vector<CallInfo> calls;
    std::vector<ApiOperation> apiOperations;
    std::vector<ControlConstruct> controls;
    std::vector<CallGraphNode> callGraphNodes;
    std::vector<CallGraphEdge> callGraphEdges;
    std::vector<FunctionSummaryInfo> functionSummaries;
    std::vector<LockDependency> lockDependencies;
    std::vector<InterruptRegistration> interruptRegistrations;
    std::vector<InterruptStateSnapshot> interruptSnapshots;
    std::vector<InterruptLockEdge> interruptLockEdges;
    std::vector<InterruptCycle> interruptCycles;
    std::vector<std::string> uncertainties;
    std::vector<std::string> diagnostics;
};

} // namespace deadlock
