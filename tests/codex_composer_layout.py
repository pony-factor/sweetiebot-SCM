"""Composer customizer persistence, reversibility and native-control safety."""
import json
import unittest

import codex_composer
import codex_composer_layout as layout


class ComposerLayoutTests(unittest.TestCase):
    def test_defaults_include_input_and_native_actions(self):
        actual = layout.parse_layout(layout.DEFAULT_LAYOUT_JSON)
        self.assertEqual(actual["left"], list(layout.IDS[:-1]))
        self.assertEqual(actual["right"], ["send"])
        self.assertEqual(actual["hidden"], [])

    def test_reordering_and_hiding_survive_serialization(self):
        value = {"left": ["input", "clipboard", "access", "attachments"], "right": ["send"],
                 "hidden": ["location"]}
        self.assertEqual(layout.parse_layout(layout.serialize_layout(value)), value)
        page = layout.render_control(layout.serialize_layout(value))
        self.assertIn('name="codexComposerLayout"', page)
        self.assertIn("Hidden controls", page)
        self.assertIn("Left aligned", page)
        self.assertIn("Right aligned", page)
        self.assertIn("codex-layout-drop-marker", layout.CONFIG_SCRIPT)
        self.assertIn("Access permissions", page)
        self.assertIn("Attachments", page)
        self.assertNotIn("Attachments / usage", page)
        self.assertIn("Computer / location / usage", page)

    def test_missing_duplicate_unknown_and_hidden_input_are_rejected(self):
        base = layout.parse_layout(layout.DEFAULT_LAYOUT_JSON)
        values = [
            "not JSON",
            [],
            {"left": ["input"], "right": [], "hidden": []},
            {"left": list(layout.IDS), "right": ["send"], "hidden": []},
            {"left": list(layout.IDS[:-1]) + ["unknown"], "right": [], "hidden": []},
            {"left": ["attachments", "access"], "right": ["send", "input"], "hidden": ["location", "clipboard"]},
            {"visible": ["attachments", "access"], "hidden": ["input", "location", "clipboard", "send"]},
        ]
        for value in values:
            with self.subTest(value=value), self.assertRaises(ValueError):
                layout.serialize_layout(value)

    def test_optional_composer_patch_is_idempotent_and_reversible(self):
        native = '/* composer.placeholder.localFollowUp.locally */\nbase;'
        custom = json.dumps({"left": ["input", "clipboard", "access"], "right": ["send"],
                             "hidden": ["attachments", "location"]})
        patched = codex_composer.transform_layout(native, inline=False, composer_layout=custom)
        self.assertIn(codex_composer.CUSTOM_START, patched)
        self.assertIn('"hidden": ["attachments", "location"]', patched)
        self.assertNotIn("__SCM_TOOLKIT_COMPOSER_LAYOUT__", patched)
        self.assertEqual(codex_composer.transform_layout(patched, inline=False, composer_layout=custom), patched)
        self.assertEqual(codex_composer.transform_layout(patched, inline=False), native)
        with self.assertRaisesRegex(ValueError, "composer layout"):
            codex_composer.transform_layout(native + codex_composer.CUSTOM_START,
                                            inline=False, composer_layout=custom)

    def test_legacy_visible_hidden_layout_is_migrated_without_losing_controls(self):
        old = {"visible": ["clipboard", "input", "attachments", "send"],
               "hidden": ["location", "access"]}
        self.assertEqual(layout.parse_layout(old), {
            "left": ["input", "access", "clipboard", "attachments"],
            "right": ["send"], "hidden": ["location"]})

    def test_compact_icons_have_tooltips_and_no_text_labels(self):
        page = layout.render_control(layout.DEFAULT_LAYOUT_JSON)
        self.assertIn('title="Attachments"', page)
        self.assertIn('title="Send / Stop (wing)"', page)
        self.assertIn('data-codex-layout-toggle', page)
        self.assertIn('id="codex-layout-control-picker"', page)
        self.assertIn('id="codex-layout-position-picker"', page)
        self.assertIn('class="codex-layout-icon"', page)
        self.assertIn('aria-label="Message input (required)"', page)

    def test_hidden_access_is_restored_and_right_alignment_is_allowed(self):
        old = {"left": ["input", "attachments"], "right": ["send"],
               "hidden": ["access", "location", "clipboard"]}
        self.assertEqual(layout.parse_layout(old), {
            "left": ["input", "access", "attachments"], "right": ["send"],
            "hidden": ["location", "clipboard"]})
        right = {"left": ["input", "attachments"], "right": ["access", "send"],
                 "hidden": ["location", "clipboard"]}
        self.assertEqual(layout.parse_layout(right), right)

    def test_extra_composer_more_menu_is_removed(self):
        from pathlib import Path
        runtime = (Path(__file__).resolve().parents[1] /
                   "assets/codex/composer-layout.js").read_text()
        self.assertNotIn("scm-toolkit-composer-more", runtime)
        self.assertNotIn("mountMenu", runtime)
        self.assertIn('id !== "access"', runtime)
        self.assertIn('id !== "input"', runtime)

    def test_input_always_remains_in_composer_preview(self):
        page = layout.render_control(layout.DEFAULT_LAYOUT_JSON)
        self.assertIn("Message input (required)", page)
        self.assertIn("codex-layout-left", page)
        self.assertIn("codex-layout-right", page)
        self.assertIn('data-codex-layout-zone="hidden"', page)
        self.assertIn('data-codex-layout-zone="left"', page)
        self.assertIn('data-codex-layout-zone="right"', page)
        self.assertIn("dragstart", layout.CONFIG_SCRIPT)
        self.assertIn("ArrowLeft", layout.CONFIG_SCRIPT)
        self.assertIn("marker.parentElement", layout.CONFIG_SCRIPT)
        self.assertIn("updateActions", layout.CONFIG_SCRIPT)
        self.assertIn("updatePicker", layout.CONFIG_SCRIPT)
        self.assertIn("positionPicker.addEventListener", layout.CONFIG_SCRIPT)
        self.assertIn('item.dataset.codexLayoutId === "access"', layout.CONFIG_SCRIPT)


if __name__ == "__main__":
    unittest.main()
