import sys
from pathlib import Path
import unittest
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import codex_drafts


class DraftPatchTests(unittest.TestCase):
    HOST = 'subscriptions.push(vscode.window.registerWebviewViewProvider(View.viewType,provider,{}));'
    WEB = 'let api=acquireVsCodeApi();'

    def test_idempotent_and_reversible(self):
        host = codex_drafts.transform_host(self.HOST)
        self.assertEqual(codex_drafts.transform_host(host), host)
        self.assertEqual(codex_drafts.transform_host(host, False), self.HOST)
        self.assertIn('scmToolkitProtectCodexDrafts(provider,vscode)', host)
        web = codex_drafts.transform_webview(self.WEB)
        self.assertEqual(codex_drafts.transform_webview(web), web)
        self.assertEqual(codex_drafts.transform_webview(web, False), self.WEB)
        self.assertTrue(web.startswith(codex_drafts.WEB_START))

    def test_patch_coexists_with_existing_context_wrapper(self):
        other = self.HOST.replace('subscriptions.push(', 'subscriptions.push(scmToolkitRegisterCodexSnapshotProvider(provider,vscode),', 1)
        patched = codex_drafts.transform_host(other)
        self.assertEqual(codex_drafts.transform_host(patched, False), other)
        self.assertEqual(patched.count('scmToolkitRegisterCodexSnapshotProvider(provider,vscode)'), 1)

    def test_discovers_renamed_bootstrap_without_touching_other_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'out').mkdir()
            (root / 'out/extension.js').write_text(self.HOST)
            assets = root / 'webview/assets'
            assets.mkdir(parents=True)
            webview = assets / 'message-bus-new.js'
            webview.write_text(self.WEB)
            (assets / 'app-initial-old.js').write_text('bootstrap();')
            self.assertEqual({p for p, _, _ in codex_drafts.patch_files(root)}, {root / 'out/extension.js', webview})
            (assets / 'another-api.js').write_text(self.WEB)
            with self.assertRaisesRegex(ValueError, 'ambiguous bootstrap'):
                codex_drafts.patch_files(root)

    def test_rejects_malformed_installations(self):
        for source in ('unknown', codex_drafts.HOST_START, codex_drafts.HOST_END):
            with self.assertRaises(ValueError):
                codex_drafts.transform_host(source)
        with self.assertRaises(ValueError):
            codex_drafts.transform_webview(codex_drafts.WEB_START + 'missing end')

if __name__=='__main__':
    unittest.main()
