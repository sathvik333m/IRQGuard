#!/usr/bin/env python3
"""Check that the preserved Phase 12 evidence does not overstate validation."""
import hashlib
import json
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "evaluation/results/linux-v6.6.87/phase12"
full = json.loads((EVIDENCE / "full-validation-measurements.json").read_text())
source_only = json.loads((EVIDENCE / "source-only-measurements.json").read_text())
post_install = json.loads((EVIDENCE / "post-libelf-full-validation-measurements.json").read_text())
full_log = (EVIDENCE / "full-validation-build.log").read_text(errors="replace")
source_log = (EVIDENCE / "source-only-build.log").read_text(errors="replace")

assert full["status"] == "kernel_build_failed"
assert full["validation"]["objtool_build"] == "failed"
assert full["validation"]["kernel_object_compilation"] == "not_run"
assert full["validation"]["source_analysis"] == "not_started"
assert full["validation"]["unwinder_orc_configured"] is True
assert full["validation"]["stack_validation_configured"] is False
assert "fatal error: 'libelf.h' file not found" in full_log
assert "fatal error: 'gelf.h' file not found" in full_log

assert source_only["status"] == "completed_with_validation_skips"
assert source_only["validation"]["kernel_object_compilation"] == "succeeded"
assert source_only["validation"]["source_analysis"] == "completed"
assert source_only["validation"]["objtool_object_checks"] == "skipped_by_request"
assert source_only["validation"]["stack_validation"] == "not_configured_by_defconfig"
assert source_only["validation"]["skip_stack_validation_variable_supported_by_kernel"] is False
assert source_only["aggregate"]["files_analyzed"] == 5
assert source_only["aggregate"]["counts_sum_across_translation_units"]["interrupt_cycles"] == 0
assert post_install["status"] == "completed"
assert post_install["validation"]["objtool_build"] == "succeeded"
assert post_install["validation"]["objtool_object_checks"] == "succeeded"
assert post_install["validation"]["objtool_deferred_to_composite"] is True
assert post_install["validation"]["objtool_invocations"] == 1
assert {"--orc", "--ibt", "--module", "--link"} <= set(post_install["validation"]["objtool_options"])
assert post_install["validation"]["orc_sections_present"] is True
assert post_install["validation"]["kernel_module_link"] == "not_attempted; composite object target only"
for source in ("netdev.c", "ethtool.c", "ich8lan.c", "phy.c", "nvm.c"):
    assert f"CC [M]  drivers/net/ethernet/intel/e1000e/{source[:-2]}.o" in source_log
assert "--orc" not in source_log
assert "SKIP_STACK_VALIDATION=1" not in source_log

with tarfile.open(EVIDENCE / "source-only-reports-and-build-inputs.tar.gz", "r:gz") as archive:
    members = set(archive.getnames())
    assert "kbuild/.config" in members
    assert "kbuild/compile_commands.json" in members
    assert {f"reports/{name}.json" for name in ("netdev", "ethtool", "ich8lan", "phy", "nvm")} <= members

for line in (EVIDENCE / "SHA256SUMS").read_text().splitlines():
    digest, filename = line.split("  ", 1)
    assert hashlib.sha256((EVIDENCE / filename).read_bytes()).hexdigest() == digest, filename
print("Phase 12 evidence checks passed: full and source-only validation are distinguished")
