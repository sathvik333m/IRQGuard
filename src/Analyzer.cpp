#include "deadlock/Analyzer.h"
#include "deadlock/Interprocedural.h"
#include "deadlock/InterruptAnalysis.h"

#include "clang/AST/ASTContext.h"
#include "clang/AST/Decl.h"
#include "clang/AST/Expr.h"
#include "clang/AST/ParentMapContext.h"
#include "clang/AST/RecursiveASTVisitor.h"
#include "clang/Analysis/CFG.h"
#include "clang/Frontend/ASTConsumers.h"
#include "clang/Frontend/CompilerInstance.h"
#include "clang/Frontend/FrontendActions.h"
#include "clang/Lex/Lexer.h"
#include "clang/Tooling/CompilationDatabase.h"
#include "clang/Tooling/Tooling.h"
#include "llvm/Support/raw_ostream.h"

#include <algorithm>
#include <functional>
#include <map>
#include <limits>
#include <set>
#include <sstream>
#include <unordered_map>
#include <unordered_set>

namespace deadlock {
namespace {

SourceLocation makeLocation(clang::SourceLocation location,
                            const clang::SourceManager &manager) {
    if (location.isInvalid())
        return {};
    auto presumed = manager.getPresumedLoc(location);
    if (presumed.isInvalid())
        return {};
    SourceLocation result;
    result.file = presumed.getFilename();
    result.line = presumed.getLine();
    result.column = presumed.getColumn();
    result.valid = true;
    return result;
}

LocatedSource makeLocated(clang::SourceLocation location,
                          const clang::SourceManager &manager) {
    LocatedSource result;
    result.isMacro = location.isMacroID();
    result.expansion = makeLocation(manager.getExpansionLoc(location), manager);
    result.spelling = makeLocation(manager.getSpellingLoc(location), manager);
    return result;
}

std::string expressionText(const clang::Expr *expression,
                           const clang::ASTContext &context) {
    if (!expression)
        return "<missing>";
    bool invalid = false;
    auto text = clang::Lexer::getSourceText(
        clang::CharSourceRange::getTokenRange(expression->getSourceRange()),
        context.getSourceManager(), context.getLangOpts(), &invalid);
    if (!invalid && !text.empty())
        return text.str();
    std::string printed;
    llvm::raw_string_ostream stream(printed);
    expression->printPretty(stream, nullptr, context.getPrintingPolicy());
    stream.flush();
    return printed;
}

const clang::Expr *identityOperand(const clang::Expr *expression) {
    expression = expression ? expression->IgnoreParenImpCasts() : nullptr;
    while (const auto *call = llvm::dyn_cast_or_null<clang::CallExpr>(expression)) {
        const auto *callee = call->getDirectCallee();
        if (!callee || callee->getNameAsString() != "spinlock_check" || call->getNumArgs() != 1)
            break;
        expression = call->getArg(0)->IgnoreParenImpCasts();
    }
    return expression;
}

std::string expressionSyntax(const clang::Expr *expression) {
    expression = identityOperand(expression);
    if (llvm::isa_and_nonnull<clang::DeclRefExpr>(expression)) return "decl_ref";
    if (llvm::isa_and_nonnull<clang::MemberExpr>(expression)) return "member";
    if (llvm::isa_and_nonnull<clang::ArraySubscriptExpr>(expression)) return "array_subscript";
    if (llvm::isa_and_nonnull<clang::UnaryOperator>(expression)) return "unary";
    if (llvm::isa_and_nonnull<clang::CallExpr>(expression)) return "call";
    return expression ? "compound_or_other" : "unknown";
}

std::string locationIdentity(clang::SourceLocation location,
                             const clang::SourceManager &manager) {
    location = manager.getExpansionLoc(location);
    if (location.isInvalid())
        return "unknown-location";
    auto presumed = manager.getPresumedLoc(location);
    if (presumed.isInvalid())
        return "unknown-location";
    return std::string(presumed.getFilename()) + ":" +
           std::to_string(presumed.getLine()) + ":" +
           std::to_string(presumed.getColumn());
}

std::string declarationIdentity(const clang::ValueDecl *declaration,
                                const clang::SourceManager &manager) {
    const auto *variable = llvm::dyn_cast<clang::VarDecl>(declaration);
    const std::string kind = variable && variable->hasLocalStorage() ? "local@" : "decl@";
    return kind + locationIdentity(declaration->getLocation(), manager) +
           ":" + declaration->getQualifiedNameAsString();
}

using SafePointerAliases = std::unordered_map<const clang::VarDecl *, const clang::Expr *>;

class PointerAliasCollector : public clang::RecursiveASTVisitor<PointerAliasCollector> {
public:
    bool VisitVarDecl(clang::VarDecl *variable) {
        if (variable->isLocalVarDecl() && variable->hasLocalStorage() &&
            !variable->isStaticLocal() && variable->getType()->isPointerType() &&
            variable->hasInit())
            candidates[variable->getCanonicalDecl()] = variable->getInit();
        return true;
    }

    bool VisitBinaryOperator(clang::BinaryOperator *binary) {
        if (!binary->isAssignmentOp()) return true;
        const auto *reference = llvm::dyn_cast<clang::DeclRefExpr>(
            binary->getLHS()->IgnoreParenImpCasts());
        const auto *variable = reference
            ? llvm::dyn_cast<clang::VarDecl>(reference->getDecl()) : nullptr;
        if (variable) modified.insert(variable->getCanonicalDecl());
        return true;
    }

    bool VisitUnaryOperator(clang::UnaryOperator *unary) {
        if (unary->getOpcode() != clang::UO_AddrOf) return true;
        const auto *reference = llvm::dyn_cast<clang::DeclRefExpr>(
            unary->getSubExpr()->IgnoreParenImpCasts());
        const auto *variable = reference
            ? llvm::dyn_cast<clang::VarDecl>(reference->getDecl()) : nullptr;
        if (variable) addressEscaped.insert(variable->getCanonicalDecl());
        return true;
    }

