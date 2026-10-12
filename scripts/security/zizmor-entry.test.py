#!/usr/bin/env python3
"""Behavior tests for the trusted zizmor entrypoint. Pure unittest; no scanner.

The module under test is loaded with a stub `parse_gate` in `sys.modules`, so the
import itself is exercised without touching /control or the real gate. Every
subprocess, clock and snapshot check is injected; no real command is executed and
no network is used.
"""
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

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


def fake_runner(calls=None, *, stdout=b"[]", outcome=0, raises=None):
    calls = [] if calls is None else calls

    def runner(args, **kwargs):
        calls.append((list(args), dict(kwargs)))
        if raises is not None:
            raise raises
        return Result(stdout, outcome)

    return runner


class ZizmorEntryTest(unittest.TestCase):
    def assert_fails(self, invoke):
        with self.assertRaises(SystemExit) as ctx:
            invoke()
        self.assertEqual(str(ctx.exception), FAILED)
        self.assertIsNone(ctx.exception.__cause__)
        return ctx.exception

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

    def test_entrypoint_has_no_autofix_render_or_network_flags(self):
        source = Path(__file__).with_name("zizmor-entry.py").read_text(encoding="utf-8")
        for banned in ["--fix", "--persona", "--gh-token", "--collect", "--format=html",
                       "--registry"]:
            self.assertNotIn(banned, source, banned)
        for required in [*FLAGS, "--no-index", "--isolated", "--require-hashes"]:
            self.assertIn(required, source, required)


if __name__ == "__main__":
    unittest.main()
