import json
import subprocess
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import branch_names
import build_installer_app
import install
import toolkit_settings


SETTINGS = {
    "branchPicker": True,
    "ponyBranch": True,
    "branchNameDisabledPacks": "",
    "branchCustomNames": "",
    "branchNameImports": "[]",
    "messagePlaceholder": "Message",
    "commitButtonLabel": "Send",
    "commitAndSendButtonLabel": "Send and Push",
    "sourceControlLabel": "Sweetiebot",
    "filledButtons": False,
    "commitAndPush": True,
    "branchCleanup": True,
    "autocompleteToggle": True,
    "autoPublishToggle": True,
    "codexCoauthor": True,
    "codexCoauthorName": "Codex",
    "codexCoauthorEmail": "noreply@openai.com",
    "hideOutgoingSyncCount": True,
    "incomingSyncLabel": "",
    "outgoingSyncLabel": "",
    "blankStateRefresh": True,
    "autoPullClean": True,
    "cmdClickCloseOthers": False,
    "browserChatgptHome": False,
    "graphOpenWorkingFile": True,
    "aiCommit": True,
    "aiDefaultBranchDescription": True,
    "aiCommitModel": "qwen2.5-coder:7b",
    "aiCommitLowMemoryModel": "qwen2.5-coder:3b",
    "aiLowMemoryGiB": "4",
    "aiModelPicker": True,
    "mcpPullRequest": True,
    "mcpPrServer": "codex-drafter",
    "mcpPrTool": "github_create_pull_request",
    "codexUsageResetCountdown": False,
    "codexUsagePieIndicator": False,
    "codexHidePromotions": False,
    "chatgptCustomInstructions": "",
    "chatgptWebCodexCoauthor": True,
    "codexHideChatTimestamps": False,
    "codexHideDictation": False,
    "defaultBranch": "main",
    "remote": "origin",
}


def workbench_fixture():
    return "".join(
        [
            'dispose(){this.disposables?.dispose()}setButton(o){if(this.clear(),!!o){',
            'layout(e,t){if(super.layout(e,t),native(this.configurationService)){this.nativeHostService.updateWindowControls({height:t})}}',
            'cmd=svc("commandService")',
            'registry.registerCommand("noop",()=>{});',
            'paths=svc("pathService");requests=svc("workspaceTrustRequestService");',
            'notify=svc("notificationService")',
            'config=svc("configurationService")',
            'mcp=svc("IMcpService")',
            'function watch(s,o=source.ofCaller()){return new first(new second(void 0,void 0,s),s,void 0,o)}',
            'this.disposables.add(this.toolbar)}static{this.ValidationTimeouts=',
            'this.inputEditor.setModel(void 0),this.model=void 0;return}'
            'let e=o.repository.provider.inputBoxTextModel;',
            'this.toolbar.setInput(o),this.model={input:o,textModel:e}}get selections()',
            't=new size(this.element.clientWidth-e,o);if(t.width<0)',
            'keys.event(e=>this.setAltPressed(e.altKey));',
            'listen(mouse=>{this.setAltPressed(mouse.altKey)},true);',
            'id:"workbench.view.scm",title:localize2("source control","Source Control"),'
            'storageId:"workbench.scm.views.state",'
            'id:"workbench.scm.action.graph.openFile",'
            'async run(){await editor.openEditor({resource:change.modifiedUri,label:'
            '`${name} (${version})`})}',
        ]
    )



def pr_explorer_fixture():
    return (
        'get singleViewPaneContainerTitle(){return this.name}'
        'get autoReveal(){return this._autoReveal}'
        'set autoReveal(e){this._autoReveal=e}'
        'get name(){return this.labelService.getWorkspaceLabel(this.contextService.getWorkspace())}'
        'let root=roots[0];'
        'if(this.contextService.getWorkbenchState()!==WorkbenchState.FOLDER||roots[0].error)root=roots;'
        'this.configurationService.getValue().explorer.expandSingleFolderWorkspaces;'
    )


def browser_cross_window_fixture():
    # Mimics the minified public API next to its model-creation exception.
    return (
        'class BrowserViewWorkbenchService{'
        'getOrCreateLazy(e){return this._getOrCreateLazy(e)}'
        '_getOrCreateLazy(e){'
        'throw new Error("Browser view ID closed during creation")}'
        '}'
    )


def browser_resolver_fixture():
    return (
        'throw new Error(`Invalid browser view resource: ${resource}`);'
        'browserViews.getOrCreateLazy({id:parsed.id,...options?.viewState})'
    )