    SafePointerAliases safeCandidates() const {
        SafePointerAliases output;
        for (const auto &candidate : candidates)
            if (!modified.count(candidate.first) && !addressEscaped.count(candidate.first))
                output.emplace(candidate);
        return output;
    }

private:
    std::unordered_map<const clang::VarDecl *, const clang::Expr *> candidates;
    std::unordered_set<const clang::VarDecl *> modified;
    std::unordered_set<const clang::VarDecl *> addressEscaped;
};

std::string canonicalExpressionImpl(
    const clang::Expr *expression, clang::ASTContext &context,
    const clang::FunctionDecl *function, bool &resolved,
    const SafePointerAliases &aliases,
    std::unordered_set<const clang::VarDecl *> &activeAliases) {
    const clang::SourceManager &manager = context.getSourceManager();
    if (!expression) {
        resolved = false;
        return "unknown@missing";
    }
    expression = identityOperand(expression);
    if (const auto *reference = llvm::dyn_cast<clang::DeclRefExpr>(expression)) {
        const auto *value = llvm::dyn_cast<clang::ValueDecl>(reference->getDecl());
        if (const auto *parameter = llvm::dyn_cast_or_null<clang::ParmVarDecl>(value)) {
            if (function) {
                for (unsigned index = 0; index < function->getNumParams(); ++index) {
                    if (function->getParamDecl(index)->getCanonicalDecl() == parameter->getCanonicalDecl())
                        return "@param[" + std::to_string(index) + "]";
                }
            }
        }
        if (const auto *variable = llvm::dyn_cast_or_null<clang::VarDecl>(value)) {
            const auto *canonical = variable->getCanonicalDecl();
            auto alias = aliases.find(canonical);
            if (alias != aliases.end()) {
                if (!activeAliases.insert(canonical).second) {
                    resolved = false;
                    return "unknown-alias-cycle@" + locationIdentity(variable->getLocation(), manager);
                }
                auto identity = canonicalExpressionImpl(alias->second, context, function,
                                                        resolved, aliases, activeAliases);
                activeAliases.erase(canonical);
                return identity;
            }
            // A pointer variable stores a value that may change or alias an
            // unknown object. Parameters are handled symbolically above.
            if (variable->getType()->isPointerType()) {
                resolved = false;
                return "unknown-pointer@" + locationIdentity(variable->getLocation(), manager);
            }
        }
        if (value)
            return declarationIdentity(value, manager);
    }
    if (const auto *member = llvm::dyn_cast<clang::MemberExpr>(expression)) {
        const clang::Expr *baseExpression = member->getBase();
        bool throughPointer = member->isArrow();
        if (!throughPointer) {
            const auto *base = llvm::dyn_cast<clang::UnaryOperator>(
                baseExpression->IgnoreParenImpCasts());
            if (base && base->getOpcode() == clang::UO_Deref) {
                baseExpression = base->getSubExpr();
                throughPointer = true;
            }
        }
        bool baseResolved = true;
        std::string base = canonicalExpressionImpl(baseExpression, context, function,
                                                   baseResolved, aliases, activeAliases);
        resolved &= baseResolved;
        if (member->getType()->isPointerType()) resolved = false;
        const auto *field = llvm::dyn_cast<clang::ValueDecl>(member->getMemberDecl());
        std::string fieldName = field ? field->getQualifiedNameAsString() : "<member>";
        return "member(" + base + (throughPointer ? "->" : ".") + fieldName + ")";
    }
    if (const auto *subscript = llvm::dyn_cast<clang::ArraySubscriptExpr>(expression)) {
        bool baseResolved = true, indexResolved = true;
        auto base = canonicalExpressionImpl(subscript->getBase(), context, function,
                                            baseResolved, aliases, activeAliases);
        auto index = canonicalExpressionImpl(subscript->getIdx(), context, function,
                                             indexResolved, aliases, activeAliases);
        resolved &= baseResolved && indexResolved;
        if (subscript->getType()->isPointerType()) resolved = false;
        return "index(" + base + "," + index + ")";
    }
    if (const auto *unary = llvm::dyn_cast<clang::UnaryOperator>(expression)) {
        const auto *inner = llvm::dyn_cast<clang::UnaryOperator>(
            unary->getSubExpr()->IgnoreParenImpCasts());
        if ((unary->getOpcode() == clang::UO_AddrOf && inner && inner->getOpcode() == clang::UO_Deref) ||
            (unary->getOpcode() == clang::UO_Deref && inner && inner->getOpcode() == clang::UO_AddrOf))
            return canonicalExpressionImpl(inner->getSubExpr(), context, function,
                                            resolved, aliases, activeAliases);
        bool operandResolved = true;
        auto operand = canonicalExpressionImpl(unary->getSubExpr(), context, function,
                                               operandResolved, aliases, activeAliases);
        resolved &= operandResolved;
        return "unary(" + unary->getOpcodeStr(unary->getOpcode()).str() + "," + operand + ")";
    }
    if (const auto *binary = llvm::dyn_cast<clang::BinaryOperator>(expression)) {
        bool leftResolved = true, rightResolved = true;
        auto left = canonicalExpressionImpl(binary->getLHS(), context, function,
                                            leftResolved, aliases, activeAliases);
        auto right = canonicalExpressionImpl(binary->getRHS(), context, function,
                                             rightResolved, aliases, activeAliases);
        resolved &= leftResolved && rightResolved;
        if (binary->getType()->isPointerType()) resolved = false;
        return "binary(" + binary->getOpcodeStr().str() + "," + left + "," + right + ")";
    }
    if (const auto *conditional = llvm::dyn_cast<clang::ConditionalOperator>(expression)) {
        bool conditionResolved = true, trueResolved = true, falseResolved = true;
        auto condition = canonicalExpressionImpl(conditional->getCond(), context, function,
                                                 conditionResolved, aliases, activeAliases);
        auto yes = canonicalExpressionImpl(conditional->getTrueExpr(), context, function,
                                           trueResolved, aliases, activeAliases);
        auto no = canonicalExpressionImpl(conditional->getFalseExpr(), context, function,
                                          falseResolved, aliases, activeAliases);
        resolved = false; // It may identify either arm; no alias/branch proof is available.
        (void)conditionResolved;
        (void)trueResolved;
        (void)falseResolved;
        return "conditional(" + condition + "," + yes + "," + no + ")";
    }
    if (const auto *cast = llvm::dyn_cast<clang::ExplicitCastExpr>(expression)) {
        bool childResolved = true;
        auto child = canonicalExpressionImpl(cast->getSubExpr(), context, function,
                                             childResolved, aliases, activeAliases);
        resolved = false;
        (void)childResolved;
        return "cast(" + cast->getTypeAsWritten().getAsString() + "," + child + ")";
    }
    resolved = false;
    return "unknown@" + locationIdentity(expression->getExprLoc(), manager);
}

std::string canonicalExpression(const clang::Expr *expression,
                                clang::ASTContext &context,
                                const clang::FunctionDecl *function,
                                bool &resolved,
                                const SafePointerAliases *aliases = nullptr) {
    static const SafePointerAliases noAliases;
    std::unordered_set<const clang::VarDecl *> activeAliases;
    return canonicalExpressionImpl(expression, context, function, resolved,
                                   aliases ? *aliases : noAliases, activeAliases);
}

const clang::FunctionDecl *referencedFunction(const clang::Expr *expression) {
    if (!expression)
        return nullptr;
    expression = expression->IgnoreParenImpCasts();
    while (const auto *unary = llvm::dyn_cast<clang::UnaryOperator>(expression)) {
        if (unary->getOpcode() != clang::UO_AddrOf && unary->getOpcode() != clang::UO_Deref)
            return nullptr;
        expression = unary->getSubExpr()->IgnoreParenImpCasts();
    }
    if (const auto *reference = llvm::dyn_cast<clang::DeclRefExpr>(expression))
        return llvm::dyn_cast<clang::FunctionDecl>(reference->getDecl());
    return nullptr;
}

class ConditionMutationCollector : public clang::RecursiveASTVisitor<ConditionMutationCollector> {
public:
    bool VisitBinaryOperator(clang::BinaryOperator *binary) {
        if (binary->isAssignmentOp())
            mark(binary->getLHS(), modified);
        return true;
    }

