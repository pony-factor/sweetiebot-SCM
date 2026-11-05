
import sys as _sb_sys
from pathlib import Path as _sb_path
for _sb_parent in _sb_path(__file__).resolve().parent.parents:
    _sb_scripts = (_sb_parent if (_sb_parent / 'importaliases.py').is_file()
                   else _sb_parent / 'scripts')
    if (_sb_scripts / 'importaliases.py').is_file():
        if str(_sb_scripts) not in _sb_sys.path:
            _sb_sys.path.insert(0, str(_sb_scripts))
        import importaliases
        importaliases.install()
        break

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
    AFFINITY_STORAGE_FIXTURE = (
        'static getOrCreateWorkspace(n,e,t,r,o){let s=o===void 0?void 0:hash("sha256").update(o).digest("hex"),'
        'a=s?join(Sessions.getWorkspaceAffinityStorageHome(t,e),s):join(t,e,"browserStorage"),'
        'l=s?`workspace:${e}:${s}`:`workspace:${e}`,c=electron.fromPath(a.fsPath);'
        'return Sessions._bySession.get(c)??n.createInstance(Sessions,l,c,"workspace",r,o)}'
        'let s=Sessions.getOrCreate(this.instantiationService,e,r,'
        'this.environmentMainService.workspaceStorageHome,o.openedWorkspace?.id,t),network=normalize(r);'
        'if(s.network?.authority!==network?.authority){s.setNetwork(network)}return s'
    )

    def test_persistent_pr_storage_is_guarded_and_reversible(self):
        for original in (self.STORAGE_FIXTURE, self.AFFINITY_STORAGE_FIXTURE):
            installed = browser_pr.transform_storage(original)
            self.assertEqual(browser_pr.transform_storage(installed), installed)
            self.assertEqual(browser_pr.transform_storage(installed, remove=True), original)
        for source in ('unknown main', browser_pr.STORAGE_START, browser_pr.STORAGE_END,
                       original + original):
            with self.assertRaises(ValueError):
                browser_pr.transform_storage(source)

    def test_repo_and_pr_windows_share_one_path_without_reusing_isolated_sessions(self):
        for fixture in (self.STORAGE_FIXTURE, self.AFFINITY_STORAGE_FIXTURE):
            with self.subTest(affinity=fixture == self.AFFINITY_STORAGE_FIXTURE):
                self.check_shared_sessions(fixture)

    def check_shared_sessions(self, fixture):
        installed = browser_pr.transform_storage(fixture)
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
const resolve = new Function('r', 'o', 'return ' + INJECTION + '"isolated";');
const windowFor = name => ({openedWorkspace:{configPath:{path:
  '/repo/.git/sweetiebot-pr-sessions/session-' + name + '/Pony PR.code-workspace'}}});
const first = resolve.call(host, {scope:'workspace'}, windowFor('one'));
const second = resolve.call(host, {scope:'workspace'}, windowFor('two'));
assert.equal(first, second);
assert.equal(first.session.path, '/Users/test/Library/Application Support/Sweetiebot/browserStorage');
for (const scope of ['ephemeral', 'agent'])
  assert.equal(resolve.call(host, {scope}, windowFor('three')), 'isolated');
for (const scope of ['workspace', 'global']) {
  for (const options of [{network:{authority:'remote'}}, {affinity:'isolated'}, {affinity:''}])
    assert.equal(resolve.call(host, {scope, ...options}, windowFor('three')), 'isolated');
}
for (const window of [{}, {openedWorkspace:{id:'repo'}},
  {openedWorkspace:{configPath:{path:'/repo/ordinary.code-workspace'}}}])
  for (const scope of ['workspace', 'global'])
    assert.equal(resolve.call(host, {scope}, window), first);
assert.equal(sessions.size, 1);
'''.replace('INJECTION', json.dumps(injected))
        subprocess.run(['node', '-e', script], check=True, capture_output=True, text=True)

    def test_affinity_resolver_preserves_native_network_bookkeeping(self):
        installed = browser_pr.transform_storage(self.AFFINITY_STORAGE_FIXTURE)
        resolver = installed.rsplit('let s=', 1)[1]
        script = r'''
const assert = require('node:assert/strict');
const join = (...parts) => ({fsPath:parts.map(p => p.fsPath || p).join('/')});
const electron = {fromPath:p => p};
let nativeCalls = 0;
const makeSession = () => ({setNetwork(value) {this.network = value;}});
const Sessions = {_bySession:new Map(), getOrCreate() {nativeCalls++; return makeSession();}};
const normalize = r => r.network;
const host = {environmentMainService:{userHome:{fsPath:'/home'},workspaceStorageHome:{}},
  instantiationService:{createInstance:() => makeSession()}};
const resolve = new Function('e', 'r', 'o', 't', 'let s=' + RESOLVER);
assert.equal(resolve.call(host, 'view', {scope:'workspace'}, {}, 1).network, undefined);
assert.equal(nativeCalls, 0);
const remote = {authority:'remote'};
assert.equal(resolve.call(host, 'view', {scope:'workspace',network:remote}, {}, 1).network, remote);
assert.equal(nativeCalls, 1);
'''.replace('RESOLVER', json.dumps(resolver))
        subprocess.run(['node', '-e', script], check=True, capture_output=True, text=True)

    def test_install_is_idempotent_and_reversible(self):
        original = '"vscode:browserView:preloadReady";'
        installed = browser_pr.transform(original)
        self.assertIn("sweetiebot_pr", installed)
        self.assertIn("sweetiebot_spellcheck", installed)
        self.assertIn("Bearer ", installed)
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
