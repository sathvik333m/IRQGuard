typedef struct { int value; } spinlock_t;
typedef void (*irq_handler_t)(int, void *);

void spin_lock(spinlock_t *lock);
void spin_unlock(spinlock_t *lock);
void spin_lock_irqsave(spinlock_t *lock, unsigned long *flags);
void spin_unlock_irqrestore(spinlock_t *lock, unsigned long *flags);
void spin_lock_irq(spinlock_t *lock);
void local_irq_disable(void);
void local_irq_enable(void);
int request_irq(unsigned int irq, irq_handler_t handler, unsigned long flags,
                const char *name, void *device);
void free_irq(unsigned int irq, void *device);
spinlock_t *get_lock(void);

static spinlock_t normal_a, normal_b;
static spinlock_t cross_a, cross_b;
static spinlock_t blocked_a, blocked_b;
static spinlock_t state_a, state_b, state_c, state_d, state_e, state_f;
static spinlock_t handler_c;
static spinlock_t unknown_lock;
static spinlock_t ambiguous_a, ambiguous_b;

static void normal_ab(void) {
    spin_lock(&normal_a);
    spin_lock(&normal_b);
}

static void normal_ba(void) {
    spin_lock(&normal_b);
    spin_lock(&normal_a);
}

static void release_before_next_acquire(void) {
    spin_lock(&state_a);
    spin_unlock(&state_a);
    spin_lock(&state_b);
    spin_unlock(&state_b);
}

static void acquire_cross_b(void) {
    spin_lock(&cross_b);
}

static void cross_handler(int irq, void *device) {
    (void)irq;
    (void)device;
    spin_lock(&cross_b);
    spin_lock(&cross_a);
}

static void second_handler(int irq, void *device) {
    (void)irq;
    (void)device;
    spin_lock(&handler_c);
    spin_lock(&cross_b);
}

static void blocked_handler(int irq, void *device) {
    (void)irq;
    (void)device;
    spin_lock(&blocked_b);
    spin_lock(&blocked_a);
}

static void ambiguous_handler(int irq, void *device) {
    (void)irq;
    (void)device;
    spin_lock(&ambiguous_b);
    spin_lock(&ambiguous_a);
}

void register_handlers(void) {
    irq_handler_t selected = second_handler;
    request_irq(1, cross_handler, 0, "cross", 0);
    request_irq(2, second_handler, 0, "second", 0);
    request_irq(3, blocked_handler, 0, "blocked", 0);
    request_irq(5, ambiguous_handler, 0, "ambiguous", 0);
    request_irq(6, selected, 0, "indirect", 0);
}

void register_unknown_handler(irq_handler_t handler) {
    request_irq(4, handler, 0, "unknown", 0);
}

void unregister_one_handler(void) {
    free_irq(1, 0);
}

void process_cross_context(void) {
    spin_lock(&cross_a);
    acquire_cross_b();
    spin_unlock(&cross_b);
    spin_unlock(&cross_a);
}

static void irq_off_wrapper(void) {
    local_irq_disable();
}

static void irqsave_lock_wrapper(spinlock_t *lock, unsigned long *flags) {
    spin_lock_irqsave(lock, flags);
}

static void irqrestore_lock_wrapper(spinlock_t *lock, unsigned long *flags) {
    spin_unlock_irqrestore(lock, flags);
}

void process_with_irqs_disabled(void) {
    irq_off_wrapper();
    spin_lock(&blocked_a);
    spin_lock(&blocked_b);
    spin_unlock(&blocked_b);
    spin_unlock(&blocked_a);
    local_irq_enable();
}

void process_with_path_dependent_irq_state(int disable) {
    if (disable)
        local_irq_disable();
    spin_lock(&ambiguous_a);
    spin_lock(&ambiguous_b);
    spin_unlock(&ambiguous_b);
    spin_unlock(&ambiguous_a);
    local_irq_enable();
}

void irqsave_restore_cases(void) {
    unsigned long flags = 0;
    spin_lock_irqsave(&state_a, &flags);
    spin_lock(&state_b);
    spin_unlock(&state_b);
    spin_unlock_irqrestore(&state_a, &flags);
    spin_lock(&state_c);
    spin_unlock(&state_c);

    local_irq_disable();
    spin_lock_irqsave(&state_d, &flags);
    spin_unlock_irqrestore(&state_d, &flags);
    spin_lock(&state_e);
    local_irq_enable();
    spin_lock(&state_f);
    spin_unlock(&state_f);
}

void irqsave_wrapper_cases(void) {
    unsigned long flags = 0;
    irqsave_lock_wrapper(&state_a, &flags);
    spin_lock(&state_b);
    irqrestore_lock_wrapper(&state_a, &flags);
    spin_lock(&state_c);
}

void unsupported_api_case(void) {
    spin_lock_irq(&unknown_lock);
}

void unmatched_irqrestore_case(void) {
    unsigned long flags = 0;
    spin_unlock_irqrestore(&state_a, &flags);
    spin_lock(&state_b);
}

void unresolved_lock_case(void) {
    spin_lock(get_lock());
}
