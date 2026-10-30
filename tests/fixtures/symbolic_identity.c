typedef struct { int value; } mutex_t;
typedef struct { mutex_t member; } device_t;

void mutex_lock(mutex_t *lock);
void mutex_unlock(mutex_t *lock);

static mutex_t global_lock;
static device_t static_device_a;
static device_t static_device_b;

void alias_parameter_matches_original(mutex_t *lock) {
    mutex_t *alias = lock;
    mutex_lock(alias);
    mutex_unlock(lock);
}

void alias_global_matches_address(void) {
    mutex_t *alias = &global_lock;
    mutex_lock(alias);
    mutex_unlock(&global_lock);
}

void alias_member_matches_address(device_t *device) {
    mutex_t *alias = &device->member;
    mutex_lock(alias);
    mutex_unlock(&device->member);
}

void normalized_pointer_forms(mutex_t *lock, device_t *device) {
    mutex_lock(&*lock);
    mutex_unlock(lock);
    mutex_lock(&(*device).member);
    mutex_unlock(&device->member);
}

static void lock_wrapper(mutex_t *lock) {
    mutex_lock(lock);
    mutex_unlock(lock);
}

void distinct_instances_at_call_sites(device_t *left, device_t *right,
                                      mutex_t *outer) {
    mutex_lock(outer);
    lock_wrapper(&left->member);
    lock_wrapper(&right->member);
    mutex_unlock(outer);
}

void same_instance_at_multiple_call_sites(device_t *device) {
    lock_wrapper(&device->member);
    lock_wrapper(&device->member);
}

void wrapper_reacquires_caller_held_lock(device_t *device) {
    mutex_lock(&device->member);
    lock_wrapper(&device->member);
    mutex_unlock(&device->member);
}

void distinct_static_members(void) {
    mutex_lock(&static_device_a.member);
    mutex_lock(&static_device_b.member);
    mutex_unlock(&static_device_b.member);
    mutex_unlock(&static_device_a.member);
}

void mutable_alias_is_unresolved(mutex_t *first, mutex_t *second, int choose) {
    mutex_t *alias = first;
    if (choose)
        alias = second;
    mutex_lock(alias);
}

static void helper_lock(mutex_t *lock) {
    mutex_lock(lock);
    mutex_unlock(lock);
}

void unresolved_alias_through_summary(mutex_t *first, mutex_t *second, int choose) {
    mutex_t *alias = first;
    if (choose)
        alias = second;
    helper_lock(alias);
}
