"""Guard complete Chromium regression coverage after CI suite reorganization."""

import sys as _sb_sys
from pathlib import Path as _sb_path
for _sb_parent in _sb_path(__file__).resolve().parent.parents:
    _sb_scripts = (_sb_parent if (_sb_parent / 'importaliases.py').is_file()
                   else _sb_parent / 'scripts')
    if (_sb_scripts / 'importaliases.py').is_file():
        if str(_sb_scripts) not in _sb_sys.path:
            _sb_sys.path.insert(0, str(_sb_scripts))
        import importaliases
        importaliases.install()
        break


import errno
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPT = ROOT / "scripts/ci/ci-test-runner.py"
SPEC = importlib.util.spec_from_file_location("sweetiebot_ci_test_runner", SCRIPT)
ci = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ci)


class BrowserRoutingTests(unittest.TestCase):
    def test_checks_ignore_personal_git_preferences(self):
        with TemporaryDirectory() as temporary:
            config = Path(temporary) / "gitconfig"
            config.write_text('[scm-toolkit]\n'
                              'github-app-identity-mode = separate-apps\n'
                              'squash-omit-bullets-for-emoji-titles = true\n',
                              encoding="utf-8")
            script = """
const assert = require('node:assert/strict');
assert.equal(process.env.CI_FIXTURE_CONTEXT, 'preserved');
assert.equal(require('./extension/github/app-identity').separateAppsEnabled(), false);
const { squashMessage } = require('./extension/merge/squash-attribution');
const result = squashMessage('Fix', 1, [{commit: {
  author: {name: 'Fixture', email: 'fixture@example.invalid'}, message: '🐛 Fix'
}}]);
assert(result.message.startsWith('- 🐛 Fix'));
"""
            env = {**os.environ, "GIT_CONFIG_GLOBAL": str(config),
                   "CI_FIXTURE_CONTEXT": "preserved"}
            env.pop("SWEETIEBOT_BOT_IDENTITY_MODE", None)
            self.assertEqual(ci.execute(["node", "-e", script], env), 0)

    def test_transient_local_process_launch_retries_without_ignoring_test_failures(self):
        unavailable = OSError(errno.EAGAIN, "Resource temporarily unavailable")
        completed = subprocess.CompletedProcess(["node", "--check"], 0)
        with patch.object(ci.subprocess, "run",
                          side_effect=[unavailable, completed]) as run, \
             patch.object(ci.time, "sleep") as sleep:
            self.assertEqual(ci.execute(["node", "--check", "tests/merge/local-author-merge.js"]), 0)
        self.assertEqual(run.call_count, 2)
        sleep.assert_called_once_with(0.25)
        self.assertEqual(run.call_args.kwargs["env"]["GIT_CONFIG_GLOBAL"], os.devnull)
        self.assertEqual(run.call_args.kwargs["env"]["GIT_CONFIG_NOSYSTEM"], "1")
        with patch.object(ci.subprocess, "run",
                          return_value=subprocess.CompletedProcess(["node"], 1)) as run:
            self.assertEqual(ci.execute(["node", "--check", "broken.js"]), 1)
        run.assert_called_once()

    def test_missing_node_reports_diagnostic_instead_of_crashing(self):
        with patch.object(ci.subprocess, "run",
                          side_effect=FileNotFoundError(errno.ENOENT, "No such file or directory")), \
             patch("sys.stderr", new_callable=io.StringIO) as stderr:
            self.assertEqual(ci.execute(["node", "--check", "missing.js"]),
                             ci.EXECUTION_UNAVAILABLE)
        self.assertIn("Node.js executable not found", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())

    def test_repeated_process_exhaustion_fails_after_bounded_retries(self):
        unavailable = OSError(errno.EAGAIN, "Resource temporarily unavailable")
        with patch.object(ci.subprocess, "run", side_effect=unavailable) as run, \
             patch.object(ci.time, "sleep") as sleep, \
             patch("sys.stderr", new_callable=io.StringIO) as stderr:
            self.assertEqual(ci.execute(["node", "--check", "broken.js"]),
                             ci.EXECUTION_UNAVAILABLE)
        self.assertEqual(run.call_count, 4)
        self.assertEqual([call.args[0] for call in sleep.call_args_list],
                         [0.25, 0.5, 1.0])
        self.assertIn("Resource temporarily unavailable", stderr.getvalue())

    def test_local_launch_failure_stops_the_group_before_other_processes(self):
        spec = {"label": "Lindsey bulk merge",
                "tests": ["merge/local-author-merge.js", "merge/dashboard.js"],
                "syntax": []}
        with patch.object(ci, "execute", return_value=ci.EXECUTION_UNAVAILABLE) as execute, \
             patch("sys.stderr", new_callable=io.StringIO) as stderr:
            with self.assertRaises(SystemExit) as stopped:
                ci.run_group("lindsey", spec)
        self.assertEqual(stopped.exception.code, ci.EXECUTION_UNAVAILABLE)
        execute.assert_called_once_with(["node", "--check", "tests/merge/local-author-merge.js"])
        self.assertIn("Test execution unavailable", stderr.getvalue())
        self.assertNotIn("JavaScript syntax check failed", stderr.getvalue())

    def test_mac_node_fallback_when_gui_path_does_not_include_homebrew(self):
        with patch.object(ci.sys, "platform", "darwin"), \
             patch.object(ci.shutil, "which", return_value=None), \
             patch.object(ci.Path, "is_file", return_value=True), \
             patch.object(ci.os, "access", return_value=True):
            self.assertEqual(ci.resolve_command(["node", "--check", "example.js"],
                                                {"PATH": ""}),
                             ["/opt/homebrew/bin/node", "--check", "example.js"])

    def test_python_and_node_descendants_inherit_discovered_node(self):
        node = ci.resolve_command(["node"], os.environ)[0]
        with TemporaryDirectory() as temporary:
            fallback = Path(temporary) / "node"
            fallback.symlink_to(node)
            env = {**os.environ, "PATH": os.defpath,
                   "CI_FIXTURE_CONTEXT": "preserved"}
            original_env = env.copy()
            javascript = """
const assert = require('node:assert/strict');
assert.equal(process.env.CI_FIXTURE_CONTEXT, 'preserved');
require('node:child_process').execFileSync('node', ['--check'], {input: 'const valid = 1;'});
"""
            python = ("import subprocess; subprocess.run("
                      + repr(["node", "-e", javascript]) + ", check=True)")
            # Simulate discovery outside the GUI PATH while exercising real
            # Python -> Node -> Node subprocesses.
            with patch.object(ci.shutil, "which", return_value=str(fallback)):
                self.assertEqual(ci.execute([sys.executable, "-c", python], env), 0)
            self.assertEqual(env, original_env)

    def test_commit_button_browser_regression_has_one_owner(self):
        manifest = json.loads(ci.CONFIG.read_text(encoding="utf-8"))
        owners = [name for name, group in manifest["groups"].items()
                  if "commits/button-browser.js" in group["tests"]]
        self.assertEqual(owners, ["browser-ui"])
        self.assertFalse(ci.browser_needed(manifest["groups"]["commit"]))
        self.assertTrue(ci.browser_needed(manifest["groups"]["browser-ui"]))

    def test_python_suite_keeps_its_module_import_path(self):
        spec = {"label": "Python imports", "tests": ["search/workspace_search/core.py"],
                "syntax": []}
        with patch.object(ci, "execute", return_value=0) as execute:
            ci.run_group("efs-search", spec)
        self.assertEqual(execute.call_count, 1)
        command, env = execute.call_args.args
        self.assertEqual(command[:4], [sys.executable, "-m", "unittest", "-v"])
        self.assertIn(str(ci.ROOT / "scripts"), env["PYTHONPATH"].split(os.pathsep))
        self.assertIn(str(ci.ROOT / "tests"), env["PYTHONPATH"].split(os.pathsep))

    def test_browser_test_is_syntax_checked_and_executed(self):
        spec = {"label": "Browser and UI",
                "tests": ["commits/button-browser.js"], "syntax": []}
        with patch.object(ci, "execute", return_value=0) as execute:
            ci.run_group("browser-ui", spec)
        commands = [list(call.args[0]) for call in execute.call_args_list]
        self.assertIn(["node", "--check", "tests/commits/button-browser.js"], commands)
        self.assertIn(["node", "tests/commits/button-browser.js"], commands)

    def test_detects_commonjs_and_es_module_playwright_imports(self):
        samples = (
            ("const { chromium } = require('playwright');", True),
            ('const browser = require ( "playwright" );', True),
            ('import { chromium } from "playwright";', True),
            ("const browser = await import('playwright');", True),
            ("import 'playwright';", True),
            ("const somethingElse = require('node:fs');", False),
            ("const unrelated = require('playwright-core');", False),
        )
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            tests = root / "tests"
            tests.mkdir()
            test_path = tests / "browser_fixture.js"
            with patch.object(ci, "ROOT", root):
                for code, expected in samples:
                    with self.subTest(code=code):
                        test_path.write_text(code, encoding="utf-8")
                        self.assertEqual(
                            bool(ci.browser_needed({"tests": [test_path.name]})), expected)

    def test_ci_uses_matching_playwright_versions_and_local_cli(self):
        workflow = (ROOT / ".github/workflows/check.yml").read_text(encoding="utf-8")
        suites = workflow.split("  suites:\n", 1)[1].split("\n  worktree-window-handoff:", 1)[0]
        chromium = workflow.split("  codex-webview-browser:\n", 1)[1].split("\n  bot-app-identities:", 1)[0]
        node_pin = re.search(r"npm install [^\n]*playwright@(\d+\.\d+\.\d+)", suites)
        python_pin = re.search(r"python -m pip install playwright==(\d+\.\d+\.\d+)", chromium)
        self.assertIsNotNone(node_pin, "Pin Node Playwright before browser installation")
        self.assertIsNotNone(python_pin, "Pin Python Playwright before browser installation")
        self.assertEqual(node_pin.group(1), python_pin.group(1))
        self.assertIn("npm install --ignore-scripts", suites)
        self.assertIn("./node_modules/.bin/playwright install --with-deps chromium", suites)
        self.assertNotIn("npx playwright install", suites)
        self.assertIn("python -m playwright install --with-deps chromium", chromium)

    def test_chromium_jobs_isolate_optional_broken_ubuntu_feed(self):
        workflow = (ROOT / ".github/workflows/check.yml").read_text(encoding="utf-8")
        suites = workflow.split("  suites:\n", 1)[1].split("\n  worktree-window-handoff:", 1)[0]
        chromium = workflow.split("  codex-webview-browser:\n", 1)[1].split("\n  bot-app-identities:", 1)[0]
        for block, install in ((suites, "Install browser-test dependencies"),
                               (chromium, "Install Chromium automation")):
            with self.subTest(install=install):
                self.assertIn("packages.microsoft.com/ubuntu/26.04/prod", block)
                self.assertIn('sudo mv -- "$source" "$source.disabled"', block)
                self.assertLess(block.index("Ignore unavailable optional Microsoft feed"),
                                block.index(install))
                self.assertIn("playwright install --with-deps chromium", block)
        self.assertIn("if: steps.browser.outputs.required == 'true'\n        run: |", suites)

    def test_codex_browser_follows_playwright_managed_revision(self):
        source = (ROOT / "tests/browser/codex_webview/browser.py").read_text(encoding="utf-8")
        self.assertIn('custom_browser = os.environ.get("CODEX_TEST_CHROMIUM")', source)
        self.assertIn("executable_path=custom_browser or None", source)
        self.assertNotIn("shutil.which", source)

    def test_commit_button_scenarios_use_real_chromium(self):
        source = (ROOT / "tests/commits/button-browser.js").read_text(encoding="utf-8")
        self.assertIn("require('playwright')", source)
        self.assertIn("await chromium.launch(", source)
        self.assertIn("await browser.newPage()", source)
        self.assertIn("await page.mouse.down()", source)
        self.assertIn("await page.keyboard.press('Enter')", source)
        self.assertIn("getComputedStyle(", source)


if __name__ == "__main__":
    unittest.main()
