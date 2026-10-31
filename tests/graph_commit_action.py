import unittest
import install
from tests.install import workbench_fixture


class GraphCommitActionTests(unittest.TestCase):
    # A compact stand-in for a compiled SCM history renderer: the hover's
    # content, target, and action are all scoped to the same commit row.
    renderer = (
        'this._hoverService.setupDelayedHover(t.element,{...o,content:c},l);'
        't.elementDisposables.add(h);'
        't.actionBar.context=n,t.actionBar.setActions(g(a,"inline").primary)'
    )

    def test_native_popup_replaces_only_inline_action(self):
        edits = install.graph_open_commit_action_edits(self.renderer)
        self.assertEqual(len(edits), 1)
        original, replacement = edits[0]
        self.assertIn('scmToolkitGraphCommitActions(g(a,"inline").primary,', replacement)
        self.assertIn('this._hoverService,t.element,c,o', replacement)
        self.assertIn('t.actionBar.context=n,', replacement)
        self.assertNotEqual(original, replacement)

    def test_rejects_missing_or_ambiguous_graph_hover(self):
        with self.assertRaisesRegex(ValueError, "Unsupported VS Code build"):
            install.graph_open_commit_action_edits('t.actionBar.context=n,t.actionBar.setActions(g(a,"inline").primary)')
        with self.assertRaisesRegex(ValueError, "Unsupported VS Code build"):
            install.graph_open_commit_action_edits(self.renderer + self.renderer)

    def test_setting_off_preserves_native_action_and_toggle_round_trip(self):
        original_js = workbench_fixture() + self.renderer
        stock = dict(install.DEFAULT_SETTINGS, graphPreferOpenCommit=False)
        custom = dict(stock, graphPreferOpenCommit=True)
        untouched, _ = install.transform(original_js, "original-css", settings=stock)
        self.assertIn('t.actionBar.setActions(g(a,"inline").primary)', untouched)
        enabled = install.transform(original_js, "original-css", settings=custom)
        self.assertIn('scmToolkitGraphCommitActions(g(a,"inline").primary,', enabled[0])
        self.assertEqual(install.transform(*enabled, remove=True, settings=custom),
                         (original_js, "original-css"))
        self.assertEqual(install.transform(*enabled, settings=stock), untouched)


if __name__ == "__main__":
    unittest.main()
