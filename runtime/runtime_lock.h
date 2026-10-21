#ifndef IRQGUARD_RUNTIME_LOCK_H
#define IRQGUARD_RUNTIME_LOCK_H

#include <pthread.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct irqguard_mutex {
    pthread_mutex_t native;
    char runtime_id[64];
} irqguard_mutex;

int irqguard_mutex_init(irqguard_mutex *mutex, const char *runtime_id);
int irqguard_mutex_destroy(irqguard_mutex *mutex);
void irqguard_lock(irqguard_mutex *mutex);
void irqguard_unlock(irqguard_mutex *mutex);

extern irqguard_mutex runtime_lock_a;
extern irqguard_mutex runtime_lock_b;
extern irqguard_mutex static_only_lock_c;
extern irqguard_mutex static_only_lock_d;

void runtime_order_ab(void);
void runtime_order_ba(void);
void runtime_order_ab_with_delay(void);
void runtime_candidate_cd(void);
void runtime_candidate_dc(void);

#ifdef __cplusplus
}
#endif

#endif
