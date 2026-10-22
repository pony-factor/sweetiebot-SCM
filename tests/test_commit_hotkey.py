"""Regression tests for the inline Commit shortcut editor."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from commit_hotkey import read_commit_hotkey, update_commit_hotkey, _entries, CODEX_COMMAND
import configurator
from toolkit_settings import DEFAULT_SETTINGS


class CommitHotkeyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "User" / "keybindings.json"

    def test_unbound_by_default_and_reset_does_not_create_file(self):
        self.assertEqual(read_commit_hotkey(self.path), "")
        self.assertEqual(update_commit_hotkey(self.path, ""), "")
        self.assertFalse(self.path.exists())

    def test_record_replace_and_reset_preserve_other_keys_and_comments(self):
        original = """[
  // Keep this user-defined shortcut.
  {"key": "ctrl+k", "command": "workbench.action.files.save"}, // note
  {"key": "f7", "command": "sweetiebot.commit",},
]
"""
        self.path.parent.mkdir(parents=True)
        self.path.write_text(original)
        update_commit_hotkey(self.path, "cmd+shift+p")
        self.assertEqual(read_commit_hotkey(self.path), "cmd+shift+p")
        updated = self.path.read_text()
        self.assertIn("// Keep this user-defined shortcut.", updated)
        self.assertIn('// note', updated)
        self.assertIn('{"key": "ctrl+k", "command": "workbench.action.files.save"}', updated)
        self.assertNotIn('"f7"', updated)
        self.assertEqual(sum(x.get("command") == "sweetiebot.commit" for x in _entries(updated)[1]), 1)
        update_commit_hotkey(self.path, "")
        self.assertEqual(read_commit_hotkey(self.path), "")
        self.assertIn("// Keep this user-defined shortcut.", self.path.read_text())
        self.assertIn('"workbench.action.files.save"', self.path.read_text())
        self.assertTrue(_entries(self.path.read_text())[1])

    def test_record_from_missing_file_and_reset(self):
        update_commit_hotkey(self.path, "f6")
        self.assertEqual(read_commit_hotkey(self.path), "f6")
        update_commit_hotkey(self.path, "")
        self.assertEqual(read_commit_hotkey(self.path), "")
        self.assertEqual(_entries(self.path.read_text())[1], [])

    def test_existing_binding_is_idempotent(self):
        self.path.parent.mkdir(parents=True)
        original = '[{"key":"f12","command":"sweetiebot.commit"}]\n'
        self.path.write_text(original)
        update_commit_hotkey(self.path, "f12")
        self.assertEqual(self.path.read_text(), original)

    def test_conflict_does_not_replace_existing_command(self):
        self.path.parent.mkdir(parents=True)
        original = '[{"key":"f6","command":"workbench.action.focusNextPart"}]\n'
        self.path.write_text(original)
        with self.assertRaisesRegex(ValueError, "already used"):
            update_commit_hotkey(self.path, "F6")
        self.assertEqual(self.path.read_text(), original)

    def test_invalid_keystrokes_and_json_are_not_overwritten(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text('[{"key":"f6","command":"other"}]\n')
        for key in ["ctrl+ctrl+x", "cmd+💖", "ctrl+shift+", "f999"]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                update_commit_hotkey(self.path, key)
        self.path.write_text("[{ bad JSON }\n")
        with self.assertRaisesRegex(ValueError, "Invalid keybindings.json"):
            update_commit_hotkey(self.path, "f7")
        self.assertEqual(self.path.read_text(), "[{ bad JSON }\n")

    def test_avoid_symlinked_keybindings(self):
        target = Path(self.temp.name) / "actual.json"
        target.write_text("[]")
        self.path.parent.mkdir(parents=True)
        self.path.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "symlinked"):
            update_commit_hotkey(self.path, "f6")
        self.assertEqual(target.read_text(), "[]")

    def test_multiple_old_bindings_removed(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text('[{"key":"f1","command":"sweetiebot.commit"},'
                             '{"key":"f2","command":"sweetiebot.commit"},'
                             '{"key":"f3","command":"other"}]\n')
        update_commit_hotkey(self.path, "f8")
        bindings = _entries(self.path.read_text())[1]
        self.assertEqual(len(bindings), 2)
        self.assertEqual(next(x["key"] for x in bindings if x["command"] == "sweetiebot.commit"), "f8")


    def test_codex_coauthor_and_regular_shortcuts_are_independent(self):
        self.assertEqual(read_commit_hotkey(self.path, CODEX_COMMAND), "")
        update_commit_hotkey(self.path, "cmd+shift+c", CODEX_COMMAND)
        update_commit_hotkey(self.path, "cmd+enter")
        self.assertEqual(read_commit_hotkey(self.path), "cmd+enter")
        self.assertEqual(read_commit_hotkey(self.path, CODEX_COMMAND), "cmd+shift+c")
        update_commit_hotkey(self.path, "", CODEX_COMMAND)
        self.assertEqual(read_commit_hotkey(self.path), "cmd+enter")
        self.assertEqual(read_commit_hotkey(self.path, CODEX_COMMAND), "")
        self.assertEqual(
            [entry["command"] for entry in _entries(self.path.read_text())[1]],
            ["sweetiebot.commit"],
        )

    def test_codex_hotkey_preserves_comments_and_other_commands(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text(
            '[\n  // Personal shortcut\n'
            '  {"key":"f7","command":"workbench.action.files.save"},\n'
            '  {"key":"f8","command":"sweetiebot.commit"},\n'
            '  {"key":"f9","command":"sweetiebot.commitWithCodex"}\n]\n'
        )
        update_commit_hotkey(self.path, "f10", CODEX_COMMAND)
        content = self.path.read_text()
        self.assertIn("// Personal shortcut", content)
        self.assertIn('"command":"workbench.action.files.save"', content)
        self.assertEqual(read_commit_hotkey(self.path), "f8")
        self.assertEqual(read_commit_hotkey(self.path, CODEX_COMMAND), "f10")
        self.assertNotIn('"f9"', content)

    def test_codex_hotkey_conflicts_and_unknown_commands_are_rejected(self):
        update_commit_hotkey(self.path, "cmd+k")
        original = self.path.read_text()
        with self.assertRaisesRegex(ValueError, "already used"):
            update_commit_hotkey(self.path, "cmd+k", CODEX_COMMAND)
        with self.assertRaisesRegex(ValueError, "Unsupported Sweetiebot commit command"):
            update_commit_hotkey(self.path, "f9", "workbench.action.files.save")
        self.assertEqual(self.path.read_text(), original)

    def test_page_has_inline_recorder_and_no_default(self):
        current = dict(DEFAULT_SETTINGS)
        page = configurator.render_form(current, [], "", "test", "Save", commit_hotkey="", codex_commit_hotkey="")
        self.assertIn('id="commit-hotkey-change"', page)
        self.assertIn('id="commit-hotkey-reset"', page)
        self.assertIn('id="codex-commit-hotkey-change"', page)
        self.assertIn('id="codex-commit-hotkey-reset"', page)
        self.assertIn("sweetiebot.commitWithCodex", page)
        self.assertIn('>Unbound</output>', page)
        self.assertIn("function captureCommitHotkey(event)", page)
        self.assertIn("'/commit-hotkey' + location.search", page)
        standalone = configurator.render_form(current, [], "", "test", "Save")
        self.assertIn('id="commit-hotkey-change" disabled', standalone)
        self.assertIn('id="codex-commit-hotkey-change" disabled', standalone)


if __name__ == "__main__":
    unittest.main()
