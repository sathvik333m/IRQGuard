typedef struct { int value; } spinlock_t;
typedef void (*irq_handler_t)(int, void *);

void spin_lock(spinlock_t *lock);
void spin_unlock(spinlock_t *lock);
void spin_lock_irqsave(spinlock_t *lock, unsigned long *flags);
void spin_unlock_irqrestore(spinlock_t *lock, unsigned long *flags);
int request_irq(unsigned int irq, irq_handler_t handler, unsigned long flags,
                const char *name, void *device);
void free_irq(unsigned int irq, void *device);
void external_side_effect(void);
int read_flag(void);

static spinlock_t exclusive_a, exclusive_b, opposite_a, opposite_b;
static spinlock_t compare_a, compare_b, mutate_a, mutate_b;
static spinlock_t nested_a, nested_b;
static spinlock_t return_a, return_b, loop_a, loop_b;
static spinlock_t summary_a, summary_b, irq_a, irq_b;
static int device_token;

void mutually_exclusive_dependency(int choose) {
    if (choose)
        spin_lock(&exclusive_a);
    if (!choose)
        spin_lock(&exclusive_b);
    spin_unlock(&exclusive_b);
    spin_unlock(&exclusive_a);
}

void reverse_exclusive_order(void) {
    spin_lock(&exclusive_b);
    spin_lock(&exclusive_a);
    spin_unlock(&exclusive_a);
    spin_unlock(&exclusive_b);
}

void complementary_comparison(int choice) {
    if (choice == 3)
        spin_lock(&compare_a);
    if (choice != 3)
        spin_lock(&compare_b);
    spin_unlock(&compare_b);
    spin_unlock(&compare_a);
}

void nested_condition_path(int outer, int inner) {
    if (outer) {
        if (inner) {
            spin_lock(&nested_a);
            spin_lock(&nested_b);
            spin_unlock(&nested_b);
            spin_unlock(&nested_a);
        }
    }
}

void reassigned_condition_is_unknown(int choice) {
    if (choice)
        spin_lock(&mutate_a);
    choice = 0;
    if (!choice)
        spin_lock(&mutate_b);
    spin_unlock(&mutate_b);
    spin_unlock(&mutate_a);
}

void opposite_orders_can_run_in_separate_calls(int choose) {
    if (choose) {
        spin_lock(&opposite_a);
        spin_lock(&opposite_b);
        spin_unlock(&opposite_b);
        spin_unlock(&opposite_a);
    } else {
        spin_lock(&opposite_b);
        spin_lock(&opposite_a);
        spin_unlock(&opposite_a);
        spin_unlock(&opposite_b);
    }
}

void early_return_order(int ready) {
    if (!ready)
        return;
    spin_lock(&return_a);
    spin_lock(&return_b);
    spin_unlock(&return_b);
    spin_unlock(&return_a);
}

void unsupported_condition_order(void) {
    if (read_flag())
        spin_lock(&summary_a);
    if (!read_flag())
        spin_lock(&summary_b);
    spin_unlock(&summary_b);
    spin_unlock(&summary_a);
}

void supported_loop_order(void) {
    const int once = 1;
    while (once) {
        spin_lock(&loop_a);
        spin_lock(&loop_b);
        spin_unlock(&loop_b);
        spin_unlock(&loop_a);
        break;
    }
}

static void take_summary_b(spinlock_t *lock) {
    spin_lock(lock);
    spin_unlock(lock);
}

void incomplete_summary_order(void) {
    spin_lock(&summary_a);
    external_side_effect();
    take_summary_b(&summary_b);
    spin_unlock(&summary_a);
}

static void registered_handler(int irq, void *device) {
    (void)irq;
    (void)device;
    spin_lock(&irq_b);
    spin_lock(&irq_a);
    spin_unlock(&irq_a);
    spin_unlock(&irq_b);
}

void register_handler(void) {
    request_irq(7, registered_handler, 0, "phase16", &device_token);
}

void unregister_handler(void) {
    free_irq(7, &device_token);
}

void process_with_registered_handler(void) {
    spin_lock(&irq_a);
    spin_unlock(&irq_a);
}

void irqsave_protects_handler_path(void) {
    unsigned long flags = 0;
    spin_lock_irqsave(&irq_a, &flags);
    spin_unlock_irqrestore(&irq_a, &flags);
}

void register_unresolved_handler(irq_handler_t handler) {
    request_irq(8, handler, 0, "unresolved", &device_token);
}
