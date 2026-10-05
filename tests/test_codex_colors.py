from pathlib import Path
import tempfile
import unittest

import codex_colors


class CodexColorTests(unittest.TestCase):
    def test_scoped_colors_are_idempotent_and_removable(self):
        original = 'base stylesheet\n'
        settings = dict(zip(codex_colors.COLOR_SETTINGS, ['#43AF49', '#ffffff', '#43AF49']))
        patched = codex_colors.transform(original, settings)
        self.assertEqual(codex_colors.transform(patched, settings), patched)
        self.assertEqual(codex_colors.transform(patched, {}, remove=True), original)
        self.assertIn('button.bg-composer-primary', patched)
        self.assertIn('[data-composer-navigation-target="permissions"]', patched)
        self.assertIn('[data-composer-navigation-target="run-location"]', patched)
        self.assertIn('[data-composer-navigation-target="add-context"]', patched)
        self.assertNotIn('--vscode-foreground:', patched)

    def test_blank_colors_restore_the_theme(self):
        patched = codex_colors.transform('base', {'codexSendBackground': '#43af49'})
        self.assertEqual(codex_colors.transform(patched, {}), 'base')

    def test_rejects_css_injection_and_invalid_colors(self):
        for color in ['green', '#12345', '#fff; color: red', '#fff}\nbody{display:none}']:
            with self.subTest(color=color), self.assertRaises(ValueError):
                codex_colors.validate_color(color)

    def test_selects_only_the_extension_stylesheet(self):
        with tempfile.TemporaryDirectory() as directory:
            assets = Path(directory) / 'webview/assets'
            assets.mkdir(parents=True)
            (assets / 'app-initial-other.css').write_text('.bg-composer-primary{}')
            extension = assets / 'app-initial-extension.css'
            extension.write_text(':root[data-codex-window-type=extension]{}.bg-composer-primary{}')
            self.assertEqual(codex_colors.stylesheet_path(directory), extension)


if __name__ == '__main__':
    unittest.main()
