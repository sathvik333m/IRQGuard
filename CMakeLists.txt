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
endif()

install(TARGETS deadlock-analyzer RUNTIME DESTINATION bin)
