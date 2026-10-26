import subprocess
import tempfile
import unittest
from pathlib import Path

import codex_queued_edit as patcher

STORE = ('function hook(thread){let scope=useScope(),host=useHost(thread),get=async()=>manager(scope,host).getTurnCoordinator(),'
         'result={messages:[],visibleMessages:[],actions:actions};return cache?result:result,result}'
         'function wrap(e){return {...e,beginEdit:e.remove,restoreEdit:e.restore}}')
ROWS = ('function Row(e){let {messageId:id,position:position,fullMessageText:text,messageText:preview,hostId:host,isEditing:editing}=e;'
        'let label={"aria-label":intl.formatMessage({id:`composer.queuedMessage.preview.trigger.label`,defaultMessage:`Preview`})};'
        'return jsx("div",{ref:nativeRef,style:style,initial:!1,animate:motion})}function next(){}')


class QueuedEditPatchTests(unittest.TestCase):
    def test_adapters_are_idempotent_and_fully_reversible(self):
        for kind, source in [('store', STORE), ('rows', ROWS)]:
            with self.subTest(kind=kind):
                patched = patcher.transform(source, kind)
                self.assertEqual(patcher.transform(patched, kind), patched)
                self.assertEqual(patcher.transform(patched, kind, False), source)
                subprocess.run(['node', '--input-type=module', '--check'], input=patched,
                               text=True, capture_output=True, check=True)
        self.assertIn('scmToolkitRegisterQueueStore(thread,host,result,()=>manager(scope,host).getTurnCoordinator())', patcher.transform(STORE, 'store'))
        self.assertIn('ref:scmToolkitQueueRowRef(nativeRef,id,host)', patcher.transform(ROWS, 'rows'))

    def test_discovery_uses_capabilities_and_never_partially_installs(self):
        with tempfile.TemporaryDirectory() as directory:
            assets = Path(directory) / 'webview/assets'
            assets.mkdir(parents=True)
            (assets / 'renamed-store.js').write_text(STORE)
            with self.assertRaisesRegex(ValueError, 'Unsupported'):
                patcher.patch_files(directory)
            (assets / 'renamed-rows.js').write_text(ROWS)
            patches = patcher.patch_files(directory)
            self.assertEqual(len(patches), 2)
            self.assertEqual((assets / 'renamed-store.js').read_text(), STORE)
            (assets / 'duplicate.js').write_text(STORE)
            with self.assertRaisesRegex(ValueError, 'Unsupported'):
                patcher.patch_files(directory)

    def test_restoration_refuses_changed_or_incomplete_patches(self):
        patched = patcher.transform(STORE, 'store')
        changed = patched.replace('scmToolkitRegisterQueueStore(thread,', 'changedAdapter(thread,', 1)
        for source in (changed, STORE + patcher.START):
            with self.assertRaises(ValueError):
                patcher.transform(source, 'store', False)

    def test_missing_native_capability_is_refused_without_mutation(self):
        for kind, source in [('store', STORE.replace('getTurnCoordinator()', 'changed()')), ('rows', ROWS.replace('ref:nativeRef', 'ref:changed()'))]:
            with self.assertRaisesRegex(ValueError, 'Unsupported'):
                patcher.transform(source, kind)


if __name__ == '__main__':
    unittest.main()
