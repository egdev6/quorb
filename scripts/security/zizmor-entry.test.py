#!/usr/bin/env python3
"""Behavior tests for the trusted zizmor entrypoint. Pure unittest; no scanner.

The module under test is loaded with a stub `parse_gate` in `sys.modules`, so the
import itself is exercised without touching /control or the real gate. Every
subprocess, clock and snapshot check is injected; no real command is executed and
no network is used.
"""
import collections
import importlib.util
import io
import json
import os
import pathlib
import runpy
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True

FAILED = "zizmor-runner-failed"
FLAGS = ("--offline", "--no-config", "--strict-collection", "--no-ignores",
         "--no-exit-codes", "--format=json-v1", "--no-progress")


def load_module():
    stub = types.ModuleType("parse_gate")

    def verify_snapshot(entries, root=Path("/inputs"), *, workflow=False):
        return [entry["path"] for entry in entries]

    stub.verify_snapshot = verify_snapshot  # type: ignore[attr-defined]
    sys.modules["parse_gate"] = stub
    path = Path(__file__).with_name("zizmor-entry.py")
    spec = importlib.util.spec_from_file_location("zizmor_entry", path)
    if spec is None or spec.loader is None:  # static narrowing; runtime path must exist
        raise RuntimeError("zizmor entry module is not importable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MODULE = load_module()


class Result:
    def __init__(self, stdout=b"[]", returncode=0):
        self.stdout = stdout
        self.returncode = returncode
        self.stderr = b""


class Clock:
    """Deterministic monotonic stand-in; repeats the final value once exhausted."""

    def __init__(self, values):
        self.values = list(values)
        self.index = 0

    def __call__(self):
        value = self.values[min(self.index, len(self.values) - 1)]
        self.index += 1
        return value


def fake_runner(calls=None, *, stdout=b"[]", outcome=0, raises=None):
    calls = [] if calls is None else calls

    def runner(args, **kwargs):
        calls.append((list(args), dict(kwargs)))
        if raises is not None:
            raise raises
        return Result(stdout, outcome)

    return runner


def recording_verify(paths):
    calls = []

    def verify(entries, root=Path("/inputs"), *, workflow=False):
        calls.append({"entries": list(entries), "root": root, "workflow": workflow})
        return list(paths)

    return verify, calls


ENTRY_PATH = Path(__file__).with_name("zizmor-entry.py")
PinnedVersion = collections.namedtuple("PinnedVersion", "major minor micro releaselevel serial")


def pinned_version(major=3, minor=12, micro=0):
    """Return a sys.version_info-shaped value without a real interpreter switch."""
    return PinnedVersion(major, minor, micro, "final", 0)


def entry_runner(events, *, scan_outcome=0, raises=None):
    """Record each subprocess kind; never execute a real venv, pip or zizmor."""

    def runner(args, **kwargs):
        argv = list(args)
        if argv[-1] == "--version":
            events.append(("version", argv))
            return Result(b"zizmor 1.30.1\n")
        if "--offline" in argv:
            events.append(("scan", argv))
            if raises is not None:
                raise raises
            return Result(b"[]", scan_outcome)
        events.append(("setup", argv))
        return Result()

    return runner


def run_entry(*, runner, events=None, version=(3, 12, 0), targets=None):
    """Execute zizmor-entry.py as __main__ with gate, subprocess and control injected.

    Returns the exact bytes written to stdout and the SystemExit raised, if any.
    """
    events = [] if events is None else events
    targets = json.dumps({"targets": [{"path": "/inputs/000000.yml",
                                       "sha256": "0" * 64}]}) if targets is None else targets
    capture = io.BytesIO()
    stub = types.ModuleType("parse_gate")
    original_read_text = pathlib.Path.read_text

    def verify_snapshot(entries, root=Path("/inputs"), *, workflow=False):
        events.append(("verify", workflow))
        return [entry["path"] for entry in entries]

    def read_text(self, *args, **kwargs):
        if str(self) == "/control/targets.json":
            return targets
        return original_read_text(self, *args, **kwargs)

    class Stream:
        buffer = capture

    stub.verify_snapshot = verify_snapshot  # type: ignore[attr-defined]
    error = None
    patches = [mock.patch.dict(sys.modules, {"parse_gate": stub}),
               mock.patch.object(pathlib.Path, "read_text", read_text),
               mock.patch.object(sys, "stdout", Stream()),
               mock.patch.object(subprocess, "run", runner),
               mock.patch.object(sys, "version_info", pinned_version(*version))]
    with ExitStack() as stack:
        for patch in patches:
            stack.enter_context(patch)
        try:
            runpy.run_path(str(ENTRY_PATH), run_name="__main__")
        except SystemExit as exc:
            error = exc
    return capture.getvalue(), error


class ZizmorEntryTest(unittest.TestCase):
    def entries(self, count=1):
        return [{"path": f"/inputs/{index:06d}.yml", "sha256": "0" * 64}
                for index in range(count)]

    def assert_fails(self, invoke):
        with self.assertRaises(SystemExit) as ctx:
            invoke()
        self.assertEqual(str(ctx.exception), FAILED)
        self.assertIsNone(ctx.exception.__cause__)
        return ctx.exception

    def scan(self, entries, *, runner, clock=None, verify=None, **kwargs):
        clock = (lambda: 0.0) if clock is None else clock
        verify = (recording_verify([entry["path"] for entry in entries])[0]
                  if verify is None else verify)
        return MODULE.scan(entries, runner=runner, clock=clock, verify=verify, **kwargs)

    def test_import_wires_trusted_gate_and_pinned_flags(self):
        self.assertIsNot(MODULE.__name__, "__main__")
        self.assertIs(MODULE.verify_snapshot, sys.modules["parse_gate"].verify_snapshot)
        self.assertEqual(MODULE.VERSION, "1.30.1")
        self.assertEqual(MODULE.SELECTED_VERSION, b"zizmor 1.30.1")
        self.assertEqual(tuple(MODULE.SCAN_FLAGS), FLAGS)
        self.assertTrue(callable(MODULE.scan))

    def test_runs_one_sanitized_call_per_path_in_order(self):
        entries = self.entries(3)
        paths = [entry["path"] for entry in entries]
        verify, verifications = recording_verify(paths)
        calls = []
        env = {"PATH": "/trusted/bin"}
        out = MODULE.scan(entries, runner=fake_runner(calls), clock=lambda: 0.0,
                          verify=verify, env=env)
        self.assertEqual(out, {"version": "1.30.1",
                               "reports": [{"path": path, "findings": []} for path in paths]})
        self.assertEqual(len(calls), 3)
        for index, (args, kwargs) in enumerate(calls):
            self.assertEqual(args, [str(MODULE.VENV / "bin" / "zizmor"), *FLAGS, paths[index]])
            self.assertIs(kwargs["shell"], False)
            self.assertIs(kwargs["check"], False)
            self.assertIs(kwargs["capture_output"], True)
            self.assertEqual(kwargs["env"], env)
            self.assertLessEqual(kwargs["timeout"], 30.0)
        self.assertEqual([call["workflow"] for call in verifications], [True, True])

    def test_embeds_raw_findings_array_from_stdout(self):
        entries = self.entries(2)
        verify, _ = recording_verify([entry["path"] for entry in entries])
        payload = b'[{"ident":"artipacked","ignored":true}]'
        out = MODULE.scan(entries, runner=fake_runner(stdout=payload),
                          clock=lambda: 0.0, verify=verify)
        self.assertEqual(out["reports"][0]["findings"], [{"ident": "artipacked", "ignored": True}])
        self.assertEqual(out["reports"][1]["findings"], [{"ident": "artipacked", "ignored": True}])

    def test_non_array_or_malformed_stdout_rejected(self):
        entries = self.entries(1)
        for stdout in [b"not json", b"{}", b"null", b"12", b'"x"', b""]:
            with self.subTest(stdout=stdout):
                runner = fake_runner(stdout=stdout)
                self.assert_fails(lambda: self.scan(entries, runner=runner))

    def test_operational_failures_are_generic_and_leak_nothing(self):
        entries = self.entries(1)
        secret = "sup3r-secret-token"
        runners = [
            fake_runner(outcome=1),
            fake_runner(outcome=-9),
            fake_runner(raises=subprocess.TimeoutExpired("zizmor", 30)),
            fake_runner(raises=OSError(secret)),
        ]
        for runner in runners:
            with self.subTest(runner=runner):
                error = self.assert_fails(lambda: self.scan(entries, runner=runner))
                self.assertNotIn(secret, str(error))

    def test_snapshot_rejection_prevents_any_scan(self):
        entries = self.entries(2)
        calls = []

        def verify(entries, root=Path("/inputs"), *, workflow=False):
            raise RuntimeError("parse-gate-failed")

        self.assert_fails(lambda: MODULE.scan(entries, runner=fake_runner(calls),
                                              clock=lambda: 0.0, verify=verify))
        self.assertEqual(calls, [])

    def test_rehashes_after_scan_before_returning(self):
        entries = self.entries(1)
        states = []

        def verify(entries, root=Path("/inputs"), *, workflow=False):
            states.append("verify")
            if len(states) == 2:
                raise RuntimeError("mutated")
            return [entries[0]["path"]]

        calls = []
        self.assert_fails(lambda: MODULE.scan(entries, runner=fake_runner(calls),
                                              clock=lambda: 0.0, verify=verify))
        self.assertEqual(len(calls), 1)
        self.assertEqual(states, ["verify", "verify"])

    def test_budget_exhausted_before_loop_after_call_and_after_final_hash(self):
        entries = self.entries(1)
        cases = [([0.0, 120.0], 0), ([0.0, 0.0, 0.0, 120.0], 1),
                 ([0.0, 0.0, 0.0, 0.0, 120.0], 1)]
        for values, expected_calls in cases:
            with self.subTest(values=values):
                calls = []
                self.assert_fails(lambda: self.scan(entries, runner=fake_runner(calls),
                                                    clock=Clock(values)))
                self.assertEqual(len(calls), expected_calls)

    def test_per_call_timeout_capped_by_remaining_budget(self):
        entries = self.entries(1)
        calls = []
        # Budget starts at 120s, the call begins with 5s left, so it must be capped.
        clock = Clock([0.0, 0.0, 115.0])
        self.scan(entries, runner=fake_runner(calls), clock=clock)
        self.assertEqual(calls[0][1]["timeout"], 5.0)

    def test_invalid_budget_rejected_before_any_call(self):
        entries = self.entries(1)
        calls = []
        for budget in [0, -1, 0.0, float("inf"), True, "x"]:
            with self.subTest(budget=budget):
                self.assert_fails(lambda: self.scan(entries, runner=fake_runner(calls),
                                                    budget_seconds=budget))
        self.assertEqual(calls, [])

    def test_per_report_and_total_byte_limits(self):
        report = b"[" + b" " * (MODULE.MAX_REPORT_BYTES - 2) + b"]"  # exactly 2 MiB
        self.assertEqual(len(report), MODULE.MAX_REPORT_BYTES)
        out = self.scan(self.entries(1), runner=fake_runner(stdout=report))
        self.assertEqual(out["reports"][0]["findings"], [])
        self.assert_fails(lambda: self.scan(self.entries(1),
                                            runner=fake_runner(stdout=report + b" ")))
        entries = self.entries(5)  # 5 * 2 MiB would emit more than the 8 MiB total limit
        self.assert_fails(lambda: self.scan(entries, runner=fake_runner(stdout=report)))

    def test_setup_pins_offline_lock_and_exact_version(self):
        calls = []
        MODULE.do_setup(runner=fake_runner(calls, stdout=b"zizmor 1.30.1\n"))
        argvs = [call[0] for call in calls]
        python = str(MODULE.VENV / "bin" / "python")
        self.assertEqual(argvs[0], [sys.executable, "-m", "venv", str(MODULE.VENV)])
        self.assertEqual(argvs[1], [python, "-m", "pip", "--isolated", "install", "--no-index",
                                    "--find-links=/wheels", "--only-binary=:all:", "--require-hashes",
                                    "--no-deps", "-r", "/control/requirements.lock"])
        self.assertEqual(argvs[2], [python, "-m", "pip", "check"])
        self.assertEqual(argvs[3], [str(MODULE.VENV / "bin" / "zizmor"), "--version"])

    def test_setup_rejects_wrong_version_and_failed_install(self):
        for stdout in [b"zizmor 1.29.0\n", b"1.30.1\n", b""]:
            with self.subTest(stdout=stdout):
                self.assert_fails(lambda: MODULE.do_setup(
                    runner=fake_runner(stdout=stdout)))
        self.assert_fails(lambda: MODULE.do_setup(runner=fake_runner(outcome=1)))

    def test_interpreter_requires_python_312(self):
        MODULE.check_interpreter((3, 12, 5))
        for version in [(3, 11), (3, 13), (2, 7)]:
            with self.subTest(version=version):
                self.assert_fails(lambda: MODULE.check_interpreter(version))

    def test_child_environment_drops_inherited_host_tokens(self):
        source = {"PATH": "/trusted/bin", "HOME": "/tmp", "LANG": "C",
                  "GITHUB_TOKEN": "secret", "ACTIONS_RUNTIME_TOKEN": "secret",
                  "AWS_SECRET_ACCESS_KEY": "secret", "PIP_INDEX_URL": "https://example.invalid"}
        self.assertEqual(MODULE.child_environment(source),
                         {"PATH": "/trusted/bin", "HOME": "/tmp", "LANG": "C"})

    def test_scan_never_inherits_host_tokens_by_default(self):
        secret = "host-secret-token"
        saved = os.environ.get("GITHUB_TOKEN")
        os.environ["GITHUB_TOKEN"] = secret
        try:
            entries = self.entries(1)
            verify, _ = recording_verify([entries[0]["path"]])
            calls = []
            MODULE.scan(entries, runner=fake_runner(calls), clock=lambda: 0.0, verify=verify)
            self.assertNotIn("GITHUB_TOKEN", calls[0][1]["env"])
            self.assertNotIn(secret, calls[0][1]["env"].values())
        finally:
            if saved is None:
                os.environ.pop("GITHUB_TOKEN", None)
            else:
                os.environ["GITHUB_TOKEN"] = saved

    def test_reads_trusted_targets_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "targets.json"
            target = {"path": "/inputs/000000.yml", "sha256": "a" * 64}
            path.write_text(json.dumps({"targets": [target]}), encoding="utf-8")
            self.assertEqual(MODULE.read_targets(path), [target])
            for bad in ["not json", "{}", '{"targets": {}}', '{"targets": []}']:
                with self.subTest(bad=bad):
                    path.write_text(bad, encoding="utf-8")
                    self.assert_fails(lambda: MODULE.read_targets(path))

    def test_emit_writes_only_the_json_envelope_to_stdout(self):
        class Stream:
            def __init__(self):
                self.buffer = io.BytesIO()

        stream = Stream()
        MODULE.emit({"version": "1.30.1", "reports": []}, stream)
        self.assertEqual(stream.buffer.getvalue(), b'{"version":"1.30.1","reports":[]}')

    def test_emitted_envelope_is_bounded_including_json_escaping(self):
        class Stream:
            def __init__(self):
                self.buffer = io.BytesIO()

        stream = Stream()
        # ensure_ascii expands non-ASCII text; raw scanner byte totals are insufficient.
        self.assert_fails(lambda: MODULE.emit({"value": "\u00e9" * (MODULE.MAX_TOTAL_BYTES // 6 + 1)}, stream))
        self.assertEqual(stream.buffer.getvalue(), b"")

    def test_entrypoint_has_no_autofix_render_or_network_flags(self):
        source = Path(__file__).with_name("zizmor-entry.py").read_text(encoding="utf-8")
        for banned in ["--fix", "--persona", "--gh-token", "--collect", "--format=html",
                       "--registry"]:
            self.assertNotIn(banned, source, banned)
        for required in [*FLAGS, "--no-index", "--isolated", "--require-hashes"]:
            self.assertIn(required, source, required)

    def test_main_guard_runs_setup_and_emits_the_exact_envelope(self):
        entries = self.entries(2)
        events = []
        stdout, error = run_entry(runner=entry_runner(events), events=events,
                                  targets=json.dumps({"targets": entries}))
        self.assertIsNone(error)
        self.assertEqual(stdout,
                         b'{"version":"1.30.1","reports":['
                         b'{"path":"/inputs/000000.yml","findings":[]},'
                         b'{"path":"/inputs/000001.yml","findings":[]}]}')
        # setup/version, then the inventory check, both scans, and the final rehash.
        self.assertEqual([kind for kind, _ in events],
                         ["setup", "setup", "setup", "version", "verify",
                          "scan", "scan", "verify"])
        python = str(MODULE.VENV / "bin" / "python")
        zizmor = str(MODULE.VENV / "bin" / "zizmor")
        setup = [args for kind, args in events if kind == "setup"]
        self.assertEqual(setup[0], [sys.executable, "-m", "venv", str(MODULE.VENV)])
        self.assertEqual(setup[1][0], python)
        self.assertEqual(setup[2], [python, "-m", "pip", "check"])
        self.assertEqual([args for kind, args in events if kind == "version"],
                         [[zizmor, "--version"]])
        self.assertEqual([args for kind, args in events if kind == "scan"],
                         [[zizmor, *FLAGS, entries[0]["path"]],
                          [zizmor, *FLAGS, entries[1]["path"]]])

    def test_main_guard_fails_closed_when_scanner_fails(self):
        cases = [("nonzero", {"scan_outcome": 1}),
                 ("exception", {"raises": OSError("sup3r-secret")})]
        for label, kwargs in cases:
            with self.subTest(label=label):
                events = []
                stdout, error = run_entry(runner=entry_runner(events, **kwargs),
                                          events=events)
                self.assertIsInstance(error, SystemExit)
                self.assertEqual(str(error), FAILED)
                self.assertIsNone(getattr(error, "__cause__", None))
                self.assertEqual(stdout, b"")
                self.assertEqual([kind for kind, _ in events],
                                 ["setup", "setup", "setup", "version", "verify", "scan"])
                self.assertNotIn("sup3r-secret", str(error))

    def test_main_guard_rejects_non_312_interpreter_before_any_call(self):
        events = []
        stdout, error = run_entry(runner=entry_runner(events), events=events,
                                  version=(3, 11, 9))
        self.assertEqual(str(error), FAILED)
        self.assertEqual(events, [])
        self.assertEqual(stdout, b"")

    def test_module_guard_skips_main_when_not_dunder_main(self):
        # If the `if __name__ == "__main__"` guard were removed, main() would run
        # here: setup, inventory and scanner calls would appear in events.
        events = []
        with mock.patch.object(subprocess, "run", entry_runner(events)):
            namespace = runpy.run_path(str(ENTRY_PATH), run_name="zizmor_entry_under_test")
        self.assertEqual(events, [])
        self.assertTrue(callable(namespace["main"]))
        self.assertEqual(namespace["FAILED"], FAILED)


if __name__ == "__main__":
    unittest.main()
