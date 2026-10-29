import hashlib
from pathlib import Path
import unittest

import codex_cannon
import install


class CannonTest(unittest.TestCase):
    def test_source_is_pinned_and_git_hashes_are_checked(self):
        self.assertEqual(len(codex_cannon.REVISION), 40)
        self.assertEqual(len(codex_cannon.UPSTREAM), 3)
        data = b"example"
        oid = hashlib.sha1(b"blob 7\0example").hexdigest()
        self.assertTrue(codex_cannon.git_blob_matches(data, oid))
        self.assertFalse(codex_cannon.git_blob_matches(b"tampered", oid))

    def test_adaptation_supports_live_codex_without_chrome_apis(self):
        sample = "\n".join([
            "const context = globalThis.__ghrcExtensionContext;",
            "  const artworkURL = chrome.runtime.getURL('cannon.png');",
            r"const PREFIX = /^Worked\s+for\s+(.+)$/i;",
            'const root = document.querySelector("main");',
            r'      if (!/^\s*Worked\s+for\s+/i.test(node.nodeValue || "")) continue;',
            '      minutes: minuteCount ? ' + chr(96) + "$" + "{minuteCount}m" + chr(96) + ' : "",',
            "  const onSettingsChanged = (changes, areaName) => {",
            "    chrome.storage.get(changes);",
            "  };",
            "  const observer = new MutationObserver(scheduleScan);",
        ])
        compiled = codex_cannon.adapt(sample, "[data-ghrc-worked-duration]{opacity:1}", b"\x89PNG\r\n\x1a\nexample")
        self.assertIn("(?:Working|Worked|Thought)", compiled)
        self.assertIn("if (!/^\\s*(?:Working|Worked|Thought)", compiled)
        self.assertIn("minutes: " + chr(96) + "$" + "{minuteCount}m" + chr(96) + ",", compiled)
        self.assertIn("data:image/png;base64", compiled)
        self.assertIn("scmToolkitShowCannon = true", compiled)
        self.assertNotIn("chrome.storage", compiled)
        self.assertNotIn("chrome.runtime.getURL", compiled)
        self.assertIn("new MutationObserver(scheduleScan)", compiled)

    def test_cannon_works_with_timestamps_and_removes_cleanly(self):
        # The chosen cannon is bundled locally in the rate-limit payload.
        # Exercise that path rather than the retired pinned-upstream argument.
        original = 'const modernStatus = "You’re out of Codex messages";'
        installed = install.transform_codex(
            original, cannon_enabled=True, hide_timestamps=True)
        self.assertEqual(installed.count(install.CODEX_LIMIT_START), 1)
        self.assertEqual(installed.count(install.CODEX_TIMESTAMPS_START), 1)
        self.assertEqual(installed.count('globalThis.scmToolkitActivityCannonEnabled=true;'), 1)
        self.assertEqual(installed.count('function scmToolkitActivityMinutes'), 1)
        self.assertNotIn('CODEX_CANNON_START', installed)
        self.assertIn("data:image/png;base64,", installed)
        self.assertNotIn("__SCM_TOOLKIT_ACTIVITY_CANNON__", installed)
        self.assertEqual(
            install.transform_codex(installed, cannon_enabled=True, hide_timestamps=True),
            installed, "Reinstalling must not duplicate the cannon")
        disabled = install.transform_codex(
            installed, cannon_enabled=False, hide_timestamps=True)
        self.assertNotIn('globalThis.scmToolkitActivityCannonEnabled=true;', disabled)
        self.assertNotIn('function scmToolkitActivityMinutes', disabled)
        self.assertIn(install.CODEX_TIMESTAMPS_START, disabled)
        self.assertEqual(install.transform_codex(disabled, remove=True), original)
        self.assertEqual(install.transform_codex(installed, remove=True), original)
        with self.assertRaises(ValueError):
            install.transform_codex(original + install.CODEX_LIMIT_START, cannon_enabled=True)

    def test_timestamp_hiding_yields_activity_label_to_cannon(self):
        content = (Path(__file__).resolve().parent.parent / "assets/codex/hide-chat-timestamps.js").read_text()
        self.assertIn("!globalThis.scmToolkitShowCannon && activityLeadPattern.test", content)


if __name__ == "__main__":
    unittest.main()
