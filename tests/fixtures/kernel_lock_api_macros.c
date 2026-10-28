typedef struct { int value; } spinlock_t;
typedef struct { int value; } mutex_t;

void mutex_lock(mutex_t *lock);
void mutex_unlock(mutex_t *lock);
void spin_lock(spinlock_t *lock);
void spin_unlock(spinlock_t *lock);
void spin_lock_irq(spinlock_t *lock);
void spin_unlock_irq(spinlock_t *lock);
void local_irq_disable(void);
void local_irq_enable(void);
void local_irq_save(unsigned long flags);
void local_irq_restore(unsigned long flags);
unsigned long _raw_spin_lock_irqsave(spinlock_t *lock);
void _raw_spin_unlock_irqrestore(spinlock_t *lock, unsigned long flags);
spinlock_t *get_lock(void);

/* Expansion shape observed in Linux v6.6.87's spinlock.h: the irqsave raw
 * helper returns saved flags, assigned by the public macro; spinlock_check is
 * an identity-preserving lock wrapper. This fixture is a small model of that
 * expansion, not a vendored or complete kernel header. */
static spinlock_t *spinlock_check(spinlock_t *lock) { return lock; }
#define raw_spin_lock_irqsave(lock, flags) \
    do { (flags) = _raw_spin_lock_irqsave(lock); } while (0)
#define spin_lock_irqsave(lock, flags) \
    do { raw_spin_lock_irqsave(spinlock_check(lock), flags); } while (0)
#define spin_unlock_irqrestore(lock, flags) \
    _raw_spin_unlock_irqrestore(spinlock_check(lock), flags)

static spinlock_t lock_a, lock_b, lock_c, irq_lock, local_lock_a, local_lock_b;
static mutex_t mutex_a;

void direct_mutex_operations(void) {
    mutex_lock(&mutex_a);
    mutex_unlock(&mutex_a);
}

void nested_macro_lock_operations(void) {
    unsigned long flags_a, flags_b;
    spin_lock_irqsave(&lock_a, flags_a);
    spin_lock_irqsave(&lock_b, flags_b);
    spin_unlock_irqrestore(&lock_b, flags_b);
    spin_unlock_irqrestore(&lock_a, flags_a);
    spin_lock(&lock_a);
    spin_unlock(&lock_a);
}

static void save_lock_wrapper(spinlock_t *lock, unsigned long *flags) {
    spin_lock_irqsave(lock, *flags);
}

static void restore_lock_wrapper(spinlock_t *lock, unsigned long *flags) {
    spin_unlock_irqrestore(lock, *flags);
}

void wrapped_macro_lock_operations(void) {
    unsigned long flags;
    save_lock_wrapper(&lock_a, &flags);
    spin_lock(&lock_b);
    spin_unlock(&lock_b);
    restore_lock_wrapper(&lock_a, &flags);
    spin_lock(&lock_c);
    spin_unlock(&lock_c);
}

void separate_flags_variables(void) {
    unsigned long first_flags, second_flags;
    spin_lock_irqsave(&lock_a, first_flags);
    spin_unlock_irqrestore(&lock_a, first_flags);
    spin_lock_irqsave(&lock_b, second_flags);
    spin_unlock_irqrestore(&lock_b, second_flags);
}

void conditional_macro_operations(int condition) {
    unsigned long flags;
    if (condition)
        spin_lock_irqsave(&lock_a, flags);
    if (condition)
        spin_unlock_irqrestore(&lock_a, flags);
    spin_lock(&lock_b);
    spin_unlock(&lock_b);
}

void unresolved_macro_lock_expression(unsigned long flags) {
    spin_lock_irqsave(get_lock(), flags);
    spin_unlock_irqrestore(get_lock(), flags);
}

void explicit_irq_lock_operations(void) {
    spin_lock_irq(&irq_lock);
    spin_unlock_irq(&irq_lock);
}

void local_irq_save_restore_operations(unsigned long flags) {
    local_irq_save(flags);
    spin_lock(&local_lock_a);
    spin_unlock(&local_lock_a);
    local_irq_restore(flags);
    spin_lock(&local_lock_b);
    spin_unlock(&local_lock_b);
}

void spin_lock_bh(spinlock_t *lock);
void unsupported_lock_api_operation(void) {
    spin_lock_bh(&lock_c);
}
