cmake_minimum_required(VERSION 3.16)
project(interrupt_aware_deadlock_analyzer VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# LLVM's exported static-library targets refer to these imported targets even
# when the analyzer itself does not include their headers. Prefer the normal
# development packages, but accept installed runtime libraries as a fallback.
function(deadlock_runtime_target target_name)
    if(TARGET ${target_name})
        return()
    endif()
    set(_runtime_paths
        /lib
        /usr/lib
        /usr/local/lib
        /lib/${CMAKE_LIBRARY_ARCHITECTURE}
        /usr/lib/${CMAKE_LIBRARY_ARCHITECTURE}
        /usr/local/lib/${CMAKE_LIBRARY_ARCHITECTURE}
    )
    string(MAKE_C_IDENTIFIER "${target_name}" _target_id)
    set(_runtime_variable "_deadlock_${_target_id}_runtime_library")
    find_file(${_runtime_variable} NAMES ${ARGN} PATHS ${_runtime_paths} NO_DEFAULT_PATH)
    if(DEFINED ${_runtime_variable} AND NOT "${${_runtime_variable}}" STREQUAL "")
        add_library(${target_name} UNKNOWN IMPORTED GLOBAL)
        set_target_properties(${target_name} PROPERTIES
            IMPORTED_LOCATION "${${_runtime_variable}}")
    endif()
endfunction()

deadlock_runtime_target(ZLIB::ZLIB libz.so.1)
deadlock_runtime_target(zstd::libzstd_shared libzstd.so.1)
deadlock_runtime_target(LibEdit::LibEdit libedit.so.2)
deadlock_runtime_target(CURL::libcurl libcurl.so.4)

find_package(LLVM REQUIRED CONFIG)
find_package(Clang REQUIRED CONFIG)

message(STATUS "Using LLVM ${LLVM_PACKAGE_VERSION}")
message(STATUS "Using Clang ${LLVM_PACKAGE_VERSION}")

add_executable(deadlock-analyzer
    src/main.cpp
    src/Analyzer.cpp
    src/ApiRegistry.cpp
    src/Interprocedural.cpp
    src/InterruptAnalysis.cpp
    src/Output.cpp
)

target_include_directories(deadlock-analyzer PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${LLVM_INCLUDE_DIRS}
    ${CLANG_INCLUDE_DIRS}
)
target_compile_definitions(deadlock-analyzer PRIVATE ${LLVM_DEFINITIONS})
target_link_libraries(deadlock-analyzer PRIVATE
    clangTooling
    clangFrontend
    clangAST
    clangBasic
    clangLex
    LLVMSupport
)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    find_package(Threads REQUIRED)
    add_library(irqguard_runtime_support STATIC runtime/runtime_lock.cpp)
    target_include_directories(irqguard_runtime_support PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/runtime)
    target_link_libraries(irqguard_runtime_support PUBLIC Threads::Threads)

    add_executable(irqguard-runtime-demo
        runtime/runtime_demo.cpp
        runtime/fixtures/lock_orders.c
    )
    target_include_directories(irqguard-runtime-demo PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/runtime)
    target_link_libraries(irqguard-runtime-demo PRIVATE irqguard_runtime_support Threads::Threads)
endif()

include(CTest)
find_package(Python3 COMPONENTS Interpreter REQUIRED)
if(BUILD_TESTING)
    add_test(NAME analyzer_extraction
        COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_analyzer.py
                $<TARGET_FILE:deadlock-analyzer>
                ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/extraction.c
                ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/invalid.c
                ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/custom_apis.json
                ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/invalid_apis.json
    )
    add_test(NAME analyzer_interprocedural
        COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_interprocedural.py
                $<TARGET_FILE:deadlock-analyzer>
                ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/interprocedural.c
    )
    add_test(NAME analyzer_dependency_generation
        COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_dependency_generation.py
                $<TARGET_FILE:deadlock-analyzer>
                ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/dependency_generation.c
    )
    add_test(NAME analyzer_symbolic_identity
        COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_symbolic_identity.py
                $<TARGET_FILE:deadlock-analyzer>
                ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/symbolic_identity.c
    )
    add_test(NAME analyzer_interrupt_aware
        COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_interrupts.py
                $<TARGET_FILE:deadlock-analyzer>
                ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/interrupts.c
    )
    add_test(NAME analyzer_feasibility
        COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_phase4.py
                $<TARGET_FILE:deadlock-analyzer>
                ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/interrupts.c
    )
    add_test(NAME analyzer_phase16_path_feasibility
        COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_phase16_feasibility.py
                $<TARGET_FILE:deadlock-analyzer>
                ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/phase16_feasibility.c
    )
    add_test(NAME analyzer_review_regressions
        COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_review_fixes.py
                $<TARGET_FILE:deadlock-analyzer>
                ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/review_fixes.c
    )
    add_test(NAME analyzer_kernel_lock_api_macros
        COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_kernel_lock_api_macros.py
                $<TARGET_FILE:deadlock-analyzer>
                ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/kernel_lock_api_macros.c
    )
    add_test(NAME analyzer_uncertainty_reporting
        COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_uncertainty_reporting.py
                $<TARGET_FILE:deadlock-analyzer>
                ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/uncertainty_propagation.c
    )
    add_test(NAME evaluation_summarizer
        COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/evaluation/test_summarize.py
                $<TARGET_FILE:deadlock-analyzer>
                ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/interrupts.c
    )
    add_test(NAME evaluation_uncertainty_baseline
        COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/evaluation/test_uncertainty_baseline.py
                ${CMAKE_CURRENT_SOURCE_DIR}/evaluation/summarize_uncertainties.py
                ${CMAKE_CURRENT_SOURCE_DIR}/evaluation/results/linux-v6.6.87/reports
    )
    add_test(NAME evaluation_phase11_cycle_review
        COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/evaluation/test_review_cycles.py
    )
    add_test(NAME evaluation_phase12_build_evidence
        COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/evaluation/test_phase12_evidence.py
    )
    add_test(NAME evaluation_phase13_comparison
        COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/evaluation/test_phase13_comparison.py
    )
    if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
        add_test(NAME runtime_lock_evidence
            COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/runtime/test_runtime_evidence.py
                    $<TARGET_FILE:irqguard-runtime-demo>
                    $<TARGET_FILE:deadlock-analyzer>
                    ${CMAKE_CURRENT_SOURCE_DIR}
        )
        set_tests_properties(runtime_lock_evidence PROPERTIES TIMEOUT 40)
        add_test(NAME unified_cli_integration
            COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_cli.py
                    ${CMAKE_CURRENT_SOURCE_DIR}
        )
        set_tests_properties(unified_cli_integration PROPERTIES TIMEOUT 40
            ENVIRONMENT "IRQGUARD_ANALYZER=$<TARGET_FILE:deadlock-analyzer>;IRQGUARD_RUNTIME_DEMO=$<TARGET_FILE:irqguard-runtime-demo>"
        )
    endif()
endif()

install(TARGETS deadlock-analyzer RUNTIME DESTINATION bin)
