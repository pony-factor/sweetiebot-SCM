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

    def test_new_chat_dot_targets_other_codex_window_shapes_without_recoloring_all_badges(self):
        patched = codex_colors.transform('base', {
            'codexNewChatDotColor': '#12AB34',
        })
        dot_rule = next(line for line in patched.splitlines()
                        if 'circle.fill-text-info[cx="15.75"]' in line)
        # The original narrow rule still works in supported primary webviews.
        self.assertIn(':root[data-codex-window-type=extension] svg circle.fill-text-info', dot_rule)
        # A secondary window may not have that root attribute or circle class.
        self.assertIn('svg circle[cx="15.75"][cy="4"][r="3.25"]', dot_rule)
        # A re-rendered icon may instead have an accessible new-chat name.
        self.assertIn('button[aria-label*="new chat" i] svg circle.fill-text-info', dot_rule)
        self.assertIn('button[title*="new chat" i] svg circle.fill-text-info', dot_rule)
        self.assertIn('[data-testid*="new-chat" i] svg circle.fill-text-info', dot_rule)
        self.assertIn('fill: #12AB34 !important;', dot_rule)
        self.assertNotIn(', svg circle,', dot_rule)
        self.assertEqual(codex_colors.transform(patched, {}, remove=True), 'base')

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
