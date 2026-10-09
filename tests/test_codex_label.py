import json
from pathlib import Path
import tempfile
import unittest

import codex_label


def example_manifest():
    return json.dumps({
        "publisher": "OpenAI", "name": "chatgpt",
        "displayName": "Codex - OpenAI's coding agent",
        "contributes": {
            "viewsContainers": {
                "activitybar": [{"id": "codexViewContainer", "title": "Codex",
                                 "icon": "resources/blossom-white.svg", "when": "enabled"}],
                "secondarySidebar": [{"id": "codexSecondaryViewContainer",
                                      "title": "Codex", "icon": "resources/blossom-white.svg"}],
                "panel": [{"id": "unrelated", "title": "Other"}],
            },
            "views": {
                "codexViewContainer": [{"id": "chatgpt.sidebarView", "type": "webview", "name": "Codex"}],
                "codexSecondaryViewContainer": [{"id": "chatgpt.sidebarView",
                                                 "type": "webview", "name": "Codex"}],
                "unrelated": [{"id": "other", "name": "Other"}],
            },
        },
    }, indent=2) + "\n"


class CodexWindowLabelTests(unittest.TestCase):
    def test_original_label_is_a_no_op_by_default(self):
        original = example_manifest()
        self.assertEqual(codex_label.transform(original), original)

    def test_custom_label_changes_both_sidebar_locations_and_views(self):
        result = json.loads(codex_label.transform(example_manifest(), "CelestAI"))
        containers = result["contributes"]["viewsContainers"]
        self.assertEqual(containers["activitybar"][0]["title"], "CelestAI")
        self.assertEqual(containers["secondarySidebar"][0]["title"], "CelestAI")
        self.assertEqual(containers["panel"][0]["title"], "Other")
        self.assertEqual(result["contributes"]["views"]["codexViewContainer"][0]["name"], "CelestAI")
        self.assertEqual(result["contributes"]["views"]["codexSecondaryViewContainer"][0]["name"], "CelestAI")
        self.assertEqual(result["displayName"], "Codex - OpenAI's coding agent")
        self.assertEqual(result["contributes"]["views"]["unrelated"][0]["name"], "Other")

    def test_idempotent_relabel_and_restore(self):
        original = example_manifest()
        changed = codex_label.transform(original, "CelestAI")
        self.assertEqual(codex_label.transform(changed, "CelestAI"), changed)
        updated = codex_label.transform(changed, "Luna")
        self.assertEqual(json.loads(codex_label.transform(updated, "Codex")), json.loads(original))
        self.assertEqual(json.loads(codex_label.transform(changed, remove=True)), json.loads(original))

    def test_rejects_changed_labels_and_invalid_input(self):
        changed = codex_label.transform(example_manifest(), "CelestAI")
        altered = changed.replace('"title": "CelestAI"', '"title": "Unexpected"', 1)
        with self.assertRaisesRegex(ValueError, "outside Sweetie Bot"):
            codex_label.transform(altered, "Luna")
        for value in ("", "text\nlabel", "x" * 81):
            with self.subTest(value=value), self.assertRaises(ValueError):
                codex_label.transform(example_manifest(), value)
        with self.assertRaisesRegex(ValueError, "Not an OpenAI"):
            codex_label.transform('{"publisher":"Other","name":"chatgpt"}', "CelestAI")

    def test_missing_view_entries_are_not_replaced_with_guesses(self):
        data = json.loads(example_manifest())
        data["contributes"] = {}
        with self.assertRaisesRegex(ValueError, "sidebar label entries"):
            codex_label.transform(json.dumps(data), "CelestAI")

    def test_patch_file_selects_explicit_extension(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "package.json"
            original = example_manifest()
            manifest.write_text(original)
            path, previous, new = codex_label.patch_file(directory, "CelestAI")
            self.assertEqual(path, manifest)
            self.assertEqual(previous, original)
            self.assertEqual(json.loads(new)["contributes"]["viewsContainers"]["activitybar"][0]["title"],
                             "CelestAI")


if __name__ == "__main__":
    unittest.main()
