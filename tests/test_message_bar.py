import json
import os
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import toolkit_settings

from message_bar import (
    DEFAULT_MESSAGE_BAR_LAYOUT,
    MESSAGE_BAR_ITEM_IDS,
    parse_message_bar_layout,
    serialize_message_bar_layout,
)
from message_bar_configurator import render_message_bar_control


class MessageBarLayoutTests(unittest.TestCase):
    def test_default_layout_contains_every_control_once(self):
        items = DEFAULT_MESSAGE_BAR_LAYOUT["before"] + DEFAULT_MESSAGE_BAR_LAYOUT["after"]
        self.assertEqual(len(items), 11)
        self.assertEqual(set(items), set(MESSAGE_BAR_ITEM_IDS))
        self.assertEqual(len(items), len(set(items)))
        self.assertEqual(DEFAULT_MESSAGE_BAR_LAYOUT["before"], ["branch", "codex"])

    def test_saved_order_and_button_preferences_survive_default_changes(self):
        saved = json.dumps({"before": ["home", "separator-37", "branch"], "after": ["codex"]})
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {
            "GIT_CONFIG_GLOBAL": root + "/preferences", "GIT_CONFIG_NOSYSTEM": "1",
        }):
            subprocess.run(["git", "config", "--global", "scm-toolkit.message-bar-layout", saved], check=True)
            subprocess.run(["git", "config", "--global", "scm-toolkit.codex-coauthor", "false"], check=True)
            toolkit_settings.persist_message_bar_layout(toolkit_settings.DEFAULT_SETTINGS)
            current = toolkit_settings.load_settings()
            self.assertEqual(json.loads(current["messageBarLayout"]), {
                "before": ["home", "separator-37", "branch"], "after": [],
            })
            self.assertFalse(current["codexCoauthor"])
            control = render_message_bar_control(current["messageBarLayout"])
            self.assertIn('data-message-bar-id="separator-37"', control)
            self.assertEqual(control.count('data-message-bar-id="codex"'), 1)

    def test_initial_layout_is_pinned_for_later_updates(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {
            "GIT_CONFIG_GLOBAL": root + "/preferences", "GIT_CONFIG_NOSYSTEM": "1",
        }):
            initial = toolkit_settings.load_settings()
            toolkit_settings.persist_message_bar_layout(initial)
            with patch.dict(toolkit_settings.DEFAULT_SETTINGS, {"messageBarLayout": '{"before":[],"after":[]}'}):
                self.assertEqual(toolkit_settings.load_settings()["messageBarLayout"], initial["messageBarLayout"])

    def test_layout_can_reorder_and_hide_controls(self):
        raw = json.dumps({
            "before": ["home", "separator-2", "branch"],
            "after": ["pull-request", "pony-branch"],
        })
        expected = {
            "before": ["home", "separator-2", "branch"],
            "after": ["pull-request", "pony-branch"],
        }
        self.assertEqual(parse_message_bar_layout(raw), expected)
        self.assertEqual(json.loads(serialize_message_bar_layout(raw)), expected)

    def test_layout_rejects_unknown_and_duplicate_controls(self):
        with self.assertRaisesRegex(ValueError, "Unknown message bar control"):
            parse_message_bar_layout('{"before":["not-a-control"],"after":[]}')
        with self.assertRaisesRegex(ValueError, "appears more than once"):
            parse_message_bar_layout('{"before":["home"],"after":["home"]}')

    def test_configurator_renders_three_drop_zones_and_all_controls(self):
        control = render_message_bar_control(
            '{"before":["home"],"after":["pull-request"]}'
        )
        self.assertEqual(control.count('data-message-bar-zone='), 3)
        self.assertEqual(control.count('data-message-bar-id='), 11)
        self.assertIn('data-message-bar-zone="hidden"', control)
        self.assertIn('id="message-bar-reset"', control)
        self.assertIn('name="messageBarLayout"', control)

    def test_placeholder_is_editable_in_the_preview_and_escaped(self):
        control = render_message_bar_control(json.dumps(DEFAULT_MESSAGE_BAR_LAYOUT), 'Say "hello" <here>')
        self.assertIn('name="messagePlaceholder"', control)
        self.assertIn('value="Say &quot;hello&quot; &lt;here&gt;"', control)
        self.assertIn('title="Click to edit the message placeholder"', control)
        empty = render_message_bar_control(json.dumps(DEFAULT_MESSAGE_BAR_LAYOUT), "")
        self.assertIn('value="" aria-label="Message placeholder"', empty)


if __name__ == "__main__":
    unittest.main()
