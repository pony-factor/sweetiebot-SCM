
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

import re
import json
import io
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import configurator
import install
import branch_names
import toolkit_settings
from pathlib import Path



# Allow direct script execution as well as the CI unittest module runner.
_sb_root = str(_sb_path(__file__).resolve().parents[2])
if _sb_root not in _sb_sys.path:
    _sb_sys.path.insert(0, _sb_root)

from tests.fixtures.configurator_support import form_values


class GitConfigTests(unittest.TestCase):
    @patch("toolkit_settings.read_git_bool")
    @patch("toolkit_settings.read_git_string")
    def test_access_visibility_uses_composer_layout(self, read_string, read_bool):
        legacy_key = "sweetiebot.codex-hide-permissions-icon"
        read_bool.side_effect = lambda key, default: key == legacy_key or default
        read_string.side_effect = lambda key, default, preserve_empty=False: default

        default_layout = json.loads(toolkit_settings.load_settings()["codexComposerLayout"])
        self.assertIn("access", default_layout["left"])

        default_layout["left"].remove("access")
        default_layout["hidden"].append("access")
        saved_layout = json.dumps(default_layout)
        read_string.side_effect = lambda key, default, preserve_empty=False: (
            saved_layout if key == "sweetiebot.codex-composer-layout" else default
        )

        settings = toolkit_settings.load_settings()
        self.assertEqual(settings["codexComposerLayout"], saved_layout)
        self.assertNotIn(legacy_key, [call.args[0] for call in read_bool.call_args_list])

    @patch("toolkit_settings.read_git_bool")
    @patch("toolkit_settings.read_git_string")
    def test_disabled_staged_whitespace_setting_loads(self, read_string, read_bool):
        read_string.side_effect = lambda key, default, preserve_empty=False: default
        read_bool.side_effect = lambda key, default: (
            False if key == "sweetiebot.normalize-staged-whitespace" else default
        )
        settings = toolkit_settings.load_settings()
        self.assertFalse(settings["normalizeStagedWhitespace"])


    @patch("toolkit_settings.subprocess.run")
    def test_global_git_settings_use_stable_directory(self, run):
        run.side_effect = lambda args, **kwargs: SimpleNamespace(
            returncode=1 if "--get" in args else 0, stdout="", stderr=""
        )

        self.assertTrue(toolkit_settings.read_git_bool("sweetiebot.branch-picker", True))
        self.assertEqual(toolkit_settings.read_git_string("sweetiebot.remote", "origin"), "origin")
        toolkit_settings.persist_message_bar_layout({"messageBarLayout": '{"before":[],"after":[]}'})
        self.assertEqual(run.call_count, 7)
        self.assertTrue(all(call.kwargs.get("cwd") == Path.home() for call in run.call_args_list))

    @patch("toolkit_settings.read_git_bool")
    @patch("toolkit_settings.read_git_string")
    def test_disabled_pack_setting_can_be_explicitly_empty(self, read_string, read_bool):
        read_bool.side_effect = lambda _key, default: default

        def read_value(key, default, preserve_empty=False):
            if key == "sweetiebot.branch-name-disabled-packs":
                self.assertTrue(preserve_empty)
                return ""
            return default

        read_string.side_effect = read_value

        settings = toolkit_settings.load_settings()

        self.assertEqual(settings["branchNameDisabledPacks"], "")

    @patch("toolkit_settings.read_git_bool")
    @patch("toolkit_settings.read_git_string")
    def test_legacy_short_placeholder_false_restores_native_placeholder(self, read_string, read_bool):
        read_string.side_effect = lambda key, default, preserve_empty=False: (
            None if key == "sweetiebot.message-placeholder" else default
        )
        read_bool.side_effect = lambda key, default: (
            False if key == "sweetiebot.short-placeholder" else default
        )

        settings = toolkit_settings.load_settings()

        self.assertEqual(settings["messagePlaceholder"], "")

    @patch("toolkit_settings.read_git_bool")
    @patch("toolkit_settings.read_git_string")
    def test_new_message_placeholder_overrides_legacy_toggle(self, read_string, read_bool):
        read_string.side_effect = lambda key, default, preserve_empty=False: (
            "Commit here" if key == "sweetiebot.message-placeholder" else default
        )
        read_bool.return_value = False

        settings = toolkit_settings.load_settings()

        self.assertEqual(settings["messagePlaceholder"], "Commit here")
        self.assertFalse(any(
            call.args[0] == "sweetiebot.short-placeholder"
            for call in read_bool.call_args_list
        ))

    @patch("configurator.shutil.which", return_value="/usr/bin/git")
    @patch("configurator.subprocess.run")
    def test_saves_every_supported_setting(self, run, _which):
        run.side_effect = lambda args, **_kwargs: SimpleNamespace(
            returncode=1 if "--get" in args else 0,
            stdout="",
            stderr="",
        )

        configurator.save_settings(configurator.parse_submission(form_values()))

        writes = [call.args[0] for call in run.call_args_list if "--replace-all" in call.args[0]]
        self.assertEqual(len(writes), len(configurator.SETTINGS))
        self.assertTrue(all(call.kwargs.get('cwd') == Path.home() for call in run.call_args_list))
        self.assertIn(
            [
                "/usr/bin/git",
                "config",
                "--global",
                "--replace-all",
                "sweetiebot.ai-commit-model",
                "qwen2.5-coder:7b",
            ],
            writes,
        )


class ManualRebuildTests(unittest.TestCase):
    def test_rebuild_invokes_explicit_installer(self):
        with patch("configurator.subprocess.run") as run:
            run.return_value = SimpleNamespace(returncode=0, stdout="Installed", stderr="")
            message = configurator._manual_rebuild()
        args = run.call_args.args[0]
        self.assertEqual(args[0], configurator.sys.executable)
        self.assertEqual(args[-1], "--install")
        self.assertTrue(str(args[1]).endswith("/repair.py"))
        self.assertEqual(run.call_args.kwargs["cwd"], Path.home())
        self.assertIn("Reload Window", message["message"])
        self.assertFalse(message["restartRequired"])

    def test_rebuild_preserves_browser_restart_requirement(self):
        with patch("configurator.subprocess.run", return_value=SimpleNamespace(
            returncode=0, stdout="Installed\nBrowser session changes require a full VS Code quit and restart after installation; Reload Window is not sufficient.\n", stderr="",
        )):
            result = configurator._manual_rebuild()
        self.assertTrue(result["restartRequired"])
        self.assertIn("Fully quit VS Code", result["message"])

    def test_rebuild_reports_installer_failure(self):
        with patch("configurator.subprocess.run", return_value=SimpleNamespace(
            returncode=1, stdout="Oops", stderr="Repair failed",
        )):
            with self.assertRaisesRegex(RuntimeError, "Installer exited with status 1"):
                configurator._manual_rebuild()

if __name__ == "__main__":
    unittest.main()
