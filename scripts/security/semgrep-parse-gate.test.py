#!/usr/bin/env python3
"""Behavior tests with inert synthetic scanners; no Semgrep binary or network."""
import contextlib
import hashlib
import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True

MODULE_PATH = Path(__file__).with_name("semgrep-parse-gate.py")
SPEC = importlib.util.spec_from_file_location("semgrep_parse_gate", MODULE_PATH)
if SPEC is None or SPEC.loader is None:  # static narrowing; runtime path must exist
    raise RuntimeError("parse gate module is not importable")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

EXTENSIONS = (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx")
FAILED = "parse-gate-failed"


class Result:
    def __init__(self, returncode=0):
        self.returncode = returncode


class Clock:
    """Deterministic monotonic stand-in; repeats the final value once exhausted."""

    def __init__(self, values):
        self.values = list(values)
        self.index = 0

    def __call__(self):
        value = self.values[min(self.index, len(self.values) - 1)]
        self.index += 1
        return value


class ManualClock:
    """Thread-safe elapsed time advanced by simulated subprocesses."""

    def __init__(self):
        self.lock = threading.Lock()
        self.value = 0.0

    def __call__(self):
        with self.lock:
            return self.value

    def advance(self, value):
        with self.lock:
            self.value += value


class SnapshotClock:
    """Simulate time spent validating the snapshot before the first call."""

    def __init__(self, elapsed):
        self.elapsed = elapsed
        self.lock = threading.Lock()
        self.first = True

    def __call__(self):
        with self.lock:
            if self.first:
                self.first = False
                return 0.0
            return self.elapsed


def fake(calls=None, *, outcome=0, raises=None, mutate=None):
    calls = [] if calls is None else calls

    def run(args, **kwargs):
        calls.append((list(args), dict(kwargs)))
        if mutate:
            mutate(Path(args[-1]))
        if raises is not None:
            raise raises
        return Result(outcome)

    return run


class ParseGateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(os.path.realpath(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, data=b"const x = 1;\n"):
        path = self.root / name
        path.write_bytes(data)
        return {"path": str(path), "sha256": hashlib.sha256(data).hexdigest()}

    def entries(self, names):
        return [self.write(name) for name in names]

    def assert_rejects(self, entries, root=None):
        with self.assertRaises(MODULE.ParseGateError) as ctx:
            MODULE.verify_snapshot(entries, root if root is not None else self.root)
        self.assertEqual(str(ctx.exception), FAILED)
        self.assertIsNone(ctx.exception.__cause__)
        return ctx.exception

    def test_import_is_safe_and_exposes_api(self):
        self.assertIsNot(MODULE.__name__, "__main__")
        self.assertTrue(callable(MODULE.check_parse))
        self.assertTrue(callable(MODULE.verify_snapshot))
        self.assertFalse(hasattr(MODULE, "LANGUAGES"))

    def test_valid_targets_use_matching_language_and_safe_options(self):
        entries = self.entries([f"{i:06d}{ext}" for i, ext in enumerate(EXTENSIONS)])
        calls = []
        result = MODULE.check_parse("semgrep", entries, self.root,
                                    runner=fake(calls), clock=lambda: 0.0)
        self.assertEqual(result, [entry["path"] for entry in entries])
        self.assertEqual(len(calls), len(EXTENSIONS))
        by_path = {args[-1]: (args, kwargs) for args, kwargs in calls}
        self.assertEqual(set(by_path), {entry["path"] for entry in entries})
        for entry, extension in zip(entries, EXTENSIONS):
            args, kwargs = by_path[entry["path"]]
            language = "typescript" if extension in (".ts", ".tsx") else "javascript"
            self.assertEqual(args, ["semgrep", "show", "dump-ast", language, entry["path"]])
            self.assertIs(kwargs["shell"], False)
            self.assertIs(kwargs["check"], False)
            self.assertEqual(kwargs["stdout"], subprocess.DEVNULL)
            self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
            self.assertLessEqual(kwargs["timeout"], 10.0)
            self.assertNotIn("capture_output", kwargs)

    def test_explicit_workflow_mode_accepts_only_yaml(self):
        entries = self.entries(["000000.yml", "000001.yaml"])
        self.assertEqual(MODULE.verify_snapshot(entries, self.root, workflow=True),
                         [entry["path"] for entry in entries])
        self.assert_rejects(entries)
        with self.assertRaises(MODULE.ParseGateError):
            MODULE.verify_snapshot([self.write("000002.js")], self.root, workflow=True)

    def test_hash_mismatch_prevents_subprocess(self):
        entry = self.write("000000.js")
        entry["sha256"] = "0" * 64
        calls = []
        with self.assertRaises(MODULE.ParseGateError):
            MODULE.check_parse("semgrep", [entry], self.root, runner=fake(calls))
        self.assertEqual(calls, [])

    def test_duplicate_and_escaped_paths_rejected(self):
        entry = self.write("000000.js")
        self.assert_rejects([entry, dict(entry)])
        self.assert_rejects([{"path": os.path.join(str(self.root), "..", "000000.js"),
                              "sha256": entry["sha256"]}])
        self.assert_rejects([{"path": os.path.join(str(self.root), ".", "000000.js"),
                              "sha256": entry["sha256"]}])

    def test_invalid_names_and_extensions_rejected(self):
        for name in ["00000.js", "abcdef.js", "000000.JS", "000000.html", "000000", "000000.js2", "000000.mts", "000000.cts"]:
            with self.subTest(name=name):
                self.assert_rejects([{"path": str(self.root / name), "sha256": "0" * 64}])

    def test_non_regular_rejected(self):
        (self.root / "000000.js").mkdir()
        self.assert_rejects([{"path": str(self.root / "000000.js"), "sha256": "0" * 64}])

    def test_symlink_rejected_when_supported(self):
        real = self.write("000001.js")
        link = self.root / "000000.js"
        try:
            os.symlink(real["path"], link)
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation is not supported on this host")
        self.assert_rejects([{"path": str(link), "sha256": real["sha256"]}])

    def test_limits_rejected(self):
        self.assert_rejects([self.write("000000.js", b"a" * (MODULE.MAX_SOURCE + 1))])
        self.assert_rejects([{"path": "/x", "sha256": "0" * 64}] * (MODULE.MAX_ENTRIES + 1))

    def test_empty_and_invalid_entries_rejected(self):
        self.assert_rejects([])
        good = self.write("000000.js")
        for bad in [None, "text", 7, {}, {"path": good["path"]}, {"sha256": good["sha256"]},
                    {"path": 1, "sha256": good["sha256"]}, {"path": good["path"], "sha256": 1},
                    {"path": good["path"], "sha256": "zz" * 32}]:
            with self.subTest(bad=bad):
                self.assert_rejects([bad])

    def test_mutated_bytes_after_call_detected(self):
        entry = self.write("000000.js")
        with self.assertRaises(MODULE.ParseGateError):
            MODULE.check_parse("semgrep", [entry], self.root,
                               runner=fake(mutate=lambda path: path.write_bytes(b"const y = 2;\n")),
                               clock=lambda: 0.0)

    def test_runner_failures_rejected(self):
        entry = self.write("000000.js")
        for name, runner in [
            ("nonzero", fake(outcome=3)),
            ("signal", fake(outcome=-9)),
            ("timeout", fake(raises=subprocess.TimeoutExpired("semgrep", 10))),
            ("oserror", fake(raises=OSError("boom"))),
        ]:
            with self.subTest(name=name):
                with self.assertRaises(MODULE.ParseGateError):
                    MODULE.check_parse("semgrep", [entry], self.root,
                                       runner=runner, clock=lambda: 0.0)

    def test_budget_exhausted_before_first_call(self):
        entry = self.write("000000.js")
        calls = []
        with self.assertRaises(MODULE.ParseGateError):
            MODULE.check_parse("semgrep", [entry], self.root,
                               runner=fake(calls), clock=Clock([0.0, 120.0]),
                               budget_seconds=120.0)
        self.assertEqual(calls, [])

    def test_budget_exhausted_after_last_call(self):
        entry = self.write("000000.js")
        calls = []
        with self.assertRaises(MODULE.ParseGateError):
            MODULE.check_parse("semgrep", [entry], self.root,
                               runner=fake(calls), clock=Clock([0.0, 0.0, 120.0]),
                               budget_seconds=120.0)
        self.assertEqual(len(calls), 1)

    def test_budget_exhausted_after_final_hash_check(self):
        entry = self.write("000000.js")
        calls = []
        with self.assertRaises(MODULE.ParseGateError):
            MODULE.check_parse("semgrep", [entry], self.root,
                               runner=fake(calls), clock=Clock([0.0, 0.0, 0.0, 120.0]),
                               budget_seconds=120.0)
        self.assertEqual(len(calls), 1)

    def test_invalid_budget_rejected(self):
        entry = self.write("000000.js")
        for budget in [0, -1, 0.0, float("inf"), float("nan"), True]:
            with self.subTest(budget=budget):
                with self.assertRaises(MODULE.ParseGateError):
                    MODULE.check_parse("semgrep", [entry], self.root, runner=fake(),
                                       clock=lambda: 0.0, budget_seconds=budget)

    def test_400_files_at_point_four_seconds_are_all_parsed_with_two_workers(self):
        entries = self.entries([f"{i:06d}.js" for i in range(400)])
        clock = ManualClock()
        barrier = threading.Barrier(2)
        lock = threading.Lock()
        calls = []
        active = 0
        peak = 0

        def run(args, **kwargs):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
                calls.append((args[-1], kwargs["timeout"]))
            if barrier.wait(timeout=2) == 0:
                clock.advance(0.4)
            barrier.wait(timeout=2)
            with lock:
                active -= 1
            return Result()

        result = MODULE.check_parse("semgrep", entries, self.root, runner=run, clock=clock)
        self.assertEqual(result, [entry["path"] for entry in entries])
        self.assertEqual({path for path, _ in calls}, set(result))
        self.assertEqual(len(calls), 400)
        self.assertEqual(peak, 2)
        self.assertEqual(active, 0)
        self.assertAlmostEqual(clock(), 80.0)
        self.assertTrue(all(0 < timeout <= 10.0 for _, timeout in calls))

    def test_scaled_budget_boundary_and_cap(self):
        entries = self.entries([f"{i:06d}.ts" for i in range(800)])
        for count, budget in [(1, 120.25), (4, 121.0), (400, 220.0), (800, 300.0)]:
            for elapsed, succeeds in [(budget - 0.1, True), (budget, False)]:
                with self.subTest(count=count, elapsed=elapsed):
                    clock = SnapshotClock(elapsed)
                    calls = []

                    def run(args, **kwargs):
                        calls.append((args[-1], kwargs["timeout"]))
                        return Result()

                    if succeeds:
                        result = MODULE.check_parse("semgrep", entries[:count], self.root,
                                                    runner=run, clock=clock)
                        self.assertEqual(result, [entry["path"] for entry in entries[:count]])
                        self.assertEqual({path for path, _ in calls}, set(result))
                        self.assertEqual(len(calls), count)
                        self.assertTrue(all(0 < timeout <= 0.100001 for _, timeout in calls))
                    else:
                        with self.assertRaises(MODULE.ParseGateError) as ctx:
                            MODULE.check_parse("semgrep", entries[:count], self.root,
                                               runner=run, clock=clock)
                        self.assertEqual(str(ctx.exception), FAILED)
                        self.assertEqual(calls, [])

    def test_scaled_total_exhaustion_during_calls_fails_closed(self):
        entries = self.entries([f"{i:06d}.js" for i in range(40)])
        clock = ManualClock()
        calls = []
        output = io.StringIO()
        errors = io.StringIO()

        def run(args, **kwargs):
            timeout = kwargs["timeout"]
            calls.append(args[-1])
            clock.advance(min(6.0, timeout))
            if timeout < 6.0:
                raise subprocess.TimeoutExpired("sensitive-path", timeout)
            return Result()

        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            with self.assertRaises(MODULE.ParseGateError) as ctx:
                MODULE.check_parse("semgrep", entries, self.root, runner=run, clock=clock)
        self.assertEqual(str(ctx.exception), FAILED)
        self.assertIsNone(ctx.exception.__cause__)
        self.assertGreaterEqual(clock(), 130.0)  # 120 + 40 * 0.25
        self.assertLess(len(calls), len(entries))
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(errors.getvalue(), "")
        self.assertEqual(MODULE.verify_snapshot(entries, self.root),
                         [entry["path"] for entry in entries])

    def test_injected_budget_can_only_lower_the_trusted_budget(self):
        entries = [self.write("000000.js")]
        for override, elapsed in [(900.0, 120.25), (1.0, 1.0)]:
            with self.subTest(override=override):
                clock = SnapshotClock(elapsed)
                calls = []
                with self.assertRaises(MODULE.ParseGateError) as ctx:
                    MODULE.check_parse("semgrep", entries, self.root, runner=fake(calls),
                                       clock=clock, budget_seconds=override)
                self.assertEqual(str(ctx.exception), FAILED)
                self.assertEqual(calls, [])

    def test_per_call_timeout_fails_closed_and_discards_details(self):
        entry = self.write("000000.js")
        calls = []
        clock = ManualClock()
        output = io.StringIO()
        errors = io.StringIO()

        def run(args, **kwargs):
            duration = 10.1
            timeout = kwargs["timeout"]
            calls.append(timeout)
            clock.advance(min(duration, timeout))
            if duration > timeout:
                raise subprocess.TimeoutExpired("sensitive-path", timeout)
            return Result()

        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            with self.assertRaises(MODULE.ParseGateError) as ctx:
                MODULE.check_parse("semgrep", [entry], self.root, runner=run, clock=clock)
        self.assertEqual(calls, [10.0])
        self.assertEqual(clock(), 10.0)
        self.assertEqual(str(ctx.exception), FAILED)
        self.assertIsNone(ctx.exception.__cause__)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(errors.getvalue(), "")
        self.assertEqual(MODULE.verify_snapshot([entry], self.root), [entry["path"]])

    def test_parallel_completion_preserves_inventory_order(self):
        entries = self.entries([f"{i:06d}.js" for i in range(4)])
        first_started = threading.Event()
        second_finished = threading.Event()
        completed = []

        def run(args, **kwargs):
            path = args[-1]
            if path == entries[0]["path"]:
                first_started.set()
                if not second_finished.wait(2):
                    raise RuntimeError("second worker did not start")
            elif path == entries[1]["path"]:
                if not first_started.wait(2):
                    raise RuntimeError("first worker did not start")
                completed.append(path)
                second_finished.set()
                return Result()
            completed.append(path)
            return Result()

        result = MODULE.check_parse("semgrep", entries, self.root, runner=run, clock=lambda: 0.0)
        self.assertEqual(result, [entry["path"] for entry in entries])
        self.assertEqual(completed[0], entries[1]["path"])
        self.assertEqual(set(completed), set(result))
        self.assertEqual(len(completed), len(entries))

    def test_parallel_worker_failure_is_sanitized_and_joined(self):
        entries = self.entries([f"{i:06d}.js" for i in range(3)])
        for failure in ("nonzero", "exception"):
            with self.subTest(failure=failure):
                first_started = threading.Event()
                second_started = threading.Event()
                completed = []
                output = io.StringIO()
                errors = io.StringIO()

                def run(args, **kwargs):
                    path = args[-1]
                    if path == entries[0]["path"]:
                        first_started.set()
                        if not second_started.wait(2):
                            raise RuntimeError("second worker did not start")
                    elif path == entries[1]["path"]:
                        if not first_started.wait(2):
                            raise RuntimeError("first worker did not start")
                        second_started.set()
                        completed.append(path)
                        if failure == "nonzero":
                            return Result(3)
                        raise OSError("secret scanner output")
                    completed.append(path)
                    return Result()

                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                    with self.assertRaises(MODULE.ParseGateError) as ctx:
                        MODULE.check_parse("semgrep", entries, self.root, runner=run, clock=lambda: 0.0)
                self.assertEqual(str(ctx.exception), FAILED)
                self.assertIsNone(ctx.exception.__cause__)
                self.assertTrue({entries[0]["path"], entries[1]["path"]}.issubset(completed))
                self.assertEqual(output.getvalue(), "")
                self.assertEqual(errors.getvalue(), "")
                self.assertEqual(MODULE.verify_snapshot(entries, self.root),
                                 [entry["path"] for entry in entries])

    @unittest.skipUnless(sys.platform.startswith("linux"), "requires Linux")
    def test_real_success_parses_all_files_in_separate_sessions(self):
        exe = self.root / "successful-scanner"
        exe.write_text(f"""#!{sys.executable}
import os, sys
if os.getsid(0) != os.getpid(): sys.exit(4)
open(os.path.join({str(self.root)!r}, os.path.basename(sys.argv[-1]) + '.done'), 'w').write('done')
print('scanner output')
print('scanner error', file=sys.stderr)
""")
        exe.chmod(0o700)
        entries = self.entries([f"{i:06d}.js" for i in range(4)])
        output = io.StringIO()
        errors = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            result = MODULE.check_parse(str(exe), entries, self.root)
        self.assertEqual(result, [entry["path"] for entry in entries])
        self.assertTrue(all((self.root / f"{i:06d}.js.done").read_text() == "done" for i in range(4)))
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(errors.getvalue(), "")

    @unittest.skipUnless(sys.platform.startswith("linux"), "requires Linux")
    def test_non_posix_fallback_stops_direct_process(self):
        import signal
        pidfile = self.root / "direct.pid"
        exe = self.root / "direct-scanner"
        exe.write_text(f"""#!{sys.executable}
import os, time
open({str(pidfile)!r}, 'w').write(str(os.getpid()))
time.sleep(15)
""")
        exe.chmod(0o700)
        entries = [self.write("000000.js")]

        class NonPosix:
            name = "nt"

            def __getattr__(self, name):
                if name == "killpg":
                    raise AssertionError("non-POSIX fallback must not signal a process group")
                return getattr(os, name)

        try:
            with mock.patch.object(MODULE, "os", NonPosix()):
                with self.assertRaises(MODULE.ParseGateError) as ctx:
                    MODULE.check_parse(str(exe), entries, self.root, budget_seconds=0.8)
            self.assertEqual(str(ctx.exception), FAILED)
            self.assertTrue(pidfile.exists(), "parser did not start")
            pid = int(pidfile.read_text())
            proc = Path(f"/proc/{pid}/stat")
            alive = proc.exists() and proc.read_text().rsplit(") ", 1)[1][0] not in "ZX"
            self.assertFalse(alive, f"direct parser {pid} survived timeout")
        finally:
            if pidfile.exists():
                try: os.kill(int(pidfile.read_text()), signal.SIGKILL)
                except ProcessLookupError: pass

    @unittest.skipUnless(sys.platform.startswith("linux"), "requires Linux")
    def test_failed_peer_leaves_no_parser_descendant(self):
        import signal, time
        pidfile = self.root / "child.pid"
        exe = self.root / "scanner"
        exe.write_text(f"""#!{sys.executable}
import os, subprocess, sys, time
p = {str(pidfile)!r}
if sys.argv[-1].endswith("000000.js"):
    end = time.monotonic() + 2
    while not os.path.exists(p) and time.monotonic() < end: time.sleep(.01)
    sys.exit(7)
c = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(15)"])
open(p, "w").write(str(c.pid))
time.sleep(15)
""")
        exe.chmod(0o700)
        entries = self.entries(["000000.js", "000001.js"])
        try:
            with self.assertRaises(MODULE.ParseGateError):
                MODULE.check_parse(str(exe), entries, self.root, budget_seconds=3)
            self.assertTrue(pidfile.exists(), "second parser did not start")
            pid = int(pidfile.read_text())
            proc = Path(f"/proc/{pid}/stat")
            alive = proc.exists() and proc.read_text().rsplit(") ", 1)[1][0] not in "ZX"
            self.assertFalse(alive, f"orphan {pid}")
        finally:
            if pidfile.exists():
                try: os.kill(int(pidfile.read_text()), signal.SIGKILL)
                except ProcessLookupError: pass

    def test_no_new_parser_is_dispatched_after_peer_failure(self):
        import time
        entries = self.entries([f"{i:06d}.js" for i in range(3)])
        first_started = threading.Event()
        second_failed = threading.Event()
        calls = []
        output = io.StringIO()
        errors = io.StringIO()

        def run(args, **kwargs):
            path = args[-1]
            calls.append(path)
            if path == entries[0]["path"]:
                first_started.set()
                if not second_failed.wait(2):
                    raise RuntimeError("peer did not start")
                time.sleep(0.15)
                return Result()
            if path == entries[1]["path"]:
                if not first_started.wait(2):
                    raise RuntimeError("first did not start")
                second_failed.set()
                return Result(3)
            return Result()

        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            with self.assertRaises(MODULE.ParseGateError) as ctx:
                MODULE.check_parse("semgrep", entries, self.root, runner=run, clock=lambda: 0.0)
        self.assertEqual(str(ctx.exception), FAILED)
        self.assertEqual(set(calls), {entries[0]["path"], entries[1]["path"]})
        self.assertEqual(len(calls), 2)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(errors.getvalue(), "")
        self.assertEqual(MODULE.verify_snapshot(entries, self.root),
                         [entry["path"] for entry in entries])

    @unittest.skipUnless(sys.platform.startswith("linux"), "requires Linux")
    def test_exited_failure_is_not_hidden_by_delayed_worker(self):
        import time
        pidfile = self.root / "failed.pid"
        third = self.root / "third-dispatched"
        exe = self.root / "ordered-scanner"
        exe.write_text(f"""#!{sys.executable}
import os, sys, time
p = os.path.basename(sys.argv[-1])
if p == '000000.js':
    end = time.monotonic() + 2
    while not os.path.exists({str(pidfile)!r}) and time.monotonic() < end: time.sleep(.01)
    time.sleep(.1)
elif p == '000001.js':
    open({str(pidfile)!r}, 'w').write(str(os.getpid()))
    sys.exit(7)
else:
    open({str(third)!r}, 'w').write('dispatched')
""")
        exe.chmod(0o700)
        entries = self.entries([f"{i:06d}.js" for i in range(3)])
        original_waitid = os.waitid
        delayed = threading.Event()

        def slow_peer_waitid(kind, pid, flags):
            try:
                failed_pid = int(pidfile.read_text())
            except (OSError, ValueError):
                failed_pid = None
            if (threading.current_thread() is not threading.main_thread()
                    and pid == failed_pid and not delayed.is_set()):
                delayed.set()
                time.sleep(0.4)
            return original_waitid(kind, pid, flags)

        with mock.patch.object(MODULE.os, "waitid", side_effect=slow_peer_waitid):
            with self.assertRaises(MODULE.ParseGateError) as ctx:
                MODULE.check_parse(str(exe), entries, self.root, budget_seconds=3)
        self.assertEqual(str(ctx.exception), FAILED)
        self.assertTrue(delayed.is_set(), "failed parser monitor was not delayed")
        self.assertFalse(third.exists(), "third parser started after its peer exited with failure")
        self.assertEqual(MODULE.verify_snapshot(entries, self.root),
                         [entry["path"] for entry in entries])

    @unittest.skipUnless(sys.platform.startswith("linux"), "requires Linux")
    def test_timed_out_peer_blocks_new_process_even_if_monitor_is_delayed(self):
        import signal, time
        pidfile = self.root / "slow-peer.pid"
        started = self.root / "late-dispatch"
        exe = self.root / "timeout-order-scanner"
        exe.write_text(f"""#!{sys.executable}
import os, sys, time
if sys.argv[-1].endswith('000001.js'):
    open({str(pidfile)!r}, 'w').write(str(os.getpid()))
    time.sleep(15)
else:
    open({str(started)!r}, 'w').write('dispatched')
""")
        exe.chmod(0o700)
        entries = self.entries([f"{i:06d}.js" for i in range(3)])
        original_waitid = os.waitid
        delayed = threading.Event()
        previous = MODULE.PER_CALL_TIMEOUT
        MODULE.PER_CALL_TIMEOUT = 0.2

        def slow_path(value):
            if str(value).endswith("000000.js"):
                time.sleep(0.35)
            return Path(value)

        def slow_peer_waitid(kind, pid, flags):
            try:
                peer_pid = int(pidfile.read_text())
            except (OSError, ValueError):
                peer_pid = None
            if pid == peer_pid and not delayed.is_set():
                delayed.set()
                time.sleep(0.6)
            return original_waitid(kind, pid, flags)

        try:
            with mock.patch.object(MODULE, "Path", side_effect=slow_path):
                with mock.patch.object(MODULE.os, "waitid", side_effect=slow_peer_waitid):
                    with self.assertRaises(MODULE.ParseGateError) as ctx:
                        MODULE.check_parse(str(exe), entries, self.root, budget_seconds=3)
            self.assertEqual(str(ctx.exception), FAILED)
            self.assertTrue(delayed.is_set(), "peer monitor was not delayed")
            self.assertFalse(started.exists(), "parser started after its peer timed out")
            self.assertEqual(MODULE.verify_snapshot(entries, self.root),
                             [entry["path"] for entry in entries])
        finally:
            MODULE.PER_CALL_TIMEOUT = previous
            if pidfile.exists():
                try: os.kill(int(pidfile.read_text()), signal.SIGKILL)
                except ProcessLookupError: pass

    @unittest.skipUnless(sys.platform.startswith("linux"), "requires Linux")
    def test_late_success_cannot_bypass_per_call_timeout(self):
        import time
        exe = self.root / "slow-scanner"
        exe.write_text(f"""#!{sys.executable}
import time
time.sleep(0.08)
""")
        exe.chmod(0o700)
        entries = [self.write("000000.js")]
        original_waitid = os.waitid
        previous = MODULE.PER_CALL_TIMEOUT
        MODULE.PER_CALL_TIMEOUT = 0.03

        def delayed_waitid(*args):
            time.sleep(0.15)
            return original_waitid(*args)

        try:
            with mock.patch.object(MODULE.os, "waitid", side_effect=delayed_waitid):
                with self.assertRaises(MODULE.ParseGateError) as ctx:
                    MODULE.check_parse(str(exe), entries, self.root, budget_seconds=3)
            self.assertEqual(str(ctx.exception), FAILED)
            self.assertEqual(MODULE.verify_snapshot(entries, self.root), [entries[0]["path"]])
        finally:
            MODULE.PER_CALL_TIMEOUT = previous

    @unittest.skipUnless(sys.platform.startswith("linux"), "requires Linux")
    def test_failure_waits_until_signalled_group_is_gone(self):
        import time
        exe = self.root / "failed-scanner"
        exe.write_text(f"""#!{sys.executable}
import sys
sys.exit(7)
""")
        exe.chmod(0o700)
        entries = [self.write("000000.js")]
        original_killpg = os.killpg
        first_probe = []

        def delayed_disappearance(group, sig):
            if sig == 0:
                if not first_probe:
                    first_probe.append(time.monotonic())
                if time.monotonic() - first_probe[0] < 0.25:
                    return
            return original_killpg(group, sig)

        with mock.patch.object(MODULE.os, "killpg", side_effect=delayed_disappearance):
            with self.assertRaises(MODULE.ParseGateError) as ctx:
                MODULE.check_parse(str(exe), entries, self.root, budget_seconds=3)
        self.assertEqual(str(ctx.exception), FAILED)
        self.assertTrue(first_probe, "process group was not checked")
        self.assertGreaterEqual(time.monotonic() - first_probe[0], 0.25)
        self.assertEqual(MODULE.verify_snapshot(entries, self.root), [entries[0]["path"]])

    @unittest.skipUnless(sys.platform.startswith("linux"), "requires Linux")
    def test_timeouts_kill_term_resistant_descendant(self):
        import signal
        for mode in ("per-call", "total"):
            with self.subTest(mode=mode):
                pidfile = self.root / f"{mode}.pid"
                ready = self.root / f"{mode}.ready"
                exe = self.root / f"scanner-{mode}"
                child = ("import os, signal, time; "
                         "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                         f"open({str(ready)!r}, 'w').write('ready'); time.sleep(15)")
                exe.write_text(f"""#!{sys.executable}
import subprocess, sys, time
c = subprocess.Popen([sys.executable, '-c', {child!r}])
open({str(pidfile)!r}, 'w').write(str(c.pid))
time.sleep(15)
""")
                exe.chmod(0o700)
                entries = [self.write("000000.js")]
                previous = MODULE.PER_CALL_TIMEOUT
                if mode == "per-call":
                    MODULE.PER_CALL_TIMEOUT = 0.8
                output = io.StringIO()
                errors = io.StringIO()
                try:
                    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                        with self.assertRaises(MODULE.ParseGateError) as ctx:
                            MODULE.check_parse(str(exe), entries, self.root,
                                               budget_seconds=0.8 if mode == "total" else 3)
                    self.assertEqual(str(ctx.exception), FAILED)
                    self.assertTrue(pidfile.exists(), "parser did not start its child")
                    self.assertTrue(ready.exists(), "child did not install its SIGTERM handler")
                    pid = int(pidfile.read_text())
                    proc = Path(f"/proc/{pid}/stat")
                    alive = proc.exists() and proc.read_text().rsplit(") ", 1)[1][0] not in "ZX"
                    self.assertFalse(alive, f"orphan {pid} after {mode} timeout")
                    self.assertEqual(output.getvalue(), "")
                    self.assertEqual(errors.getvalue(), "")
                    self.assertEqual(MODULE.verify_snapshot(entries, self.root), [entries[0]["path"]])
                finally:
                    MODULE.PER_CALL_TIMEOUT = previous
                    if pidfile.exists():
                        try: os.kill(int(pidfile.read_text()), signal.SIGKILL)
                        except ProcessLookupError: pass

    def test_errors_never_leak_paths_or_secrets(self):
        secret = "sup3r-secret-token"
        error = self.assert_rejects([{"path": os.path.join(str(self.root), secret, "000000.js"),
                                      "sha256": "0" * 64}])
        self.assertNotIn(secret, str(error))
        with self.assertRaises(MODULE.ParseGateError) as ctx:
            MODULE.check_parse("semgrep", [self.write("000001.js")], self.root,
                               runner=fake(raises=OSError(secret)), clock=lambda: 0.0)
        self.assertEqual(str(ctx.exception), FAILED)
        self.assertNotIn(secret, str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
