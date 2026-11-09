#!/usr/bin/env python3
"""Behavior tests for the trusted parse gate. Pure unittest; no scanner, no network."""
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
