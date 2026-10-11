import unittest
import browser_pr


class BrowserPullRequestPatchTests(unittest.TestCase):
    def test_install_is_idempotent_and_reversible(self):
        original = '"vscode:browserView:preloadReady";'
        installed = browser_pr.transform(original)
        self.assertIn("sweetiebot_fresh", installed)
        self.assertIn("oai/apps/lightweight-web/composerDraft/v1", installed)
        self.assertEqual(browser_pr.transform(installed), installed)
        self.assertEqual(browser_pr.transform(installed, remove=True), original)

    def test_rejects_incomplete_patch_and_unknown_preload(self):
        for source in ['unknown preload', browser_pr.START, browser_pr.END]:
            with self.assertRaises(ValueError):
                browser_pr.transform(source)

    def test_background_patch_is_scoped_idempotent_and_reversible(self):
        original = browser_pr.BACKGROUND_ANCHOR + '1000}'
        installed = browser_pr.transform_background(original)
        self.assertIn('setBackgroundThrottling', installed)
        self.assertEqual(browser_pr.transform_background(installed), installed)
        self.assertEqual(browser_pr.transform_background(installed, remove=True), original)
        for source in ['unknown main', browser_pr.BACKGROUND_START, browser_pr.BACKGROUND_END,
                       original + original]:
            with self.assertRaises(ValueError):
                browser_pr.transform_background(source)


if __name__ == '__main__':
    unittest.main()
