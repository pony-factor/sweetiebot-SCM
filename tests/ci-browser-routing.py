"""Guard complete Chromium regression coverage after CI suite reorganization."""

import sys as _sb_sys
from pathlib import Path as _sb_path
for _sb_parent in _sb_path(__file__).resolve().parents:
    _sb_scripts = (_sb_parent if (_sb_parent / 'importaliases.py').is_file()
                   else _sb_parent / 'scripts')
    if (_sb_scripts / 'importaliases.py').is_file():
        if str(_sb_scripts) not in _sb_sys.path:
            _sb_sys.path.insert(0, str(_sb_scripts))
        import importaliases
        importaliases.install()
        break


import importlib.util
import json
import re
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts/ci/ci-test-runner.py"
SPEC = importlib.util.spec_from_file_location("sweetiebot_ci_test_runner", SCRIPT)
ci = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ci)


class BrowserRoutingTests(unittest.TestCase):
    def test_commit_button_browser_regression_has_one_owner(self):
        manifest = json.loads(ci.CONFIG.read_text(encoding="utf-8"))
        owners = [name for name, group in manifest["groups"].items()
                  if "commit-button-browser.js" in group["tests"]]
        self.assertEqual(owners, ["browser-ui"])
        self.assertFalse(ci.browser_needed(manifest["groups"]["commit"]))
        self.assertTrue(ci.browser_needed(manifest["groups"]["browser-ui"]))

    def test_browser_test_is_syntax_checked_and_executed(self):
        spec = {"label": "Browser and UI",
                "tests": ["commit-button-browser.js"], "syntax": []}
        with patch.object(ci, "execute", return_value=0) as execute:
            ci.run_group("browser-ui", spec)
        commands = [list(call.args[0]) for call in execute.call_args_list]
        self.assertIn(["node", "--check", "tests/commit-button-browser.js"], commands)
        self.assertIn(["node", "tests/commit-button-browser.js"], commands)

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
        source = (ROOT / "tests/codex-webview-browser.py").read_text(encoding="utf-8")
        self.assertIn('custom_browser = os.environ.get("CODEX_TEST_CHROMIUM")', source)
        self.assertIn("executable_path=custom_browser or None", source)
        self.assertNotIn("shutil.which", source)

    def test_commit_button_scenarios_use_real_chromium(self):
        source = (ROOT / "tests/commit-button-browser.js").read_text(encoding="utf-8")
        self.assertIn("require('playwright')", source)
        self.assertIn("await chromium.launch(", source)
        self.assertIn("await browser.newPage()", source)
        self.assertIn("await page.mouse.down()", source)
        self.assertIn("await page.keyboard.press('Enter')", source)
        self.assertIn("getComputedStyle(", source)


if __name__ == "__main__":
    unittest.main()
