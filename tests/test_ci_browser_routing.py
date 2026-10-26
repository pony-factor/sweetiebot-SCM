"""Guard complete Chromium regression coverage after CI suite reorganization."""

import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts/ci/ci_test_runner.py"
SPEC = importlib.util.spec_from_file_location("sweetiebot_ci_test_runner", SCRIPT)
ci = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ci)


class BrowserRoutingTests(unittest.TestCase):
    def test_commit_button_browser_regression_has_one_owner(self):
        manifest = json.loads(ci.CONFIG.read_text(encoding="utf-8"))
        owners = [name for name, group in manifest["groups"].items()
                  if "test_commit_button_browser.js" in group["tests"]]
        self.assertEqual(owners, ["browser-ui"])
        self.assertFalse(ci.browser_needed(manifest["groups"]["commit"]))
        self.assertTrue(ci.browser_needed(manifest["groups"]["browser-ui"]))

    def test_browser_test_is_syntax_checked_and_executed(self):
        spec = {"label": "Browser and UI",
                "tests": ["test_commit_button_browser.js"], "syntax": []}
        with patch.object(ci, "execute", return_value=0) as execute:
            ci.run_group("browser-ui", spec)
        commands = [list(call.args[0]) for call in execute.call_args_list]
        self.assertIn(["node", "--check", "tests/test_commit_button_browser.js"], commands)
        self.assertIn(["node", "tests/test_commit_button_browser.js"], commands)

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
            test_path = tests / "test_browser_fixture.js"
            with patch.object(ci, "ROOT", root):
                for code, expected in samples:
                    with self.subTest(code=code):
                        test_path.write_text(code, encoding="utf-8")
                        self.assertEqual(
                            bool(ci.browser_needed({"tests": [test_path.name]})), expected)

    def test_commit_button_scenarios_use_real_chromium(self):
        source = (ROOT / "tests/test_commit_button_browser.js").read_text(encoding="utf-8")
        self.assertIn("require('playwright')", source)
        self.assertIn("await chromium.launch(", source)
        self.assertIn("await browser.newPage()", source)
        self.assertIn("await page.mouse.down()", source)
        self.assertIn("await page.keyboard.press('Enter')", source)
        self.assertIn("getComputedStyle(", source)


if __name__ == "__main__":
    unittest.main()
