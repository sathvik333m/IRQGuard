#include "deadlock/Analyzer.h"
#include "deadlock/Output.h"

#include "llvm/Support/Program.h"

#include <fstream>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

namespace {
void usage(std::ostream &out) {
    out << "Usage: deadlock-analyzer analyze --source FILE [options]\n"
           "Options:\n"
           "  --compile-commands DIR  Compilation database directory\n"
           "  --api-config FILE       JSON API registry (extends/replaces defaults by name)\n"
           "  --clang-arg ARG         Add a Clang argument (repeatable; direct mode only)\n"
           "  --format text|json      Output format (default: text)\n"
           "  --output FILE           Write report to file instead of stdout\n"
           "  --help                  Show this help\n";
}
}

int main(int argc, char **argv) {
    if (argc == 1 || std::string(argv[1]) == "--help" || std::string(argv[1]) == "-h") {
        usage(std::cout);
        return argc == 1 ? 2 : 0;
    }
    if (std::string(argv[1]) != "analyze") {
        std::cerr << "error: expected subcommand 'analyze'\n";
        usage(std::cerr);
        return 2;
    }

    deadlock::AnalyzeOptions options;
    std::string apiConfig;
    std::string format = "text";
    std::string outputPath;
    for (int i = 2; i < argc; ++i) {
        std::string argument = argv[i];
        auto value = [&](const char *name) -> std::string {
            if (i + 1 >= argc) {
                std::cerr << "error: option " << name << " requires a value\n";
                std::exit(2);
            }
            return argv[++i];
        };
        if (argument == "--source") options.source = value("--source");
        else if (argument == "--compile-commands") options.compilationDatabase = value("--compile-commands");
        else if (argument == "--api-config") apiConfig = value("--api-config");
        else if (argument == "--clang-arg") options.clangArguments.push_back(value("--clang-arg"));
        else if (argument == "--format") format = value("--format");
        else if (argument == "--output") outputPath = value("--output");
        else if (argument == "--help" || argument == "-h") { usage(std::cout); return 0; }
        else { std::cerr << "error: unknown option '" << argument << "'\n"; return 2; }
    }
    if (options.source.empty()) { std::cerr << "error: --source is required\n"; return 2; }
    if (format != "text" && format != "json") {
        std::cerr << "error: --format must be 'text' or 'json'\n";
        return 2;
    }
    if (!options.compilationDatabase.empty() && !options.clangArguments.empty()) {
        std::cerr << "error: --clang-arg cannot be combined with --compile-commands\n";
        return 2;
    }

    deadlock::ApiRegistry registry;
    std::string error;
    if (!apiConfig.empty() && !registry.loadFile(apiConfig, error)) {
        std::cerr << "error: " << error << '\n';
        return 2;
    }
    deadlock::AnalysisResult result;
    int status = deadlock::analyzeSource(options, registry, result, error);
    if (status != 0) {
        std::cerr << "error: " << error << '\n';
        return status;
    }
    const std::string report = format == "json" ? deadlock::toJson(result) : deadlock::toText(result);
    if (outputPath.empty()) {
        std::cout << report;
    } else {
        std::ofstream output(outputPath);
        if (!output) { std::cerr << "error: cannot write output file '" << outputPath << "'\n"; return 2; }
        output << report;
        if (!output) { std::cerr << "error: failed while writing output file '" << outputPath << "'\n"; return 2; }
    }
    return 0;
}
