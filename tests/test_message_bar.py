import json
import unittest

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


if __name__ == "__main__":
    unittest.main()
