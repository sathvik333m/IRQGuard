#include "runtime_lock.h"

#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <mutex>
#include <sched.h>
#include <string>
#include <sys/syscall.h>
#include <unistd.h>

namespace {
std::mutex eventMutex;
std::atomic<unsigned long long> nextSequence{1};
std::ofstream eventFile;

std::string jsonEscape(const char *value) {
    std::string escaped;
    for (const unsigned char ch : std::string(value ? value : "")) {
        switch (ch) {
        case '"': escaped += "\\\""; break;
        case '\\': escaped += "\\\\"; break;
        case '\n': escaped += "\\n"; break;
        case '\r': escaped += "\\r"; break;
        case '\t': escaped += "\\t"; break;
        default:
            if (ch < 0x20) escaped += '?';
            else escaped += static_cast<char>(ch);
        }
    }
    return escaped;
}

void writeEventLocked(const irqguard_mutex *mutex, const char *event) {
    if (!eventFile.is_open()) {
        const char *tracePath = std::getenv("IRQGUARD_TRACE")
            ? std::getenv("IRQGUARD_TRACE") : nullptr;
        if (!tracePath || !*tracePath) {
            std::cerr << "IRQGUARD_TRACE must name a JSONL trace file\n";
            std::abort();
        }
        eventFile.open(tracePath, std::ios::out | std::ios::app);
        if (!eventFile) {
            std::cerr << "cannot open IRQGUARD_TRACE file: " << tracePath << '\n';
            std::abort();
        }
    }
    const auto now = std::chrono::steady_clock::now().time_since_epoch();
    const auto timestamp = std::chrono::duration_cast<std::chrono::nanoseconds>(now).count();
    const auto sequence = nextSequence.fetch_add(1, std::memory_order_relaxed);
    const auto tid = static_cast<long long>(::syscall(SYS_gettid));
    const char *runId = std::getenv("IRQGUARD_RUN_ID");
    eventFile << "{\"schema_version\":1"
              << ",\"run_id\":\"" << jsonEscape(runId ? runId : "local") << "\""
              << ",\"sequence\":" << sequence
              << ",\"timestamp_monotonic_ns\":" << timestamp
              << ",\"process_id\":" << static_cast<long long>(::getpid())
              << ",\"thread_id\":\"" << tid << "\""
              << ",\"lock_id\":\"" << jsonEscape(mutex->runtime_id) << "\""
              << ",\"event\":\"" << event << "\"}\n";
    // Flush each event: a watchdog may terminate the process while a test is stuck.
    eventFile.flush();
}

void record(const irqguard_mutex *mutex, const char *event) {
    std::lock_guard<std::mutex> guard(eventMutex);
    writeEventLocked(mutex, event);
}
}

extern "C" int irqguard_mutex_init(irqguard_mutex *mutex, const char *runtimeId) {
    if (!mutex || !runtimeId || std::strlen(runtimeId) >= sizeof(mutex->runtime_id)) return EINVAL;
    const int status = pthread_mutex_init(&mutex->native, nullptr);
    if (status != 0) return status;
    std::strcpy(mutex->runtime_id, runtimeId);
    return 0;
}

extern "C" int irqguard_mutex_destroy(irqguard_mutex *mutex) {
    return mutex ? pthread_mutex_destroy(&mutex->native) : EINVAL;
}

extern "C" void irqguard_lock(irqguard_mutex *mutex) {
    if (!mutex) std::abort();
    record(mutex, "acquire_attempt");
    bool observedContention = false;
    for (;;) {
        const int status = pthread_mutex_trylock(&mutex->native);
        if (status == 0) {
            record(mutex, "acquire_success");
            return;
        }
        if (status != EBUSY) {
            std::cerr << "pthread_mutex_trylock failed: " << std::strerror(status) << '\n';
            std::abort();
        }
        if (!observedContention) {
            record(mutex, "contention_observed");
            observedContention = true;
        }
        ::sched_yield();
    }
}

extern "C" void irqguard_unlock(irqguard_mutex *mutex) {
    if (!mutex) std::abort();
    // Keep the event order coherent with ownership transfer: a new owner cannot
    // log acquire_success before the preceding release has been recorded.
    std::lock_guard<std::mutex> guard(eventMutex);
    const int status = pthread_mutex_unlock(&mutex->native);
    if (status != 0) {
        std::cerr << "pthread_mutex_unlock failed: " << std::strerror(status) << '\n';
        std::abort();
    }
    writeEventLocked(mutex, "release");
}
