#include "runtime_lock.h"

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <pthread.h>
#include <string>

namespace {
pthread_barrier_t deadlockBarrier;
pthread_barrier_t contentionBarrier;

void *deadlockAtoB(void *) {
    irqguard_lock(&runtime_lock_a);
    pthread_barrier_wait(&deadlockBarrier);
    irqguard_lock(&runtime_lock_b);
    irqguard_unlock(&runtime_lock_b);
    irqguard_unlock(&runtime_lock_a);
    return nullptr;
}

void *deadlockBtoA(void *) {
    irqguard_lock(&runtime_lock_b);
    pthread_barrier_wait(&deadlockBarrier);
    irqguard_lock(&runtime_lock_a);
    irqguard_unlock(&runtime_lock_a);
    irqguard_unlock(&runtime_lock_b);
    return nullptr;
}

void *contendedOrder(void *) {
    pthread_barrier_wait(&contentionBarrier);
    runtime_order_ab_with_delay();
    return nullptr;
}

void runDeadlock() {
    pthread_barrier_init(&deadlockBarrier, nullptr, 2);
    pthread_t first{}, second{};
    pthread_create(&first, nullptr, deadlockAtoB, nullptr);
    pthread_create(&second, nullptr, deadlockBtoA, nullptr);
    pthread_join(first, nullptr);
    pthread_join(second, nullptr);
    pthread_barrier_destroy(&deadlockBarrier);
}

void runContention() {
    pthread_barrier_init(&contentionBarrier, nullptr, 3);
    pthread_t first{}, second{};
    pthread_create(&first, nullptr, contendedOrder, nullptr);
    pthread_create(&second, nullptr, contendedOrder, nullptr);
    pthread_barrier_wait(&contentionBarrier);
    pthread_join(first, nullptr);
    pthread_join(second, nullptr);
    pthread_barrier_destroy(&contentionBarrier);
}

void baselineOrderAB() {
    pthread_mutex_lock(&runtime_lock_a.native);
    pthread_mutex_lock(&runtime_lock_b.native);
    pthread_mutex_unlock(&runtime_lock_b.native);
    pthread_mutex_unlock(&runtime_lock_a.native);
}
}

int main(int argc, char **argv) {
    if (argc < 2) {
        std::cerr << "usage: irqguard-runtime-demo SCENARIO [ITERATIONS]\n";
        return 2;
    }
    const std::string scenario(argv[1]);
    if (irqguard_mutex_init(&runtime_lock_a, "A") != 0 ||
        irqguard_mutex_init(&runtime_lock_b, "B") != 0 ||
        irqguard_mutex_init(&static_only_lock_c, "C") != 0 ||
        irqguard_mutex_init(&static_only_lock_d, "D") != 0) {
        std::cerr << "could not initialize test mutexes\n";
        return 2;
    }

    if (scenario == "safe") {
        runtime_order_ab();
    } else if (scenario == "reverse-only") {
        runtime_order_ba();
    } else if (scenario == "opposite-order") {
        // Deliberately sequential. Both directions appear in this trace, but
        // there is no simultaneous wait-for cycle and this is not a deadlock.
        runtime_order_ab();
        runtime_order_ba();
    } else if (scenario == "contention") {
        runContention();
    } else if (scenario == "deadlock") {
        runDeadlock();
    } else if (scenario == "static-only") {
        runtime_order_ab();
    } else if (scenario == "benchmark-instrumented" || scenario == "benchmark-baseline") {
        const unsigned long iterations = argc > 2 ? std::strtoul(argv[2], nullptr, 10) : 1000;
        const auto started = std::chrono::steady_clock::now();
        for (unsigned long i = 0; i < iterations; ++i) {
            if (scenario == "benchmark-instrumented") runtime_order_ab();
            else baselineOrderAB();
        }
        const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - started).count();
        std::cout << "{\"scenario\":\"" << scenario << "\",\"iterations\":"
                  << iterations << ",\"elapsed_ns\":" << elapsed << "}\n";
    } else {
        std::cerr << "unknown scenario: " << scenario << '\n';
        return 2;
    }
    if (scenario != "benchmark-instrumented" && scenario != "benchmark-baseline")
        std::cout << "{\"scenario\":\"" << scenario << "\",\"status\":\"completed\"}\n";
    return 0;
}
