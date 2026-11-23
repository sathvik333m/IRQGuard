typedef struct { int value; } spinlock_t;
typedef struct { spinlock_t p_work_lock; } qedi_percpu_s;

void spin_lock(spinlock_t *lock);
void spin_unlock(spinlock_t *lock);
void spin_lock_bh(spinlock_t *lock);

static qedi_percpu_s qedi_percpu[8];

static unsigned int computed_cpu_index(unsigned int argument) { return argument; }
unsigned int raw_smp_processor_id(void);
#define smp_processor_id() raw_smp_processor_id()
#define per_cpu(variable, cpu) ((variable)[cpu])
#define this_cpu_ptr(pointer) (&(*(pointer))[smp_processor_id()])

void this_cpu_ptr_current_cpu_alias(void) {
    qedi_percpu_s *p = this_cpu_ptr(&qedi_percpu);
    spin_lock_bh(&p->p_work_lock);
    spin_unlock(&p->p_work_lock);
}

void explicit_current_cpu_instance(void) {
    spin_lock(&per_cpu(qedi_percpu, smp_processor_id()).p_work_lock);
    spin_unlock(&per_cpu(qedi_percpu, smp_processor_id()).p_work_lock);
}

void fixed_per_cpu_instance(void) {
    spin_lock(&per_cpu(qedi_percpu, 3).p_work_lock);
    spin_unlock(&per_cpu(qedi_percpu, 3).p_work_lock);
}

void different_fixed_per_cpu_instance(void) {
    spin_lock(&per_cpu(qedi_percpu, 4).p_work_lock);
    spin_unlock(&per_cpu(qedi_percpu, 4).p_work_lock);
}

void unresolved_per_cpu_index(unsigned int cpu) {
    spin_lock(&per_cpu(qedi_percpu, cpu).p_work_lock);
}

void computed_per_cpu_index(unsigned int cpu) {
    spin_lock(&per_cpu(qedi_percpu, cpu + 3).p_work_lock);
}

void call_computed_per_cpu_index(void) {
    spin_lock(&per_cpu(qedi_percpu, computed_cpu_index(3)).p_work_lock);
}
