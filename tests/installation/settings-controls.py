
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


class SettingsControlsTests(unittest.TestCase):
    def test_github_refresh_controls_round_trip(self):
        values = form_values()
        values.pop("mergeAutoRefresh", None)
        values.update(mergeRefreshIntervalSeconds=["180"], githubRateLimitCooldownSeconds=["600"])
        parsed = configurator.parse_submission(values)
        payload = configurator.extension_settings_payload(parsed)["vscodeSettings"]
        self.assertFalse(payload["mergeAutoRefresh"])
        self.assertEqual(payload["mergeRefreshIntervalSeconds"], 180)
        self.assertEqual(payload["githubRateLimitCooldownSeconds"], 600)
        for name, value in [("mergeRefreshIntervalSeconds", "29"), ("githubRateLimitCooldownSeconds", "59")]:
            with self.assertRaises(ValueError):
                configurator.parse_submission(dict(values, **{name: [value]}))

    def test_bulk_merge_commit_history_toggle_defaults_on_and_persists(self):
        self.assertTrue(toolkit_settings.DEFAULT_SETTINGS["mergeShowPrCommits"])
        self.assertEqual(toolkit_settings.SETTING_KEYS["mergeShowPrCommits"], "sweetiebot.merge-show-pr-commits")
        values = form_values()
        parsed = configurator.parse_submission(values)
        self.assertTrue(parsed["mergeShowPrCommits"])
        self.assertTrue(configurator.extension_settings_payload(parsed)["vscodeSettings"]["mergeShowPrCommits"])
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('name="mergeShowPrCommits" value="true" checked', page)
        values.pop("mergeShowPrCommits")
        disabled = configurator.parse_submission(values)
        self.assertFalse(disabled["mergeShowPrCommits"])
        self.assertFalse(configurator.extension_settings_payload(disabled)["vscodeSettings"]["mergeShowPrCommits"])

    def test_merge_summaries_are_opt_in_and_persist(self):
        self.assertFalse(toolkit_settings.DEFAULT_SETTINGS["mergePostSummaries"])
        values = form_values()
        self.assertFalse(configurator.parse_submission(values)["mergePostSummaries"])
        values["mergePostSummaries"] = ["true"]
        parsed = configurator.parse_submission(values)
        self.assertTrue(configurator.extension_settings_payload(parsed)["vscodeSettings"]["mergePostSummaries"])
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('name="mergePostSummaries" value="true" checked', page)

    def test_sync_commit_filter_defaults_on_and_persists(self):
        self.assertTrue(toolkit_settings.DEFAULT_SETTINGS["filterSyncCommitSummaries"])
        self.assertEqual(toolkit_settings.SETTING_KEYS["filterSyncCommitSummaries"],
                         "sweetiebot.filter-sync-commit-summaries")
        values = form_values()
        parsed = configurator.parse_submission(values)
        self.assertTrue(parsed["filterSyncCommitSummaries"])
        self.assertTrue(configurator.extension_settings_payload(parsed)["vscodeSettings"]["filterSyncCommitSummaries"])
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('name="filterSyncCommitSummaries" value="true" checked', page)
        self.assertIn("Exclude sync commits from squash summaries", page)
        values.pop("filterSyncCommitSummaries")
        disabled = configurator.parse_submission(values)
        self.assertFalse(disabled["filterSyncCommitSummaries"])
        self.assertFalse(configurator.extension_settings_payload(disabled)["vscodeSettings"]["filterSyncCommitSummaries"])

    def test_emoji_only_squash_summary_format_toggle(self):
        self.assertFalse(toolkit_settings.DEFAULT_SETTINGS["squashOmitBulletsForEmojiTitles"])
        self.assertEqual(toolkit_settings.SETTING_KEYS["squashOmitBulletsForEmojiTitles"],
                         "sweetiebot.squash-omit-bullets-for-emoji-titles")
        values = form_values()
        self.assertFalse(configurator.parse_submission(values)["squashOmitBulletsForEmojiTitles"])
        values["squashOmitBulletsForEmojiTitles"] = ["true"]
        parsed = configurator.parse_submission(values)
        self.assertTrue(parsed["squashOmitBulletsForEmojiTitles"])
        self.assertTrue(configurator.extension_settings_payload(parsed)["vscodeSettings"]["squashOmitBulletsForEmojiTitles"])
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('name="squashOmitBulletsForEmojiTitles" value="true" checked', page)
        self.assertIn("Omit hyphens when every commit title starts with an emoji", page)

    def test_squash_separator_style_round_trip(self):
        self.assertEqual(toolkit_settings.DEFAULT_SETTINGS["squashTrailerSeparatorStyle"], "underscores")
        self.assertEqual(toolkit_settings.SETTING_KEYS["squashTrailerSeparatorStyle"],
                         "sweetiebot.squash-trailer-separator-style")
        for style in ("underscores", "hyphens", "none"):
            values = form_values()
            values["squashTrailerSeparatorStyle"] = [style]
            parsed = configurator.parse_submission(values)
            self.assertEqual(parsed["squashTrailerSeparatorStyle"], style)
            self.assertEqual(configurator.extension_settings_payload(parsed)["vscodeSettings"]["squashTrailerSeparatorStyle"], style)
            page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
            self.assertIn('name="squashTrailerSeparatorStyle"', page)
            self.assertIn(f'<option value="{style}" selected>', page)
        values["squashTrailerSeparatorStyle"] = ["unknown"]
        with self.assertRaises(ValueError):
            configurator.parse_submission(values)

    def test_ai_title_explanation_toggle_defaults_off_and_persists(self):
        self.assertFalse(toolkit_settings.DEFAULT_SETTINGS["aiTitleExplanations"])
        self.assertEqual(toolkit_settings.SETTING_KEYS["aiTitleExplanations"],
                         "sweetiebot.ai-title-explanations")
        values = form_values()
        self.assertFalse(configurator.parse_submission(values)["aiTitleExplanations"])
        values["aiTitleExplanations"] = ["true"]
        settings = configurator.parse_submission(values)
        self.assertTrue(settings["aiTitleExplanations"])
        page = configurator.render_form(settings, [], "Ready", "test-token", "Save")
        self.assertIn('name="aiTitleExplanations" value="true" checked', page)
        self.assertIn("Explain AI commit title choices", page)
        self.assertFalse("aiTitleExplanations" in configurator.extension_settings_payload(settings)["vscodeSettings"])

    def test_spellcheck_menu_documents_repository_override(self):
        page = configurator.render_form(
            dict(toolkit_settings.DEFAULT_SETTINGS), [], "Ready", "test-token", "Save"
        )
        self.assertIn("Opt out in one repository", page)
        self.assertIn("<code>.vscode/settings.json</code>", page)
        self.assertIn("&quot;sweetiebot.postCommitSpellcheck&quot;: false", page)
        self.assertIn("Other repositories still spellcheck", page)

    def test_spellcheck_only_date_format_persists_and_has_a_separate_panel(self):
        self.assertEqual(toolkit_settings.DEFAULT_SETTINGS["spellcheckDateFormat"], "preserve")
        self.assertEqual(toolkit_settings.SETTING_KEYS["spellcheckDateFormat"],
                         "sweetiebot.spellcheck-date-format")
        values = form_values()
        values["spellcheckDateFormat"] = ["day-first"]
        parsed = configurator.parse_submission(values)
        self.assertEqual(parsed["spellcheckDateFormat"], "day-first")
        self.assertEqual(configurator.extension_settings_payload(parsed)["vscodeSettings"]["spellcheckDateFormat"],
                         "day-first")
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn("<h3>ChatGPT Spellcheck Only</h3>", page)
        self.assertIn('name="spellcheckDateFormat"', page)
        self.assertIn('<option value="day-first" selected>6 May 2026</option>', page)
        for format_name in ("preserve", "month-first", "day-first", "iso", "us-numeric", "day-numeric"):
            values["spellcheckDateFormat"] = [format_name]
            self.assertEqual(configurator.parse_submission(values)["spellcheckDateFormat"], format_name)
        values["spellcheckDateFormat"] = ["unexpected"]
        with self.assertRaises(ValueError):
            configurator.parse_submission(values)

    def test_spellcheck_line_break_preference_can_be_toggled(self):
        values = form_values()
        values["spellcheckPreserveLineBreaks"] = ["true"]
        self.assertTrue(configurator.parse_submission(values)["spellcheckPreserveLineBreaks"])
        page = configurator.render_form(configurator.parse_submission(values), [], "Ready", "test-token", "Save")
        self.assertIn('name="spellcheckPreserveLineBreaks"', page)
        self.assertIn("Preserve intentional line breaks", page)
        values.pop("spellcheckPreserveLineBreaks")
        self.assertFalse(configurator.parse_submission(values)["spellcheckPreserveLineBreaks"])
        self.assertFalse(toolkit_settings.DEFAULT_SETTINGS["spellcheckPreserveLineBreaks"])

    def test_commit_coauthor_identity_can_be_changed_safely(self):
        values = form_values()
        self.assertEqual(configurator.parse_submission(values)["codexCoauthorName"], "Codex")
        self.assertEqual(configurator.parse_submission(values)["codexCoauthorEmail"], "noreply@openai.com")
        values["codexCoauthorName"] = ["Contributor Bot"]
        values["codexCoauthorEmail"] = ["123+bot[bot]@users.noreply.github.com"]
        parsed = configurator.parse_submission(values)
        self.assertEqual(parsed["codexCoauthorName"], "Contributor Bot")
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('name="codexCoauthorName" value="Contributor Bot"', page)
        self.assertIn('name="codexCoauthorEmail" value="123+bot[bot]@users.noreply.github.com"', page)
        for bad in ("", "Bad <Name>", "Bad\\nCo-authored-by: Intruder <x@y>", "N" * 101):
            values["codexCoauthorName"] = [bad]
            with self.assertRaisesRegex(ValueError, "co-author name"):
                configurator.parse_submission(values)
        values["codexCoauthorName"] = ["Contributor Bot"]
        for bad in ("", "no-at-sign", "a@b\\nCo-authored-by: Intruder <x@y>", "a <a@b>"):
            values["codexCoauthorEmail"] = [bad]
            with self.assertRaisesRegex(ValueError, "co-author email"):
                configurator.parse_submission(values)

    def test_pull_request_refresh_interval_validation(self):
        values = form_values()
        self.assertEqual(configurator.parse_submission(values)["pullRequestRefreshIntervalSeconds"], "120")
        page = configurator.render_form(configurator.parse_submission(values), [], "Ready", "test-token", "Save")
        self.assertIn('name="pullRequestRefreshIntervalSeconds"', page)
        for bad in ["0", "5", "29", "3601", "Infinity", "12.5", "invalid"]:
            values["pullRequestRefreshIntervalSeconds"] = [bad]
            with self.assertRaises(ValueError, msg=bad):
                configurator.parse_submission(values)
        values["pullRequestRefreshIntervalSeconds"] = ["600"]
        parsed = configurator.parse_submission(values)
        self.assertEqual(parsed["pullRequestRefreshIntervalSeconds"], "600")
        self.assertEqual(configurator.extension_settings_payload(parsed)["vscodeSettings"]["pullRequestRefreshIntervalSeconds"], 600)

    def test_chatgpt_project_url_validation(self):
        values = form_values()
        values["chatgptProjectUrl"] = ["https://chatgpt.com/g/g-p-sample123/project/"]
        parsed = configurator.parse_submission(values)
        self.assertEqual(parsed["chatgptProjectUrl"], "https://chatgpt.com/g/g-p-sample123/project")
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('name="chatgptProjectUrl"', page)
        values["chatgptProjectUrl"] = [""]
        self.assertEqual(configurator.parse_submission(values)["chatgptProjectUrl"], "")
        for bad_url in [
            "https://chatgpt.com.evil.test/g/g-p-sample/project",
            "http://chatgpt.com/g/g-p-sample/project",
            "https://chatgpt.com/g/g-p-sample/project?redirect=1",
            "https://chatgpt.com/",
            "https://user@chatgpt.com/g/g-p-sample/project",
        ]:
            values["chatgptProjectUrl"] = [bad_url]
            with self.assertRaises(ValueError):
                configurator.parse_submission(values)

    def test_add_separator_appears_immediately_above_available_buttons(self):
        page = configurator.render_form(dict(toolkit_settings.DEFAULT_SETTINGS), [], "Ready", "test-token", "Save")
        preview = page.index('class="message-bar-preview"')
        add_separator = page.index('id="message-bar-add-separator"')
        available = page.index('class="message-bar-hidden"')
        self.assertLess(preview, add_separator)
        self.assertLess(add_separator, available)
        self.assertEqual(page.count('id="message-bar-add-separator"'), 1)

    def test_available_push_control_is_disabled_without_a_visibility_switch(self):
        values = form_values()
        values["messageBarLayout"] = ['{"before":["codex"],"after":[]}']
        values["postCommitAction"] = ["push"]
        parsed = configurator.parse_submission(values)
        self.assertFalse(parsed["commitAndPush"])
        self.assertEqual(parsed["postCommitAction"], "none")
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertNotIn('type="checkbox" name="commitAndPush"', page)
        self.assertNotIn("Button options", page)
        self.assertIn('data-message-bar-zone="hidden"><div class="message-bar-item message-bar-push"', page)

    def test_native_update_controls_preserve_vscode_startup_preferences(self):
        current = dict(toolkit_settings.DEFAULT_SETTINGS)
        configurator.apply_vscode_settings(current, {
            "appUpdateSettings": {"mode": "start"},
            "extensionUpdateSettings": {"autoCheckUpdates": False, "autoUpdate": False},
        })
        page = configurator.render_form(current, [], "Ready", "test-token", "Save")
        self.assertIn('name="nativeAppUpdateMode"', page)
        self.assertIn('name="nativeExtensionAutoCheckUpdates"', page)
        self.assertIn('name="nativeExtensionAutoUpdate"', page)
        self.assertIn("Automatically check for VS Code extension updates", page)
        self.assertIn("Automatically update VS Code extensions", page)
        self.assertIn("Automatically update Sweetiebot and restore patches", page)
        self.assertNotIn("Automatically update and restore app customizations", page)
        self.assertNotIn("Sweetie Bot", page)
        payload = configurator.extension_settings_payload(current)
        self.assertEqual(payload["appUpdateSettings"], {"mode": "start"})
        self.assertEqual(payload["extensionUpdateSettings"], {"autoCheckUpdates": False, "autoUpdate": False})
        self.assertNotIn("showReleaseNotes", payload["appUpdateSettings"])
        self.assertTrue(current["automaticAppRepair"])
        for mode in ("default", "start", "manual", "none"):
            values = form_values()
            values["nativeAppUpdateMode"] = [mode]
            self.assertEqual(configurator.parse_submission(values)["nativeAppUpdateMode"], mode)

    def test_push_checkbox_and_automatic_sync_are_independent(self):
        values = form_values()
        values.pop("postCommitAction")
        parsed = configurator.parse_submission(values)
        self.assertEqual(parsed["postCommitAction"], "none")
        self.assertTrue(parsed["autoPullClean"])
        values["postCommitAction"] = ["push"]
        values.pop("autoPullClean")
        parsed = configurator.parse_submission(values)
        self.assertEqual(parsed["postCommitAction"], "push")
        self.assertFalse(parsed["autoPullClean"])
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('type="checkbox" name="postCommitAction" value="push" checked', page)
        self.assertNotIn('<select name="postCommitAction"', page)
        self.assertIn("Automatically sync", page)
        self.assertTrue(toolkit_settings.DEFAULT_SETTINGS["autoPullClean"])

    def test_custom_sync_direction_names_round_trip(self):
        values = form_values()
        values["incomingSyncLabel"] = ["Remote work"]
        values["outgoingSyncLabel"] = ["Ship it"]
        parsed = configurator.parse_submission(values)
        self.assertEqual(parsed["incomingSyncLabel"], "Remote work")
        self.assertEqual(parsed["outgoingSyncLabel"], "Ship it")
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('name="incomingSyncLabel" value="Remote work"', page)
        self.assertIn('name="outgoingSyncLabel" value="Ship it"', page)
        payload = configurator.extension_settings_payload(parsed)["vscodeSettings"]
        self.assertEqual(payload["incomingSyncLabel"], "Remote work")
        self.assertEqual(payload["outgoingSyncLabel"], "Ship it")
        values["incomingSyncLabel"] = [""]
        values["outgoingSyncLabel"] = [""]
        self.assertEqual(configurator.parse_submission(values)["incomingSyncLabel"], "")
        self.assertEqual(configurator.parse_submission(values)["outgoingSyncLabel"], "")
        values["incomingSyncLabel"] = ["bad\nname"]
        with self.assertRaisesRegex(ValueError, "one line"):
            configurator.parse_submission(values)

    def test_sync_direction_count_toggles_round_trip(self):
        self.assertFalse(toolkit_settings.DEFAULT_SETTINGS["hideIncomingSyncCount"])
        self.assertTrue(toolkit_settings.DEFAULT_SETTINGS["hideOutgoingSyncCount"])
        values = form_values()
        values["hideIncomingSyncCount"] = ["true"]
        values.pop("hideOutgoingSyncCount")
        parsed = configurator.parse_submission(values)
        payload = configurator.extension_settings_payload(parsed)["vscodeSettings"]
        self.assertTrue(payload["hideIncomingSyncCount"])
        self.assertFalse(payload["hideOutgoingSyncCount"])
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('name="hideIncomingSyncCount" value="true" checked', page)
        self.assertIn('name="hideOutgoingSyncCount" value="true"', page)

    def test_pr_warning_highlights_require_opt_in(self):
        self.assertFalse(toolkit_settings.DEFAULT_SETTINGS["prWarningHighlights"])
        values = form_values()
        values.pop("prWarningHighlights", None)
        parsed = configurator.parse_submission(values)
        self.assertFalse(parsed["prWarningHighlights"])
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('name="prWarningHighlights" value="true"', page)
        self.assertNotIn('name="prWarningHighlights" value="true" checked', page)
        self.assertFalse(configurator.extension_settings_payload(parsed)["vscodeSettings"]["prWarningHighlights"])

        values["prWarningHighlights"] = ["true"]
        parsed = configurator.parse_submission(values)
        self.assertTrue(parsed["prWarningHighlights"])
        self.assertTrue(configurator.extension_settings_payload(parsed)["vscodeSettings"]["prWarningHighlights"])
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('name="prWarningHighlights" value="true" checked', page)

    def test_sync_direction_arrow_toggles_round_trip(self):
        self.assertFalse(toolkit_settings.DEFAULT_SETTINGS["hideIncomingSyncArrow"])
        self.assertFalse(toolkit_settings.DEFAULT_SETTINGS["hideOutgoingSyncArrow"])
        values = form_values()
        values["hideIncomingSyncArrow"] = ["true"]
        values["hideOutgoingSyncArrow"] = ["true"]
        parsed = configurator.parse_submission(values)
        self.assertTrue(parsed["hideIncomingSyncArrow"])
        self.assertTrue(parsed["hideOutgoingSyncArrow"])
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('name="hideIncomingSyncArrow" value="true" checked', page)
        self.assertIn('name="hideOutgoingSyncArrow" value="true" checked', page)
        payload = configurator.extension_settings_payload(parsed)["vscodeSettings"]
        self.assertTrue(payload["hideIncomingSyncArrow"])
        self.assertTrue(payload["hideOutgoingSyncArrow"])
        values.pop("hideOutgoingSyncArrow")
        parsed = configurator.parse_submission(values)
        self.assertTrue(parsed["hideIncomingSyncArrow"])
        self.assertFalse(parsed["hideOutgoingSyncArrow"])

    def test_legacy_post_commit_sync_is_replaced_by_unchecked_push(self):
        current = dict(toolkit_settings.DEFAULT_SETTINGS)
        configurator.apply_vscode_settings(current, {"gitSettings": {"postCommitCommand": "sync"}})
        self.assertEqual(current["postCommitAction"], "none")

    def test_button_visibility_comes_from_layout_instead_of_legacy_switches(self):
        values = form_values()
        values["messageBarLayout"] = ['{"before":["codex"],"after":["autocomplete"]}']
        values.pop("codexCoauthor")
        parsed = configurator.parse_submission(values)
        self.assertTrue(parsed["codexCoauthor"])
        self.assertTrue(parsed["autocompleteToggle"])
        self.assertFalse(parsed["branchPicker"])
        self.assertFalse(parsed["ponyBranch"])
        self.assertFalse(parsed["mcpPullRequest"])
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        for name in (*configurator.MESSAGE_BAR_VISIBILITY_SETTINGS, "inlineSuggestions"):
            self.assertNotIn(f'type="checkbox" name="{name}"', page)
            self.assertIn(f'type="hidden" name="{name}"', page)

    def test_relative_codex_reset_time_setting_explains_conversion(self):
        setting = next(item for item in configurator.SETTINGS
                       if item.name == "codexUsageResetCountdown")
        self.assertEqual(setting.label, "Relative Codex reset times")
        self.assertIn("absolute reset dates and times", setting.description)
        self.assertIn("live relative countdowns", setting.description)
        self.assertEqual(setting.git_key, "sweetiebot.codex-usage-reset-countdown")
        page = configurator.render_form(install.DEFAULT_SETTINGS, [], "Ready", "token", "Save")
        self.assertIn("Relative Codex reset times", page)
        self.assertIn("live relative countdowns", page)
        self.assertIn('name="codexResetTimePieIndicator"', page)

    def test_rate_limit_continuation_checkbox(self):
        key = 'codexContinueAtReset'
        self.assertFalse(toolkit_settings.DEFAULT_SETTINGS[key])
        self.assertEqual(toolkit_settings.SETTING_KEYS[key], 'sweetiebot.codex-continue-at-reset')
        values = form_values()
        # This preference is off by default; the browser submits the key only
        # after the user explicitly checks its box.
        self.assertFalse(configurator.parse_submission(values)[key])
        values[key] = ['on']
        self.assertTrue(configurator.parse_submission(values)[key])
        values.pop(key)
        self.assertFalse(configurator.parse_submission(values)[key])
        page = configurator.render_form(install.DEFAULT_SETTINGS, [], 'Ready', 'token', 'Save')
        self.assertIn('data-message-bar-id="codex-resume"', page)
        self.assertIn('name="codexContinueAtReset"', page)
        self.assertIn('Resume at reset', page)
        self.assertNotIn('<strong>Resume work after Codex rate limits reset</strong>', page)

    def test_coauthor_button_custom_icon_controls(self):
        page = configurator.render_form(install.DEFAULT_SETTINGS, [], "Ready", "test-token", "Save")
        self.assertIn('id="coauthor-icon-upload"', page)
        self.assertIn('id="coauthor-icon-reset"', page)
        self.assertIn("Bundled Sweetiebot icon", page)
        self.assertIn("/coauthor-icon-upload", configurator.COAUTHOR_ICON_SCRIPT)
        self.assertIn("/coauthor-icon-reset", configurator.COAUTHOR_ICON_SCRIPT)

    def test_rate_limit_sticker_toggle_and_local_picker(self):
        self.assertTrue(toolkit_settings.DEFAULT_SETTINGS["codexRateLimitSticker"])
        values = form_values()
        self.assertTrue(configurator.parse_submission(values)["codexRateLimitSticker"])
        page = configurator.render_form(install.DEFAULT_SETTINGS, [], "Ready", "test-token", "Save")
        self.assertIn('name="codexRateLimitSticker"', page)
        self.assertIn('id="sticker-upload"', page)
        self.assertIn("Cached", configurator.STICKER_SCRIPT)
        values.pop("codexRateLimitSticker")
        self.assertFalse(configurator.parse_submission(values)["codexRateLimitSticker"])

    def test_codex_send_interrupt_option_is_persisted(self):
        key = "codexInterruptOnSendClick"
        self.assertTrue(toolkit_settings.DEFAULT_SETTINGS[key])
        self.assertEqual(toolkit_settings.SETTING_KEYS[key], "sweetiebot.codex-interrupt-on-send-click")
        values = form_values()
        values.pop(key)
        disabled = configurator.parse_submission(values)
        self.assertFalse(disabled[key])
        self.assertIn("Click Send to interrupt Codex", configurator.render_form(
            disabled, [], "Ready", "token", "Save"))

if __name__ == "__main__":
    unittest.main()