    bool VisitUnaryOperator(clang::UnaryOperator *unary) {
        if (unary->isIncrementDecrementOp()) mark(unary->getSubExpr(), modified);
        if (unary->getOpcode() == clang::UO_AddrOf) mark(unary->getSubExpr(), escaped);
        return true;
    }

    std::set<const clang::VarDecl *> modified;
    std::set<const clang::VarDecl *> escaped;

private:
    static void mark(const clang::Expr *expression, std::set<const clang::VarDecl *> &set) {
        expression = expression ? expression->IgnoreParenImpCasts() : nullptr;
        if (const auto *reference = llvm::dyn_cast_or_null<clang::DeclRefExpr>(expression))
            if (const auto *variable = llvm::dyn_cast<clang::VarDecl>(reference->getDecl()))
                set.insert(variable->getCanonicalDecl());
    }
};

bool conditionOperand(const clang::Expr *expression,
                      const clang::ASTContext &context,
                      const clang::SourceManager &manager,
                      const std::set<const clang::VarDecl *> &modified,
                      const std::set<const clang::VarDecl *> &escaped,
                      std::string &key) {
    expression = expression ? expression->IgnoreParenImpCasts() : nullptr;
    if (const auto *reference = llvm::dyn_cast_or_null<clang::DeclRefExpr>(expression)) {
        if (const auto *variable = llvm::dyn_cast<clang::VarDecl>(reference->getDecl())) {
            const bool local = variable->hasLocalStorage() || llvm::isa<clang::ParmVarDecl>(variable);
            if (!local && !variable->getType().isConstQualified()) return false;
            if (modified.count(variable->getCanonicalDecl()) ||
                escaped.count(variable->getCanonicalDecl()) ||
                !variable->getType()->isScalarType() || variable->getType().isVolatileQualified())
                return false;
            key = declarationIdentity(variable, manager);
            return true;
        }
        if (const auto *constant = llvm::dyn_cast<clang::EnumConstantDecl>(reference->getDecl())) {
            key = "enum@" + locationIdentity(constant->getLocation(), manager) + ":" +
                  constant->getQualifiedNameAsString();
            return true;
        }
        return false;
    }
    if (llvm::isa_and_nonnull<clang::IntegerLiteral>(expression) ||
        llvm::isa_and_nonnull<clang::CXXBoolLiteralExpr>(expression) ||
        llvm::isa_and_nonnull<clang::CharacterLiteral>(expression)) {
        key = expressionText(expression, context);
        return true;
    }
    return false;
}

bool normalizeCondition(const clang::Expr *expression,
                        const clang::ASTContext &context,
                        const clang::SourceManager &manager,
                        const std::set<const clang::VarDecl *> &modified,
                        const std::set<const clang::VarDecl *> &escaped,
                        std::string &atom, bool &truth) {
    expression = expression ? expression->IgnoreParenImpCasts() : nullptr;
    if (const auto *unary = llvm::dyn_cast_or_null<clang::UnaryOperator>(expression)) {
        if (unary->getOpcode() == clang::UO_LNot) {
            if (!normalizeCondition(unary->getSubExpr(), context, manager, modified, escaped, atom, truth))
                return false;
            truth = !truth;
            return true;
        }
    }
    if (const auto *binary = llvm::dyn_cast_or_null<clang::BinaryOperator>(expression)) {
        std::string lhs, rhs, op;
        bool invert = false;
        switch (binary->getOpcode()) {
        case clang::BO_EQ: op = "=="; break;
        case clang::BO_NE: op = "=="; invert = true; break;
        case clang::BO_LT: op = "<"; break;
        case clang::BO_GE: op = "<"; invert = true; break;
        case clang::BO_GT: op = ">"; break;
        case clang::BO_LE: op = ">"; invert = true; break;
        default: return false;
        }
        if (!conditionOperand(binary->getLHS(), context, manager, modified, escaped, lhs) ||
            !conditionOperand(binary->getRHS(), context, manager, modified, escaped, rhs))
            return false;
        if ((op == "==") && rhs < lhs) std::swap(lhs, rhs);
        if (op == ">") { std::swap(lhs, rhs); op = "<"; }
        atom = "cmp(" + op + "," + lhs + "," + rhs + ")";
        truth = !invert;
        return true;
    }
    std::string operand;
    if (!conditionOperand(expression, context, manager, modified, escaped, operand)) return false;
    atom = "bool(" + operand + ")";
    truth = true;
    return true;
}

const clang::Expr *supportedBranchCondition(const clang::Stmt *terminator) {
    if (const auto *statement = llvm::dyn_cast_or_null<clang::IfStmt>(terminator))
        return statement->getCond();
    if (const auto *statement = llvm::dyn_cast_or_null<clang::WhileStmt>(terminator))
        return statement->getCond();
    if (const auto *statement = llvm::dyn_cast_or_null<clang::DoStmt>(terminator))
        return statement->getCond();
    if (const auto *statement = llvm::dyn_cast_or_null<clang::ForStmt>(terminator))
        return statement->getCond();
    return nullptr;
}

class CFGCallCollector : public clang::RecursiveASTVisitor<CFGCallCollector> {
public:
    bool VisitCallExpr(clang::CallExpr *call) {
        calls.push_back(call);
        return true;
    }
    std::vector<clang::CallExpr *> calls;
};

class Extractor : public clang::RecursiveASTVisitor<Extractor> {
public:
    Extractor(clang::ASTContext &context, const ApiRegistry &registry,
              AnalysisResult &result)
        : context_(context), manager_(context.getSourceManager()),
          registry_(registry), result_(result) {}

