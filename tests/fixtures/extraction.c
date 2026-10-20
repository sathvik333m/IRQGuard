typedef struct { int held; } spinlock_t;
typedef struct { int held; } mutex_t;

void mutex_lock(mutex_t *lock);
void mutex_unlock(mutex_t *lock);
void spin_lock(spinlock_t *lock);
void spin_unlock(spinlock_t *lock);
void spin_lock_irqsave(spinlock_t *lock, unsigned long flags);
void spin_unlock_irqrestore(spinlock_t *lock, unsigned long flags);
void local_irq_disable(void);
void local_irq_enable(void);
int request_irq(unsigned int irq, void (*handler)(void), unsigned long flags,
                const char *name, void *data);
void free_irq(unsigned int irq, void *data);
void project_lock(int mode, spinlock_t *lock);

#define LOCK_WITH_MACRO(lockptr) spin_lock((lockptr))

static void inner(mutex_t *m, spinlock_t *s) {
    mutex_lock(m);
    LOCK_WITH_MACRO(s);
    mutex_unlock(m);
}

static void indirect(spinlock_t *lock) {
    spinlock_t *chosen = lock;
    spinlock_t *lock_array[2];
    lock_array[0] = lock;
    spin_lock(&chosen[0]);
    spin_unlock(&chosen[0]);
    spin_lock(lock_array[0]);
    spin_unlock(lock_array[0]);
}

int analyze_me(mutex_t *m, spinlock_t *s, int enabled) {
    unsigned long flags = 0;
    if (enabled) {
        spin_lock_irqsave(s, flags);
        inner(m, s);
        spin_unlock_irqrestore(s, flags);
    } else {
        local_irq_disable();
        local_irq_enable();
    }
    for (int i = 0; i < 2; ++i) {
        if (i)
            indirect(s);
    }
    request_irq(4, 0, 0, "demo", s);
    free_irq(4, s);
    project_lock(1, s);
    return 0;
}
