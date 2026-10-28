import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import ui_customizations as ui
from toolkit_settings import DEFAULT_SETTINGS
import workspace_search


class UiCustomizationTests(unittest.TestCase):
    def fixture(self, root):
        extension = root / 'codex'
        assets = extension / 'webview/assets'
        assets.mkdir(parents=True)
        manifest = {'publisher':'openai','name':'chatgpt','contributes':{
            'viewsContainers':{'activitybar':[{'id':'codexViewContainer','title':'Codex','icon':'native.svg'}]},
            'views':{'codexViewContainer':[{'id':'chatgpt.sidebarView','name':'Codex','type':'webview'}]}}}
        (extension / 'package.json').write_text(json.dumps(manifest))
        (extension / 'webview/index.html').write_text('<head><link rel="stylesheet" href="./assets/renamed.css"><script type="module" src="./assets/entry.js"></script></head>')
        (assets / 'renamed.css').write_text('native stylesheet')
        (assets / 'entry.js').write_text('export const nativeBoot = true;')
        (extension / 'out').mkdir()
        (extension / 'out/extension.js').write_text('unchanged host with unrelated patches')
        companion = root / 'companion'
        companion.mkdir()
        package = workspace_search.render_package(dict(DEFAULT_SETTINGS))
        package['contributes']['commands'].append({'command':'fixture.preserve','title':'Preserve me'})
        (companion / 'package.json').write_text(json.dumps(package))
        return extension, companion

    def test_updates_labels_icon_and_styles_without_touching_host(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            extension, companion = self.fixture(root)
            settings = dict(DEFAULT_SETTINGS, codexWindowLabel='CelestAI', workspaceSearchLabel='Research', workspaceSearchActivityBar=True)
            before = (extension / 'out/extension.js').read_bytes()
            planned = ui.plan(extension, settings, companion)
            self.assertFalse(any(path.name == 'extension.js' for path, _, _ in planned))
            ui.apply(planned)
            self.assertEqual((extension / 'out/extension.js').read_bytes(), before)
            codex = json.loads((extension / 'package.json').read_text())
            self.assertEqual(codex['contributes']['viewsContainers']['activitybar'][0]['title'], 'CelestAI')
            efs = json.loads((companion / 'package.json').read_text())
            view = efs['contributes']['views'][workspace_search.STANDALONE_CONTAINER_ID][0]
            self.assertEqual(view['name'], 'Research')
            self.assertEqual(view['contextualTitle'], 'Research')
            self.assertEqual(view['icon'], 'media/efs.svg')
            self.assertEqual(
                (companion / 'media/efs.svg').read_bytes(),
                workspace_search.source_files()[Path('media/efs.svg')].read_bytes(),
            )
            self.assertIn({'command':'fixture.preserve','title':'Preserve me'}, efs['contributes']['commands'])
            self.assertEqual(ui.plan(extension, settings, companion), [])

    def test_concurrent_change_refuses_entire_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            extension, companion = self.fixture(root)
            planned = ui.plan(extension, dict(DEFAULT_SETTINGS, codexWindowLabel='CelestAI'), companion)
            path, _, _ = planned[0]
            path.write_text('changed concurrently')
            css = (extension / 'webview/assets/renamed.css').read_text()
            with self.assertRaises(RuntimeError):
                ui.apply(planned)
            self.assertEqual((extension / 'webview/assets/renamed.css').read_text(), css)

    def test_write_failure_restores_old_files_and_removes_new_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            existing, created = root / 'old.txt', root / 'new.txt'
            existing.write_text('original')
            write = Path.write_text
            def fail(path, content, *args, **kwargs):
                if path == existing and content == 'changed':
                    raise OSError('simulated write failure')
                return write(path, content, *args, **kwargs)
            with patch.object(Path, 'write_text', fail), self.assertRaises(OSError):
                ui.apply([(created,None,'new'),(existing,'original','changed')])
            self.assertFalse(created.exists())
            self.assertEqual(existing.read_text(), 'original')

    def test_window_label_payload_is_deferred_and_reversible(self):
        original = 'export const boot = true;'
        custom = ui.window_label(original, 'CelestAI')
        self.assertIn('setTimeout(start, 0)', custom)
        self.assertEqual(ui.window_label(custom, 'CelestAI'), custom)
        self.assertEqual(ui.window_label(custom, 'Codex'), original)
        with self.assertRaises(ValueError):
            ui.window_label(original + ui.LABEL_START, 'Codex')


if __name__ == '__main__':
    unittest.main()