    bool TraverseFunctionDecl(clang::FunctionDecl *function) {
        if (!function || !function->doesThisDeclarationHaveABody())
            return clang::RecursiveASTVisitor<Extractor>::TraverseFunctionDecl(function);
        const std::string previous = currentFunction_;
        const std::string previousId = currentFunctionId_;
        const clang::FunctionDecl *previousDecl = currentFunctionDecl_;
        const SafePointerAliases previousAliases = safeAliases_;
        currentFunction_ = function->getQualifiedNameAsString();
        currentFunctionDecl_ = function;
        PointerAliasCollector aliasCollector;
        aliasCollector.TraverseStmt(function->getBody());
        const auto aliasCandidates = aliasCollector.safeCandidates();
        safeAliases_.clear();
        for (const auto &candidate : aliasCandidates) {
            bool resolved = true;
            canonicalExpression(candidate.second, context_, function, resolved,
                                &aliasCandidates);
            if (resolved)
                safeAliases_.emplace(candidate);
        }
        std::optional<std::size_t> infoIndex;
        if (isMainFile(function->getLocation())) {
            FunctionInfo info;
            info.name = function->getNameAsString();
            info.qualifiedName = currentFunction_;
            info.returnType = function->getReturnType().getAsString();
            info.location = makeLocated(function->getLocation(), manager_);
            info.id = functionId(function, manager_);
            for (const auto *parameter : function->parameters())
                info.parameters.push_back(parameter->getNameAsString());
            result_.functions.push_back(std::move(info));
            infoIndex = result_.functions.size() - 1;
            currentFunctionId_ = result_.functions.back().id;
            functionCallIndices_[currentFunctionId_].clear();
            functionDefinitions_[function->getCanonicalDecl()] = currentFunctionId_;
        }
        bool traversed = clang::RecursiveASTVisitor<Extractor>::TraverseFunctionDecl(function);
        if (infoIndex)
            buildCFG(function, *infoIndex);
        currentFunction_ = previous;
        currentFunctionId_ = previousId;
        currentFunctionDecl_ = previousDecl;
        safeAliases_ = previousAliases;
        return traversed;
    }

    bool VisitVarDecl(clang::VarDecl *variable) {
        if (!variable->hasInit())
            return true;
        if (const auto *target = referencedFunction(variable->getInit()))
            pointerTargets_[variable->getCanonicalDecl()].insert(target->getCanonicalDecl());
        return true;
    }

    bool VisitBinaryOperator(clang::BinaryOperator *binary) {
        if (!binary->isAssignmentOp())
            return true;
        const auto *lhs = binary->getLHS()->IgnoreParenImpCasts();
        const auto *reference = llvm::dyn_cast<clang::DeclRefExpr>(lhs);
        const auto *variable = reference ? llvm::dyn_cast<clang::VarDecl>(reference->getDecl()) : nullptr;
        const auto *target = referencedFunction(binary->getRHS());
        if (variable && target)
            pointerTargets_[variable->getCanonicalDecl()].insert(target->getCanonicalDecl());
        return true;
    }

