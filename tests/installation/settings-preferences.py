
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

import re
import json
import io
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import configurator
import install
import branch_names
import toolkit_settings
from pathlib import Path



# Allow direct script execution as well as the CI unittest module runner.
_sb_root = str(_sb_path(__file__).resolve().parents[2])
if _sb_root not in _sb_sys.path:
    _sb_sys.path.insert(0, _sb_root)

from tests.fixtures.configurator_support import form_values


class SettingsPreferencesTests(unittest.TestCase):
    def test_gear_page_covers_every_toolkit_and_extension_setting(self):
        controls = {setting.name: setting.git_key for setting in configurator.SETTINGS}
        self.assertEqual(controls, toolkit_settings.SETTING_KEYS)
        self.assertEqual(set(controls), set(toolkit_settings.DEFAULT_SETTINGS))
        package = json.loads((Path(__file__).parent.parent.parent / "extension/package.json").read_text())
        properties = set(package["contributes"]["configuration"]["properties"])
        exposed = {
            f"{root}.{key}"
            for group, root in (("workspaceSearch", "sweetiebot.workspaceSearch"), ("vscodeSettings", "sweetiebot"))
            for key in toolkit_settings.VSCODE_SETTINGS[group]
        }
        # Extension-native and repository-scoped settings do not belong
        # to the global Git-backed configurator's managed controls.
        self.assertEqual(properties - exposed, {
            "sweetiebot.caseOnlyRenameDetection",
            "sweetiebot.postCommitSpellcheck",
            "sweetiebot.startCompactPRSession",
            "sweetiebot.startExpandedMergeSession",
            "sweetiebot.promptForIndependentWorkspaceTrust",
            "sweetiebot.mergePostStatusUpdates",
            "sweetiebot.mergeAutoFixCi",
            "sweetiebot.mergeAutoFixConflicts",
            "sweetiebot.mergeAutoFixCiMethod",
        })
        self.assertFalse(exposed - properties)
        page = configurator.render_form(install.DEFAULT_SETTINGS, [], "Ready", "test-token", "Save")
        for name in controls:
            if name not in {"branchNameDisabledPacks", "kefaniaShowCloseButton"}:
                self.assertIn(f'name="{name}"', page)

    def test_kefania_chat_publication_is_opt_in_and_warns_before_saving(self):
        values = form_values()
        self.assertFalse(configurator.parse_submission(values)["kefaniaAutoShareCodexChat"])
        values["kefaniaAutoShareCodexChat"] = ["true"]
        parsed = configurator.parse_submission(values)
        self.assertTrue(parsed["kefaniaAutoShareCodexChat"])
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('name="kefaniaAutoShareCodexChat" value="true" checked', page)
        self.assertIn("window.confirm('Enable public chat sharing for Kefania?", page)
        self.assertIn("Sweetiebot cannot unpublish or revoke", page)
        payload = configurator.extension_settings_payload(parsed)
        self.assertTrue(payload["vscodeSettings"]["kefaniaAutoShareCodexChat"])
        current = dict(install.DEFAULT_SETTINGS)
        configurator.apply_vscode_settings(current, payload)
        self.assertTrue(current["kefaniaAutoShareCodexChat"])

    def test_kefania_close_after_merge_round_trips(self):
        values = form_values()
        self.assertFalse(configurator.parse_submission(values)["kefaniaCloseAfterMerge"])
        values["kefaniaCloseAfterMerge"] = ["true"]
        parsed = configurator.parse_submission(values)
        self.assertTrue(parsed["kefaniaCloseAfterMerge"])
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('name="kefaniaCloseAfterMerge" value="true" checked', page)
        payload = configurator.extension_settings_payload(parsed)
        self.assertTrue(payload["vscodeSettings"]["kefaniaCloseAfterMerge"])
        current = dict(install.DEFAULT_SETTINGS)
        configurator.apply_vscode_settings(current, payload)
        self.assertTrue(current["kefaniaCloseAfterMerge"])

    def test_automatic_workspace_cleanup_round_trips_into_vscode(self):
        values = form_values()
        self.assertTrue(configurator.parse_submission(values)["automaticWorkspaceCleanup"])
        page = configurator.render_form(install.DEFAULT_SETTINGS, [], "Ready", "test-token", "Save")
        self.assertIn('name="automaticWorkspaceCleanup" value="true" checked', page)

        values.pop("automaticWorkspaceCleanup")
        parsed = configurator.parse_submission(values)
        self.assertFalse(parsed["automaticWorkspaceCleanup"])
        payload = configurator.extension_settings_payload(parsed)
        self.assertFalse(payload["vscodeSettings"]["automaticWorkspaceCleanup"])
        current = dict(install.DEFAULT_SETTINGS)
        configurator.apply_vscode_settings(current, payload)
        self.assertFalse(current["automaticWorkspaceCleanup"])

    def test_search_box_placeholder_round_trips_into_vscode(self):
        values = form_values()
        values["workspaceSearchPlaceholder"] = ["SATS"]
        parsed = configurator.parse_submission(values)
        self.assertEqual(parsed["workspaceSearchPlaceholder"], "SATS")
        self.assertEqual(configurator.extension_settings_payload(parsed)["workspaceSearch"]["placeholder"], "SATS")
        values["workspaceSearchPlaceholder"] = [""]
        self.assertEqual(configurator.parse_submission(values)["workspaceSearchPlaceholder"], "")

    def test_notification_position_round_trips_into_vscode(self):
        current = dict(install.DEFAULT_SETTINGS)
        configurator.apply_vscode_settings(current, {
            "workbenchNotificationSettings": {"position": "top-right"},
        })
        self.assertEqual(current["notificationPosition"], "top-right")
        page = configurator.render_form(current, [], "Ready", "test-token", "Save")
        self.assertIn('name="notificationPosition"', page)
        self.assertIn('<option value="top-right" selected>Top-right</option>', page)

        values = form_values()
        values["notificationPosition"] = ["bottom-right"]
        payload = configurator.extension_settings_payload(configurator.parse_submission(values))
        self.assertEqual(payload["workbenchNotificationSettings"]["position"], "bottom-right")

        values["notificationPosition"] = ["center"]
        with self.assertRaises(ValueError):
            configurator.parse_submission(values)

    def test_ludicrous_mode_defaults_off_and_round_trips(self):
        values = form_values()
        self.assertFalse(configurator.parse_submission(values)["ludicrousMode"])
        values["ludicrousMode"] = ["true"]
        parsed = configurator.parse_submission(values)
        payload = configurator.extension_settings_payload(parsed)
        self.assertNotIn("ludicrousMode", payload["vscodeSettings"])
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('name="ludicrousMode" value="true" checked', page)
        self.assertIn('Ludicrous mode', page)
        self.assertEqual(toolkit_settings.SETTING_KEYS["ludicrousMode"], "scm-toolkit.ludicrous-mode")
        with patch.object(configurator.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="", stderr="")) as run:
            configurator.save_settings(parsed)
        self.assertTrue(any(call.args[0][-2:] == ["scm-toolkit.ludicrous-mode", "true"] for call in run.call_args_list))
        values.pop("ludicrousMode")
        self.assertFalse(configurator.parse_submission(values)["ludicrousMode"])

    def test_kefania_x_position_round_trips_and_validates(self):
        values = form_values()
        self.assertEqual(configurator.parse_submission(values)["kefaniaCloseButtonPosition"], "left")
        for position in ("left", "middle", "right"):
            values["kefaniaCloseButtonPosition"] = [position]
            parsed = configurator.parse_submission(values)
            self.assertEqual(parsed["kefaniaCloseButtonPosition"], position)
            self.assertTrue(parsed["kefaniaShowCloseButton"])
            payload = configurator.extension_settings_payload(parsed)
            self.assertEqual(payload["vscodeSettings"]["kefaniaCloseButtonPosition"], position)
            current = dict(install.DEFAULT_SETTINGS)
            configurator.apply_vscode_settings(current, payload)
            page = configurator.render_form(current, [], "Ready", "test-token", "Save")
            self.assertIn('<select name="kefaniaCloseButtonPosition">', page)
            self.assertIn(f'<option value="{position}" selected>{position.capitalize()}</option>', page)
            self.assertNotIn('name="kefaniaCloseButtonLeft"', page)
            self.assertNotIn('name="kefaniaShowCloseButton"', page)
        values["kefaniaCloseButtonPosition"] = ["hidden"]
        parsed = configurator.parse_submission(values)
        self.assertFalse(parsed["kefaniaShowCloseButton"])
        self.assertEqual(parsed["kefaniaCloseButtonPosition"], "left")
        payload = configurator.extension_settings_payload(parsed)
        self.assertFalse(payload["vscodeSettings"]["kefaniaShowCloseButton"])
        current = dict(install.DEFAULT_SETTINGS)
        configurator.apply_vscode_settings(current, payload)
        page = configurator.render_form(current, [], "Ready", "test-token", "Save")
        self.assertIn('<option value="hidden" selected>Hidden</option>', page)
        self.assertNotIn('name="kefaniaShowCloseButton"', page)
        with patch.object(configurator.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="", stderr="")) as run:
            configurator.save_settings(parsed)
        self.assertTrue(any(call.args[0][-2:] == ["scm-toolkit.kefania-show-close-button", "false"] for call in run.call_args_list))
        for invalid in ("", "center", "top", "left\\nright"):
            values["kefaniaCloseButtonPosition"] = [invalid]
            with self.assertRaises(ValueError):
                configurator.parse_submission(values)

    def test_legacy_kefania_close_position_is_preserved_until_saved(self):
        def read_string(key, default, preserve_empty=False):
            if key == "scm-toolkit.kefania-close-button-position":
                return None
            return default
        with patch.object(toolkit_settings, "read_git_string", side_effect=read_string), patch.object(toolkit_settings, "read_git_bool", side_effect=lambda key, default: False if key == "scm-toolkit.kefania-close-button-left" else default):
            settings = toolkit_settings.load_settings()
        self.assertEqual(settings["kefaniaCloseButtonPosition"], "right")

    def test_pr_auto_publish_preference_round_trips_into_vscode(self):
        values = form_values()
        self.assertTrue(configurator.parse_submission(values)["autoPublishPullRequests"])

        values.pop("autoPublishPullRequests")
        parsed = configurator.parse_submission(values)
        self.assertFalse(parsed["autoPublishPullRequests"])
        payload = configurator.extension_settings_payload(parsed)
        self.assertFalse(payload["vscodeSettings"]["autoPublishPullRequests"])

        current = dict(install.DEFAULT_SETTINGS)
        configurator.apply_vscode_settings(current, payload)
        self.assertFalse(current["autoPublishPullRequests"])
        page = configurator.render_form(current, [], "Ready", "test-token", "Save")
        self.assertIn('name="autoPublishPullRequests"', page)
        self.assertNotIn('name="autoPublishPullRequests" value="true" checked', page)

    def test_cloud_preference_round_trips_into_vscode(self):
        current = dict(install.DEFAULT_SETTINGS)
        configurator.apply_vscode_settings(current, {
            "vscodeSettings": {"autoPublishNewBranches": True},
            "workspaceSearch": {"resultLimit": 35},
            "gitSettings": {"postCommitCommand": "push"},
        })
        self.assertTrue(current["autoPublishNewBranches"])
        page = configurator.render_form(current, [], "Ready", "test-token", "Save")
        self.assertIn('name="autoPublishNewBranches" value="true" checked', page)
        values = form_values()
        values["autoPublishNewBranches"] = ["true"]
        values["workspaceSearchResultLimit"] = ["35"]
        values["postCommitAction"] = ["push"]
        payload = configurator.extension_settings_payload(configurator.parse_submission(values))
        self.assertTrue(payload["vscodeSettings"]["autoPublishNewBranches"])
        self.assertEqual(payload["workspaceSearch"]["resultLimit"], 35)
        self.assertEqual(payload["gitSettings"]["postCommitCommand"], "push")

    def test_search_preferences_reject_values_outside_runtime_contract(self):
        for key, value in (("workspaceSearchResultLimit", "101"), ("workspaceSearchMaxFiles", "1.5"),
                           ("workspaceSearchMaxFileSizeMB", "nan"), ("workspaceSearchMode", "invalid"),
                           ("workspaceSearchOllamaUrl", "https://example.com")):
            with self.subTest(key=key):
                values = form_values()
                values[key] = [value]
                with self.assertRaises(ValueError):
                    configurator.parse_submission(values)

    def test_manual_spellcheck_preview_defaults_off_and_has_own_model(self):
        values = form_values()
        self.assertFalse(install.DEFAULT_SETTINGS["spellcheckManualCommit"])
        self.assertEqual(install.DEFAULT_SETTINGS["spellcheckModel"], "qwen2.5:3b")
        parsed = configurator.parse_submission(values)
        self.assertFalse(parsed["spellcheckManualCommit"])
        self.assertEqual(parsed["spellcheckModel"], "qwen2.5:3b")
        values["spellcheckManualCommit"] = ["true"]
        self.assertTrue(configurator.parse_submission(values)["spellcheckManualCommit"])

    def test_manual_draft_emoji_toggle_is_independent_of_spellcheck(self):
        values = form_values()
        self.assertFalse(toolkit_settings.DEFAULT_SETTINGS["draftCommitEmoji"])
        self.assertEqual(toolkit_settings.SETTING_KEYS["draftCommitEmoji"], "scm-toolkit.draft-commit-emoji")
        self.assertFalse(configurator.parse_submission(values)["draftCommitEmoji"])
        values["draftCommitEmoji"] = ["true"]
        configured = configurator.parse_submission(values)
        self.assertTrue(configured["draftCommitEmoji"])
        self.assertFalse(configured["spellcheckManualCommit"])
        page = configurator.render_form(configured, [], "Ready", "test-token", "Save")
        self.assertIn('name="draftCommitEmoji" value="true" checked', page)

    def test_spellcheck_changes_commit_emoji_setting_is_independent(self):
        values = form_values()
        key = "spellcheckChangesEmoji"
        self.assertTrue(toolkit_settings.DEFAULT_SETTINGS[key])
        self.assertEqual(toolkit_settings.SETTING_KEYS[key], "scm-toolkit.spellcheck-changes-emoji")
        self.assertFalse(toolkit_settings.DEFAULT_SETTINGS["draftCommitEmoji"])
        self.assertTrue(configurator.parse_submission(values)[key])
        unchecked = dict(values)
        unchecked.pop(key)
        self.assertFalse(configurator.parse_submission(unchecked)[key])
        values[key] = ["true"]
        rendered = configurator.render_form(configurator.parse_submission(values), [], "Ready", "test-token", "Save")
        self.assertIn('name="spellcheckChangesEmoji" value="true" checked', rendered)
        self.assertIn("<h3>After committing</h3>", rendered)

    def test_spellchecking_suite_defaults_validation_and_grouping(self):
        values = form_values()
        self.assertEqual(toolkit_settings.DEFAULT_SETTINGS["draftSpellcheckAction"], "automatic")
        self.assertEqual(toolkit_settings.DEFAULT_SETTINGS["draftSpellcheckDelaySeconds"], "1.5")
        self.assertEqual(toolkit_settings.DEFAULT_SETTINGS["draftSpellcheckStyle"], "spelling")
        values.update({
            "spellcheckManualCommit": ["true"],
            "draftSpellcheckAction": ["review"],
            "draftSpellcheckDelaySeconds": ["2.5"],
            "draftSpellcheckStyle": ["grammar"],
            "draftSpellcheckVocabulary": ["Instinet\nSoroban"],
            "draftSpellcheckGuidance": ["Keep legal terminology unchanged."],
            "draftCommitEmoji": ["true"],
        })
        parsed = configurator.parse_submission(values)
        for key in ("draftSpellcheckAction", "draftSpellcheckDelaySeconds", "draftSpellcheckStyle",
                    "draftSpellcheckVocabulary", "draftSpellcheckGuidance"):
            self.assertEqual(parsed[key], values[key][0])
        page = configurator.render_form(parsed, [], "Ready", "token", "Save")
        self.assertIn(">Spellchecker</button>", page)
        self.assertNotIn(">Spellcheck Changes</button>", page)
        self.assertIn("<h3>While drafting a commit</h3>", page)
        self.assertIn("<h3>After committing</h3>", page)
        self.assertIn('name="draftSpellcheckAction"', page)
        self.assertIn('name="draftSpellcheckDelaySeconds"', page)
        self.assertIn('name="draftSpellcheckVocabulary"', page)
        self.assertIn('name="draftSpellcheckGuidance"', page)
        self.assertIn('name="draftCommitEmoji" value="true" checked', page)

    def test_spellcheck_thinking_effort_uses_supported_persisted_levels(self):
        self.assertEqual(toolkit_settings.DEFAULT_SETTINGS["spellcheckThinkingEffort"], "default")
        self.assertEqual(toolkit_settings.SETTING_KEYS["spellcheckThinkingEffort"],
                         "scm-toolkit.spellcheck-thinking-effort")
        values = form_values()
        self.assertEqual(configurator.parse_submission(values)["spellcheckThinkingEffort"], "default")
        for effort in ("low", "medium", "high"):
            with self.subTest(effort=effort):
                values["spellcheckThinkingEffort"] = [effort]
                configured = configurator.parse_submission(values)
                self.assertEqual(configured["spellcheckThinkingEffort"], effort)
                page = configurator.render_form(configured, [], "Ready", "test-token", "Save")
                self.assertIn('name="spellcheckThinkingEffort"', page)
                self.assertIn(f'<option value="{effort}" selected>', page)
        values["spellcheckThinkingEffort"] = ["maximum"]
        with self.assertRaises(ValueError):
            configurator.parse_submission(values)

    def test_spellchecking_suite_rejects_invalid_inputs(self):
        invalid = (
            ("draftSpellcheckAction", "silent"),
            ("draftSpellcheckStyle", "rewrite"),
            ("draftSpellcheckDelaySeconds", "0.1"),
            ("draftSpellcheckDelaySeconds", "11"),
            ("draftSpellcheckDelaySeconds", "nan"),
            ("draftSpellcheckVocabulary", "word\n" * 101),
            ("draftSpellcheckGuidance", "x" * 2001),
            ("draftSpellcheckVocabulary", "x\x00"),
        )
        for name, value in invalid:
            with self.subTest(name=name, value=value[:30]):
                form = form_values()
                form[name] = [value]
                with self.assertRaises(ValueError):
                    configurator.parse_submission(form)

    def test_custom_emoji_priority_enforcement_defaults_on_and_can_be_disabled(self):
        self.assertTrue(toolkit_settings.DEFAULT_SETTINGS["aiEmojiPriorityRules"])
        self.assertEqual(toolkit_settings.SETTING_KEYS["aiEmojiPriorityRules"], "scm-toolkit.ai-emoji-priority-rules")
        values = form_values()
        self.assertTrue(configurator.parse_submission(values)["aiEmojiPriorityRules"])
        values.pop("aiEmojiPriorityRules")
        self.assertFalse(configurator.parse_submission(values)["aiEmojiPriorityRules"])
        page = configurator.render_form(install.DEFAULT_SETTINGS, [], "Ready", "test-token", "Save")
        self.assertIn("Enforce custom emoji priorities", page)
        self.assertIn('name="aiEmojiPriorityRules" value="true" checked', page)

    def test_staged_whitespace_toggle_defaults_on_and_can_be_disabled(self):
        setting = next(setting for setting in configurator.SETTINGS if setting.name == "normalizeStagedWhitespace")
        self.assertEqual(setting.section, "Source control")
        self.assertEqual(setting.label, "Normalize line endings and whitespace")
        self.assertIn("Commit with Codex", setting.description)
        self.assertTrue(toolkit_settings.DEFAULT_SETTINGS["normalizeStagedWhitespace"])
        self.assertEqual(
            toolkit_settings.SETTING_KEYS["normalizeStagedWhitespace"],
            "scm-toolkit.normalize-staged-whitespace",
        )
        values = form_values()
        self.assertTrue(configurator.parse_submission(values)["normalizeStagedWhitespace"])
        page = configurator.render_form(install.DEFAULT_SETTINGS, [], "Ready", "test-token", "Save")
        self.assertIn('name="normalizeStagedWhitespace" value="true" checked', page)
        values.pop("normalizeStagedWhitespace")
        self.assertFalse(configurator.parse_submission(values)["normalizeStagedWhitespace"])
        page = configurator.render_form(
            dict(install.DEFAULT_SETTINGS, normalizeStagedWhitespace=False),
            [], "Ready", "test-token", "Save",
        )
        self.assertIn('name="normalizeStagedWhitespace" value="true"', page)
        self.assertNotIn('name="normalizeStagedWhitespace" value="true" checked', page)

    def test_ai_commit_fallback_toggle_defaults_on_and_supports_strict_debugging(self):
        setting = next(setting for setting in configurator.SETTINGS if setting.name == "aiCommitFallback")
        self.assertEqual(setting.section, "AI")
        self.assertTrue(toolkit_settings.DEFAULT_SETTINGS["aiCommitFallback"])
        self.assertEqual(toolkit_settings.SETTING_KEYS["aiCommitFallback"], "scm-toolkit.ai-commit-fallback")
        values = form_values()
        self.assertTrue(configurator.parse_submission(values)["aiCommitFallback"])
        page = configurator.render_form(install.DEFAULT_SETTINGS, [], "Ready", "test-token", "Save")
        self.assertIn('name="aiCommitFallback" value="true" checked', page)
        values.pop("aiCommitFallback")
        self.assertFalse(configurator.parse_submission(values)["aiCommitFallback"])

    def test_commit_time_budget_setting_renders_and_validates(self):
        for name, default, maximum, key in (
                ('aiCommitRequestTimeoutSeconds', '45', '900', 'scm-toolkit.ai-commit-request-timeout-seconds'),
                ('aiCommitAttempts', '3', '10', 'scm-toolkit.ai-commit-attempts')):
            setting = next(s for s in configurator.SETTINGS if s.name == name)
            self.assertEqual(setting.section, 'AI')
            self.assertEqual(toolkit_settings.DEFAULT_SETTINGS[name], default)
            self.assertEqual(toolkit_settings.SETTING_KEYS[name], key)
            values = form_values()
            for value in ('1', default, maximum):
                values[name] = [value]
                parsed = configurator.parse_submission(values)
                self.assertEqual(parsed[name], value)
                page = configurator.render_form(parsed, [], 'Ready', 'test-token', 'Save')
                self.assertIn(f'name="{name}"', page)
                self.assertIn('id="commit-generation-budget"', page)
                self.assertNotIn('name="aiCommitTimeBudgetSeconds"', page)
            for value in ('', '0', '-1', str(int(maximum) + 1), '1.5', 'nan'):
                values[name] = [value]
                with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                    configurator.parse_submission(values)

    def test_rebuild_button_is_not_a_preference_toggle(self):
        page = configurator.render_form(install.DEFAULT_SETTINGS, [], "Ready", "test-token", "Save")
        self.assertIn('id="rebuild-app"', page)
        self.assertIn("pollRebuildStatus", page)
        self.assertNotIn('name="rebuildApp"', page)

    def test_post_commit_spellcheck_toggle_defaults_off_and_saves_on(self):
        values = form_values()
        self.assertFalse(install.DEFAULT_SETTINGS["postCommitSpellcheck"])
        self.assertFalse(configurator.parse_submission(values)["postCommitSpellcheck"])
        values["postCommitSpellcheck"] = ["true"]
        self.assertTrue(configurator.parse_submission(values)["postCommitSpellcheck"])

if __name__ == "__main__":
    unittest.main()
