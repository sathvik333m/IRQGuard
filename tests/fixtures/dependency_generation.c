typedef struct { int state; } mutex_t;
void mutex_lock(mutex_t *lock);
void mutex_unlock(mutex_t *lock);
mutex_t *unknown_lock(void);
void external_helper(void);

void nested_ab(mutex_t *a, mutex_t *b) {
    mutex_lock(a);
    mutex_lock(b);
    mutex_unlock(b);
    mutex_unlock(a);
}

void nested_ba(mutex_t *a, mutex_t *b) {
    mutex_lock(b);
    mutex_lock(a);
    mutex_unlock(a);
    mutex_unlock(b);
}

void independent_locks(mutex_t *a, mutex_t *b) {
    mutex_lock(a);
    mutex_unlock(a);
    mutex_lock(b);
    mutex_unlock(b);
}

void lock_pairs_without_nesting(mutex_t *a, mutex_t *b) {
    mutex_lock(a);
    mutex_unlock(a);
    mutex_lock(b);
    mutex_unlock(b);
}

static void acquire_b(mutex_t *b) {
    mutex_lock(b);
    mutex_unlock(b);
}

void dependency_through_summary(mutex_t *a, mutex_t *b) {
    mutex_lock(a);
    acquire_b(b);
    mutex_unlock(a);
}

void mutually_exclusive_locks(mutex_t *a, mutex_t *b, int choose) {
    if (choose) {
        mutex_lock(a);
        mutex_unlock(a);
    } else {
        mutex_lock(b);
        mutex_unlock(b);
    }
}

void unresolved_nested_expression(mutex_t *a) {
    mutex_lock(a);
    mutex_lock(unknown_lock());
    mutex_unlock(unknown_lock());
    mutex_unlock(a);
}

void unavailable_summary_does_not_invent_order(mutex_t *a) {
    mutex_lock(a);
    external_helper();
    mutex_unlock(a);
}
