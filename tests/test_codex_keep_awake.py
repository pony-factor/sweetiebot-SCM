import unittest
import codex_keep_awake
import codex_context


class KeepAwakePatchTests(unittest.TestCase):
    SOURCE = 'e.push(v.window.registerUriHandler(uri));e.push(c.registerInternalNotificationHandler(n=>{n.method==="turn/completed"&&cache.invalidateGitReadCachesForTurn(c.takeCompletedTurnCwds(n.params),id)}));'

    def test_reinstall_and_uninstall_preserve_original(self):
        patched = codex_keep_awake.transform(self.SOURCE)
        self.assertIn('scmToolkitRegisterCodexKeepAwake(c,v,true)', patched)
        self.assertEqual(codex_keep_awake.transform(patched), patched)
        self.assertEqual(codex_keep_awake.transform(patched, remove=True), self.SOURCE)
        disabled = codex_keep_awake.transform(patched, enabled=False)
        self.assertIn('scmToolkitRegisterCodexKeepAwake(c,v,false)', disabled)
        self.assertEqual(codex_keep_awake.transform(disabled, remove=True), self.SOURCE)

    def test_unsupported_or_modified_host_is_not_overwritten(self):
        for source in ['', self.SOURCE + self.SOURCE]:
            with self.assertRaisesRegex(ValueError, 'Unsupported Codex build'):
                codex_keep_awake.transform(source)
        patched = codex_keep_awake.transform(self.SOURCE)
        with self.assertRaisesRegex(ValueError, 'patch changed'):
            codex_keep_awake.transform(patched.replace('KeepAwake(c,v,true)', 'KeepAwake(c,v,false)', 1))
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            codex_keep_awake.transform(self.SOURCE + codex_keep_awake.START)

    def test_context_patch_can_be_updated_and_removed_independently(self):
        source = self.SOURCE + 's.push(v.window.registerWebviewViewProvider(View.viewType,provider,{}));'
        context = codex_context.transform(source, 'host')
        awake = codex_keep_awake.transform(context)
        self.assertEqual(codex_keep_awake.transform(codex_context.transform(awake, 'host')), awake)
        awake_only = codex_context.transform(awake, 'host', False)
        self.assertEqual(codex_keep_awake.transform(awake_only, remove=True), source)
