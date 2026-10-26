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
        self.assertTrue(codex_colors.transform(original, {}).startswith(original))

    def test_scoped_colors_are_idempotent_and_removable(self):
        original = 'base stylesheet\n'
        settings = {'codexSendBackground': '#43AF49', 'codexSendForeground': '#ffffff',
                    'codexComposerLabelColor': '#43AF49'}
        patched = codex_colors.transform(original, settings)
        self.assertEqual(codex_colors.transform(patched, settings), patched)
        self.assertEqual(codex_colors.transform(patched, {}, remove=True), original)
        self.assertIn('button.bg-composer-primary', patched)
        self.assertIn('[data-composer-navigation-target="permissions"]', patched)
        self.assertIn('[data-composer-navigation-target="run-location"]', patched)
        self.assertIn('[data-composer-navigation-target="add-context"]', patched)
        self.assertNotIn('--vscode-foreground:', patched)
        self.assertIn('scm-toolkit-pegasus-send::after { background-color: #ffffff !important; }', patched)

    def test_flat_composer_is_opt_in_scoped_and_removable(self):
        original = 'base stylesheet'
        native = codex_colors.transform(original, {})
        patched = codex_colors.transform(original, {'codexFlatComposer': True})
        self.assertNotIn('--composer-layout-surface-shadow', native)
        self.assertIn('--composer-layout-surface-shadow: none !important', patched)
        self.assertIn(':root[data-codex-window-type=extension]', patched)
        self.assertIn(':not([data-composer-surface-variant=document])', patched)
        self.assertIn('--vscode-focusBorder', patched)
        self.assertEqual(codex_colors.transform(patched, {'codexFlatComposer': True}), patched)
        self.assertEqual(codex_colors.transform(patched, {}), native)
        self.assertEqual(codex_colors.transform(patched, {}, remove=True), original)

    def test_inline_appearance_bypasses_resource_cache_and_restores_html(self):
        index = '<head><link rel="stylesheet" href="./assets/app-current.css"></head>'
        css = codex_colors.transform('base', {'codexFlatComposer': True})
        patched = codex_colors.webview_appearance(index, css)
        self.assertIn('<style>', patched)
        self.assertNotIn('base', patched)
        self.assertIn('--composer-border-radius: 8px', patched)
        self.assertEqual(codex_colors.webview_appearance(patched, css), patched)
        self.assertEqual(codex_colors.webview_appearance(patched, css, remove=True), index)
        for broken in (index + index, index + codex_colors.INLINE_START):
            with self.assertRaises(ValueError):
                codex_colors.webview_appearance(broken, css)

    def test_new_chat_dot_follows_send_button_or_uses_explicit_color(self):
        selector = 'svg circle.fill-text-info[cx="15.75"][cy="4"][r="3.25"]'
        theme = ('var(--vscode-focusBorder, var(--vscode-textLink-foreground, '
                 'var(--color-text-info)))')
        for settings, expected in (
            ({}, theme),
            ({'codexSendBackground': '#43AF49'}, '#43AF49'),
            ({'codexSendBackground': '#43AF49', 'codexNewChatDotColor': '#ABCDEF'}, '#ABCDEF'),
            ({'codexNewChatDotColor': '#ABCDEF'}, '#ABCDEF'),
        ):
            with self.subTest(settings=settings):
                patched = codex_colors.transform('base', settings)
                dot_rule = next(line for line in patched.splitlines() if selector in line)
                self.assertIn(f'fill: {expected} !important;', dot_rule)
                self.assertEqual(patched.count(selector), 1)
                self.assertEqual(codex_colors.transform(patched, settings), patched)
                self.assertEqual(codex_colors.transform(patched, {}, remove=True), 'base')
        distinct = codex_colors.transform('base', {
            'codexSendBackground': '#43AF49', 'codexNewChatDotColor': '#ABCDEF',
        })
        self.assertIn('button.bg-composer-primary { background-color: #43AF49', distinct)

    def test_new_chat_dot_rejects_invalid_hex(self):
        with self.assertRaisesRegex(ValueError, 'hexadecimal'):
            codex_colors.transform('base', {'codexNewChatDotColor': 'red'})

    def test_blank_colors_restore_the_theme(self):
        patched = codex_colors.transform('base', {'codexSendBackground': '#43af49'})
        self.assertEqual(codex_colors.transform(patched, {}), codex_colors.transform('base', {}))

    def test_rejects_css_injection_and_invalid_colors(self):
        for color in ['green', '#12345', '#fff; color: red', '#fff}\nbody{display:none}']:
            with self.subTest(color=color), self.assertRaises(ValueError):
                codex_colors.validate_color(color)

    def test_follows_native_stylesheet_link_across_filename_and_class_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            assets = root / 'webview/assets'
            assets.mkdir(parents=True)
            stylesheet = assets / 'completely-renamed.css'
            stylesheet.write_text('native CSS after a compiler update')
            (assets / 'unrelated.css').write_text('unrelated CSS')
            (root / 'webview/index.html').write_text(
                '<link href="./assets/completely-renamed.css?v=2" crossorigin rel="stylesheet">')
            self.assertEqual(codex_colors.stylesheet_path(root), stylesheet)
            (root / 'webview/index.html').write_text('<link rel="stylesheet" href="./assets/../../outside.css">')
            self.assertIsNone(codex_colors.stylesheet_path(root))

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
