"""The fast default and optional detailed style preserve existing commit rules."""

import sys as _sb_sys
from pathlib import Path as _sb_path
for _sb_parent in _sb_path(__file__).resolve().parents:
    _sb_scripts = _sb_parent / 'scripts'
    if (_sb_scripts / 'importaliases.py').is_file():
        if str(_sb_scripts) not in _sb_sys.path:
            _sb_sys.path.insert(0, str(_sb_scripts))
        import importaliases
        importaliases.install()
        break

import unittest
from unittest.mock import patch
import ai_commit
from toolkit_settings import DEFAULT_SETTINGS, SETTING_KEYS

class CommitModeSettingTests(unittest.TestCase):
    def test_durable_mode_is_opt_in(self):
        self.assertFalse(DEFAULT_SETTINGS["durableBackgroundCommits"])
        self.assertEqual(SETTING_KEYS["durableBackgroundCommits"],
                         "scm-toolkit.durable-background-commits")
    def test_custom_instructions_still_apply(self):
        self.assertTrue(DEFAULT_SETTINGS["aiEmojiPriorityRules"])
        self.assertTrue(DEFAULT_SETTINGS["aiCommit"])
    def test_topic_branch_has_no_description_by_default(self):
        with patch.object(ai_commit, "git_config_bool", return_value=False), \
             patch.object(ai_commit, "default_branch_description_enabled", return_value=True), \
             patch.object(ai_commit, "current_branch", return_value="topic"), \
             patch.object(ai_commit, "configured_default_branch", return_value="main"):
            self.assertFalse(ai_commit.should_add_default_branch_description())
    def test_detailed_style_enables_topic_description(self):
        with patch.object(ai_commit, "git_config_bool", return_value=True), \
             patch.object(ai_commit, "current_branch", return_value="topic"):
            self.assertTrue(ai_commit.should_add_default_branch_description())
