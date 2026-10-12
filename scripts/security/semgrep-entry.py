#!/usr/bin/env python3
"""Trusted offline Semgrep entrypoint. Runs only inside the pinned container.

Runtime assumptions (unverified here): CPython 3.12 on the pinned manylinux image,
/control mounted read-only with rules.yml, requirements.lock and targets.json,
/wheels read-only holding exactly the locked wheels, /tmp tmpfs writable.

The scan JSON is the only bytes written to stdout. Setup output is captured and
discarded so pip or scanner logs cannot leak into host output or error messages,
and failures surface only as a generic non-zero exit label.
"""
import json
import pathlib
import subprocess
import sys
from typing import NoReturn

# Copied beside this trusted entrypoint in /control; never imported from /inputs.
from parse_gate import check_parse, verify_snapshot

CONTROL = pathlib.Path("/control")
VENV = pathlib.Path("/tmp/venv")
SELECTED_VERSION = b"1.180.0"


def fail() -> NoReturn:
    raise SystemExit("semgrep-runner-failed")


def run(args: list[str]) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(args, capture_output=True, check=True)
    except Exception:
        fail()


def targets() -> list[dict]:
    try:
        document = json.loads((CONTROL / "targets.json").read_text(encoding="utf-8"))
        return document["targets"]
    except SystemExit:
        raise
    except Exception:
        fail()


def main():
    if sys.version_info[:2] != (3, 12):
        fail()
    run([sys.executable, "-m", "venv", str(VENV)])
    python = str(VENV / "bin" / "python")
    run([python, "-m", "pip", "--isolated", "install", "--no-index", "--find-links=/wheels",
         "--only-binary=:all:", "--require-hashes", "--no-deps", "-r", "/control/requirements.lock"])
    run([python, "-m", "pip", "check"])
    semgrep = str(VENV / "bin" / "semgrep")
    version = run([semgrep, "--version"])
    if version.stdout.strip() != SELECTED_VERSION:
        fail()
    entries = targets()
    paths = check_parse(semgrep, entries)
    scan = run([semgrep, "scan", "--oss-only", "--metrics", "off", "--disable-version-check",
                "--disable-nosem", "--strict", "--no-git-ignore",
                "--json", "--config", "/control/rules.yml", *paths])
    verify_snapshot(entries)
    sys.stdout.buffer.write(scan.stdout)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        fail()
