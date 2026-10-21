#include "runtime_lock.h"

#include <unistd.h>

irqguard_mutex runtime_lock_a;
irqguard_mutex runtime_lock_b;
irqguard_mutex static_only_lock_c;
irqguard_mutex static_only_lock_d;

void runtime_order_ab(void) {
    irqguard_lock(&runtime_lock_a);
    irqguard_lock(&runtime_lock_b);
    irqguard_unlock(&runtime_lock_b);
    irqguard_unlock(&runtime_lock_a);
}

void runtime_order_ba(void) {
    irqguard_lock(&runtime_lock_b);
    irqguard_lock(&runtime_lock_a);
    irqguard_unlock(&runtime_lock_a);
    irqguard_unlock(&runtime_lock_b);
}

void runtime_order_ab_with_delay(void) {
    irqguard_lock(&runtime_lock_a);
    usleep(30000);
    irqguard_lock(&runtime_lock_b);
    irqguard_unlock(&runtime_lock_b);
    irqguard_unlock(&runtime_lock_a);
}

// Deliberately present for static analysis, but not called by the
// "static-only" runtime scenario.
void runtime_candidate_cd(void) {
    irqguard_lock(&static_only_lock_c);
    irqguard_lock(&static_only_lock_d);
    irqguard_unlock(&static_only_lock_d);
    irqguard_unlock(&static_only_lock_c);
}

void runtime_candidate_dc(void) {
    irqguard_lock(&static_only_lock_d);
    irqguard_lock(&static_only_lock_c);
    irqguard_unlock(&static_only_lock_c);
    irqguard_unlock(&static_only_lock_d);
}
