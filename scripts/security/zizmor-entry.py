#!/usr/bin/env python3
"""Trusted offline zizmor entrypoint. Runs only inside the pinned container.

Runtime assumptions (unverified here): CPython 3.12 on the pinned manylinux image,
/control mounted read-only with requirements.lock and targets.json, /wheels
read-only holding exactly the locked wheel, /tmp tmpfs writable.

zizmor runs once per exported workflow with an explicitly sanitized environment,
so no inherited host token reaches the scanner. The JSON envelope is the only
bytes written to stdout; every subprocess stream is captured and discarded and
failures surface only as the generic non-zero label, never as scanner text.
"""
import json
import math
import os
import pathlib
import subprocess
import sys
import time
from typing import NoReturn

# Copied beside this trusted entrypoint in /control; never imported from /inputs.
from parse_gate import verify_snapshot  # type: ignore[import-not-found]

CONTROL = pathlib.Path("/control")
VENV = pathlib.Path("/tmp/venv")
VERSION = "1.30.1"
SELECTED_VERSION = b"zizmor 1.30.1"
FAILED = "zizmor-runner-failed"
SCAN_FLAGS = ("--offline", "--no-config", "--strict-collection", "--no-ignores",
              "--no-exit-codes", "--format=json-v1", "--no-progress")
CHILD_ENV_KEYS = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR")
PER_CALL_TIMEOUT = 30.0
GLOBAL_BUDGET = 120.0
MAX_REPORT_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024


def fail() -> NoReturn:
    # `from None` suppresses exception chaining so no original message can leak.
    raise SystemExit(FAILED) from None


def check_interpreter(version_info):
    if tuple(version_info[:2]) != (3, 12):
        fail()


def child_environment(source=None):
    """Return only non-secret container variables; drop inherited host tokens."""
    base = os.environ if source is None else source
    try:
        return {key: base[key] for key in CHILD_ENV_KEYS if key in base}
    except Exception:
        fail()


def invoke(args, *, runner, timeout=None, env=None):
    """Run one trusted subprocess, discarding all of its output and text."""
    try:
        result = runner(args, shell=False, check=False, capture_output=True,
                        timeout=timeout, env=env)
    except Exception:
        fail()
    if getattr(result, "returncode", None) != 0:
        fail()
    return result


def do_setup(*, runner=subprocess.run):
    """Create the pinned venv, install the locked wheel offline and check it."""
    python = str(VENV / "bin" / "python")
    invoke([sys.executable, "-m", "venv", str(VENV)], runner=runner)
    invoke([python, "-m", "pip", "--isolated", "install", "--no-index",
            "--find-links=/wheels", "--only-binary=:all:", "--require-hashes",
            "--no-deps", "-r", str(CONTROL / "requirements.lock")], runner=runner)
    invoke([python, "-m", "pip", "check"], runner=runner)
    version = invoke([str(VENV / "bin" / "zizmor"), "--version"], runner=runner)
    data = getattr(version, "stdout", None)
    if not isinstance(data, (bytes, bytearray)) or data.strip() != SELECTED_VERSION:
        fail()


def read_targets(path=None):
    """Read the trusted exporter inventory; never derived from scanner output."""
    target = CONTROL / "targets.json" if path is None else path
    try:
        document = json.loads(pathlib.Path(target).read_text(encoding="utf-8"))
        entries = document["targets"]
        if not isinstance(entries, list) or not entries:
            fail()
        return entries
    except Exception:
        fail()
