typedef struct lock { int value; } lock_t;

extern void mutex_lock(lock_t *lock);
extern void mutex_unlock(lock_t *lock);
extern void local_irq_disable(void);
extern int request_irq(unsigned int irq, void (*handler)(void), unsigned long flags,
                       const char *name, void *device);
extern unsigned long _raw_spin_lock_irqsave(lock_t *lock);
extern void _raw_spin_unlock_irqrestore(lock_t *lock, unsigned long flags);
extern void opaque_callback(lock_t *lock);

/* Kernel v6.6.87-shaped expansion: the public lock is checked, and the raw
 * irqsave helper returns flags into the macro's source lvalue. */
static lock_t *spinlock_check(lock_t *lock) { return lock; }
#define raw_spin_lock_irqsave(lock, flags) do { (flags) = _raw_spin_lock_irqsave(lock); } while (0)
#define spin_lock_irqsave(lock, flags) \
    do { raw_spin_lock_irqsave(spinlock_check(lock), flags); } while (0)
#define spin_unlock_irqrestore(lock, flags) \
    _raw_spin_unlock_irqrestore(spinlock_check(lock), flags)

void macro_lock_pair(lock_t *lock) {
    unsigned long flags;
    spin_lock_irqsave(lock, flags);
    spin_unlock_irqrestore(lock, flags);
}

void raw_kernel_helpers(lock_t *lock, unsigned long flags) {
    (void)_raw_spin_lock_irqsave(lock);
    _raw_spin_unlock_irqrestore(lock, flags);
}

void order_ab(lock_t *a, lock_t *b) {
    mutex_lock(a);
    mutex_lock(b);
    mutex_unlock(b);
    mutex_unlock(a);
}

void order_ba(lock_t *x, lock_t *y) {
    mutex_lock(y);
    mutex_lock(x);
    mutex_unlock(x);
    mutex_unlock(y);
}

void reacquire_same(lock_t *lock) {
    mutex_lock(lock);
    mutex_lock(lock);
    mutex_unlock(lock);
    mutex_unlock(lock);
}

static lock_t handler_lock;
static lock_t process_lock;

static void known_disable(lock_t *lock) {
    (void)lock;
    local_irq_disable();
}

static void irq_handler(void) {
    mutex_lock(&handler_lock);
    mutex_unlock(&handler_lock);
}

void unknown_indirect_target(lock_t *lock, int choose_opaque) {
    void (*callback)(lock_t *) = known_disable;
    if (choose_opaque)
        callback = opaque_callback;
    callback(lock);
    mutex_lock(&process_lock);
    mutex_unlock(&process_lock);
}

void register_test_handler(void) {
    request_irq(1, irq_handler, 0, "review", 0);
}
