import unittest
import json
import subprocess
import browser_pr


class BrowserPullRequestPatchTests(unittest.TestCase):
    STORAGE_FIXTURE = (
        'static getOrCreateWorkspace(n,e,t){let r=join(t,e,"browserStorage"),'
        'o=electron.fromPath(r.fsPath);return Sessions._bySession.get(o)}'
        'return Sessions.getOrCreate(this.instantiationService,e,r,'
        'this.environmentMainService.workspaceStorageHome,o.openedWorkspace?.id,t)'
    )

    def test_persistent_pr_storage_is_guarded_and_reversible(self):
        original = self.STORAGE_FIXTURE
        installed = browser_pr.transform_storage(original)
        self.assertEqual(browser_pr.transform_storage(installed), installed)
        self.assertEqual(browser_pr.transform_storage(installed, remove=True), original)
        for source in ('unknown main', browser_pr.STORAGE_START, browser_pr.STORAGE_END,
                       original + original):
            with self.assertRaises(ValueError):
                browser_pr.transform_storage(source)

    def test_pr_windows_share_one_path_without_reusing_other_sessions(self):
        installed = browser_pr.transform_storage(self.STORAGE_FIXTURE)
        injected = installed.split(browser_pr.STORAGE_START)[1].split(browser_pr.STORAGE_END)[0]
        script = r'''
const assert = require('node:assert/strict');
const path = require('node:path');
const join = (root, ...parts) => ({fsPath: path.join(root.fsPath, ...parts)});
const sessions = new Map();
const electron = {fromPath(p) { if (!sessions.has(p)) sessions.set(p, {path:p}); return sessions.get(p); }};
const Sessions = {_bySession: new Map()};
const host = {environmentMainService: {userHome:{fsPath:'/Users/test'}},
  instantiationService: {createInstance(cls, id, session, scope) {
    const instance = {id, session, scope}; cls._bySession.set(session, instance); return instance;
  }}};
const resolve = new Function('r', 'o', INJECTION + ';return "isolated";');
const windowFor = name => ({openedWorkspace:{configPath:{path:
  '/repo/.git/sweetiebot-pr-sessions/session-' + name + '/Pony PR.code-workspace'}}});
const first = resolve.call(host, {scope:'workspace'}, windowFor('one'));
const second = resolve.call(host, {scope:'workspace'}, windowFor('two'));
assert.equal(first, second);
assert.equal(first.session.path, '/Users/test/Library/Application Support/Sweetiebot/browserStorage');
for (const scope of ['ephemeral', 'agent', 'global'])
  assert.equal(resolve.call(host, {scope}, windowFor('three')), 'isolated');
for (const window of [{}, {openedWorkspace:{id:'repo'}},
  {openedWorkspace:{configPath:{path:'/repo/ordinary.code-workspace'}}}])
  assert.equal(resolve.call(host, {scope:'workspace'}, window), 'isolated');
assert.equal(sessions.size, 1);
'''.replace('INJECTION', json.dumps(injected))
        subprocess.run(['node', '-e', script], check=True, capture_output=True, text=True)

    def test_install_is_idempotent_and_reversible(self):
        original = '"vscode:browserView:preloadReady";'
        installed = browser_pr.transform(original)
        self.assertIn("sweetiebot_pr", installed)
        self.assertLess(installed.index('globalThis.sweetiebotEnsureMaximumThinking ='),
                        installed.index('/* Submit only the exact prompt'))
        self.assertNotIn("sweetiebot_fresh", installed)
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
