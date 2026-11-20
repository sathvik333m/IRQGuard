#!/usr/bin/env python3
"""Fetch or validate immutable upstream worktrees for the historical case."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASE_ROOT = ROOT / "historical-case"
REPOSITORY = CASE_ROOT / "linux-git"
UPSTREAM = "https://git.kernel.org/pub/scm/linux/kernel/git/tip/tip.git"
PINS = {
    "affected": "03c4d26933d54556a89379db5923ae9e474569e8",
    "fixed": "1bae25dcc6beb8b874f23601d2efa142ac4f9f36",
    "introduced-322a906": "322a9063876890895cb8308cc6f59de312e8aad5",
    "serial8250/affected": "547bbf7d214fff2d29bc885ea7efea0fbc127791",
    "serial8250/fixed": "730037c3ee57f892e6df019bc88d417a5944737c",
}


def run(command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=ROOT, text=True, check=check)


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run(["git", "-C", str(REPOSITORY), *args], check=check)


def verify_worktree(name: str, commit: str) -> None:
    path = CASE_ROOT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if not (path / ".git").exists():
            raise RuntimeError(f"refusing to replace non-worktree path: {path}")
        head = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
        if head != commit:
            raise RuntimeError(f"{path} is at {head}; expected {commit}; source left untouched")
        print(f"validated {name}: {head}")
        return
    run(["git", "-C", str(REPOSITORY), "worktree", "add", "--detach", str(path), commit])
    print(f"created {name}: {commit}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--include-introducing-revision", action="store_true",
                        help="also create a worktree at the bug-introducing commit for provenance")
    args = parser.parse_args()
    CASE_ROOT.mkdir(parents=True, exist_ok=True)
    if not REPOSITORY.exists():
        run(["git", "clone", "--no-checkout", "--single-branch", "--branch", "irq/drivers",
             UPSTREAM, str(REPOSITORY)])
    if not (REPOSITORY / ".git").exists():
        parser.error(f"not a Git checkout: {REPOSITORY}")

    for name, commit in PINS.items():
        if name == "introduced-322a906" and not args.include_introducing_revision:
            continue
        exists = git("cat-file", "-e", f"{commit}^{{commit}}", check=False).returncode == 0
        if not exists:
            raise RuntimeError(f"pinned commit {commit} is missing; fetch the documented upstream history")
        verify_worktree(name, commit)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, subprocess.CalledProcessError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
