import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import branch_names
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
    "sourceControlLabel": "Sweetie Bot",
    "filledButtons": False,
    "commitAndPush": True,
    "branchCleanup": True,
    "autocompleteToggle": True,
    "autoPublishToggle": True,
    "codexCoauthor": True,
    "hideOutgoingSyncCount": True,
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
            'cmd=svc("commandService")',
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


def browser_resolver_fixture():
    return (
        'throw new Error(`Invalid browser view resource: ${resource}`);'
        'browserViews.getOrCreateLazy({id:parsed.id,...options?.viewState})'
    )


class TransformTests(unittest.TestCase):
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
        self.assertIn("commands.executeCommand('git.refresh', repositoryArgument)", js)
        self.assertNotIn("scm-toolkit-refreshing", js)
        self.assertIn("historyItemRemoteRef.get()", js)
        self.assertIn("resolveHistoryItemRefsCommonAncestor", js)
        self.assertIn("commands.executeCommand('sweetiebot.autoPullClean', repositoryArgument)", js)
        self.assertIn("scm-toolkit-autocomplete", css)
        self.assertIn("scm-toolkit-auto-publish", css)
        # Two initial dividers plus the factory for additional saved separators.
        self.assertEqual(js.count("className = 'scm-toolkit-divider'"), 3)
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
        self.assertEqual(js.count("className = 'scm-toolkit-tooltip'"), 5)
        self.assertIn(".scm-toolkit-autocomplete:hover > .scm-toolkit-tooltip", css)
        self.assertIn("Co-authored-by: Codex <noreply@openai.com>", js)
        self.assertIn("currentInput?.repository.provider.acceptInputCommand", js)
        self.assertIn("currentCommitCommand.id,", js)
        self.assertIn("...(currentCommitCommand.arguments ?? [])", js)
        self.assertNotIn("commands.executeCommand('git.commit', currentRepositoryArgument)", js)
        self.assertIn("scmToolkitGuardCommit(", js)
        self.assertIn("'sweetiebot.checkCommitLimits'", js)
        self.assertIn("postCommitCommand: null", js)
        self.assertIn("scmToolkitPushWithPullRetry(repository, originalPush)", js)
        self.assertIn("error?.gitErrorCode !== 'PushRejected'", js)
        self.assertIn("await repository.fetch({ remote: head.upstream.remote, ref: head.upstream.name })", js)
        self.assertIn("await repository.merge(`refs/remotes/${head.upstream.remote}/${head.upstream.name}`)", js)
        self.assertIn("await originalPush.call(repository, repository.HEAD)", js)
        self.assertIn("commands.executeCommand('sweetiebot.openPullRequestChat', repository, {", js)
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
        self.assertIn("const repository = currentRepositoryUri;", js)
        self.assertIn("const repositoryArgument = currentRepositoryUri;", js)
        self.assertIn("commands.executeCommand('sweetiebot.deleteBranch', repositoryArgument, {", js)
        self.assertIn("scm-toolkit-sync-branch", css)
        self.assertIn("settingsButton.textContent = '🪄'", js)
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
        self.assertEqual(install.DEFAULT_SETTINGS["sourceControlLabel"], "Sweetie Bot")

    def test_commit_button_label_defaults_to_send(self):
        self.assertEqual(install.DEFAULT_SETTINGS["messagePlaceholder"], "Message")
        self.assertEqual(install.DEFAULT_SETTINGS["commitButtonLabel"], "Send")
        self.assertEqual(install.DEFAULT_SETTINGS["commitAndSendButtonLabel"], "Send")
        self.assertTrue(install.DEFAULT_SETTINGS["autoPublishToggle"])

    def test_source_control_label_patches_view_container_title(self):
        js, _ = install.transform(workbench_fixture(), "base-css", settings=SETTINGS)

        self.assertIn(
            'title:{"value": "Sweetie Bot", "original": "Sweetie Bot"},'
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
        self.assertIn('panelTitle="Sweetie Bot"', patched[0].split(install.START, 1)[0])
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

    def test_chatgpt_browser_home_is_opt_in(self):
        self.assertFalse(install.DEFAULT_SETTINGS["browserChatgptHome"])

        js, _ = install.transform(
            workbench_fixture(), "base-css", settings=SETTINGS
        )

        self.assertNotIn('"https://chatgpt.com/"', js)

    def test_chatgpt_browser_home_patches_blank_browser_tabs(self):
        original_js = workbench_fixture() + browser_resolver_fixture()
        enabled = dict(SETTINGS, browserChatgptHome=True)

        patched_js, patched_css = install.transform(
            original_js, "base-css", settings=enabled
        )

        self.assertIn(
            'browserViews.getOrCreateLazy({id:parsed.id,...options?.viewState,'
            'url:options?.viewState?.url??"https://chatgpt.com/"})',
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
        self.assertIn('url:options?.viewState?.url??"https://example.com/?q=hello"', patched[0])
        enabled["browserHomeUrl"] = "https://chatgpt.com/"
        updated = install.transform(*patched, settings=enabled)
        self.assertNotIn('url:options?.viewState?.url??"https://example.com/?q=hello"', updated[0])
        self.assertEqual(install.transform(*updated, remove=True, settings=enabled), (original, "base-css"))

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


class AiWrapperTests(unittest.TestCase):
    def test_sync_ai_wrapper_installs_executable_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "bin" / "scm-toolkit-git"
            self.assertTrue(install.sync_ai_wrapper(check=True, destination=destination))
            self.assertFalse(destination.exists())

            self.assertTrue(install.sync_ai_wrapper(destination=destination))
            self.assertEqual(destination.read_bytes(), (install.HERE / "ai_commit.py").read_bytes())
            self.assertTrue(destination.stat().st_mode & 0o111)
            self.assertFalse(install.sync_ai_wrapper(check=True, destination=destination))

    def test_sync_ai_wrapper_refreshes_existing_legacy_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            primary = Path(tmp) / "bin" / "scm-toolkit-git"
            legacy = Path(tmp) / "bin" / "git-auto-title"
            legacy.parent.mkdir(parents=True)
            legacy.write_text("stale wrapper", encoding="utf-8")

            with patch.object(install, "ai_wrapper_path", return_value=primary), patch.object(
                install, "legacy_ai_wrapper_path", return_value=legacy
            ):
                self.assertTrue(install.sync_ai_wrapper())

            expected = (install.HERE / "ai_commit.py").read_bytes()
            self.assertEqual(primary.read_bytes(), expected)
            self.assertEqual(legacy.read_bytes(), expected)
            self.assertTrue(legacy.stat().st_mode & 0o111)

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

    def test_sync_ai_wrapper_uninstall_removes_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "scm-toolkit-git"
            install.sync_ai_wrapper(destination=destination)
            self.assertTrue(install.sync_ai_wrapper(remove=True, check=True, destination=destination))
            self.assertTrue(destination.exists())
            install.sync_ai_wrapper(remove=True, destination=destination)
            self.assertFalse(destination.exists())


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
        self.assertNotIn("spellcheckManualCommit", install.DEFAULT_SETTINGS)
        self.assertNotIn("spellcheckManualCommit", toolkit_settings.SETTING_KEYS)

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

        self.assertEqual(install.transform_codex(patched, enabled=False), original)


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


if __name__ == "__main__":
    unittest.main()
