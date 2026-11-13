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
import signal
import stat
import subprocess
import threading
import time
import unicodedata
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path

MAX_SOURCE = 1024 * 1024
MAX_ENTRIES = 10000
PER_CALL_TIMEOUT = 10.0
TERMINATE_GRACE = 0.1
CLEANUP_TIMEOUT = 0.75
PARSE_WORKERS = 2
BASE_BUDGET = 120.0
PER_FILE_BUDGET = 0.25
MAX_BUDGET = 300.0
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


def _can_peek_unreaped():
    return os.name == "posix" and all(hasattr(os, name) for name in
                                      ("waitid", "P_PID", "WEXITED", "WNOHANG", "WNOWAIT", "CLD_EXITED"))


def _peek_parser(process):
    if _can_peek_unreaped():
        status = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        if status is None:
            return None
        return 0 if status.si_code == os.CLD_EXITED and status.si_status == 0 else 1
    return process.poll()


def _wait_parser(process, timeout, deadline, stopped):
    # Where waitid supports WNOWAIT, keep leaders unreaped until group cleanup
    # so a reused PID cannot identify an unrelated group. Polling also lets a
    # cancelled worker exit without an unbounded wait on non-POSIX platforms.
    while not stopped.is_set():
        status = _peek_parser(process)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired(process.args, timeout)
        if status is not None:
            return status
        stopped.wait(min(0.01, remaining))
    _fail()


def _signal_parser(process, *, terminate):
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM if terminate else signal.SIGKILL)
        elif terminate:
            process.terminate()
        else:
            process.kill()
    except ProcessLookupError:
        pass
    except OSError:
        # If signalling the group fails, still attempt to stop its direct child.
        try:
            process.terminate() if terminate else process.kill()
        except OSError:
            pass


def _stop_parsers(processes, *, graceful=True, deadline=None):
    """Stop groups and reap children within one shared deadline; report completeness."""
    if not processes:
        return True
    if deadline is None:
        deadline = time.monotonic() + CLEANUP_TIMEOUT
    if graceful:
        for process in processes:
            _signal_parser(process, terminate=True)
        delay = min(TERMINATE_GRACE, max(0.0, deadline - time.monotonic()))
        if delay:
            time.sleep(delay)
    # Signal every group even if the deadline has elapsed or its leader exited.
    for process in processes:
        _signal_parser(process, terminate=False)
    for process in processes:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        try:
            process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            return False
    if os.name == "posix":
        # Reap adopted children without blocking, but never wait indefinitely
        # for a zombie owned by another reaper or a process stuck in the kernel.
        groups = {process.pid for process in processes}
        while groups and time.monotonic() < deadline:
            for group in list(groups):
                try:
                    while time.monotonic() < deadline and os.waitpid(-group, os.WNOHANG)[0]:
                        pass
                except ChildProcessError:
                    pass
                try:
                    os.killpg(group, 0)
                except ProcessLookupError:
                    groups.remove(group)
            if groups:
                delay = min(0.005, max(0.0, deadline - time.monotonic()))
                if delay:
                    time.sleep(delay)
        return not groups
    return True


def check_parse(semgrep, entries, root=Path("/inputs"), *, runner=None,
                clock=time.monotonic, budget_seconds=None):
    """Return validated paths in inventory order once every analyzer succeeds.

    Both snapshot checks count against the scaled, capped monotonic budget. The
    injected runner is for tests; production tracks a separate process group per
    call. A failure stops dispatch and terminates and joins in-flight parsers.
    """
    try:
        if not isinstance(semgrep, str) or not semgrep:
            _fail()
        if budget_seconds is not None:
            if isinstance(budget_seconds, bool) or not isinstance(budget_seconds, (int, float)):
                _fail()
            budget_seconds = float(budget_seconds)
            if not math.isfinite(budget_seconds) or budget_seconds <= 0:
                _fail()
        start = clock()
        validated = verify_snapshot(entries, root)
        budget = min(MAX_BUDGET, BASE_BUDGET + PER_FILE_BUDGET * len(validated))
        if budget_seconds is not None:
            budget = min(budget, budget_seconds)
        lock = threading.Lock()
        stopped = threading.Event()
        active = {}
        cleanup_deadline = None

        def check_peers():
            # A worker may not yet have observed an exited or timed-out peer.
            # Check both before dispatching or starting another parser.
            if runner is None and any(time.monotonic() >= deadline or
                                      _peek_parser(process) not in (None, 0)
                                      for process, deadline in active.items()):
                _fail()

        def parse(path):
            nonlocal cleanup_deadline
            try:
                language = "typescript" if Path(path).suffix in (".ts", ".tsx") else "javascript"
                command = [semgrep, "show", "dump-ast", language, path]
                with lock:
                    if stopped.is_set():
                        _fail()
                    check_peers()
                    remaining = budget - (clock() - start)
                    if remaining <= 0:
                        _fail()
                    timeout = min(PER_CALL_TIMEOUT, remaining)
                    process = None
                    if runner is None:
                        process = subprocess.Popen(command, shell=False,
                                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                                   start_new_session=(os.name == "posix"))
                        deadline = time.monotonic() + timeout
                        active[process] = deadline
                if process is None:
                    result = runner(command, shell=False, check=False,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    timeout=timeout)
                    code = getattr(result, "returncode", None)
                else:
                    code = _wait_parser(process, timeout, deadline, stopped)
                if code != 0:
                    _fail()
                with lock:
                    if stopped.is_set():
                        _fail()
                    if process is not None:
                        # Keep the leader unreaped until its entire group has
                        # been signalled, including after a successful parse.
                        cleanup_deadline = time.monotonic() + CLEANUP_TIMEOUT
                        if not _stop_parsers([process], graceful=False, deadline=cleanup_deadline):
                            _fail()
                        del active[process]
                        cleanup_deadline = None
            except Exception:
                with lock:
                    stopped.set()
                raise

        with ThreadPoolExecutor(max_workers=PARSE_WORKERS) as pool:
            paths = iter(validated)
            pending = set()

            def fill():
                while len(pending) < PARSE_WORKERS:
                    with lock:
                        if stopped.is_set():
                            _fail()
                        check_peers()
                        path = next(paths, None)
                        if path is None:
                            return
                        pending.add(pool.submit(parse, path))

            try:
                fill()
                while pending:
                    done, pending = wait(pending, return_when=FIRST_COMPLETED)
                    for future in done:
                        future.result()
                    fill()
            except BaseException:
                with lock:
                    stopped.set()
                    processes = list(active)
                    deadline = cleanup_deadline
                _stop_parsers(processes, deadline=deadline)
                raise
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
