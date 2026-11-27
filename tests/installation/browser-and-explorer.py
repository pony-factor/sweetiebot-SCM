
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


class BrowserAndExplorerTransformTests(unittest.TestCase):
    def test_browser_globe_new_tab_toggle_round_trip(self):
        action = ('id:Fc.OpenOrList,title:O(1,"Browser"),icon:L.globe}'
                  'async run(o){let e=o.get(cd),t=o.get(be);'
                  'if(e.getContextualBrowserViews().size>0){'
                  'await t.executeCommand(Fc.QuickOpen);return}'
                  'await t.executeCommand(Fc.Open)}')
        # A later browser action reuses Open's telemetry variable name for
        # its own editor service, as seen in VS Code 1.148.
        next_action = ('id:Fc.OpenFile,title:O(3,"Open in Integrated Browser")}'
                       'async run(o,n){let b=o.get(EditorService);await b.openEditor(n)}')
        original = workbench_fixture() + action + browser_open_action_fixture() + next_action
        enabled = dict(SETTINGS, browserGlobeNewTab=True)
        patched = install.transform(original, "base-css", settings=enabled)
        self.assertIn(
            'async run(o){return o.get(be).executeCommand(Fc.Open,'
            '{scmToolkitPreferActiveGroup:true});',
            patched[0],
        )
        self.assertIn(
            'c.getPreferredGroup(t.openToSide?SIDE_GROUP:'
            't.scmToolkitPreferActiveGroup?a.activeEditorPane?.group:void 0)',
            patched[0],
        )
        self.assertEqual(install.transform(*patched, remove=True, settings=enabled), (original, "base-css"))
        disabled = install.transform(*patched, settings=dict(enabled, browserGlobeNewTab=False))
        self.assertIn(action, disabled[0])
        self.assertIn(browser_open_action_fixture(), disabled[0])
        with self.assertRaisesRegex(ValueError, "browser globe action"):
            install.browser_globe_new_tab_edits("unsupported")
        with self.assertRaisesRegex(ValueError, "browser globe action"):
            install.browser_globe_new_tab_edits(action + action)
        with self.assertRaisesRegex(ValueError, "browser open action"):
            install.browser_globe_new_tab_edits(action)
        with self.assertRaisesRegex(ValueError, "browser open placement"):
            install.browser_globe_new_tab_edits(action + 'id:Fc.Open,async run(o,n){return 1}')

    def test_browser_globe_homepage_does_not_focus_address_picker(self):
        action = ('id:Fc.OpenOrList,title:O(1,"Browser"),icon:L.globe}'
                  'async run(o){let e=o.get(cd),t=o.get(be);'
                  'if(e.getContextualBrowserViews().size>0){'
                  'await t.executeCommand(Fc.QuickOpen);return}'
                  'await t.executeCommand(Fc.Open)}')
        original = workbench_fixture() + action + browser_open_action_fixture() + browser_resolver_fixture()
        for requested_url in ("https://chatgpt.com/", "https://example.com/chat", ""):
            with self.subTest(url=requested_url):
                enabled = dict(
                    SETTINGS, browserGlobeNewTab=True, browserChatgptHome=True,
                    browserHomeUrl=requested_url,
                )
                patched = install.transform(original, "base-css", settings=enabled)
                destination = requested_url or "https://chatgpt.com/"
                # URL-bearing Open skips the native NewTab URL picker.
                self.assertIn(
                    f'async run(o){{return o.get(be).executeCommand(Fc.Open,'
                    f'{{url:{json.dumps(destination)},scmToolkitPreferActiveGroup:true}});',
                    patched[0],
                )
                self.assertNotIn(
                    'async run(o){return o.get(be).executeCommand(Fc.NewTab);',
                    patched[0],
                )
                self.assertIn(
                    f',url:options?.viewState?.url||{json.dumps(destination)}',
                    patched[0],
                )
                self.assertEqual(
                    install.transform(*patched, remove=True, settings=enabled),
                    (original, "base-css"),
                )

    def test_browser_globe_targets_active_split_without_changing_other_opens(self):
        import shutil

        if not shutil.which("node"):
            self.skipTest("Node.js is unavailable")
        action = ('id:Fc.OpenOrList,title:O(1,"Browser"),icon:L.globe}'
                  'async run(o){let e=o.get(cd),t=o.get(be);'
                  'if(e.getContextualBrowserViews().size>0){'
                  'await t.executeCommand(Fc.QuickOpen);return}'
                  'await t.executeCommand(Fc.Open)}')
        original = action + browser_open_action_fixture()
        patches = install.browser_globe_new_tab_edits(original, "https://chatgpt.com/")
        for old, new in patches:
            self.assertEqual(original.count(old), 1)
            original = original.replace(old, new)
        native_action = original.split('id:Fc.Open,title:O(2,"Open Integrated Browser")}', 1)[1]
        script = (
            'const EditorService="editor",TelemetryService="telemetry",'
            'BrowserService="browser",SIDE_GROUP="side";'
            'const opened=[];'
            'const editor={activeEditorPane:{group:{id:"right"}},'
            'async openEditor(resource,group){opened.push({resource,group})}};'
            'const browser={async getPreferredGroup(group){return group??{id:"first"}}};'
            'const accessor={get(id){return id==="editor"?editor:id==="browser"?browser:{}}};'
            'const native={' + native_action + '};'
            '(async()=>{'
            'await native.run(accessor,{url:"https://chatgpt.com/",scmToolkitPreferActiveGroup:true});'
            'await native.run(accessor,{url:"https://example.com"});'
            'await native.run(accessor,{openToSide:true,scmToolkitPreferActiveGroup:true});'
            'if(opened.length!==3||opened[0].group.id!=="right"'
            '||opened[1].group.id!=="first"||opened[2].group!=="side")'
            'throw Error(JSON.stringify(opened));'
            '})().catch(e=>{console.error(e);process.exit(1)});'
        )
        subprocess.run(["node", "-e", script], check=True, capture_output=True, text=True)

    def test_cross_window_browser_views_reopen_without_reusing_foreign_ids(self):
        original = workbench_fixture() + browser_cross_window_fixture()
        patched, css = install.transform(original, "base-css", settings=SETTINGS)
        self.assertIn(
            "getOrCreateLazy(e){return this._getOrCreateLazy("
            "this._known.has(e.id)?e:{...e,id:globalThis.crypto.randomUUID()})}",
            patched,
        )
        self.assertEqual(
            install.transform(patched, css, remove=True, settings=SETTINGS),
            (original, "base-css"),
        )
        self.assertEqual(
            install.browser_cross_window_reopen_edits(workbench_fixture()), [],
        )

        with self.assertRaisesRegex(ValueError, "browser view window handoff"):
            install.browser_cross_window_reopen_edits(
                "Browser view ID closed during creation"
            )
        with self.assertRaisesRegex(ValueError, "browser view window handoff"):
            install.browser_cross_window_reopen_edits(
                browser_cross_window_fixture() * 2
            )

    def test_cross_window_browser_resolution_preserves_local_views(self):
        import shutil
        import subprocess

        if not shutil.which("node"):
            self.skipTest("Node.js is unavailable")
        # Execute the generated JavaScript, testing copied URL/title and
        # unchanged local view identity as well as the new destination ID.
        snippet = (
            'class ViewService{constructor(known){this._known=new Map(known);}'
            'getOrCreateLazy(e){return this._getOrCreateLazy(e)}'
            '_getOrCreateLazy(e){return e}'
            '}'
        )
        patched = install.browser_cross_window_reopen_edits(
            snippet + 'Browser view ID closed during creation'
        )
        self.assertEqual(len(patched), 1)
        code = (snippet.replace(*patched[0])
            + 'Object.defineProperty(globalThis,"crypto",{configurable:true,value:{randomUUID:()=>"fresh-id"}});'
            + 'const v={id:"old-id",url:"https://example.com",title:"Page"};'
            + 'const fresh=new ViewService().getOrCreateLazy(v);'
            + 'const local=new ViewService([["old-id",{}]]).getOrCreateLazy(v);'
            + 'if(fresh.id!=="fresh-id"||fresh.url!==v.url||fresh.title!==v.title'
            + '||local!==v||v.id!=="old-id")process.exit(1);'
        )
        result = subprocess.run(
            ["node", "-e", code], capture_output=True, text=True, timeout=10
        )
        self.assertEqual(result.returncode, 0, result.stderr)


    def test_chatgpt_browser_home_is_opt_in(self):
        self.assertFalse(install.DEFAULT_SETTINGS["browserChatgptHome"])

        js, _ = install.transform(
            workbench_fixture(), "base-css", settings=SETTINGS
        )

        self.assertNotIn('"https://chatgpt.com/"', js)

    def test_chatgpt_browser_home_preserves_workspace_drafts(self):
        original_js = workbench_fixture() + browser_resolver_fixture()
        enabled = dict(SETTINGS, browserChatgptHome=True)

        patched_js, patched_css = install.transform(
            original_js, "base-css", settings=enabled
        )

        self.assertIn(
            'browserViews.getOrCreateLazy({id:parsed.id,...options?.viewState,'
            'url:options?.viewState?.url||"https://chatgpt.com/"})',
            patched_js,
        )
        restored = install.transform(
            patched_js, patched_css, remove=True, settings=enabled
        )
        self.assertEqual(restored, (original_js, "base-css"))

    def test_browser_home_preserves_sanitized_view_state(self):
        original = (workbench_fixture() + browser_resolver_fixture()).replace(
            '...options?.viewState}', '...sanitize(options?.viewState)}')
        settings = dict(SETTINGS, browserChatgptHome=True)
        patched = install.transform(original, 'base-css', settings=settings)
        self.assertIn(
            '...sanitize(options?.viewState),'
            'url:sanitize(options?.viewState)?.url||"https://chatgpt.com/"}',
            patched[0])
        self.assertEqual(
            install.transform(*patched, remove=True, settings=settings),
            (original, 'base-css'))

    def test_blank_browser_custom_url_round_trip_and_reconfiguration(self):
        original = workbench_fixture() + browser_resolver_fixture()
        enabled = dict(SETTINGS, browserChatgptHome=True, browserHomeUrl="https://example.com/?q=hello")
        patched = install.transform(original, "base-css", settings=enabled)
        self.assertIn('url:options?.viewState?.url||"https://example.com/?q=hello"', patched[0])
        enabled["browserHomeUrl"] = "https://chatgpt.com/"
        updated = install.transform(*patched, settings=enabled)
        self.assertNotIn('url:options?.viewState?.url||"https://example.com/?q=hello"', updated[0])
        self.assertIn('url:options?.viewState?.url||"https://chatgpt.com/"', updated[0])
        self.assertEqual(install.transform(*updated, remove=True, settings=enabled), (original, "base-css"))

    def test_browser_home_preserves_normalized_view_state(self):
        resolver = browser_resolver_fixture().replace(
            "...options?.viewState", "...normalize(options?.viewState)"
        )
        original = workbench_fixture() + resolver
        settings = dict(SETTINGS, browserChatgptHome=True)
        patched = install.transform(original, "base-css", settings=settings)
        self.assertEqual(
            install.transform(*patched, remove=True, settings=settings),
            (original, "base-css"),
        )
        call = install.browser_chatgpt_home_edits(resolver)[0][1]
        code = (
            'const parsed={id:"saved-id"};'
            'function normalize(s){return {url:typeof s?.url==="string"?s.url:undefined,'
            'session:s?.session}};'
            'const browserViews={getOrCreateLazy:data=>data};'
            'for(const url of [undefined,"","https://example.com/draft",123]){'
            'const options={viewState:{url,session:"workspace"}};'
            f'const result={call};'
            'const expected=typeof url==="string"&&url?url:"https://chatgpt.com/";'
            'if(result.url!==expected||result.session!=="workspace"||result.id!=="saved-id")'
            'process.exit(1);}'
        )
        result = subprocess.run(["node", "-e", code], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_blank_project_home_preserves_draft_and_explicit_prompts(self):
        source = workbench_fixture() + browser_resolver_fixture()
        project = "https://chatgpt.com/g/g-p-example123/project"
        for home, expected in [
            (project, project),
            ("https://chatgpt.com/?q=Do%20not%20clear", "https://chatgpt.com/?q=Do%20not%20clear"),
            ("https://example.com/", "https://example.com/"),
        ]:
            enabled = dict(SETTINGS, browserChatgptHome=True, browserHomeUrl=home)
            patched = install.transform(source, "base-css", settings=enabled)
            self.assertIn('url:options?.viewState?.url||' + json.dumps(expected), patched[0])
            self.assertEqual(install.transform(*patched, remove=True, settings=enabled), (source, "base-css"))

    def test_install_and_remove_round_trip(self):
        original_js = workbench_fixture()
        original_css = "base-css"

        patched = install.transform(original_js, original_css, settings=SETTINGS)
        restored = install.transform(*patched, remove=True, settings=SETTINGS)

        self.assertEqual(restored, (original_js, original_css))

    def test_reinstall_replaces_configuration_without_duplicate_markers(self):
        first = install.transform(workbench_fixture(), "base-css", settings=SETTINGS)
        changed = dict(SETTINGS, branchPicker=False)

        second = install.transform(*first, settings=changed)

        self.assertEqual(second[0].count(install.START), 1)
        self.assertEqual(second[0].count(install.END), 1)
        self.assertIn('"branchPicker":false', second[0])
        self.assertNotIn('"branchPicker":true', second[0])

    def test_overlapping_patches_are_removed_in_reverse_order(self):
        changes = [('native-title', 'toolkit-title'), ('toolkit-title', 'toolkit-title-with-repository')]
        with patch.object(install, 'edits', return_value=changes):
            patched = install.transform('native-title', 'base-css', settings=SETTINGS)
            self.assertEqual(install.transform(*patched, settings=SETTINGS), patched)
            self.assertEqual(install.transform(*patched, remove=True), ('native-title', 'base-css'))
            modified = patched[0].replace('toolkit-title-with-repository', 'custom-title', 1)
            with self.assertRaisesRegex(ValueError, 'Installed toolkit patch changed'):
                install.transform(modified, patched[1], remove=True)

    def test_incomplete_installation_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Incomplete toolkit installation"):
            install.transform(workbench_fixture() + install.START, "base-css", settings=SETTINGS)


    def test_explorer_removes_single_root_node_and_labels_contents(self):
        original = workbench_fixture() + pr_explorer_fixture()
        patched = install.transform(original, "base-css", settings=SETTINGS)
        self.assertIn(
            'this.contextService.getWorkbenchState()!==WorkbenchState.FOLDER'
            '&&!scmToolkitIsSingleRoot(this.contextService.getWorkspace(),roots)',
            patched[0],
        )
        self.assertIn('scmToolkitIsSingleRoot(workspace, roots)', patched[0])
        self.assertIn('folders.length===1?this.contextService.getWorkspace().folders[0].name:this.labelService.getWorkspaceLabel', patched[0])
        self.assertEqual(install.transform(*patched, settings=SETTINGS), patched)
        self.assertEqual(
            install.transform(*patched, remove=True, settings=SETTINGS),
            (original, "base-css"),
        )

    def test_explorer_supports_workspace_label_with_location(self):
        original = workbench_fixture() + pr_explorer_fixture().replace(
            'getWorkspaceLabel(this.contextService.getWorkspace())',
            'getWorkspaceLabel(this.contextService.getWorkspace(),{withLocation:!0})')
        patched = install.transform(original, 'base-css', settings=SETTINGS)
        self.assertIn('folders[0].name:this.labelService.getWorkspaceLabel(this.contextService.getWorkspace(),{withLocation:!0})', patched[0])
        self.assertEqual(install.transform(*patched, settings=SETTINGS), patched)
        self.assertEqual(install.transform(*patched, remove=True), (original, 'base-css'))

    def test_pr_explorer_rejects_ambiguous_or_changed_native_anchor(self):
        source = workbench_fixture() + pr_explorer_fixture()
        with self.assertRaisesRegex(ValueError, "Explorer single-root input anchor"):
            install.pr_workspace_explorer_edits(source + pr_explorer_fixture())
        with self.assertRaisesRegex(ValueError, "Explorer single-root input anchor"):
            install.pr_workspace_explorer_edits(
                source.replace(
                    'this.contextService.getWorkbenchState()!==WorkbenchState.FOLDER',
                    'this.contextService.getWorkbenchState()===WorkbenchState.FOLDER',
                ).replace('roots[0].error', 'roots[0].different')
            )
        self.assertEqual(install.pr_workspace_explorer_edits(workbench_fixture()), [])

    def test_explorer_migrates_stale_contents_title_metadata(self):
        source = workbench_fixture() + pr_explorer_fixture()
        patched, css = install.transform(source, 'base-css', settings=SETTINGS)
        before, payload = patched.split(install.START, 1)
        # Reproduce the installed folder-name code with older Contents metadata.
        payload = payload.replace(
            '?this.contextService.getWorkspace().folders[0].name:',
            '?\\"Contents\\":',
        )
        stale = before + install.START + payload
        self.assertNotEqual(stale, patched)
        self.assertEqual(install.transform(stale, css, settings=SETTINGS), (patched, css))
        self.assertEqual(install.transform(stale, css, remove=True), (source, 'base-css'))
        for unexpected in (
            before.replace('folders[0].name:', 'folders[0].path:'),
            before + install.pr_workspace_explorer_edits(source)[1][1],
        ):
            with self.assertRaisesRegex(ValueError, 'Installed toolkit patch changed'):
                install.transform(unexpected + install.START + payload, css, settings=SETTINGS)

    def test_pr_explorer_supports_inlined_folder_state(self):
        original = workbench_fixture() + pr_explorer_fixture().replace(
            'WorkbenchState.FOLDER', '2'
        )
        patched = install.transform(original, 'base-css', settings=SETTINGS)
        self.assertIn(
            'this.contextService.getWorkbenchState()!==2'
            '&&!scmToolkitIsSingleRoot(this.contextService.getWorkspace(),roots)',
            patched[0],
        )
        self.assertEqual(install.transform(*patched, settings=SETTINGS), patched)
        self.assertEqual(install.transform(*patched, remove=True), (original, 'base-css'))

if __name__ == "__main__":
    unittest.main()
