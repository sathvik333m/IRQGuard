typedef struct spinlock { int value; } spinlock_t;
extern void spin_lock(spinlock_t *lock);
extern void spin_unlock(spinlock_t *lock);
extern void opaque_external(void);
extern long long ktime_to_ns(long long value);
extern unsigned long long timecounter_cyc2time(void *counter, unsigned long long cycles);

static spinlock_t guarded;

void exact_pure_builtins(long long value) {
    (void)__builtin_constant_p(value);
    (void)__builtin_ffsll(value);
    (void)__builtin_bswap16((unsigned short)value);
    (void)__builtin_expect((long)value, 0);
    __builtin_prefetch(&value, 0, 3);
    (void)ktime_to_ns(value);
    (void)timecounter_cyc2time((void *)0, (unsigned long long)value);
    spin_lock(&guarded);
    spin_unlock(&guarded);
}

void unsupported_builtin_control_flow(void) {
    __builtin_unreachable();
}

void unrelated_unknown_call(void) {
    opaque_external();
}
