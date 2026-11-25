
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


class ControlTransformTests(unittest.TestCase):
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

    def test_scm_icons_use_user_theme_foregrounds(self):
        css = (install.WORKBENCH_ASSETS / "picker.css").read_text()
        for control in (
            "home", "delete-branch", "autocomplete", "spellcheck", "post-spellcheck",
            "codex-coauthor", "pull-request", "sync-branch", "pony-branch",
            "stacked-branch", "auto-publish", "auto-commit",
        ):
            selector = f".scm-view .scm-editor > .scm-toolkit-{control}"
            start = selector + " {" if selector + " {" in css else selector + ","
            rule = css.split(start, 1)[1].split("}", 1)[0]
            self.assertIn("color: var(--vscode-icon-foreground, var(--vscode-foreground));", rule)
            self.assertIn(selector + ":disabled", css)
        self.assertIn("color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));", css)
        self.assertIn("border: 1px solid var(--vscode-checkbox-border,", css)
        self.assertIn("border: solid var(--vscode-checkbox-foreground,", css)
        self.assertIn("color: #FFFFFF !important;", css)

    def test_branch_selector_uses_the_vscode_button_colors(self):
        css = (install.WORKBENCH_ASSETS / "picker.css").read_text()

        self.assertIn("background: var(--vscode-button-background);", css)
        self.assertIn("color: var(--vscode-button-foreground);", css)
        self.assertIn("background: var(--vscode-button-hoverBackground);", css)

    def test_unfilled_buttons_match_their_background_with_a_border(self):
        css = (install.WORKBENCH_ASSETS / "outlined-buttons.css").read_text()

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

        # Transient press feedback uses the same selector in picker.css for both
        # button styles. Only the persistent outline rule must be opt-in.
        selector = ".scm-view:not(.scm-history-view) .button-container > .monaco-button-dropdown"
        outlined_rule = selector + " {\n    /* One continuous themed outline"
        self.assertIn(outlined_rule, outlined_css)
        self.assertNotIn(outlined_rule, filled_css)

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
        self.assertIn("color: var(--vscode-icon-foreground, var(--vscode-foreground));", sync_css)
        self.assertIn(
            ".scm-view .scm-editor > .scm-toolkit-sync-branch:hover:not(:disabled)",
            css,
        )

    def test_pr_warning_icon_is_neutral_by_default(self):
        self.assertFalse(install.DEFAULT_SETTINGS["prWarningHighlights"])
        js, css = install.transform(workbench_fixture(), "base-css", settings=SETTINGS)
        self.assertIn("scmToolkitHighlightPrWarnings(configuration, settings)", js)
        self.assertIn("settings.prWarningHighlights === true", js)
        self.assertIn(
            "scmToolkitHighlightPrWarnings(configuration, settings) && pullRequestEligibility?.reason === 'unavailable'",
            js,
        )
        self.assertIn("event.affectsConfiguration('sweetiebot.prWarningHighlights')", js)
        self.assertIn("color: var(--vscode-icon-foreground, var(--vscode-foreground));", css)
        self.assertIn(".scm-toolkit-pr-needs-attention", css)

    def test_install_injects_valid_settings_line(self):
        js, css = install.transform(workbench_fixture(), "base-css", settings=SETTINGS)

        self.assertIn("const scmToolkitSettings = ", js)
        self.assertIn('"codexCoauthorIconDataUrl":"data:image/png;base64,', js)
        self.assertIn('scm-toolkit-codex-coauthor-icon', js)
        self.assertIn('object-fit: contain;', css)
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
        self.assertIn("configuration.getValue('sweetiebot.messagePlaceholder')", js)
        self.assertIn("configuredLabel('commitButtonLabel'", js)
        self.assertIn("configuredLabel(", js)
        self.assertIn("'commitAndSendButtonLabel'", js)
        self.assertIn("event.affectsConfiguration('sweetiebot.messagePlaceholder')", js)
        self.assertIn("event.affectsConfiguration('sweetiebot.commitButtonLabel')", js)
        self.assertIn("configuration.getValue('git.postCommitCommand') === 'push'", js)
        self.assertIn("'.button-container > .monaco-button:first-child'", js)
        self.assertIn("'sweetiebot.publishBranch'", js)
        self.assertIn("sweetiebot.autoPublishNewBranches", js)
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
        self.assertIn('onCommand:sweetiebot.resolveDefaultBranch', (install.HERE.parent / 'extension/package.json').read_text())
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

if __name__ == "__main__":
    unittest.main()