    bool VisitCallExpr(clang::CallExpr *call) {
        if (!isMainFile(call->getExprLoc()))
            return true;
        const auto *direct = call->getDirectCallee();
        std::string callee = direct ? direct->getQualifiedNameAsString()
                                    : expressionText(call->getCallee(), context_);
        CallInfo info;
        info.caller = currentFunction_;
        info.callerId = currentFunctionId_;
        info.callee = callee;
        info.calleeExpression = expressionText(call->getCallee(), context_);
        info.location = makeLocated(call->getExprLoc(), manager_);
        info.resolution = direct ? "direct_pending" : "unresolved_indirect";
        for (const auto *argument : call->arguments()) {
            bool resolved = true;
            auto identity = canonicalExpression(argument, context_, currentFunctionDecl_,
                                                 resolved, &safeAliases_);
            if (!resolved)
                identity = "unknown-argument@" +
                    locationIdentity(argument->getExprLoc(), manager_) + "|" + identity;
            info.argumentIdentities.push_back(std::move(identity));
        }
        const std::size_t callIndex = result_.calls.size();
        result_.calls.push_back(std::move(info));
        callIndices_[call] = callIndex;
        if (!currentFunctionId_.empty())
            functionCallIndices_[currentFunctionId_].push_back(callIndex);
        callEndOffsets_[callIndex] = sourceOffset(call->getEndLoc());
        if (direct) {
            directTargets_[callIndex] = direct->getCanonicalDecl();
        } else {
            const auto *calleeExpr = call->getCallee()->IgnoreParenImpCasts();
            if (const auto *reference = llvm::dyn_cast<clang::DeclRefExpr>(calleeExpr))
                if (const auto *variable = llvm::dyn_cast<clang::VarDecl>(reference->getDecl()))
                    indirectVariables_[callIndex] = variable->getCanonicalDecl();
        }

        if (!direct)
            return true;
        // Calls emitted from a function-like lock macro can have an internal
        // helper as their AST callee. Match configured direct helpers first,
        // then fall back to the immediate macro name for wrappers whose helper
        // itself is not registered. `spinlock_check` is an argument validator,
        // not the lock acquisition inside Linux spinlock macros.
        std::optional<ApiSpec> spec = registry_.find(direct->getNameAsString());
        if (call->getExprLoc().isMacroID() && direct->getNameAsString() != "spinlock_check") {
            // The expansion location points back to the public invocation in
            // the source file. Read that one Clang token instead of guessing
            // from helper-name substrings or macro spelling locations.
            clang::Token invocation;
            const auto expansion = manager_.getExpansionLoc(call->getExprLoc());
            if (!clang::Lexer::getRawToken(expansion, invocation, manager_,
                                           context_.getLangOpts(), true)) {
                const std::string publicName = clang::Lexer::getSpelling(
                    invocation, manager_, context_.getLangOpts());
                auto publicSpec = registry_.find(publicName);
                if (publicSpec && (!spec || publicSpec->kind == spec->kind))
                    spec = std::move(publicSpec);
            }
        }
        if (!spec)
            return true;
        result_.calls.back().modeledApi = true;
        ApiOperation operation;
        operation.api = spec->name;
        operation.kind = spec->kind;
        operation.callIndex = callIndex;
        operation.caller = currentFunction_;
        operation.location = makeLocated(call->getExprLoc(), manager_);
        operation.stateArgument = spec->stateArgument;
        const bool hasSavedState = spec->stateArgument >= 0 ||
            spec->kind == "lock_acquire_irqsave" ||
            spec->kind == "lock_release_irqrestore" ||
            spec->kind == "irq_save" || spec->kind == "irq_restore";
        if (hasSavedState)
            operation.stateIdentityStatus = "unresolved";
        for (const auto *argument : call->arguments())
            operation.arguments.push_back(expressionText(argument, context_));
        if (spec->lockArgument >= 0) {
            if (static_cast<unsigned>(spec->lockArgument) < call->getNumArgs()) {
                const auto *argument = identityOperand(call->getArg(spec->lockArgument));
                LockExpression lock;
                lock.text = expressionText(argument, context_);
                lock.syntax = expressionSyntax(argument);
                bool resolved = true;
                lock.identityTemplate = canonicalExpression(
                    argument, context_, currentFunctionDecl_, resolved, &safeAliases_);
                lock.identityStatus = resolved ? "symbolic" : "unresolved";
                lock.location = makeLocated(argument->getExprLoc(), manager_);
                operation.lock = std::move(lock);
            } else {
                result_.diagnostics.push_back("API '" + spec->name + "' at " +
                    locationString(operation.location.expansion) +
                    " has no configured lock argument at index " +
                    std::to_string(spec->lockArgument));
            }
        }
        const clang::Expr *stateExpression = nullptr;
        if (spec->stateArgument >= 0 &&
            static_cast<unsigned>(spec->stateArgument) < call->getNumArgs()) {
            stateExpression = call->getArg(spec->stateArgument);
        } else if (spec->kind == "lock_acquire_irqsave" || spec->kind == "irq_save") {
            // Linux's raw irqsave helper returns saved flags. Public macros
            // assign that value to the source flags lvalue; recover it from
            // the enclosing assignment expression when Clang exposes it.
            stateExpression = assignedStateLValue(call);
        }
        if (stateExpression) {
            operation.stateExpression = expressionText(stateExpression, context_);
            bool stateResolved = true;
            operation.stateIdentity = canonicalExpression(
                stateExpression, context_, currentFunctionDecl_, stateResolved, &safeAliases_);
            operation.stateIdentityStatus = stateResolved ? "symbolic" : "unresolved";
        }
        if (spec->handlerArgument >= 0) {
            operation.handlerArgument = spec->handlerArgument;
            if (static_cast<unsigned>(spec->handlerArgument) < call->getNumArgs()) {
                const auto *handlerExpr = call->getArg(spec->handlerArgument)->IgnoreParenImpCasts();
                if (const auto *handler = referencedFunction(handlerExpr)) {
                    directHandlerTargets_[callIndex] = handler->getCanonicalDecl();
                    operation.handlerResolution = "pending_direct";
                } else if (const auto *reference = llvm::dyn_cast<clang::DeclRefExpr>(handlerExpr)) {
                    if (const auto *variable = llvm::dyn_cast<clang::VarDecl>(reference->getDecl())) {
                        handlerVariables_[callIndex] = variable->getCanonicalDecl();
                        operation.handlerResolution = "pending_indirect";
                    } else {
                        operation.handlerResolution = "unresolved";
                    }
                } else {
                    operation.handlerResolution = "unresolved";
                }
            } else {
                operation.handlerResolution = "missing_argument";
                result_.uncertainties.push_back("interrupt registration API '" + spec->name +
                    "' has no configured handler argument at " + locationString(operation.location.expansion));
            }
        }
        // Nested macro ASTs can expose both the expansion's helper call and a
        // synthesized call node at the same public invocation. Keep one
        // semantic API event per public source location. Prefer the node with
        // actual arguments/lock identity over an empty synthesized node.
        auto duplicate = std::find_if(result_.apiOperations.begin(), result_.apiOperations.end(),
            [&](const ApiOperation &existing) {
                const auto &left = existing.location.expansion;
                const auto &right = operation.location.expansion;
                return existing.api == operation.api && left.valid && right.valid &&
                    left.file == right.file && left.line == right.line &&
                    left.column == right.column;
            });
        if (duplicate == result_.apiOperations.end()) {
            result_.apiOperations.push_back(std::move(operation));
        } else if (!duplicate->lock && operation.lock) {
            *duplicate = std::move(operation);
        }
        return true;
    }

