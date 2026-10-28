"""Guard the versioned patches to the GitHub Pull Requests overview."""
import subprocess
import unittest

import github_pr_reactions


class GitHubReactionHoverTests(unittest.TestCase):
    def test_webview_round_trip_and_idempotence(self):
        source = '(function(){const reactionClass="comment-reactions";})();'
        patched = github_pr_reactions.transform_webview(source)
        self.assertIn('sweetiebot-reaction-popover', patched)
        self.assertEqual(github_pr_reactions.transform_webview(patched), patched)
        self.assertEqual(github_pr_reactions.transform_webview(patched, remove=True), source)
        subprocess.run(['node', '--check'], input=patched, text=True, check=True)
        with self.assertRaises(ValueError):
            github_pr_reactions.transform_webview('(function(){})();')
        with self.assertRaises(ValueError):
            github_pr_reactions.transform_webview(patched.replace('sweetiebot-reactor-name', 'changed', 1), remove=True)
        with self.assertRaises(ValueError):
            github_pr_reactions.transform_webview(patched + github_pr_reactions.WEBVIEW_START)

    def test_host_csp_only_allows_public_github_profiles(self):
        source = 'const policy=' + '"default-src none; img-src vscode-resource: https:; media-src https:; script-src nonce";'
        patched = github_pr_reactions.transform_csp(source)
        self.assertIn('connect-src https://api.github.com;', patched)
        self.assertEqual(github_pr_reactions.transform_csp(patched), patched)
        self.assertEqual(github_pr_reactions.transform_csp(patched, remove=True), source)
        with self.assertRaises(ValueError):
            github_pr_reactions.transform_csp(source + source)
        with self.assertRaises(ValueError):
            github_pr_reactions.transform_csp(patched.replace('connect-src https://api.github.com;', 'connect-src https://other.example;', 1), remove=True)

    def test_reactor_title_parser_keeps_usernames_and_overflow(self):
        script = github_pr_reactions.ASSET.read_text()
        start = script.index('function parseNativeTitle(')
        end = script.index('function profileFor(', start)
        parser = script[start:end]
        tests = '''
const assert=require('node:assert/strict');
assert.deepEqual(parseNativeTitle('some-user reacted with 👍'),
 {logins:['some-user'], more:0, emoji:'👍'});
assert.deepEqual(parseNativeTitle('JFWooten4 and another-user reacted with ❤️'),
 {logins:['JFWooten4','another-user'], more:0, emoji:'❤️'});
assert.deepEqual(parseNativeTitle('first, second and 3 more reacted with 🎉'),
 {logins:['first','second'], more:3, emoji:'🎉'});
assert.deepEqual(parseNativeTitle('github-actions[bot] reacted with 👀'),
 {logins:['github-actions[bot]'], more:0, emoji:'👀'});
assert.equal(parseNativeTitle(''), null);
assert.equal(parseNativeTitle('not a reaction'), null);
assert.equal(parseNativeTitle('Name with spaces reacted with 👍'), null);
'''
        login_pattern = r'const loginPattern=/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?(?:\[bot\])?$/i;'
        subprocess.run(['node', '-e', login_pattern + '\n' + parser + '\n' + tests], check=True)


if __name__ == '__main__':
    unittest.main()
