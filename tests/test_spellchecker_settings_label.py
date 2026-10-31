"""Regression coverage for the renamed Spellchecker settings tab."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import configurator
import toolkit_settings


class SpellcheckerSettingsLabelTests(unittest.TestCase):
    def test_spellchecking_controls_share_spellchecker_section(self):
        names = {
            "spellcheckManualCommit",
            "draftSpellcheckAction",
            "draftSpellcheckDelaySeconds",
            "spellcheckModel",
            "spellcheckThinkingEffort",
            "postCommitSpellcheck",
            "spellcheckPreserveLineBreaks",
            "spellcheckInstructions",
        }
        controls = [setting for setting in configurator.SETTINGS if setting.name in names]
        self.assertEqual({setting.name for setting in controls}, names)
        self.assertEqual({setting.section for setting in controls}, {"Spellchecker"})
        self.assertNotIn("Spellcheck Changes", {setting.section for setting in configurator.SETTINGS})

    def test_rendered_settings_tab_and_groups_use_new_label(self):
        page = configurator.render_form(
            dict(toolkit_settings.DEFAULT_SETTINGS),
            [],
            "Ollama status",
            "test-token",
            "Save",
        )
        self.assertIn(">Spellchecker</button>", page)
        self.assertIn("<h2>Spellchecker</h2>", page)
        self.assertIn("<h3>While drafting a commit</h3>", page)
        self.assertIn("<h3>After committing</h3>", page)
        self.assertIn("Ollama status", page)
        self.assertNotIn(">Spellcheck Changes</button>", page)


if __name__ == "__main__":
    unittest.main()