class TransformTests(unittest.TestCase):
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
            values['scmToolkit.windowHeading']='${rootName} (${activeRepositoryBranchName})';
            title.onConfigurationChanged({affectsConfiguration:key=>key==='scmToolkit.windowHeading'});
            title.doUpdateTitle();
            assert.equal(changes,2,'heading changes refresh the UI even when the native window name stays the same');
            assert.equal(scheduled,1);
            assert.equal(title.getWindowTitle(),'repository (branch)');
            assert.equal(title.getFullWindowTitle(),'file.md — Code');
            assert.equal(title.isCustomTitleFormat(),true);
            values['scmToolkit.windowName']='${rootName} — ${focusedView}';
            title.onConfigurationChanged({affectsConfiguration:key=>key==='scmToolkit.windowName'});
            assert.equal(title.titleIncludesFocusedView,true);
            assert.equal(title.getFullWindowTitle(),'repository — Explorer');
            pending=true;
            assert.equal(title.getWindowTitle(),'repository (branch) — Pushing');
            assert.equal(title.getFullWindowTitle(),'repository — Explorer — Pushing');
            pending=false;
            values['scmToolkit.windowHeading']='';values['scmToolkit.windowName']='';
            assert.equal(title.getWindowTitle(),'file.md — Code');
            assert.equal(title.getFullWindowTitle(),'file.md — Code');
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

    def test_legacy_picker_hooks_are_replaced_in_code_not_saved_metadata(self):
        original = workbench_fixture()
        anchor = 'this.disposables.add(this.toolbar)}static{this.ValidationTimeouts='
        replacement = 'this.disposables.add(this.toolbar);this.studioBranchPicker=legacy()}static{this.ValidationTimeouts='
        legacy = original.replace(anchor, replacement) + '\n/* studio-scm-branch-picker:start */\n/* edits:' + json.dumps([[anchor, replacement]]) + ' */\nfunction legacy(){}\n/* studio-scm-branch-picker:end */'
        legacy_css = 'base-css/* studio-scm-branch-picker:start */.studio{}/* studio-scm-branch-picker:end */'
        installed, css = install.transform(legacy, legacy_css, settings=SETTINGS)
        runtime = installed.split(install.START)[0]
        self.assertIn('this.scmToolkitControls=', runtime)
        self.assertNotIn('studioBranchPicker', installed)
        self.assertNotIn('.studio{}', css)
        self.assertEqual(install.transform(installed, css, settings=SETTINGS), (installed, css))

    def test_progress_animation_can_be_restored_from_gear_settings(self):
        _, css = install.transform(workbench_fixture(), "base-css", settings=dict(SETTINGS, hideSCMProgress=False))
        self.assertNotIn(".monaco-progress-container", css)
        _, css = install.transform(workbench_fixture(), "base-css", settings=dict(SETTINGS, hideSCMProgress=True))
        self.assertIn(".monaco-progress-container", css)

    def test_controls_use_the_vscode_input_background(self):
        css = (install.WORKBENCH_ASSETS / "picker.css").read_text()

        for control in ("delete-branch", "autocomplete", "codex-coauthor", "pull-request", "auto-publish"):
            rule = css.split(f".scm-view .scm-editor > .scm-toolkit-{control} {{", 1)[1].split("}", 1)[0]
            self.assertIn("background: var(--vscode-input-background);", rule)
        for control in ("home", "push"):
            rule = css.split(f".scm-view .scm-editor > .scm-toolkit-{control} {{", 1)[1].split("}", 1)[0]
            self.assertIn("background: transparent;", rule)

    def test_branch_selector_uses_the_vscode_button_colors(self):
        css = (install.WORKBENCH_ASSETS / "picker.css").read_text()

        self.assertIn("background: var(--vscode-button-background);", css)
        self.assertIn("color: var(--vscode-button-foreground);", css)
        self.assertIn("background: var(--vscode-button-hoverBackground);", css)

    def test_unfilled_buttons_match_their_background_with_a_border(self):
        css = (install.WORKBENCH_ASSETS / "outlined_buttons.css").read_text()

        self.assertIn(
            ".scm-view:not(.scm-history-view) .button-container > .monaco-button-dropdown", css
        )
        self.assertIn(
            "border: 1px solid var(--vscode-button-border, var(--vscode-widget-border));",
            css,
        )
        self.assertEqual(css.count("--vscode-button-background: transparent;"), 2)
        self.assertIn("background: transparent !important;", css)
        self.assertNotIn(".scm-toolkit-settings::before", css)
        self.assertNotIn(".scm-view .button-container >", css)

    def test_filled_button_setting_controls_outlined_stylesheet(self):
        _, outlined_css = install.transform(
            workbench_fixture(), "base-css", settings=SETTINGS
        )
        _, filled_css = install.transform(
            workbench_fixture(),
            "base-css",
            settings=dict(SETTINGS, filledButtons=True),
        )

        selector = ".scm-view:not(.scm-history-view) .button-container > .monaco-button-dropdown"
        self.assertIn(selector, outlined_css)
        self.assertNotIn(selector, filled_css)

    def test_push_control_is_centered_without_a_divider(self):
        css = (install.WORKBENCH_ASSETS / "picker.css").read_text()
        push_css = css.split(
            ".scm-view .scm-editor > .scm-toolkit-push {", 1
        )[1].split(
            ".scm-view .scm-editor > .scm-toolkit-push[hidden]", 1
        )[0]

        self.assertNotIn("border-left", push_css)
        self.assertIn("height: 22px;", push_css)
        self.assertIn("margin: 2px 2px 2px 0;", push_css)
        self.assertIn("border-radius: var(--vscode-cornerRadius-small, 4px);", push_css)

    def test_right_side_controls_have_no_vertical_dividers(self):
        css = (install.WORKBENCH_ASSETS / "picker.css").read_text()

        for selector in (
            "scm-toolkit-delete-branch",
            "scm-toolkit-autocomplete",
            "scm-toolkit-codex-coauthor",
            "scm-toolkit-pull-request",
            "scm-toolkit-auto-publish",
        ):
            control_css = css.split(
                f".scm-view .scm-editor > .{selector} {{", 1
            )[1].split(
                f".scm-view .scm-editor > .{selector}[hidden]", 1
            )[0]
            self.assertNotIn("border-left", control_css)

    def test_sync_control_uses_studio_toolbar_style(self):
        css = (install.WORKBENCH_ASSETS / "picker.css").read_text()
        sync_css = css.split(
            ".scm-view .scm-editor > .scm-toolkit-sync-branch {", 1
        )[1].split(
            ".scm-view .scm-editor > .scm-toolkit-sync-branch[hidden]", 1
        )[0]

        self.assertIn("background: transparent;", sync_css)
        self.assertIn("color: var(--vscode-descriptionForeground);", sync_css)
        self.assertIn(
            ".scm-view .scm-editor > .scm-toolkit-sync-branch:hover:not(:disabled)",
            css,
        )

    def test_install_injects_valid_settings_line(self):
        js, css = install.transform(workbench_fixture(), "base-css", settings=SETTINGS)

        self.assertIn("const scmToolkitSettings = ", js)
        self.assertIn("editor.inlineSuggest.enabled", js)
        self.assertIn("commands.executeCommand('sweetiebot.refreshRepository', repositoryArgument)", js)
        self.assertNotIn("scm-toolkit-refreshing", js)
        self.assertIn("historyItemRemoteRef.get()", js)
        self.assertIn("resolveHistoryItemRefsCommonAncestor", js)
        self.assertIn("commands.executeCommand('sweetiebot.autoPullClean', repositoryArgument)", js)
        self.assertIn("scm-toolkit-autocomplete", css)
        self.assertIn("scm-toolkit-auto-publish", css)
        # Two initial dividers plus the factory for additional saved separators.
        self.assertEqual(js.count("className = 'scm-toolkit-divider'"), 3)
        self.assertIn("scmToolkitCustomizeSyncLabels", js)
        self.assertIn("settings.incomingSyncLabel", js)
        self.assertIn("settings.outgoingSyncLabel", js)
        self.assertIn("scmToolkitCustomizeCommitButtonLabel", js)
        self.assertIn("scmToolkitCustomizeMessagePlaceholder", js)
        self.assertIn("settings.commitAndSendButtonLabel", js)
        self.assertIn("configuration.getValue('scmToolkit.messagePlaceholder')", js)
        self.assertIn("configuredLabel('commitButtonLabel'", js)
        self.assertIn("configuredLabel(", js)
        self.assertIn("'commitAndSendButtonLabel'", js)
        self.assertIn("event.affectsConfiguration('scmToolkit.messagePlaceholder')", js)
        self.assertIn("event.affectsConfiguration('scmToolkit.commitButtonLabel')", js)
        self.assertIn("configuration.getValue('git.postCommitCommand') === 'push'", js)
        self.assertIn("'.button-container > .monaco-button:first-child'", js)
        self.assertIn("'sweetiebot.publishBranch'", js)
        self.assertIn("scmToolkit.autoPublishNewBranches", js)
        self.assertIn('[id="workbench.view.scm"] .monaco-progress-container', css)
        self.assertIn(".pane:has(.scm-view) > .monaco-progress-container", css)
        self.assertEqual(js.count("className = 'scm-toolkit-tooltip'"), 6)
        self.assertIn("scm-toolkit-stacked-branch codicon codicon-layers", js)
        self.assertIn("sweetiebot.createStackedBranch", js)
        self.assertIn(".scm-toolkit-autocomplete:hover > .scm-toolkit-tooltip", css)
        self.assertIn("Co-authored-by: Codex <noreply@openai.com>", js)
        self.assertIn("currentInput?.repository.provider.acceptInputCommand", js)
        self.assertIn("currentCommitCommand?.id", js)
        self.assertIn("'sweetiebot.commitWithCodex', repositoryUri,", js)
        self.assertNotIn("commands.executeCommand('git.commit', currentRepositoryArgument)", js)
        self.assertIn("scmToolkitGuardCommit(", js)
        self.assertIn("'sweetiebot.checkCommitLimits'", js)
        self.assertIn("postCommitCommand: null", js)
        self.assertIn("scmToolkitPushWithPullRetry(repository, originalPush, selectedBranch)", js)
        self.assertIn("error?.gitErrorCode !== 'PushRejected'", js)
        self.assertIn("await repository.fetch({ remote: head.upstream.remote, ref: head.upstream.name })", js)
        self.assertIn("await repository.merge(`refs/remotes/${head.upstream.remote}/${head.upstream.name}`)", js)
        self.assertIn("await originalPush.call(repository, repository.HEAD)", js)
        self.assertIn("commands.executeCommand('sweetiebot.openPullRequestChat', repository, options)", js)
        self.assertIn("commands.executeCommand('sweetiebot.createLocalPullRequest', repository, options)", js)
        self.assertIn("SweetiebotBrowserUnavailable", js)
        self.assertIn("mcpService.activateCollections()", js)
        self.assertIn("'github_comment_pull_request_source'", js)
        self.assertIn("scm-toolkit-pull-request", css)
        self.assertIn("scm-toolkit-pony-branch", css)
        self.assertIn("scmToolkitBranchNamePool", js)
        runtime_json = js.split("const scmToolkitSettings = ", 1)[1].split(";\n/* edits:", 1)[0]
        runtime = json.loads(runtime_json)
        self.assertEqual(runtime["messagePlaceholder"], "Message")
        self.assertEqual(
            runtime["branchNamePacks"],
            branch_names.load_catalog()["packs"],
        )
        self.assertEqual(runtime["branchNameDisabledPacks"], [])
        self.assertEqual(runtime["branchCustomNames"], [])
        self.assertIn("commands.executeCommand('sweetiebot.createBranch', repository, {", js)
        self.assertIn("currentRepositoryUri = provider.rootUri;", js)
        self.assertIn("'sweetiebot.resolveDefaultBranch', provider.rootUri", js)
        self.assertIn('onCommand:sweetiebot.resolveDefaultBranch', (install.HERE.parent / 'efs/package.json').read_text())
        self.assertIn("currentDefaultBranch = branch;", js)
        self.assertIn("currentBranch === currentDefaultBranch", js)
        self.assertNotIn("currentBranch === 'main'", js)
        self.assertIn("const repository = currentRepositoryUri;", js)
        self.assertIn("const repositoryArgument = currentRepositoryUri;", js)
        self.assertIn("commands.executeCommand('sweetiebot.deleteBranch', repositoryArgument, {", js)
        self.assertIn("scm-toolkit-sync-branch", css)
        self.assertIn("settingsIcon.textContent = '🪄'", js)
        self.assertIn("commands.executeCommand('sweetiebot.openSettings')", js)
        self.assertIn("scm-toolkit-settings", css)
        self.assertIn("commands.executeCommand('sweetiebot.syncBranch', repository, {", js)
        self.assertIn("typeof repository.merge !== 'function'", js)
        self.assertNotIn("resolveMergeConflicts", js)
        self.assertEqual(js.count(install.START), 1)
        self.assertEqual(js.count(install.END), 1)
        self.assertEqual(css.count(install.START), 1)
        self.assertEqual(css.count(install.END), 1)

    def test_source_control_label_defaults_to_sweetiebot(self):
        self.assertEqual(install.DEFAULT_SETTINGS["sourceControlLabel"], "Sweetiebot")

    def test_commit_button_label_defaults_to_send(self):
        self.assertEqual(install.DEFAULT_SETTINGS["messagePlaceholder"], "Message")
        self.assertEqual(install.DEFAULT_SETTINGS["commitButtonLabel"], "Send")
        self.assertEqual(install.DEFAULT_SETTINGS["commitAndSendButtonLabel"], "Send")
        self.assertTrue(install.DEFAULT_SETTINGS["autoPublishToggle"])

    def test_source_control_label_patches_view_container_title(self):
        js, _ = install.transform(workbench_fixture(), "base-css", settings=SETTINGS)

        self.assertIn(
            'title:{"value": "Sweetiebot", "original": "Sweetiebot"},'
            'storageId:"workbench.scm.views.state"',
            js.split(install.START, 1)[0],
        )

    def test_source_control_label_can_restore_stock_name(self):
        stock = dict(SETTINGS, sourceControlLabel="Source Control")
        js, _ = install.transform(workbench_fixture(), "base-css", settings=stock)

        self.assertIn(
            'title:localize2("source control","Source Control"),'
            'storageId:"workbench.scm.views.state"',
            js.split(install.START, 1)[0],
        )

    def test_source_control_label_bypasses_numeric_localization(self):
        original = workbench_fixture().replace(
            'localize2("source control","Source Control")',
            'O(21166,"Source Control")',
        )
        settings = dict(SETTINGS, sourceControlLabel='My "SCM"')
        patched = install.transform(original, "base-css", settings=settings)
        self.assertIn(
            'title:' + json.dumps({"value": 'My "SCM"', "original": 'My "SCM"'}),
            patched[0].split(install.START, 1)[0],
        )
        self.assertNotIn('O(21166,', patched[0].split(install.START, 1)[0])
        self.assertEqual(install.transform(*patched, settings=settings), patched)
        self.assertEqual(
            install.transform(*patched, remove=True, settings=settings),
            (original, "base-css"),
        )

    def test_source_control_label_round_trip(self):
        original_js = workbench_fixture()
        original_css = "base-css"

        patched = install.transform(original_js, original_css, settings=SETTINGS)
        restored = install.transform(*patched, remove=True, settings=SETTINGS)

        self.assertEqual(restored, (original_js, original_css))

    def test_source_control_label_follows_changes_into_panel(self):
        original = workbench_fixture() + (
            ';panelTitle=d(21169,null);'
            'views.registerViews([{id:changes,containerTitle:panelTitle,'
            'name:O(21159,"Changes"),singleViewPaneContainerTitle:panelTitle}],container);'
        )
        patched = install.transform(original, "base-css", settings=SETTINGS)
        self.assertIn('panelTitle="Sweetiebot"', patched[0].split(install.START, 1)[0])
        self.assertEqual(install.transform(*patched, settings=SETTINGS), patched)
        self.assertEqual(install.transform(*patched, remove=True, settings=SETTINGS), (original, "base-css"))

    def test_cmd_click_close_others_is_off_by_default(self):
        self.assertFalse(install.DEFAULT_SETTINGS["cmdClickCloseOthers"])

    def test_cmd_click_close_others_extends_native_modifier(self):
        enabled = dict(SETTINGS, cmdClickCloseOthers=True)
        js, _ = install.transform(workbench_fixture(), "base-css", settings=enabled)

        self.assertIn(
            "this.setAltPressed(e.altKey||scmToolkitSettings.cmdClickCloseOthers&&e.metaKey)",
            js,
        )
        self.assertIn(
            "this.setAltPressed(mouse.altKey||scmToolkitSettings.cmdClickCloseOthers&&mouse.metaKey)",
            js,
        )

    def test_cmd_click_close_others_round_trip(self):
        original_js = workbench_fixture()
        original_css = "base-css"
        enabled = dict(SETTINGS, cmdClickCloseOthers=True)

        patched = install.transform(original_js, original_css, settings=enabled)
        restored = install.transform(*patched, remove=True, settings=enabled)

        self.assertEqual(restored, (original_js, original_css))

    def test_graph_open_working_file_is_on_by_default(self):
        self.assertTrue(install.DEFAULT_SETTINGS["graphOpenWorkingFile"])

    def test_graph_open_working_file_retargets_history_uri(self):
        js, _ = install.transform(workbench_fixture(), "base-css", settings=SETTINGS)

        self.assertIn(
            'resource:change.modifiedUri.with({scheme:"file",query:""}),label:',
            js,
        )
        self.assertNotIn(
            "resource:change.modifiedUri,label:",
            js.split(install.START, 1)[0],
        )

    def test_graph_open_working_file_can_be_disabled(self):
        disabled = dict(SETTINGS, graphOpenWorkingFile=False)
        js, _ = install.transform(workbench_fixture(), "base-css", settings=disabled)

        self.assertIn("resource:change.modifiedUri,label:", js)
        self.assertNotIn('.modifiedUri.with({scheme:"file",query:""})', js)

    def test_graph_open_working_file_round_trip(self):
        original_js = workbench_fixture()
        original_css = "base-css"

        patched = install.transform(original_js, original_css, settings=SETTINGS)
        restored = install.transform(*patched, remove=True, settings=SETTINGS)

        self.assertEqual(restored, (original_js, original_css))

    def test_browser_globe_new_tab_toggle_round_trip(self):
        action = ('id:Fc.OpenOrList,title:O(1,"Browser"),icon:L.globe}'
                  'async run(o){let e=o.get(cd),t=o.get(be);'
                  'if(e.getContextualBrowserViews().size>0){'
                  'await t.executeCommand(Fc.QuickOpen);return}'
                  'await t.executeCommand(Fc.Open)}')
        original = workbench_fixture() + action
        enabled = dict(SETTINGS, browserGlobeNewTab=True)
        patched = install.transform(original, "base-css", settings=enabled)
        self.assertIn('async run(o){return o.get(be).executeCommand(Fc.NewTab);', patched[0])
        self.assertEqual(install.transform(*patched, remove=True, settings=enabled), (original, "base-css"))
        disabled = install.transform(*patched, settings=dict(enabled, browserGlobeNewTab=False))
        self.assertIn(action, disabled[0])
        with self.assertRaisesRegex(ValueError, "browser globe action"):
            install.browser_globe_new_tab_edits("unsupported")
        with self.assertRaisesRegex(ValueError, "browser globe action"):
            install.browser_globe_new_tab_edits(action + action)


    def test_browser_globe_homepage_does_not_focus_address_picker(self):
        action = ('id:Fc.OpenOrList,title:O(1,"Browser"),icon:L.globe}'
                  'async run(o){let e=o.get(cd),t=o.get(be);'
                  'if(e.getContextualBrowserViews().size>0){'
                  'await t.executeCommand(Fc.QuickOpen);return}'
                  'await t.executeCommand(Fc.Open)}')
        original = workbench_fixture() + action + browser_resolver_fixture()
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
                    f'async run(o){{return o.get(be).executeCommand(Fc.Open,{json.dumps(destination)});',
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



