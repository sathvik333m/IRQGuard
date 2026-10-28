extern void external_action(void);

static void uncertain_helper(void) {
    external_action();
}

void caller_one(void) {
    uncertain_helper();
}

void caller_two(void) {
    uncertain_helper();
}
