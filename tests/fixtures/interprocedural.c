typedef struct { int state; } mutex_t;
void mutex_lock(mutex_t *lock);
void mutex_unlock(mutex_t *lock);
void opaque_external(mutex_t *lock);

static void leaf(mutex_t *lock) {
    mutex_lock(lock);
}

static void bridge(mutex_t *lock) {
    leaf(lock);
}

static void release_one(mutex_t *lock) {
    mutex_unlock(lock);
}

void same_function(mutex_t *first, mutex_t *second) {
    mutex_lock(first);
    mutex_lock(second);
    mutex_unlock(second);
    mutex_unlock(first);
}

void cross_function(mutex_t *outer, mutex_t *inner) {
    mutex_lock(outer);
    bridge(inner);
    mutex_unlock(inner);
    mutex_unlock(outer);
}

void release_through_helper(mutex_t *first, mutex_t *second, mutex_t *third) {
    mutex_lock(first);
    mutex_lock(second);
    release_one(second);
    mutex_lock(third);
    mutex_unlock(third);
    mutex_unlock(first);
}

void multiple_sites(mutex_t *outer, mutex_t *inner, int choose) {
    mutex_lock(outer);
    if (choose)
        bridge(inner);
    else
        bridge(inner);
    mutex_unlock(outer);
}

void opposite_orders(mutex_t *left, mutex_t *right, int choose) {
    if (choose) {
        mutex_lock(left);
        mutex_lock(right);
        mutex_unlock(right);
        mutex_unlock(left);
    } else {
        mutex_lock(right);
        mutex_lock(left);
        mutex_unlock(left);
        mutex_unlock(right);
    }
}

void similar_names(void) {
    mutex_t device_lock;
    mutex_t device_lock2;
    mutex_lock(&device_lock);
    mutex_lock(&device_lock2);
    mutex_unlock(&device_lock2);
    mutex_unlock(&device_lock);
}

static void lock_local_once(void) {
    mutex_t local_lock;
    mutex_lock(&local_lock);
}

void local_calls_twice(void) {
    lock_local_once();
    lock_local_once();
}

void external_call_while_locked(mutex_t *lock) {
    mutex_lock(lock);
    opaque_external(lock);
    mutex_unlock(lock);
}

typedef void (*callback_t)(mutex_t *);
static void callback_target(mutex_t *lock) {
    mutex_lock(lock);
}

void resolved_indirect(mutex_t *outer, mutex_t *inner) {
    callback_t callback = callback_target;
    mutex_lock(outer);
    callback(inner);
    mutex_unlock(outer);
}

void unresolved_indirect(callback_t callback, mutex_t *lock) {
    mutex_lock(lock);
    callback(lock);
    mutex_unlock(lock);
}

static void recursive_swap(mutex_t *left, mutex_t *right, int descend) {
    if (descend) {
        mutex_lock(left);
        recursive_swap(right, left, 0);
        mutex_unlock(left);
    } else {
        mutex_lock(right);
    }
}

static void mutual_b(mutex_t *lock, int descend);
static void mutual_a(mutex_t *lock, int descend) {
    if (descend)
        mutual_b(lock, 0);
    else
        mutex_lock(lock);
}
static void mutual_b(mutex_t *lock, int descend) {
    if (descend)
        mutual_a(lock, 0);
    else
        mutex_lock(lock);
}

void start_mutual(mutex_t *lock) {
    mutual_a(lock, 1);
}