    void finalizeCallTargets() {
        std::unordered_map<const clang::FunctionDecl *, std::string> definitionIds;
        for (const auto &entry : functionDefinitions_)
            definitionIds[entry.first] = entry.second;

        for (std::size_t index = 0; index < result_.calls.size(); ++index) {
            CallInfo &call = result_.calls[index];
            auto direct = directTargets_.find(index);
            if (direct != directTargets_.end()) {
                auto internal = definitionIds.find(direct->second);
                if (internal != definitionIds.end()) {
                    call.targetIds.push_back(internal->second);
                    call.targetNames.push_back(call.callee);
                    call.resolution = "direct";
                } else {
                    call.targetIds.push_back("external:" + call.callee);
                    call.targetNames.push_back(call.callee);
                    call.resolution = call.modeledApi ? "modeled_api" : "external";
                }
                continue;
            }
            auto variable = indirectVariables_.find(index);
            if (variable != indirectVariables_.end()) {
                auto targets = pointerTargets_.find(variable->second);
                if (targets != pointerTargets_.end()) {
                    std::vector<const clang::FunctionDecl *> orderedTargets(targets->second.begin(),
                                                                            targets->second.end());
                    std::sort(orderedTargets.begin(), orderedTargets.end(), [&](const auto *left, const auto *right) {
                        const std::string leftKey = left->getQualifiedNameAsString() + "@" +
                            locationIdentity(left->getLocation(), manager_);
                        const std::string rightKey = right->getQualifiedNameAsString() + "@" +
                            locationIdentity(right->getLocation(), manager_);
                        return leftKey < rightKey;
                    });
                    for (const auto *target : orderedTargets) {
                        const std::string targetName = target->getQualifiedNameAsString();
                        auto internal = definitionIds.find(target->getCanonicalDecl());
                        const std::string targetId = internal != definitionIds.end()
                            ? internal->second : "external:" + targetName;
                        if (std::find(call.targetIds.begin(), call.targetIds.end(), targetId) == call.targetIds.end()) {
                            call.targetIds.push_back(targetId);
                            call.targetNames.push_back(targetName);
                        }
                    }
                }
            }
            call.resolution = call.targetIds.empty() ? "unresolved_indirect" : "resolved_indirect";
        }

        for (auto &operation : result_.apiOperations) {
            if (operation.handlerArgument < 0)
                continue;
            auto appendTarget = [&](const clang::FunctionDecl *target) {
                const std::string name = target->getQualifiedNameAsString();
                auto internal = definitionIds.find(target->getCanonicalDecl());
                const std::string id = internal != definitionIds.end()
                    ? internal->second : "external:" + name;
                if (std::find(operation.handlerTargetIds.begin(), operation.handlerTargetIds.end(), id) ==
                    operation.handlerTargetIds.end()) {
                    operation.handlerTargetIds.push_back(id);
                    operation.handlerTargetNames.push_back(name);
                }
            };
            auto direct = directHandlerTargets_.find(operation.callIndex);
            if (direct != directHandlerTargets_.end()) {
                appendTarget(direct->second);
                operation.handlerResolution = operation.handlerTargetIds.front().rfind("external:", 0) == 0
                    ? "external_handler" : "resolved_direct";
            } else {
                auto variable = handlerVariables_.find(operation.callIndex);
                if (variable != handlerVariables_.end()) {
                    auto targets = pointerTargets_.find(variable->second);
                    if (targets != pointerTargets_.end()) {
                        std::vector<const clang::FunctionDecl *> ordered(targets->second.begin(),
                                                                          targets->second.end());
                        std::sort(ordered.begin(), ordered.end(), [&](const auto *left, const auto *right) {
                            const std::string leftKey = left->getQualifiedNameAsString() + "@" +
                                locationIdentity(left->getLocation(), manager_);
                            const std::string rightKey = right->getQualifiedNameAsString() + "@" +
                                locationIdentity(right->getLocation(), manager_);
                            return leftKey < rightKey;
                        });
                        for (const auto *target : ordered)
                            appendTarget(target);
                    }
                    operation.handlerResolution = operation.handlerTargetIds.empty()
                        ? "unresolved_handler" : "resolved_indirect";
                } else if (operation.handlerResolution != "missing_argument") {
                    operation.handlerResolution = "unresolved_handler";
                }
            }
            if (operation.handlerResolution == "unresolved_handler" ||
                operation.handlerResolution == "external_handler") {
                result_.uncertainties.push_back("handler target for '" + operation.api +
                    "' at " + locationString(operation.location.expansion) + " is " +
                    operation.handlerResolution);
            }
        }
    }

