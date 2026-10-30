#!/usr/bin/env python3
"""Check safe aliases, wrapper identity, call-site substitution and uncertainty."""

import json
import subprocess
import sys


binary, fixture = sys.argv[1:]
run = subprocess.run([binary, "analyze", "--source", fixture, "--format", "json"],
                     text=True, capture_output=True)
assert run.returncode == 0, run.stderr
report = json.loads(run.stdout)


def operations(function):
    return [item for item in report["api_operations"] if item["caller"] == function]


def summary(function):
    return next(item for item in report["function_summaries"]
                if item["function"] == function)


def edges(function):
    return [item for item in report["lock_dependencies"]
            if item["reporting_function"] == function]


# Unmodified local pointer aliases preserve the identity of their initializer,
# including formals, globals, and structure members.
for name in ("alias_parameter_matches_original", "alias_global_matches_address",
             "alias_member_matches_address"):
    acquire = next(item for item in operations(name) if item["kind"] == "lock_acquire")
    release = next(item for item in operations(name) if item["kind"] == "lock_release")
    assert acquire["lock"]["identity_status"] == "symbolic"
    assert acquire["lock"]["identity_template"] == release["lock"]["identity_template"]
    assert summary(name)["held_on_return"] == [], (name, summary(name)["held_on_return"])

normalized = operations("normalized_pointer_forms")
for acquire, release in ((normalized[0], normalized[1]),
                         (normalized[2], normalized[3])):
    assert acquire["lock"]["identity_status"] == "symbolic"
    assert acquire["lock"]["identity_template"] == release["lock"]["identity_template"]
assert summary("normalized_pointer_forms")["held_on_return"] == []

# Summary instantiation keeps two instances of one struct type distinct across
# two call sites; the same caller-owned instance stays stable across call sites.
sites = edges("distinct_instances_at_call_sites")
targets = {item["to_lock"] for item in sites if item["from_lock"] == "@param[2]"}
assert len(targets) == 2, sites
assert any("@param[0]" in target for target in targets)
assert any("@param[1]" in target for target in targets)
same_summary = summary("same_instance_at_multiple_call_sites")
same_lock_ids = {item["lock_identity"] for item in same_summary["acquisitions"]}
assert len(same_lock_ids) == 1, same_lock_ids

# If a helper reacquires a caller-held instance, both sides of the dependency
# must use one lock identity. This is a real self-order candidate, not two
# artificial call-activation identities.
reacquire = edges("wrapper_reacquires_caller_held_lock")
assert any(item["from_lock"] == item["to_lock"] for item in reacquire), reacquire

# Direct globals/statics remain declaration-based; same-typed instances do not
# merge. The mutably reassigned pointer cannot receive a guessed identity.
static = edges("distinct_static_members")
assert len(static) == 1 and static[0]["from_lock"] != static[0]["to_lock"]
mutated = next(item for item in operations("mutable_alias_is_unresolved")
               if item["kind"] == "lock_acquire")
assert mutated["lock"]["identity_status"] == "unresolved"
assert any(item["category"] == "lock_identity" and
           item["enclosing_function"] == "mutable_alias_is_unresolved"
           for item in report["uncertainty_records"])
through_unknown = summary("unresolved_alias_through_summary")
assert any(item["identity_status"] == "unresolved"
           for item in through_unknown["acquisitions"])
assert any(item["category"] == "lock_identity" and
           item["enclosing_function"] == "unresolved_alias_through_summary"
           for item in report["uncertainty_records"])

print("safe aliases, wrapper identities, call-site substitution and uncertainty passed")
