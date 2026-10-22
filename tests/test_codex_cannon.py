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
            "  const onSettingsChanged = (changes, areaName) => {",
            "    chrome.storage.get(changes);",
            "  };",
            "  const observer = new MutationObserver(scheduleScan);",
        ])
        compiled = codex_cannon.adapt(sample, "[data-ghrc-worked-duration]{opacity:1}", b"\x89PNG\r\n\x1a\nexample")
        self.assertIn("(?:Working|Worked|Thought)", compiled)
        self.assertIn("data:image/png;base64", compiled)
        self.assertIn("scmToolkitShowCannon = true", compiled)
        self.assertNotIn("chrome.storage", compiled)
        self.assertNotIn("chrome.runtime.getURL", compiled)
        self.assertIn("new MutationObserver(scheduleScan)", compiled)

    def test_cannon_works_with_timestamps_and_removes_cleanly(self):
        original = 'const app="codex";'
        payload = "globalThis.scmToolkitShowCannon = true;"
        installed = install.transform_codex(original, cannon_payload=payload, hide_timestamps=True)
        self.assertIn(install.CODEX_CANNON_START, installed)
        self.assertIn(install.CODEX_TIMESTAMPS_START, installed)
        self.assertEqual(install.transform_codex(installed, cannon_payload=payload, hide_timestamps=True), installed)
        self.assertEqual(install.transform_codex(installed, remove=True), original)
        with self.assertRaises(ValueError):
            install.transform_codex(original + install.CODEX_CANNON_START, cannon_payload=payload)

    def test_timestamp_hiding_yields_activity_label_to_cannon(self):
        content = (Path(__file__).resolve().parent.parent / "assets/codex/hide-chat-timestamps.js").read_text()
        self.assertIn("!globalThis.scmToolkitShowCannon && activityLeadPattern.test", content)


if __name__ == "__main__":
    unittest.main()
