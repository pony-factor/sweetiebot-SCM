from pathlib import Path
import tempfile
import unittest

import codex_colors


class CodexColorTests(unittest.TestCase):
    def test_embedded_font_uses_local_fallback_and_restores_original(self):
        original = '@font-face{font-family:Math;src:url(data:font/woff2;base64,d09GMg==)format("woff2"),url(./math.woff)format("woff");font-weight:400}'
        patched = codex_colors.transform(original, {})
        active = patched.split(' */', 1)[1].split(codex_colors.FONT_END, 1)[0]
        self.assertNotIn('data:font', active)
        self.assertIn('src:url(./math.woff)format("woff")', active)
        self.assertEqual(codex_colors.transform(patched, {}), patched)
        self.assertEqual(codex_colors.transform(patched, {}, remove=True), original)

    def test_embedded_font_without_local_fallback_is_preserved(self):
        original = '@font-face{src:url(data:font/woff2;base64,d09GMg==)format("woff2")}'
        self.assertEqual(codex_colors.transform(original, {}), original)

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
