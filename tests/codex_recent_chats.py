import json
import subprocess
import unittest

import codex_recent_chats
import install


class RecentChatPatchTests(unittest.TestCase):
    def test_metadata_cannot_call_the_next_injected_payload(self):
        source = ('let n=[],e=[],c;c=(0,Mt.default)([...e,...n],kt)'
                  '.slice(0,Math.max(3,e.length));'
                  '/* header.recentTasks.seeAll defaultMessage: */')
        patched = codex_recent_chats.transform(source)
        subprocess.run(['node', '-e', patched + '\n(()=>{})();'], check=True, capture_output=True)

    def test_legacy_executable_metadata_is_migrated_and_removable(self):
        original = 'c=(0,Mt.default)([...e,...n],kt).slice(0,Math.max(3,e.length))'
        source = original + ';/* header.recentTasks.seeAll defaultMessage: */'
        legacy = source.replace(original, 'c=n.slice(0,7)') + codex_recent_chats.START
        legacy += json.dumps([original, 'c=n.slice(0,7)']) + codex_recent_chats.END
        self.assertEqual(codex_recent_chats.transform(legacy, remove=True), source)
        self.assertEqual(codex_recent_chats.transform(legacy), codex_recent_chats.transform(source))

    def test_preview_keeps_latest_seven_and_view_all(self):
        source = ('let e=n.filter(At);c=(0,Mt.default)([...e,...n],kt)'
                  '.slice(0,Math.max(3,e.length));'
                  'id:`header.recentTasks.seeAll`,defaultMessage:`View all ({total})`')
        patched = codex_recent_chats.transform(source)
        self.assertIn('c=n.slice(0,7)', patched)
        self.assertIn('defaultMessage:`View all ({total})`', patched)
        self.assertTrue(install.codex_bundle_matches(source))
        self.assertEqual(codex_recent_chats.transform(patched), patched)
        self.assertEqual(codex_recent_chats.transform(patched, remove=True), source)

    def test_other_chunks_and_translation_dictionaries_are_unchanged(self):
        for source in ('other bundle', '"header.recentTasks.seeAll":"View all"'):
            self.assertEqual(codex_recent_chats.transform(source), source)

    def test_unknown_preview_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Unsupported Codex build'):
            codex_recent_chats.transform('header.recentTasks.seeAll defaultMessage: changed')