    bool VisitIfStmt(clang::IfStmt *statement) { return addControl("if", statement->getCond(), statement->getIfLoc()); }
    bool VisitSwitchStmt(clang::SwitchStmt *statement) { return addControl("switch", statement->getCond(), statement->getSwitchLoc()); }
    bool VisitForStmt(clang::ForStmt *statement) { return addControl("for", statement->getCond(), statement->getForLoc()); }
    bool VisitWhileStmt(clang::WhileStmt *statement) { return addControl("while", statement->getCond(), statement->getWhileLoc()); }
    bool VisitDoStmt(clang::DoStmt *statement) { return addControl("do_while", statement->getCond(), statement->getDoLoc()); }
    bool VisitConditionalOperator(clang::ConditionalOperator *expression) { return addControl("conditional_operator", expression->getCond(), expression->getQuestionLoc()); }

private:
    const clang::Expr *assignedStateLValue(const clang::CallExpr *call) const {
        const clang::Stmt *current = call;
        for (unsigned depth = 0; depth < 8 && current; ++depth) {
            const auto parents = context_.getParents(*current);
            if (parents.empty()) break;
            const clang::Stmt *next = nullptr;
            for (const auto &parent : parents) {
                if (const auto *assignment = parent.get<clang::BinaryOperator>()) {
                    const auto *rhs = assignment->getRHS()->IgnoreParenImpCasts();
                    if (assignment->isAssignmentOp() && rhs == call)
                        return assignment->getLHS();
                    next = assignment;
                    break;
                }
                if (const auto *statement = parent.get<clang::Stmt>()) {
                    next = statement;
                    break;
                }
            }
            current = next;
        }
        return nullptr;
    }

    static std::string functionId(const clang::FunctionDecl *function,
                                  const clang::SourceManager &manager) {
        return function->getQualifiedNameAsString() + "@" +
               locationIdentity(function->getLocation(), manager);
    }

    unsigned sourceOffset(clang::SourceLocation location) const {
        location = manager_.getExpansionLoc(location);
        return location.isValid() ? manager_.getFileOffset(location) : 0;
    }

    void buildCFG(clang::FunctionDecl *function, std::size_t infoIndex) {
        clang::CFG::BuildOptions options;
        auto cfg = clang::CFG::buildCFG(function, function->getBody(), &context_, options);
        if (!cfg) {
            result_.diagnostics.push_back("could not construct CFG for " + currentFunction_);
            return;
        }
        auto &info = result_.functions[infoIndex];
        info.cfgAvailable = true;
        info.cfg.resize(cfg->getNumBlockIDs());
        info.entryBlock = cfg->getEntry().getBlockID();
        ConditionMutationCollector mutations;
        mutations.TraverseStmt(function->getBody());
        std::unordered_map<std::size_t, std::pair<unsigned, unsigned long long>> chosenBlock;
        for (const clang::CFGBlock *block : *cfg) {
            auto &record = info.cfg[block->getBlockID()];
            record.id = block->getBlockID();
            record.isExit = block == &cfg->getExit();
            std::vector<const clang::CFGBlock *> reachableSuccessors;
            for (auto successor : block->succs())
                if (const clang::CFGBlock *target = successor.getReachableBlock())
                    reachableSuccessors.push_back(target);
            const auto *terminator = block->getTerminatorStmt();
            const auto *condition = supportedBranchCondition(terminator);
            const bool recognizedBranch = condition &&
                (llvm::isa<clang::IfStmt>(terminator) || llvm::isa<clang::WhileStmt>(terminator) ||
                 llvm::isa<clang::DoStmt>(terminator) || llvm::isa<clang::ForStmt>(terminator));
            for (std::size_t successorIndex = 0; successorIndex < reachableSuccessors.size(); ++successorIndex) {
                const clang::CFGBlock *target = reachableSuccessors[successorIndex];
                record.successors.push_back(target->getBlockID());
                FunctionInfo::CFGBlock::BranchCondition branch;
                branch.targetBlock = target->getBlockID();
                branch.hasCondition = reachableSuccessors.size() > 1;
                if (branch.hasCondition) {
                    const clang::Expr *branchExpr = recognizedBranch
                        ? condition : llvm::dyn_cast_or_null<clang::Expr>(block->getTerminatorCondition());
                    branch.expression = branchExpr ? expressionText(branchExpr, context_) : "<unsupported-branch>";
                    branch.location = branchExpr ? makeLocated(branchExpr->getExprLoc(), manager_) :
                        makeLocated(block->getTerminatorStmt() ? block->getTerminatorStmt()->getBeginLoc()
                                                               : clang::SourceLocation(), manager_);
                    if (recognizedBranch && reachableSuccessors.size() == 2) {
                        bool conditionTruth = true;
                        branch.supported = normalizeCondition(condition, context_, manager_, mutations.modified,
                                                              mutations.escaped, branch.atom, conditionTruth);
                        // Clang CFG orders the if/loop body before the alternate/exit edge.
                        branch.truth = successorIndex == 0 ? conditionTruth : !conditionTruth;
                    }
                }
                record.successorConditions.push_back(std::move(branch));
            }
            for (const auto &element : *block) {
                auto cfgStmt = element.getAs<clang::CFGStmt>();
                if (!cfgStmt)
                    continue;
                const clang::Stmt *statement = cfgStmt->getStmt();
                CFGCallCollector collector;
                collector.TraverseStmt(const_cast<clang::Stmt *>(statement));
                unsigned statementBegin = sourceOffset(statement->getBeginLoc());
                unsigned statementEnd = sourceOffset(statement->getEndLoc());
                unsigned long long span = statementEnd >= statementBegin
                    ? static_cast<unsigned long long>(statementEnd - statementBegin) + 1
                    : std::numeric_limits<unsigned>::max();
                for (const auto *call : collector.calls) {
                    auto found = callIndices_.find(call);
                    if (found == callIndices_.end())
                        continue;
                    auto candidate = std::make_pair(record.id, span);
                    auto previous = chosenBlock.find(found->second);
                    if (previous == chosenBlock.end() || span < previous->second.second ||
                        (span == previous->second.second && statement == call))
                        chosenBlock[found->second] = candidate;
                }
            }
        }
        for (const auto &entry : chosenBlock)
            info.cfg[entry.second.first].callEvents.push_back(entry.first);
        auto expected = functionCallIndices_.find(info.id);
        if (expected != functionCallIndices_.end()) {
            for (std::size_t callIndex : expected->second) {
                if (!chosenBlock.count(callIndex)) {
                    info.cfgEventsComplete = false;
                    const auto &location = result_.calls[callIndex].location.expansion;
                    result_.diagnostics.push_back("could not map call at " + location.file + ":" +
                        std::to_string(location.line) + ":" + std::to_string(location.column) +
                        " into CFG for " + currentFunction_);
                }
            }
        }
        auto offsets = [&](std::size_t index) {
            auto found = callEndOffsets_.find(index);
            return found == callEndOffsets_.end() ? 0u : found->second;
        };
        for (auto &block : info.cfg)
            std::stable_sort(block.callEvents.begin(), block.callEvents.end(),
                [&](std::size_t left, std::size_t right) { return offsets(left) < offsets(right); });

        // Mark DFS back edges so predicate facts from one loop iteration are
        // not incorrectly reused in a later iteration after values may change.
        std::vector<unsigned char> color(info.cfg.size(), 0);
        std::function<void(unsigned)> markBackEdges = [&](unsigned blockId) {
            if (blockId >= info.cfg.size() || color[blockId] == 2) return;
            color[blockId] = 1;
            auto &block = info.cfg[blockId];
            for (auto &branch : block.successorConditions) {
                if (branch.targetBlock >= color.size()) continue;
                if (color[branch.targetBlock] == 1)
                    branch.loopBackEdge = true;
                else if (color[branch.targetBlock] == 0)
                    markBackEdges(branch.targetBlock);
            }
            color[blockId] = 2;
        };
        markBackEdges(info.entryBlock);
    }