class AiWrapperTests(unittest.TestCase):
    def test_sync_ai_wrapper_installs_executable_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "bin" / "scm-toolkit-git"
            self.assertTrue(install.sync_ai_wrapper(check=True, destination=destination))
            self.assertFalse(destination.exists())

            self.assertTrue(install.sync_ai_wrapper(destination=destination))
            self.assertEqual(destination.read_bytes(), (install.HERE / "ai_commit.py").read_bytes())
            diagnostics = destination.with_name("sweetiebot_diagnostics.py")
            self.assertEqual(diagnostics.read_bytes(), (install.HERE / "sweetiebot_diagnostics.py").read_bytes())
            async_worker = destination.with_name("sweetiebot_async_commit.py")
            self.assertEqual(async_worker.read_bytes(), (install.HERE / "sweetiebot_async_commit.py").read_bytes())
            self.assertTrue(destination.stat().st_mode & 0o111)
            self.assertFalse(install.sync_ai_wrapper(check=True, destination=destination))

    def test_canonical_installer_call_migrates_existing_legacy_wrapper(self):
        with tempfile.TemporaryDirectory() as tmp:
            primary = Path(tmp) / "bin" / "scm-toolkit-git"
            legacy = Path(tmp) / "bin" / "git-auto-title"
            legacy.parent.mkdir(parents=True)
            legacy.write_text("stale wrapper", encoding="utf-8")

            with patch.object(install, "ai_wrapper_path", return_value=primary), patch.object(
                install, "legacy_ai_wrapper_path", return_value=legacy
            ):
                # Match the normal installer call shape: it supplies the
                # canonical destination explicitly.
                self.assertTrue(
                    install.sync_ai_wrapper(check=True, destination=primary)
                )
                self.assertFalse(legacy.is_symlink())
                self.assertTrue(install.sync_ai_wrapper(destination=primary))
                self.assertFalse(
                    install.sync_ai_wrapper(check=True, destination=primary)
                )

            expected = (install.HERE / "ai_commit.py").read_bytes()
            helper = legacy.with_name(legacy.name + "-spellcheck.py")
            primary_helper = primary.with_name(primary.name + "-spellcheck.py")
            self.assertEqual(primary.read_bytes(), expected)
            self.assertTrue(legacy.is_symlink())
            self.assertEqual(legacy.resolve(), primary.resolve())
            self.assertTrue(helper.is_symlink())
            self.assertEqual(helper.resolve(), primary_helper.resolve())
            self.assertEqual(legacy.read_bytes(), expected)
            self.assertTrue(legacy.stat().st_mode & 0o111)

    def test_custom_wrapper_destination_does_not_rewrite_legacy_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            canonical = Path(tmp) / "bin" / "scm-toolkit-git"
            custom = Path(tmp) / "custom" / "git"
            legacy = Path(tmp) / "bin" / "git-auto-title"
            legacy.parent.mkdir(parents=True)
            legacy.write_text("leave me alone", encoding="utf-8")

            with patch.object(install, "ai_wrapper_path", return_value=canonical), patch.object(
                install, "legacy_ai_wrapper_path", return_value=legacy
            ):
                self.assertTrue(install.sync_ai_wrapper(destination=custom))

            self.assertFalse(legacy.is_symlink())
            self.assertEqual(legacy.read_text(encoding="utf-8"), "leave me alone")

    def test_installed_wrapper_loads_spellcheck_helper_and_core(self):
        import importlib.util
        from importlib.machinery import SourceFileLoader
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "scm-toolkit-git"
            install.sync_ai_wrapper(destination=destination)
            loader = SourceFileLoader("installed_commit_core", str(destination))
            spec = importlib.util.spec_from_file_location("installed_commit_core", destination, loader=loader)
            core = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(core)
            worker = core.load_post_commit_spellcheck()
            helper = destination.with_name(destination.name + "-spellcheck.py")
            self.assertEqual(helper.read_bytes(), (install.HERE / "post_commit_spellcheck.py").read_bytes())
            with patch.object(worker, "CORE_PATH", str(destination)):
                self.assertTrue(callable(worker.load_core().generate_message))
            install.sync_ai_wrapper(remove=True, destination=destination)
            self.assertFalse(helper.exists())
            self.assertFalse(destination.with_name("sweetiebot_diagnostics.py").exists())
            self.assertFalse(destination.with_name("sweetiebot_async_commit.py").exists())

    def test_sync_ai_wrapper_uninstall_removes_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "scm-toolkit-git"
            install.sync_ai_wrapper(destination=destination)
            self.assertTrue(install.sync_ai_wrapper(remove=True, check=True, destination=destination))
            self.assertTrue(destination.exists())
            install.sync_ai_wrapper(remove=True, destination=destination)
            self.assertFalse(destination.exists())
            self.assertFalse(destination.with_name("sweetiebot_diagnostics.py").exists())
            self.assertFalse(destination.with_name("sweetiebot_async_commit.py").exists())


    def test_sync_model_picker_installs_executable_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "bin" / "scm-toolkit-models"
            self.assertTrue(
                install.sync_model_picker(
                    enabled=True, check=True, destination=destination
                )
            )
            self.assertFalse(destination.exists())

            self.assertTrue(
                install.sync_model_picker(enabled=True, destination=destination)
            )
            self.assertEqual(
                destination.read_bytes(),
                (install.HERE / "model_picker.py").read_bytes(),
            )
            self.assertTrue(destination.stat().st_mode & 0o111)

    def test_disabling_model_picker_removes_installed_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "scm-toolkit-models"
            install.sync_model_picker(enabled=True, destination=destination)
            self.assertTrue(destination.exists())

            self.assertTrue(
                install.sync_model_picker(
                    enabled=False, check=True, destination=destination
                )
            )
            self.assertTrue(destination.exists())
            install.sync_model_picker(enabled=False, destination=destination)
            self.assertFalse(destination.exists())


