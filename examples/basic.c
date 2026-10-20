typedef struct {
    int state;
} mutex_t;

void mutex_lock(mutex_t *lock);
void mutex_unlock(mutex_t *lock);

static void update_state(mutex_t *lock) {
    mutex_lock(lock);
    mutex_unlock(lock);
}

void worker(mutex_t *outer, mutex_t *inner, int ready) {
    if (ready) {
        mutex_lock(outer);
        update_state(inner);
        mutex_unlock(outer);
    }
}
