
import sys as _sb_sys
from pathlib import Path as _sb_path
for _sb_parent in _sb_path(__file__).resolve().parent.parents:
    _sb_scripts = (_sb_parent if (_sb_parent / 'importaliases.py').is_file()
                   else _sb_parent / 'scripts')
    if (_sb_scripts / 'importaliases.py').is_file():
        if str(_sb_scripts) not in _sb_sys.path:
            _sb_sys.path.insert(0, str(_sb_scripts))
        import importaliases
        importaliases.install()
        break

import sys
from pathlib import Path
import unittest
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import codex_drafts


class DraftPatchTests(unittest.TestCase):
    HOST = 'subscriptions.push(vscode.window.registerWebviewViewProvider(View.viewType,provider,{}));'
    WEB = 'let api=acquireVsCodeApi();'
    COMPOSER = ('pi=he(`composer-auto-context-enabled`,!0);'
                'Fi=m(T,({scope:e})=>e.get(X)?.viewState,{});'
                'function V(e,t){let r=t;if(r){e.set(Ni,w(e.value),{images:r.imageAttachments,attachmentOrder:[]});e.set(Fi,r)}}'
                'function Fr(e){}'
                'n.imageAttachments=e(X)?.viewState.imageAttachments??r.images;')

    def test_attachment_state_is_reversible_and_guarded(self):
        patched = codex_drafts.transform_attachments(self.COMPOSER)
        self.assertEqual(codex_drafts.transform_attachments(patched), patched)
        self.assertEqual(codex_drafts.transform_attachments(patched, False), self.COMPOSER)
        self.assertIn('scmToolkitRestoreComposerAttachments(e,scmToolkitComposerAttachmentDrafts,w)', patched)
        self.assertIn('scmToolkitSaveComposerAttachments(e,r,scmToolkitComposerAttachmentDrafts,w)', patched)
        with self.assertRaisesRegex(ValueError, 'Unsupported Codex attachment'):
            codex_drafts.transform_attachments('vendor contract changed')

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
            composer = assets / 'composer-view-state-new.js'
            composer.write_text(self.COMPOSER)
            self.assertEqual({p for p, _, _ in codex_drafts.patch_files(root)}, {root / 'out/extension.js', webview, composer})
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