class GitConfigTests(unittest.TestCase):
    def test_every_default_has_a_git_config_key(self):
        self.assertEqual(
            set(toolkit_settings.DEFAULT_SETTINGS),
            set(toolkit_settings.SETTING_KEYS),
        )

    @patch("toolkit_settings.subprocess.run")
    def test_boolean_git_config_uses_parsed_value(self, run):
        run.return_value = types.SimpleNamespace(returncode=0, stdout="true\n", stderr="")
        self.assertTrue(install.read_git_bool("scm-toolkit.branch-picker", False))

    @patch("toolkit_settings.subprocess.run")
    def test_missing_boolean_git_config_uses_default(self, run):
        run.return_value = types.SimpleNamespace(returncode=1, stdout="", stderr="")
        self.assertTrue(install.read_git_bool("scm-toolkit.branch-picker", True))

    def test_manual_commit_spellcheck_is_preview_only(self):
        self.assertFalse(install.DEFAULT_SETTINGS["spellcheckManualCommit"])
        self.assertEqual(
            toolkit_settings.SETTING_KEYS["spellcheckManualCommit"],
            "scm-toolkit.spellcheck-preview",
        )

    @patch("toolkit_settings.subprocess.run")
    def test_string_git_config_uses_value(self, run):
        run.return_value = types.SimpleNamespace(returncode=0, stdout="upstream\n", stderr="")
        self.assertEqual(install.read_git_string("scm-toolkit.remote", "origin"), "upstream")


