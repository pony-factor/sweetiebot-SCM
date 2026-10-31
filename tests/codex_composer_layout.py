"""Composer customizer persistence, reversibility and native-control safety."""
import json
import unittest

import codex_composer
import codex_composer_layout as layout


class ComposerLayoutTests(unittest.TestCase):
    def test_defaults_include_input_and_native_actions(self):
        actual = layout.parse_layout(layout.DEFAULT_LAYOUT_JSON)
        self.assertEqual(actual["visible"], list(layout.IDS))
        self.assertEqual(actual["hidden"], [])

    def test_reordering_and_hiding_survive_serialization(self):
        value = {"visible": ["send", "clipboard", "input", "attachments"],
                 "hidden": ["access", "location"]}
        self.assertEqual(layout.parse_layout(layout.serialize_layout(value)), value)
        page = layout.render_control(layout.serialize_layout(value))
        self.assertIn('name="codexComposerLayout"', page)
        self.assertIn("Available controls", page)
        self.assertLess(page.index("Send / Stop (wing)"), page.index("Clipboard Send / Queue"))
        self.assertIn("Access permissions", page)
        self.assertIn("Attachments", page)
        self.assertNotIn("Attachments / usage", page)
        self.assertIn("Computer / location / usage", page)

    def test_missing_duplicate_unknown_and_hidden_input_are_rejected(self):
        base = layout.parse_layout(layout.DEFAULT_LAYOUT_JSON)
        values = [
            "not JSON",
            [],
            {"visible": ["input"], "hidden": []},
            {"visible": list(layout.IDS) + ["input"], "hidden": []},
            {"visible": list(layout.IDS[:-1]) + ["unknown"], "hidden": []},
            {"visible": ["attachments", "access"], "hidden": ["input", "location", "clipboard", "send"]},
        ]
        for value in values:
            with self.subTest(value=value), self.assertRaises(ValueError):
                layout.serialize_layout(value)

    def test_optional_composer_patch_is_idempotent_and_reversible(self):
        native = '/* composer.placeholder.localFollowUp.locally */\nbase;'
        custom = json.dumps({"visible": ["input", "clipboard", "send"],
                             "hidden": ["attachments", "access", "location"]})
        patched = codex_composer.transform_layout(native, inline=False, composer_layout=custom)
        self.assertIn(codex_composer.CUSTOM_START, patched)
        self.assertIn('"hidden": ["attachments", "access", "location"]', patched)
        self.assertNotIn("__SCM_TOOLKIT_COMPOSER_LAYOUT__", patched)
        self.assertEqual(codex_composer.transform_layout(patched, inline=False, composer_layout=custom), patched)
        self.assertEqual(codex_composer.transform_layout(patched, inline=False), native)
        with self.assertRaisesRegex(ValueError, "composer layout"):
            codex_composer.transform_layout(native + codex_composer.CUSTOM_START,
                                            inline=False, composer_layout=custom)

    def test_input_always_remains_in_composer_preview(self):
        page = layout.render_control(layout.DEFAULT_LAYOUT_JSON)
        self.assertIn("Message input (required)", page)
        self.assertIn('data-codex-layout-zone="hidden"', page)
        self.assertIn('data-codex-layout-zone="visible"', page)
        self.assertIn("dragstart", layout.CONFIG_SCRIPT)
        self.assertIn("ArrowLeft", layout.CONFIG_SCRIPT)


if __name__ == "__main__":
    unittest.main()
