
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
    "prWarningHighlights": False,
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
            'this.button.onDidClick(async()=>await this.executeCommand(o.command.id,...o.command.arguments||[])',
            'run:async()=>{await this.executeCommand(n.id,...n.arguments||[])}',
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


def browser_open_action_fixture():
    # Minified native Open action: default placement differs from a clicked
    # title-bar globe when multiple editor groups or auxiliary windows exist.
    return (
        'id:Fc.Open,title:O(2,"Open Integrated Browser")}'
        'async run(o,n){const a=o.get(EditorService),b=o.get(TelemetryService),c=o.get(BrowserService);'
        'const t=typeof n=="string"?{url:n}:n??{},'
        'r=await c.getPreferredGroup(t.openToSide?SIDE_GROUP:void 0);'
        'await a.openEditor({resource:"browser",options:{viewState:{url:t.url}}},r)}'
    )


GIT_MODEL_FIXTURE = """
class GitModel {
    constructor() {
        api.workspace.onDidChangeConfiguration(this.onDidChangeConfiguration,this,this.disposables)
    }
    disposables = [];
    openRepositories = [];
    logger = {};
    git = {open: root => root};
    async onDidChangeWorkspaceFolders({added:e,removed:t}){try{
        for (const s of this.openRepositories) e.some(c=>contains(c.uri.fsPath,s.repository.root));
        await Promise.all(e.map(folder => this.openRepository(folder.uri.fsPath)));
    }catch(error){throw error}}
    onDidChangeConfiguration() {}
    scanWorkspaceFolders() {}
    onDidChangeVisibleTextEditors() {}
    async getRepositoryRoot(root) { return { repositoryRoot: root }; }
    async openRepository(e){
        let{repositoryRoot:s,unsafeRepositoryMatch:c}=await this.getRepositoryRoot(e);
        let y=this.git.open(s,m,f,this.logger);
        const entry = {
            repository: {root: y},
            dispose: () => this.openRepositories.splice(this.openRepositories.indexOf(entry), 1),
        };
        this.openRepositories.push(entry);
    }
}
"""