class CodexCountdownTests(unittest.TestCase):
    def modern_fixture(self):
        return (
            'let e=n.reset_at==null?null:format(d,n.reset_at,true);'
            'x=e==null?n.title:n.title.replaceAll(`{time}`,e),'
            'b=e==null?n.description:n.description.replaceAll(`{time}`,e),other=true;'
            '(0,J.jsx)(`span`,{children:b});'
            'const id=`codex.rateLimitUpsellBanner.dismiss`;'
            'let f=a.weeklyWindow.resetsAt==null?null:format(d,a.weeklyWindow.resetsAt,true);'
            '(0,J.jsx)(Button,{});'
            'pe=f==null?S.description:S.description.replace(`{time}`,f),unused=true;'
        )

    def test_backend_banner_and_weekly_reset_round_trip(self):
        original = self.modern_fixture()
        patched = install.transform_codex(original, enabled=True)
        self.assertIn('scmToolkitUsageResetMessage(n.title,n.reset_at,J.jsx)', patched)
        self.assertIn('scmToolkitUsageResetMessage(n.description,n.reset_at,J.jsx)', patched)
        self.assertIn('scmToolkitUsageResetMessage(S.description,a.weeklyWindow.resetsAt,J.jsx)', patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)
        self.assertTrue(install.codex_bundle_matches(original))
        self.assertEqual(install.transform_codex(patched, enabled=True), patched)

    def test_transcript_reset_uses_live_countdown_and_restores_original(self):
        transcript = (
            'u=e==null?null:format(r,e);'
            '(0,J.jsx)(Message,{id:`localConversation.usageLimit.upgrade.noReset`});'
        )
        for variant in ('upgrade', 'upgradeOrAddCredits', 'addCredits', 'retry'):
            transcript += (
                '(0,J.jsx)(Message,{id:`localConversation.usageLimit.' + variant + '`, '
                'defaultMessage:`Try again at {resetDate}.`,values:{resetDate:r}});'
            ).replace('`, defaultMessage:', '`,defaultMessage:')
        original = self.modern_fixture() + transcript
        patched = install.transform_codex(original, enabled=True)
        self.assertIn('u=e==null?null:(0,J.jsx)(`scm-toolkit-usage-reset-countdown`,{"reset-at":e})', patched)
        self.assertIn('usageLimit.upgradeOrAddCredits.countdown', patched)
        self.assertIn('defaultMessage:`Try again in {resetDate}.`', patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)
        self.assertEqual(install.transform_codex(patched, enabled=True), patched)

        # Reset-time hiding must preserve the native transcript formatter.
        hidden = install.transform_codex(patched, hide_reset_times=True)
        self.assertIn('u=e==null?null:format(r,e);', hidden)
        self.assertNotIn('usageLimit.upgradeOrAddCredits.countdown', hidden)
        self.assertEqual(install.transform_codex(hidden, hide_reset_times=True), hidden)
        self.assertEqual(install.transform_codex(hidden, remove=True), original)
        self.assertEqual(install.transform_codex(hidden, enabled=True), patched)

    def test_installer_app_includes_bundled_twilight_artwork(self):
        self.assertIn(Path("assets/imgs/twi-stop.png"), build_installer_app.source_files())

    def test_semantic_rate_limit_bundle_can_be_discovered_after_copy_changes(self):
        source = 'const view={"data-composer-navigation-target":true,"data-testid":"codex-rate-limit-alert",role:"alert"};'
        self.assertTrue(install.codex_bundle_matches(source))
        changed = install.transform_codex(source, sticker_enabled=False)
        self.assertIn(install.CODEX_LIMIT_START, changed)
        self.assertIn("scmToolkitSemanticRateLimitNodes", changed)
        self.assertEqual(install.transform_codex(changed, remove=True), source)
        self.assertFalse(install.codex_bundle_matches('const docs="quota limit";'))

    def test_sticker_can_be_disabled_without_disabling_compaction(self):
        original = 'const modernStatus = "You’re out of Codex messages";'
        disabled = install.transform_codex(original, sticker_enabled=False)
        self.assertIn(install.CODEX_LIMIT_START, disabled)
        self.assertIn("scmToolkitCompactUntimedRateLimitBranch", disabled)
        self.assertIn("const scmToolkitRateLimitStickerEnabled = false;", disabled)
        self.assertNotIn("data:image/png;base64,", disabled)
        self.assertEqual(install.transform_codex(disabled, sticker_enabled=False), disabled)
        self.assertEqual(install.transform_codex(disabled, remove=True), original)

    def test_rate_limit_sticker_works_without_legacy_transcript_ids(self):
        original = 'const modernStatus = "You’re out of Codex messages";'
        patched = install.transform_codex(original)
        self.assertIn(install.CODEX_LIMIT_START, patched)
        self.assertIn("data:image/png;base64,", patched)
        self.assertNotIn("__SCM_TOOLKIT_TWILIGHT_STOP_IMAGE__", patched)
        self.assertIn("scmToolkitFooterRateLimitNotice", patched)
        self.assertEqual(install.transform_codex(patched), patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_rate_limited_transcript_compaction_preserves_timed_messages(self):
        no_reset = (
            "(0,J.jsx)(Message,{id:`localConversation.usageLimit.upgrade.noReset`,"
            "defaultMessage:`You've hit your usage limit. Upgrade your plan or "
            "add credits to continue, or try again later.`});"
        )
        timed = (
            "(0,J.jsx)(Message,{id:`localConversation.usageLimit.retry`,"
            "defaultMessage:`Try again at {resetDate}.`});"
        )
        original = no_reset + timed
        patched = install.transform_codex(original)
        self.assertIn("localConversation.usageLimit.upgrade.noReset.scmShort", patched)
        self.assertIn("defaultMessage:`Rate limited`", patched)
        self.assertIn("defaultMessage:`Try again at {resetDate}.`", patched)
        self.assertIn("scmToolkitSyncResetShortcut", patched)
        self.assertEqual(install.transform_codex(patched), patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_transcript_compaction_never_targets_unrelated_messages(self):
        original = "(0,J.jsx)(Message,{id:`other.noReset`,defaultMessage:`Try again later.`});"
        self.assertEqual(install.transform_codex(original), original)

    def test_previous_transcript_reset_edit_is_restored(self):
        original = 'u=e==null?null:format(r,e);'
        replacement = 'u=null/* scm-toolkit-hide-transcript-reset */'
        installed = original.replace(original[:-1], replacement)
        installed += install.CODEX_HIDE_RESET_START
        installed += '/* edits:' + json.dumps([[original[:-1], replacement]]) + ' */\n'
        installed += install.CODEX_HIDE_RESET_END
        self.assertEqual(install.transform_codex(installed, remove=True), original)
        repaired = install.transform_codex(installed, hide_reset_times=True)
        self.assertTrue(repaired.startswith(original))
        self.assertEqual(install.transform_codex(repaired, remove=True), original)

    def test_legacy_countdown_metadata_can_still_be_removed(self):
        original = self.fixture()
        before, after = install.codex_countdown_edit(original)
        patched = original.replace(before, after) + install.CODEX_START
        patched += '/* edit:' + json.dumps([before, after]) + ' */\n' + install.CODEX_END
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def fixture(self):
        return (
            "function banner(){let V={},ne=123,We=false,Ge="
            "ne==null?null:oE(V,ne,We),unused=true;"
            "return (0,L4.jsx)(Y,{id:`codex.upsellBanner.general.title`,"
            "defaultMessage:`You’re out of Codex messages`,"
            "values:{resetDate:Ge}})}"
        )

    def test_countdown_is_off_by_default(self):
        self.assertFalse(install.DEFAULT_SETTINGS["codexUsageResetCountdown"])
        self.assertFalse(install.DEFAULT_SETTINGS["codexUsagePieIndicator"])
        self.assertFalse(install.DEFAULT_SETTINGS["codexHideUsageResetTimes"])

    def test_hide_reset_times_without_countdown(self):
        original = self.modern_fixture()
        patched = install.transform_codex(original, hide_reset_times=True)
        self.assertIn(install.CODEX_HIDE_RESET_START, patched)
        self.assertNotIn(install.CODEX_START, patched)
        self.assertEqual(install.transform_codex(patched, hide_reset_times=True), patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_codex_countdown_install_and_remove_round_trip(self):
        original = self.fixture()
        patched = install.transform_codex(original, enabled=True)

        self.assertIn("scm-toolkit-usage-reset-countdown", patched)
        self.assertIn('"reset-at":ne', patched)
        self.assertEqual(patched.count(install.CODEX_START), 1)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_codex_countdown_disabled_removes_existing_patch(self):
        original = self.fixture()
        patched = install.transform_codex(original, enabled=True)

        without_countdown = install.transform_codex(patched, enabled=False)
        self.assertNotIn(install.CODEX_START, without_countdown)
        self.assertIn(install.CODEX_LIMIT_START, without_countdown)
        self.assertEqual(without_countdown, install.transform_codex(original, enabled=False))
        self.assertEqual(install.transform_codex(without_countdown, remove=True), original)


class CodexPromotionTests(unittest.TestCase):
    def test_split_usage_and_promotion_chunks_are_both_discovered(self):
        with tempfile.TemporaryDirectory() as directory:
            extension = Path(directory)
            assets = extension / 'webview/assets'
            assets.mkdir(parents=True)
            banner = assets / 'usage-new-hash.js'
            banner.write_text(CodexCountdownTests().modern_fixture())
            promo = assets / 'promotion-new-hash.js'
            promo.write_text('const title=`Enable Fast mode`;')
            (assets / 'locale.js').write_text('"codex.rateLimitUpsellBanner.dismiss":"Dismiss usage banner"')
            self.assertEqual(set(install.codex_bundle_paths(extension)), {banner, promo})
            self.assertEqual(install.codex_bundle_path(extension), banner)

    def test_bundle_discovery_supports_split_extension_chunks(self):
        with tempfile.TemporaryDirectory() as directory:
            extension = Path(directory)
            assets = extension / "webview/assets"
            assets.mkdir(parents=True)
            (assets / "app-initial-test.js").write_text("const app = {};")
            bundle = assets / "home-announcement-state-test.js"
            bundle.write_text("const title=`Enable Fast mode`;")
            self.assertEqual(install.codex_bundle_path(extension), bundle)

    def test_promotion_hiding_is_off_by_default(self):
        self.assertFalse(install.DEFAULT_SETTINGS["codexHidePromotions"])

    def test_codex_promotion_install_and_remove_round_trip(self):
        original = "const promo=`Enable Fast mode`;const action=`Enable now`;"
        patched = install.transform_codex(original, hide_promotions=True)

        self.assertIn("scm-toolkit-codex-promotions:start", patched)
        self.assertIn("Enable Fast mode", patched)
        self.assertIn("Enable now", patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_promotions_and_countdown_can_coexist(self):
        original = CodexCountdownTests().fixture()
        patched = install.transform_codex(
            original, enabled=True, hide_promotions=True
        )

        self.assertIn("scm-toolkit-usage-reset-countdown", patched)
        self.assertIn("scm-toolkit-codex-promotions:start", patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_bundle_match_accepts_fast_mode_promotion(self):
        self.assertTrue(
            install.codex_bundle_matches(
                "const title=`Enable Fast mode`;const action=`Enable now`;"
            )
        )


class CodexTimestampTests(unittest.TestCase):
    def test_chat_timestamp_hiding_is_off_by_default(self):
        self.assertFalse(install.DEFAULT_SETTINGS["codexHideChatTimestamps"])

    def test_codex_timestamp_hiding_install_and_remove_round_trip(self):
        original = "const app='codex';"
        patched = install.transform_codex(original, hide_timestamps=True)

        self.assertIn("scm-toolkit-codex-timestamps:start", patched)
        self.assertIn("data-scm-toolkit-hidden-chat-timestamp", patched)
        self.assertIn("looksLikeTimestamp", patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_timestamp_hiding_can_coexist_with_other_codex_patches(self):
        original = CodexCountdownTests().fixture()
        patched = install.transform_codex(
            original,
            enabled=True,
            hide_promotions=True,
            hide_timestamps=True,
        )

        self.assertIn("scm-toolkit-usage-reset-countdown", patched)
        self.assertIn("scm-toolkit-codex-promotions:start", patched)
        self.assertIn("scm-toolkit-codex-timestamps:start", patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)


class CodexWindowLabelRenderingTests(unittest.TestCase):
    def test_replaces_entire_codex_header_and_restores_on_default(self):
        original = "const app='codex';"
        patched = install.transform_codex(original, window_label="CelestAI")
        self.assertIn(install.CODEX_WINDOW_LABEL_START, patched)
        self.assertIn('const label = "CelestAI";', patched)
        self.assertTrue(install.codex_bundle_matches(patched))
        self.assertEqual(install.transform_codex(patched, window_label="CelestAI"), patched)
        updated = install.transform_codex(patched, window_label="Luna")
        self.assertIn('const label = "Luna";', updated)
        self.assertNotIn('const label = "CelestAI";', updated)
        self.assertEqual(install.transform_codex(patched, window_label="Codex"), original)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_label_is_scoped_and_reversible_with_other_patches(self):
        original = "const app='codex';"
        patched = install.transform_codex(original, hide_dictation=True, window_label="CelestAI")
        self.assertIn(install.CODEX_DICTATION_START, patched)
        self.assertIn(install.CODEX_WINDOW_LABEL_START, patched)
        self.assertEqual(install.transform_codex(patched, hide_dictation=True), install.transform_codex(original, hide_dictation=True))
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_malformed_header_patch_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "Incomplete Codex window-label patch"):
            install.transform_codex("const app='codex';" + install.CODEX_WINDOW_LABEL_START, window_label="CelestAI")


class CodexModelLabelTests(unittest.TestCase):
    def test_toggle_and_removal_preserve_other_patches(self):
        self.assertFalse(install.DEFAULT_SETTINGS["codexShortModelLabels"])
        original = "const app='codex';"
        other = install.transform_codex(original, hide_dictation=True)
        patched = install.transform_codex(other, hide_dictation=True, short_model_labels=True)
        self.assertIn(install.CODEX_LABELS_START, patched)
        self.assertEqual(install.transform_codex(patched, hide_dictation=True, short_model_labels=True), patched)
        self.assertEqual(install.transform_codex(patched, hide_dictation=True), other)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_incomplete_patch_is_rejected(self):
        with self.assertRaises(ValueError):
            install.transform_codex("const app='codex';" + install.CODEX_LABELS_END)

    def test_model_control_bundle_is_discovered(self):
        self.assertTrue(install.codex_bundle_matches('"data-composer-navigation-target":`reasoning`,"data-selected-reasoning-effort":effort'))


class CodexDictationTests(unittest.TestCase):
    def test_dictation_hiding_is_off_by_default(self):
        self.assertFalse(install.DEFAULT_SETTINGS["codexHideDictation"])

    def test_codex_dictation_hiding_install_and_remove_round_trip(self):
        original = "const app='codex';"
        patched = install.transform_codex(original, hide_dictation=True)

        self.assertIn("scm-toolkit-codex-dictation:start", patched)
        self.assertIn("data-scm-toolkit-hidden-dictation", patched)
        self.assertIn("looksLikeDictation", patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)

    def test_dictation_hiding_can_coexist_with_other_codex_patches(self):
        original = CodexCountdownTests().fixture()
        patched = install.transform_codex(
            original,
            enabled=True,
            hide_promotions=True,
            hide_timestamps=True,
            hide_dictation=True,
        )

        self.assertIn("scm-toolkit-usage-reset-countdown", patched)
        self.assertIn("scm-toolkit-codex-promotions:start", patched)
        self.assertIn("scm-toolkit-codex-timestamps:start", patched)
        self.assertIn("scm-toolkit-codex-dictation:start", patched)
        self.assertEqual(install.transform_codex(patched, remove=True), original)


class InstallerScriptsLayoutTests(unittest.TestCase):
    def test_install_command_runs_from_checkout_root(self):
        root = Path(__file__).resolve().parents[1]
        launcher = root / "scripts/install.command"
        self.assertTrue(launcher.is_file())
        self.assertTrue(launcher.stat().st_mode & 0o111)
        self.assertFalse((root / "Install Sweetiebot.command").exists())
        source = launcher.read_text(encoding="utf-8")
        self.assertIn('cd -- "$(dirname -- "$0")/.."', source)
        self.assertIn("python3 scripts/build_installer_app.py", source)
        self.assertIn('open "$PWD/Sweetiebot Installer.app"', source)

    def test_ci_runner_and_inventory_share_directory(self):
        root = Path(__file__).resolve().parents[1]
        self.assertTrue((root / "scripts/ci/ci_test_runner.py").is_file())
        self.assertTrue((root / "scripts/ci/ci_test_groups.json").is_file())
        self.assertFalse((root / "scripts/ci_test_runner.py").exists())
        self.assertFalse((root / "scripts/ci_test_groups.json").exists())
        workflow = (root / ".github/workflows/check.yml").read_text(encoding="utf-8")
        self.assertEqual(workflow.count("scripts/ci/ci_test_runner.py"), 3)


if __name__ == "__main__":
    unittest.main()