    bool isMainFile(clang::SourceLocation location) const {
        return location.isValid() && manager_.isWrittenInMainFile(manager_.getExpansionLoc(location));
    }

    static std::string locationString(const SourceLocation &location) {
        if (!location.valid) return "<unknown>";
        return location.file + ":" + std::to_string(location.line) + ":" + std::to_string(location.column);
    }

    bool addControl(const std::string &kind, const clang::Expr *condition,
                    clang::SourceLocation location) {
        if (!isMainFile(location))
            return true;
        ControlConstruct construct;
        construct.kind = kind;
        construct.condition = condition ? expressionText(condition, context_) : "";
        construct.function = currentFunction_;
        construct.location = makeLocated(location, manager_);
        result_.controls.push_back(std::move(construct));
        return true;
    }

    clang::ASTContext &context_;
    clang::SourceManager &manager_;
    const ApiRegistry &registry_;
    AnalysisResult &result_;
    std::string currentFunction_;
    std::string currentFunctionId_;
    const clang::FunctionDecl *currentFunctionDecl_ = nullptr;
    SafePointerAliases safeAliases_;
    std::unordered_map<const clang::CallExpr *, std::size_t> callIndices_;
    std::unordered_map<std::size_t, unsigned> callEndOffsets_;
    std::unordered_map<std::string, std::vector<std::size_t>> functionCallIndices_;
    std::unordered_map<std::size_t, const clang::FunctionDecl *> directTargets_;
    std::unordered_map<std::size_t, const clang::FunctionDecl *> directHandlerTargets_;
    std::unordered_map<std::size_t, const clang::VarDecl *> indirectVariables_;
    std::unordered_map<std::size_t, const clang::VarDecl *> handlerVariables_;
    std::unordered_map<const clang::VarDecl *, std::unordered_set<const clang::FunctionDecl *>> pointerTargets_;
    std::unordered_map<const clang::FunctionDecl *, std::string> functionDefinitions_;
};

class ExtractConsumer : public clang::ASTConsumer {
public:
    ExtractConsumer(clang::ASTContext &context, const ApiRegistry &registry,
                    AnalysisResult &result)
        : extractor_(context, registry, result) {}
    void HandleTranslationUnit(clang::ASTContext &context) override {
        extractor_.TraverseDecl(context.getTranslationUnitDecl());
        extractor_.finalizeCallTargets();
    }
private:
    Extractor extractor_;
};

class ExtractAction : public clang::ASTFrontendAction {
public:
    ExtractAction(const ApiRegistry &registry, AnalysisResult &result)
        : registry_(registry), result_(result) {}
    std::unique_ptr<clang::ASTConsumer> CreateASTConsumer(
        clang::CompilerInstance &compiler, llvm::StringRef) override {
        return std::make_unique<ExtractConsumer>(compiler.getASTContext(), registry_, result_);
    }
private:
    const ApiRegistry &registry_;
    AnalysisResult &result_;
};

class ExtractFactory : public clang::tooling::FrontendActionFactory {
public:
    ExtractFactory(const ApiRegistry &registry, AnalysisResult &result)
        : registry_(registry), result_(result) {}
    std::unique_ptr<clang::FrontendAction> create() override {
        return std::make_unique<ExtractAction>(registry_, result_);
    }
private:
    const ApiRegistry &registry_;
    AnalysisResult &result_;
};

} // namespace

int analyzeSource(const AnalyzeOptions &options, const ApiRegistry &registry,
                  AnalysisResult &result, std::string &error) {
    result.source = options.source;
    std::unique_ptr<clang::tooling::CompilationDatabase> database;
    if (!options.compilationDatabase.empty()) {
        std::string loadError;
        database = clang::tooling::CompilationDatabase::loadFromDirectory(
            options.compilationDatabase, loadError);
        if (!database) {
            error = "cannot load compilation database from '" +
                    options.compilationDatabase + "': " + loadError;
            return 2;
        }
    } else {
        std::vector<std::string> arguments = options.clangArguments;
        if (arguments.empty())
            arguments.push_back("-std=c11");
        database = std::make_unique<clang::tooling::FixedCompilationDatabase>(".", arguments);
    }
    clang::tooling::ClangTool tool(*database, {options.source});
    ExtractFactory factory(registry, result);
    int status = tool.run(&factory);
    if (status != 0)
        error = "Clang failed to parse or analyze the requested source (tool status " +
                std::to_string(status) + ")";
    else {
        analyzeInterprocedural(result);
        analyzeInterrupts(result);
    }
    return status;
}

} // namespace deadlock
