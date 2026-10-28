"""Regression checks for the dynamic title-bar heading editor."""
import unittest

from window_title_configurator import TOKENS, WINDOW_TITLE_SCRIPT, render_heading


class HeadingEditorTests(unittest.TestCase):
    def test_existing_template_survives_as_editable_source(self):
        page = render_heading('${rootName} ("main") & <branch>')
        self.assertIn('name="windowHeading"', page)
        self.assertIn('value="${rootName} (&quot;main&quot;) &amp; &lt;branch&gt;"', page)
        self.assertIn('id="heading-layout"', page)
        self.assertIn('id="heading-add-text"', page)

    def test_placeholder_palette_and_drag_targets(self):
        page = render_heading("")
        self.assertIn('data-title-token="activeRepositoryBranchName"', page)
        self.assertIn('data-title-token="activeEditorState"', page)
        self.assertIn('id="heading-available"', page)
        self.assertIn("render(stored.value)", WINDOW_TITLE_SCRIPT)
        self.assertEqual(len(TOKENS), len(set(TOKENS)))


if __name__ == "__main__":
    unittest.main()
