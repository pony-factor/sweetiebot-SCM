
import sys as _sb_sys
from pathlib import Path as _sb_path
for _sb_parent in _sb_path(__file__).resolve().parents:
    _sb_scripts = (_sb_parent if (_sb_parent / 'importaliases.py').is_file()
                   else _sb_parent / 'scripts')
    if (_sb_scripts / 'importaliases.py').is_file():
        if str(_sb_scripts) not in _sb_sys.path:
            _sb_sys.path.insert(0, str(_sb_scripts))
        import importaliases
        importaliases.install()
        break

import json
import contextlib
import io
import subprocess
import os
import sys
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import branch_names
import build_installer_app
import install
import toolkit_settings
import wrapper_dependencies



# Allow direct script execution as well as the CI unittest module runner.
_sb_root = str(_sb_path(__file__).resolve().parents[2])
if _sb_root not in _sb_sys.path:
    _sb_sys.path.insert(0, _sb_root)

from tests.fixtures.installer_support import (
    SETTINGS, GIT_MODEL_FIXTURE, workbench_fixture, pr_explorer_fixture,
    browser_cross_window_fixture, browser_resolver_fixture, browser_open_action_fixture,
)


class WindowAndGitTransformTests(unittest.TestCase):
    def test_checkout_editor_guard_patches_single_and_batch_opens(self):
        native = (
            'class EditorService{'
            'async openEditor(e,t,n){let a,b=isTyped(e)?t:e.options,rest=0;}'
            'async openEditors(e,t,n){if(n?.validateTrust&&!await this.handleWorkspaceTrust(e))return[];return e;}'
            'extract(){return this.extractEditorResources([])}}'
        )
        patches = install.checkout_editor_edits(native, 'commands')
        self.assertEqual(len(patches), 2)
        for old, new in patches:
            self.assertIn('scmToolkitAllowCheckoutEditor(this,commands,', new)
            native = native.replace(old, new)
        self.assertIn('isTyped(e)?{editor:e}:e', native)
        self.assertIn('filter(Boolean);if(!e.length)return[];', native)

    def test_native_git_repository_limit_tracks_window_and_setting(self):
        installed = install.transform_git_repository_limit(GIT_MODEL_FIXTURE)
        self.assertEqual(install.transform_git_repository_limit(installed), installed)
        self.assertEqual(install.transform_git_repository_limit(installed, remove=True), GIT_MODEL_FIXTURE)
        script = """
const assert = require('node:assert/strict');
const contains = (folder, path) => path === folder || path.startsWith(folder + '/');
const folder = fsPath => ({uri: {scheme: 'file', fsPath}});
const m = null, f = null;
let enabled, settingChanged;
const api = {workspace: {
    workspaceFolders: [folder('/main')],
    getConfiguration: () => ({get: (name, fallback) => enabled ?? fallback}),
    onDidChangeConfiguration: (listener, model) => { settingChanged ??= listener.bind(model); },
}, window: {visibleTextEditors: []}};
""" + installed + """
(async () => {
    const model = new GitModel();
    const roots = () => model.openRepositories.map(entry => entry.repository.root);
    await Promise.all(['/other', '/main/module', '/main'].map(root => model.openRepository(root)));
    assert.deepEqual(roots(), ['/main']);
    enabled = false;
    await model.openRepository('/other');
    assert.deepEqual(roots(), ['/main', '/other']);
    enabled = true;
    settingChanged({affectsConfiguration: () => true});
    assert.deepEqual(roots(), ['/main']);
    api.workspace.workspaceFolders = [folder('/other')];
    await model.onDidChangeWorkspaceFolders({added: [], removed: []});
    await model.openRepository('/main');
    assert.deepEqual(roots(), ['/other']);
})().catch(error => { console.error(error); process.exitCode = 1; });
"""
        # Run the injected Git model code with two independent checkout paths.
        subprocess.run(['node', '-'], input=script, check=True, text=True)

    def test_native_git_repository_limit_preserves_folder_location_switch(self):
        method = 'async onDidChangeWorkspaceFolders({added:e,removed:t}){'
        switch = (
            'let r=this.workspaceFolderRepositories.getFolderLocationSwitches({added:e,removed:t});'
            'if(r){try{await this.applyRepositoryChanges(r)}catch(n){this.logger.warn(n)}return}'
        )
        discovery = 'try{let n=e.filter(c=>!this.getOpenRepository(c.uri));'
        native = GIT_MODEL_FIXTURE.replace(method + 'try{', method + switch + discovery)
        installed = install.transform_git_repository_limit(native)
        self.assertIn(method + switch + 'try{/* sweetiebot-repository-limit:start */', installed)
        self.assertEqual(install.transform_git_repository_limit(installed), installed)
        self.assertEqual(install.transform_git_repository_limit(installed, remove=True), native)

    def test_window_title_uses_single_repository_before_editor_selection(self):
        native = '''class Title {
getWindowTitle(){let e=this.editorService.activeEditor,t=this.contextService.getWorkspace();let v='',p='',b='';return {rootName:v,rootPath:p,rootNameShort:b}}
}
class Context {
initialize(){this._activeRepositoryHistoryItemRefName=derive(r=>this.scmViewService.activeRepository.read(r)?.repository.provider.historyProvider.read(r)?.historyItemRef.read(r)?.name)}
update(r){let u=this.scmViewService.activeRepository.read(r),p=this._activeRepositoryHistoryItemRefName.read(r);return [u?.repository.provider.name,p]}
}'''
        edits = install.window_title_repository_edits(native)
        self.assertEqual(len(edits), 3)
        for before, after in edits:
            native = native.replace(before, after)
        subprocess.run(['node', '-e', '''
const assert=require('node:assert/strict');
const derive=fn=>({read:fn});
''' + native + '''
const title=new Title();
title.editorService={};title.contextService={getWorkspace:()=>({folders:[{name:'repo'}]})};
assert.equal(title.getWindowTitle().rootName,'repo');
let branch='topic', active, visible=[];
const repo={provider:{name:'repo',historyProvider:{read:()=>({historyItemRef:{read:()=>({name:branch})}})}}};
const context=new Context();
context.scmViewService={activeRepository:{read:()=>active}};
context._visibleRepositories={read:()=>visible};context.initialize();
assert.deepEqual(context.update(),[undefined,undefined]);
visible=[repo];assert.deepEqual(context.update(),['repo','topic']);
branch='other';assert.deepEqual(context.update(),['repo','other']);
visible=[repo,repo];assert.deepEqual(context.update(),[undefined,undefined]);
active={repository:repo};assert.deepEqual(context.update(),['repo','other']);
'''], check=True, capture_output=True, text=True)

    def test_window_title_refreshes_on_startup_and_focus_without_editors(self):
        native = '''class Title {
registerListeners(){this._register(this.configurationService.onDidChangeConfiguration(()=>{}))}
onConfigurationChanged(){}
doUpdateTitle(){let e=this.getFullWindowTitle();if(e!==this.title){let i=getWindow(this.windowId,!0).window;i.document.title=e}}
}'''
        edits = install.window_title_refresh_edits(native)
        self.assertEqual(len(edits), 1)
        transformed = native
        for before, after in edits:
            self.assertEqual(transformed.count(before), 1)
            transformed = transformed.replace(before, after)
        subprocess.run(['node', '-e', '''
const assert=require('node:assert/strict');
const events=new Map(), timers=new Map(), disposables=[];
const win={document:{title:''},addEventListener:(name,fn)=>events.set(name,fn),
 removeEventListener:(name,fn)=>{assert.equal(events.get(name),fn);events.delete(name)},
 setTimeout:(fn,delay)=>{timers.set(delay,fn);return delay},clearTimeout:id=>timers.delete(id)};
function getWindow(id){assert.equal(id,42);return {window:win}}
''' + transformed + '''
let label='()', updates=0;
const title=new Title();
Object.assign(title,{windowId:42,_register:item=>disposables.push(item),
 configurationService:{onDidChangeConfiguration:()=>({dispose(){}})},
 getFullWindowTitle:()=>label,titleUpdater:{schedule(){updates++;title.doUpdateTitle()}}});
title.registerListeners();
assert.deepEqual([...timers.keys()],[0,250,1000,3000]);
timers.get(0)();assert.equal(win.document.title,'()');
label='repo (branch)';timers.get(250)();assert.equal(win.document.title,label);
label='repo (other)';events.get('focus')();assert.equal(win.document.title,label);
disposables.forEach(item=>item.dispose());
assert.equal(events.size,0);assert.equal(timers.size,0);assert.equal(updates,3);
'''], check=True, capture_output=True, text=True)

    def test_live_component_assets_update_without_repatching_workbench(self):
        import hashlib
        with tempfile.TemporaryDirectory() as root:
            app = Path(root)
            base = app / "sweetiebot"
            self.assertTrue(install.sync_live_components(app, check=True))
            self.assertFalse(base.exists(), "--check must not create component assets")
            self.assertTrue(install.sync_live_components(app))
            self.assertFalse(install.sync_live_components(app, check=True))
            manifest = json.loads((base / "manifest.json").read_text())
            self.assertEqual(manifest["schema"], 1)
            spec = manifest["modules"][0]
            self.assertEqual(spec["name"], "codex-file-drag")
            asset = (base / spec["file"]).read_bytes()
            self.assertEqual(hashlib.sha256(asset).hexdigest(), spec["version"])
            (base / spec["file"]).write_text("// modified")
            self.assertTrue(install.sync_live_components(app, check=True))
            self.assertTrue(install.sync_live_components(app))
            self.assertEqual((base / spec["file"]).read_bytes(), asset)
            self.assertTrue(install.sync_live_components(app, remove=True))
            self.assertFalse(base.exists())
            self.assertFalse(install.sync_live_components(app, remove=True, check=True))

    def test_live_components_reject_symlinked_paths(self):
        with tempfile.TemporaryDirectory() as root:
            app = Path(root)
            elsewhere = app / "elsewhere"
            elsewhere.mkdir()
            (app / "sweetiebot").symlink_to(elsewhere, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "symlinked"):
                install.sync_live_components(app)
            self.assertEqual(list(elsewhere.iterdir()), [])

    def test_window_naming_preserves_defaults_and_independent_templates(self):
        native = '''class Title {
initialize(){this.checkTitleVariables(),this.registerListeners()}
registerListeners(){}
onActiveEditorChange(){this.titleIncludesEditorState&&this.activeEditorListeners.add(this.decorationsService.onDidChangeDecorations(()=>this.titleUpdater.schedule()))}
getFullWindowTitle(){let{prefix:e,suffix:t}=this.getTitleDecorations(),i=this.getWindowTitle()||this.productService.nameLong;return i}
doUpdateTitle(){let e=this.getFullWindowTitle();if(e!==this.title){this.title=e;this.onDidChangeEmitter.fire()}}
onConfigurationChanged(e){let t=e.affectsConfiguration("window.title");t&&this.checkTitleVariables(),t&&this.titleUpdater.schedule()}
checkTitleVariables(){let e=this.configurationService.getValue("window.title");typeof e==="string"&&(this.titleIncludesFocusedView=e.includes("${focusedView}"),this.titleIncludesEditorState=e.includes("${activeEditorState}"))}
getWindowTitle(){let z=this.configurationService.getValue("window.title");typeof z!=="string"&&(z="${rootName}");!this.titleIncludesEditorState&&this.accessibilityService.isScreenReaderOptimized()&&this.configurationService.getValue("accessibility.windowTitleOptimized")&&(z+="${separator}${activeEditorState}");return render(z)}isCustomTitleFormat(){return!1}
}'''
        original = workbench_fixture() + native
        patched = install.transform(original, 'base-css', settings=SETTINGS)
        self.assertEqual(install.transform(*patched, settings=SETTINGS), patched)
        self.assertEqual(install.transform(*patched, remove=True), (original, 'base-css'))
        transformed = native
        for before, after in install.window_title_push_edits(native) + install.window_title_naming_edits(native):
            transformed = transformed.replace(before, after)
        subprocess.run(['node', '-e', r'''
            const assert = require('node:assert/strict');
            const values = {'window.title': '${activeEditorShort} — ${appName}'};
            const tokens = {rootName:'repository',activeRepositoryBranchName:'branch',
                activeEditorShort:'file.md',appName:'Code',focusedView:'Explorer',
                separator:' — ',activeEditorState:'Modified'};
            function render(template) {
                return template.replace(/\$\{([^}]+)\}/g, (_, key) => tokens[key] || '');
            }
        ''' + transformed + '''
            let pending = false, scheduled = 0, changes = 0;
            const title = new Title();
            Object.assign(title, {
                configurationService:{getValue:key => values[key]},
                contextKeyService:{getContextKeyValue:() => pending},
                accessibilityService:{isScreenReaderOptimized:() => false},
                productService:{nameLong:'Code'},
                getTitleDecorations:() => ({}),
                registerVariables:() => {},
                titleUpdater:{schedule:() => scheduled++}
                ,onDidChangeEmitter:{fire:() => changes++}
            });
            title.initialize();
            title.doUpdateTitle();
            assert.equal(changes,1);
            assert.equal(title.getWindowTitle(), 'file.md — Code');
            assert.equal(title.getFullWindowTitle(), 'file.md — Code');
            assert.equal(title.isCustomTitleFormat(), false);
            values['sweetiebot.windowHeading']='${rootName} (${activeRepositoryBranchName})';
            title.onConfigurationChanged({affectsConfiguration:key=>key==='sweetiebot.windowHeading'});
            title.doUpdateTitle();
            assert.equal(changes,2,'heading changes refresh the UI even when the native window name stays the same');
            assert.equal(scheduled,1);
            assert.equal(title.getWindowTitle(),'repository (branch)');
            assert.equal(title.getFullWindowTitle(),'file.md — Code');
            assert.equal(title.isCustomTitleFormat(),true);
            values['sweetiebot.windowName']='${rootName} — ${focusedView}';
            title.onConfigurationChanged({affectsConfiguration:key=>key==='sweetiebot.windowName'});
            assert.equal(title.titleIncludesFocusedView,true);
            assert.equal(title.getFullWindowTitle(),'repository — Explorer');
            pending=true;
            assert.equal(title.getWindowTitle(),'repository (branch) — Pushing');
            assert.equal(title.getFullWindowTitle(),'repository — Explorer — Pushing');
            pending=false;
            values['sweetiebot.windowHeading']='';values['sweetiebot.windowName']='';
            assert.equal(title.getWindowTitle(),'file.md — Code');
            assert.equal(title.getFullWindowTitle(),'file.md — Code');
        '''], check=True, capture_output=True, text=True)

    def test_window_naming_preserves_folder_location_updates(self):
        native = '''class Title {
initialize(){this.checkTitleVariables(),this.registerListeners()}
registerListeners(){this._register(this.configurationService.onDidChangeConfiguration(()=>{}))}
onConfigurationChanged(e){let t=e.affectsConfiguration("window.title");t&&this.checkTitleVariables()}
onActiveEditorChange(){this.titleIncludesEditorState&&this.activeEditorListeners.add(this.decorationsService.onDidChangeDecorations(()=>this.titleUpdater.schedule()))}
checkTitleVariables(){let e=this.configurationService.getValue("window.title");this.titleIncludesFocusedView=e.includes("${focusedView}")}
doUpdateTitle(){let e=this.getFullWindowTitle(),t=this.folderLocationInfo,i=t?`${t.uri.toString()}|${t.label}|${t.description??""}|${t.icon?.id??""}`:"",n=i!==this.folderLocationKey;if(this.folderLocationKey=i,e===this.title)n&&this.onDidChangeEmitter.fire();else{let r=e;let a=getWindow(this.windowId,!0).window;a.document.title=r,this.title=e,this.onDidChangeEmitter.fire()}}
getFullWindowTitle(){let{prefix:e,suffix:t}=this.getTitleDecorations(),i=this.getWindowTitle()||this.productService.nameLong;return i}
getWindowTitle(){let z=this.configurationService.getValue("window.title");return z}isCustomTitleFormat(){return!1}
}'''
        original = workbench_fixture() + native
        patched = install.transform(original, 'base-css', settings=SETTINGS)
        self.assertEqual(install.transform(*patched, settings=SETTINGS), patched)
        self.assertEqual(install.transform(*patched, remove=True), (original, 'base-css'))
        transformed = native
        for before, after in (install.window_title_push_edits(native)
                              + install.window_title_naming_edits(native)
                              + install.window_title_refresh_edits(native)):
            self.assertEqual(transformed.count(before), 1)
            transformed = transformed.replace(before, after)
        subprocess.run(['node', '-e', '''
const assert=require('node:assert/strict');
const win={document:{title:''},addEventListener(){},removeEventListener(){},setTimeout(){},clearTimeout(){}};
function getWindow(){return {window:win}}
''' + transformed + '''
const values={'window.title':'native','sweetiebot.windowName':'fixed','sweetiebot.windowHeading':'heading'};
let changes=0;
const title=new Title();
Object.assign(title,{configurationService:{getValue:key=>values[key],onDidChangeConfiguration:()=>({})},
contextKeyService:{getContextKeyValue:()=>false},productService:{nameLong:'Code'},
getTitleDecorations:()=>({}),onDidChangeEmitter:{fire:()=>changes++},
_register(){},registerVariables(){},titleUpdater:{schedule(){}}});
title.initialize();title.doUpdateTitle();assert.equal(changes,1);assert.equal(win.document.title,'fixed');
title.doUpdateTitle();assert.equal(changes,1);
values['sweetiebot.windowHeading']='new heading';title.doUpdateTitle();
assert.equal(changes,2);assert.equal(title.scmToolkitHeading,'new heading');assert.equal(win.document.title,'fixed');
title.folderLocationInfo={uri:{toString:()=>'/repo'},label:'repo'};title.doUpdateTitle();
assert.equal(changes,3);assert.equal(title.folderLocationKey,'/repo|repo||');
title.doUpdateTitle();assert.equal(changes,3);
values['sweetiebot.windowName']='new title';title.doUpdateTitle();assert.equal(changes,4);
assert.equal(win.document.title,'new title');
'''], check=True, capture_output=True, text=True)

    def test_window_push_title_is_reversible_and_tracks_context(self):
        title = (
            'this.checkTitleVariables(),this.registerListeners();'
            'getFullWindowTitle(){let{prefix:e,suffix:t}=this.getTitleDecorations(),'
            'i=this.getWindowTitle()||this.productService.nameLong;return i}'
        )
        original = workbench_fixture() + title
        patched = install.transform(original, 'base-css', settings=SETTINGS)
        self.assertEqual(install.transform(*patched, settings=SETTINGS), patched)
        self.assertEqual(install.transform(*patched, remove=True), (original, 'base-css'))
        transformed = title
        for before, after in install.window_title_push_edits(title):
            transformed = transformed.replace(before, after)
        method = transformed.split(';getFullWindowTitle()', 1)[1]
        subprocess.run(['node', '-e', '''
            const assert = require('node:assert/strict');
            let pending = false;
            const title = {
                getTitleDecorations: () => ({}),
                getWindowTitle: () => 'repository (branch)',
                contextKeyService: {getContextKeyValue(key) {
                    assert.equal(key, 'sweetiebot.pushPending'); return pending;
                }},
                productService: {nameLong: 'Code'},
                configurationService: {getValue: () => ''},
                getFullWindowTitle() ''' + method + '''
            };
            assert.equal(title.getFullWindowTitle(), 'repository (branch)');
            pending = true;
            assert.equal(title.getFullWindowTitle(), 'repository (branch) — Pushing');
            pending = false;
            assert.equal(title.getFullWindowTitle(), 'repository (branch)');
        '''], check=True, capture_output=True, text=True)

    def test_implicit_title_status_refreshes_after_external_commit(self):
        listener = (
            'this.titleIncludesEditorState&&this.activeEditorListeners.add('
            'this.decorationsService.onDidChangeDecorations(()=>this.titleUpdater.schedule()))'
        )
        original = workbench_fixture() + listener
        patched = install.transform(original, 'base-css', settings=SETTINGS)
        self.assertEqual(install.transform(*patched, settings=SETTINGS), patched)
        self.assertEqual(install.transform(*patched, remove=True), (original, 'base-css'))
        _, after = install.window_title_status_edits(listener)[0]
        # The accessibility-generated suffix uses decorations even when the
        # explicit title template does not include activeEditorState.
        subprocess.run(['node', '-e', '''
            const assert = require('node:assert/strict');
            let onDecoration, scheduled = 0, disposed = false;
            const subscriptions = [];
            const service = {
                titleIncludesEditorState: false,
                activeEditorListeners: {add(subscription) {
                    assert.equal(typeof subscription.dispose, 'function');
                    subscriptions.push(subscription);
                }},
                decorationsService: {onDidChangeDecorations(callback) {
                    onDecoration = callback;
                    return {dispose() {disposed = true;}};
                }},
                titleUpdater: {schedule() {scheduled++;}}
            };
        ''' + f'function subscribe() {{{after}}}; subscribe.call(service);' + '''
            assert.equal(typeof onDecoration, 'function');
            onDecoration(); // Git decoration cleared after the external commit.
            assert.equal(scheduled, 1);
            subscriptions.forEach(subscription => subscription.dispose());
            assert.equal(disposed, true);
        '''], check=True, capture_output=True, text=True)

    def test_title_status_rejects_changed_or_ambiguous_native_listener(self):
        listener = (
            'this.titleIncludesEditorState&&this.activeEditorListeners.add('
            'this.decorationsService.onDidChangeDecorations(()=>this.titleUpdater.schedule()))'
        )
        with self.assertRaisesRegex(ValueError, 'window title status listener'):
            install.window_title_status_edits('checkTitleVariables(){}')
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            install.window_title_status_edits(listener + listener)

    def test_native_status_scheduling_is_fast_and_reversible(self):
        original = ('class Repository{async updateWhenIdleAndWait(){await this.whenIdleAndFocused(),'
                    'await this.status(),await pause(5e3)}}'
                    'decorate([debounce(1e3)],Repository.prototype,"eventuallyUpdateWhenIdleAndWait",1)')
        installed = install.transform_git_refresh(original)
        self.assertEqual(install.transform_git_refresh(installed), installed)
        self.assertEqual(install.transform_git_refresh(installed, remove=True), original)
        # Exercise the transformed scheduling hooks; preserve idle-before-status ordering.
        subprocess.run(['node', '-e', '''
            const assert = require('node:assert/strict');
            const events=[];
            const pause=async ms=>events.push(ms);
            const debounce=ms=>{assert.equal(ms,100);return ()=>{}};
            const decorate=()=>{};
        ''' + installed + '''
            const repo=new Repository();
            repo.whenIdleAndFocused=async()=>events.push('idle');
            repo.status=async()=>events.push('status');
            repo.updateWhenIdleAndWait().then(()=>assert.deepEqual(events,['idle','status',250]));
        '''], check=True, capture_output=True, text=True)
        with self.assertRaisesRegex(ValueError, 'Unsupported native Git status'):
            install.transform_git_refresh(original.replace('debounce(1e3)', 'debounce(2e3)'))
        with self.assertRaisesRegex(ValueError, 'Unsupported native Git status'):
            install.transform_git_refresh(original + original)
        with self.assertRaisesRegex(ValueError, 'Incomplete fast Git status'):
            install.transform_git_refresh(installed.replace('/* sweetiebot-fast-status:end */', '', 1))

    def test_native_push_handoff_is_reversible(self):
        original = ('class Repository{async commit(e,t=Object.create(null)){let r=[...this.indexGroup.resourceStates.map(o=>o.resourceUri.fsPath)];'
                    'let x=api.workspace.getConfiguration("git",api.Uri.file(this.root));}'
                    'async _push(e,t,r=!1,n=!1,o,a=!1){return this.repository.push(e,t,r,n,o,a)}}')
        installed = install.transform_git_background(original)
        self.assertIn('sweetiebot.queuePush', installed)
        self.assertIn('if(!n&&!o&&!a)', installed)
        self.assertEqual(install.transform_git_background(installed), installed)
        self.assertEqual(install.transform_git_background(installed, remove=True), original)

    def test_native_commit_handoff_captures_both_push_command_names(self):
        import subprocess
        original = 'class Repository{async commit(e,t=Object.create(null)){let r=[...this.indexGroup.resourceStates.map(o=>o.resourceUri.fsPath)];let x=api.workspace.getConfiguration("git",api.Uri.file(this.root));return "native"}}'
        installed = install.transform_git_background(original)
        self.assertIn('durableBackgroundCommits', installed)
        self.assertIn('all:t.all', installed)
        self.assertNotIn('!t.all', installed)
        self.assertEqual(install.transform_git_background(installed), installed)
        self.assertEqual(install.transform_git_background(installed, remove=True), original)
        script = """
const assert = require('node:assert/strict');
const requests=[];
const api={Uri:{file:x=>x}, workspace:{getConfiguration(){return {get(){return true}}}}, commands:{async executeCommand(id,root,options){requests.push(options);return {queued:true}}}};
SOURCE
(async()=>{for(const push of ['push','git.push']){
 const repo=new Repository();repo.root='/test';repo.inputBox={};repo.getInputTemplate=async()=>'';
 await repo.commit('Captured',{postCommitCommand:push});assert.equal(requests.at(-1).push,true);
}const repo=new Repository();repo.root='/test';repo.inputBox={};repo.getInputTemplate=async()=>'';repo.indexGroup={resourceStates:[]};
assert.equal(await repo.commit('special',{amend:true}),'native');assert.equal(requests.length,2);
})().catch(e=>{console.error(e);process.exitCode=1});
""".replace('SOURCE', installed)
        subprocess.run(['node', '-e', script], check=True, capture_output=True)

if __name__ == "__main__":
    unittest.main()
