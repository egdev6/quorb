#!/usr/bin/env python3
"""Trusted parse gate for the offline Semgrep runner.

`check_parse` runs `semgrep show dump-ast <language> <path>` per exported target,
with stdout/stderr discarded. The language map matches pinned scan targeting
WITHOUT its language-detection bypass; the filename selects the TSX dialect. Export maps .mts/.cts
to .ts without changing bytes; JSX/TSX suffixes remain distinct.
Exits are a fail-closed candidate
signal, not a syntax or malware certificate. No version, network, setup or retry
logic lives here; the caller owns the Semgrep path and pinned runtime.
"""
import hashlib
import math
import os
import re
import stat
import subprocess
import time
import unicodedata
from pathlib import Path

MAX_SOURCE = 1024 * 1024
MAX_ENTRIES = 10000
PER_CALL_TIMEOUT = 10.0
NAME_RE = re.compile(r"^[0-9]{6}\.(?:js|jsx|mjs|cjs|ts|tsx)$")
HASH_RE = re.compile(r"^[0-9a-f]{64}$")


class ParseGateError(Exception):
    """Generic gate failure; never carries paths, source bytes or scanner text."""

    def __init__(self):
        super().__init__("parse-gate-failed")


def _fail():
    # `from None` suppresses exception chaining so no original message can leak.
    raise ParseGateError() from None


def _is_plain(value):
    return all(unicodedata.category(char) not in ("Cc", "Cf") for char in value)


def _root_path(root):
    root_text = os.fspath(root)
    if not isinstance(root_text, str) or not os.path.isabs(root_text):
        _fail()
    return os.path.realpath(root_text)


def verify_snapshot(entries, root=Path("/inputs"), *, workflow=False):
    """Return validated absolute paths for trusted exporter entries.

    Paths must be canonical flat six-digit names inside `root`, regular
    non-symlink files, with a valid SHA-256 matching the exporter's claim.
    """
    try:
        root_path = _root_path(root)
        items = list(entries)
        if not items or len(items) > MAX_ENTRIES:
            _fail()
        name_re = re.compile(r"^[0-9]{6}\.(?:yml|yaml)$") if workflow else NAME_RE
        seen = set()
        validated = []
        for entry in items:
            if not isinstance(entry, dict):
                _fail()
            path = entry["path"]
            digest = entry["sha256"]
            if not isinstance(path, str) or not isinstance(digest, str):
                _fail()
            if not _is_plain(path) or os.path.dirname(path) != root_path:
                _fail()
            if not name_re.fullmatch(os.path.basename(path)) or path in seen:
                _fail()
            seen.add(path)
            info = os.lstat(path)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                _fail()
            if info.st_size > MAX_SOURCE or not HASH_RE.match(digest):
                _fail()
            with open(path, "rb") as handle:
                data = handle.read(MAX_SOURCE + 1)
            if len(data) != info.st_size or len(data) > MAX_SOURCE:
                _fail()
            if hashlib.sha256(data).hexdigest() != digest:
                _fail()
            validated.append(path)
        return validated
    except ParseGateError:
        raise
    except Exception:
        _fail()


def check_parse(semgrep, entries, root=Path("/inputs"), *, runner=subprocess.run,
                clock=time.monotonic, budget_seconds=120.0):
    """Return validated paths once the matching analyzer parses every target.

    `verify_snapshot` runs before and after the calls, so bytes mutated during a
    call are detected. Remaining budget is recomputed per call from the monotonic
    start; any failure or budget exhaustion (including after the final call)
    fails closed.
    """
    try:
        if not isinstance(semgrep, str) or not semgrep:
            _fail()
        if isinstance(budget_seconds, bool) or not isinstance(budget_seconds, (int, float)):
            _fail()
        budget = float(budget_seconds)
        if not math.isfinite(budget) or budget <= 0:
            _fail()
        start = clock()
        validated = verify_snapshot(entries, root)
        for path in validated:
            remaining = budget - (clock() - start)
            if remaining <= 0:
                _fail()
            language = "typescript" if Path(path).suffix in (".ts", ".tsx") else "javascript"
            command = [semgrep, "show", "dump-ast", language, path]
            result = runner(command, shell=False, check=False,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            timeout=min(PER_CALL_TIMEOUT, remaining))
            if getattr(result, "returncode", None) != 0:
                _fail()
        if budget - (clock() - start) <= 0:
            _fail()
        verify_snapshot(entries, root)
        if budget - (clock() - start) <= 0:
            _fail()
        return validated
    except ParseGateError:
        raise
    except Exception:
        _fail()
