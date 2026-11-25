
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


class SettingsValidationTests(unittest.TestCase):
    def test_browser_toggles_default_off_and_save_on(self):
        values = form_values()
        self.assertFalse(install.DEFAULT_SETTINGS["cmdClickCloseOthers"])
        self.assertFalse(install.DEFAULT_SETTINGS["browserChatgptHome"])
        parsed = configurator.parse_submission(values)
        self.assertFalse(parsed["cmdClickCloseOthers"])
        self.assertFalse(parsed["browserChatgptHome"])
        values["cmdClickCloseOthers"] = ["true"]
        values["browserChatgptHome"] = ["true"]
        parsed = configurator.parse_submission(values)
        self.assertTrue(parsed["cmdClickCloseOthers"])
        self.assertTrue(parsed["browserChatgptHome"])

    def test_blank_browser_url_saves_custom_destination_and_defaults_to_chatgpt(self):
        values = form_values()
        self.assertEqual(configurator.parse_submission(values)["browserHomeUrl"], "https://chatgpt.com/")
        for url in ("https://example.com/path?q=hello#section", "http://localhost:3000/", "about:blank"):
            values["browserHomeUrl"] = [url]
            self.assertEqual(configurator.parse_submission(values)["browserHomeUrl"], url)
        values["browserHomeUrl"] = [""]
        self.assertEqual(configurator.parse_submission(values)["browserHomeUrl"], "https://chatgpt.com/")
        values["browserHomeUrl"] = ["not a URL"]
        with self.assertRaises(ValueError):
            configurator.parse_submission(values)

    def test_optional_name_packs_default_off(self):
        self.assertEqual(
            set(install.DEFAULT_SETTINGS["branchNameDisabledPacks"].split(",")),
            {"pony-life", "idw-comics", "g5-remaining", "g4-pets"},
        )
        page = configurator.render_form(
            install.DEFAULT_SETTINGS,
            [],
            "Ready",
            "test-token",
            "Save",
        )
        for pack_id in ("pony-life", "idw-comics", "g5-remaining", "g4-pets"):
            self.assertIn(
                f'<input type="checkbox" name="branchNamePack" value="{pack_id}">',
                page,
            )
            self.assertNotIn(
                f'<input type="checkbox" name="branchNamePack" value="{pack_id}" checked>',
                page,
            )

    def test_branch_name_bundles_render_as_browsable_tabs(self):
        page = configurator.render_form(
            install.DEFAULT_SETTINGS,
            [],
            "Ready",
            "test-token",
            "Save",
        )

        self.assertIn('class="pack-tabs" role="tablist"', page)
        self.assertIn('class="pack-tab" role="tab"', page)
        self.assertIn('class="pack-panel" role="tabpanel"', page)
        self.assertIn('class="pack-names"', page)
        self.assertIn('Find a bundle or name', page)
        self.assertIn('queen-chrysalis', page)
        self.assertIn('Use this bundle', page)
        self.assertIn("ArrowRight", page)
        self.assertNotIn('class="pack-grid"', page)
        self.assertNotIn('class="pack-card"', page)

    def test_parses_optional_composer_colors(self):
        values = form_values()
        values['codexSendBackground'] = ['#43AF49']
        values['codexComposerLabelColor'] = ['#43AF49']
        values['codexNewChatDotColor'] = ['#AABBCC']
        parsed = configurator.parse_submission(values)
        self.assertEqual(parsed['codexSendBackground'], '#43AF49')
        self.assertEqual(parsed['codexComposerLabelColor'], '#43AF49')
        self.assertEqual(parsed['codexNewChatDotColor'], '#AABBCC')
        self.assertEqual(toolkit_settings.SETTING_KEYS['codexNewChatDotColor'],
                         'scm-toolkit.codex-new-chat-dot-color')
        page = configurator.render_form(parsed, [], 'Ready', 'test-token', 'Save')
        self.assertIn('name="codexNewChatDotColor" value="#AABBCC"', page)
        self.assertEqual(parsed['codexSendForeground'], '')

    def test_rejects_invalid_composer_color(self):
        for name in ('codexSendBackground', 'codexNewChatDotColor'):
            with self.subTest(name=name):
                values = form_values()
                values[name] = ['#fff;display:none']
                with self.assertRaisesRegex(ValueError, 'hexadecimal'):
                    configurator.parse_submission(values)

    def test_parses_checked_and_unchecked_switches(self):
        values = form_values()
        values.pop("branchPicker")
        layout = json.loads(values["messageBarLayout"][0])
        for zone in layout:
            layout[zone] = [item for item in layout[zone] if item not in {"branch", "sync", "home"}]
        values["messageBarLayout"] = [json.dumps(layout)]

        parsed = configurator.parse_submission(values)

        self.assertFalse(parsed["branchPicker"])
        self.assertTrue(parsed["commitAndPush"])
        self.assertEqual(parsed["aiCommitModel"], "qwen2.5-coder:7b")
        self.assertEqual(parsed["sourceControlLabel"], "Sweetiebot")
        self.assertEqual(parsed["messagePlaceholder"], "Message")
        self.assertTrue(parsed["openPanelOnStartup"])
        self.assertEqual(parsed["commitButtonLabel"], "Send")
        self.assertEqual(parsed["commitAndSendButtonLabel"], "Send")
        self.assertTrue(parsed["autoPublishToggle"])
        self.assertFalse(parsed["cmdClickCloseOthers"])
        self.assertFalse(parsed["browserChatgptHome"])
        self.assertFalse(parsed["workspaceSearchActivityBar"])
        self.assertEqual(parsed["workspaceSearchLabel"], "EFS")
        self.assertEqual(parsed["workspaceSearchPlaceholder"], "Search your workspace…")
        self.assertFalse(parsed["workspaceSearchAskOllama"])
        self.assertEqual(parsed["workspaceSearchChatModel"], "")
        self.assertEqual(parsed["branchNameDisabledPacks"], "")
        self.assertEqual(parsed["branchCustomNames"], "")
        self.assertEqual(parsed["branchNameImports"], "[]")

    def test_parses_disabled_custom_and_imported_branch_names(self):
        values = form_values()
        values["branchNamePack"].remove("g4-creatures")
        values["branchCustomNames"] = ["my-oc\nrainy-friend"]
        values["branchNameImports"] = [
            '[{"id":"friends","label":"Friends","names":["other-oc"]}]'
        ]

        parsed = configurator.parse_submission(values)

        self.assertEqual(parsed["branchNameDisabledPacks"], "g4-creatures")
        self.assertEqual(parsed["branchCustomNames"], "my-oc,rainy-friend")
        self.assertIn('"id":"friends"', parsed["branchNameImports"])

    def test_ask_ollama_requires_chat_model_when_enabled(self):
        values = form_values()
        values["workspaceSearchAskOllama"] = ["true"]
        values["workspaceSearchChatModel"] = [""]

        with self.assertRaisesRegex(ValueError, "requires a chat model"):
            configurator.parse_submission(values)

    def test_ask_ollama_accepts_selected_chat_model(self):
        values = form_values()
        values["workspaceSearchAskOllama"] = ["true"]
        values["workspaceSearchChatModel"] = ["qwen3:8b"]

        parsed = configurator.parse_submission(values)

        self.assertTrue(parsed["workspaceSearchAskOllama"])
        self.assertEqual(parsed["workspaceSearchChatModel"], "qwen3:8b")

    def test_rejects_invalid_imported_branch_name(self):
        values = form_values()
        values["branchNameImports"] = [
            '[{"id":"friends","label":"Friends","names":["Not Safe"]}]'
        ]

        with self.assertRaisesRegex(ValueError, "branch-safe slug"):
            configurator.parse_submission(values)

    def test_rejects_invalid_memory_threshold(self):
        values = form_values()
        values["aiLowMemoryGiB"] = ["0"]

        with self.assertRaisesRegex(ValueError, "greater than zero"):
            configurator.parse_submission(values)

    def test_memory_threshold_uses_compact_numeric_control(self):
        page = configurator.render_form(
            install.DEFAULT_SETTINGS, [], "Ready", "test-token", "Save"
        )

        self.assertIn(
            'type="number" min="0.1" step="0.1" inputmode="decimal" class="compact-number" name="aiLowMemoryGiB"',
            page,
        )
        self.assertIn(
            ".field-row input.compact-number{width:76px;min-width:76px",
            page,
        )

    def test_form_escapes_values_and_lists_local_models(self):
        current = dict(install.DEFAULT_SETTINGS, defaultBranch='<script>alert("x")</script>')

        page = configurator.render_form(
            current,
            ["local:model"],
            "Detected one model.",
            "test-token",
            "Save and install",
        )

        self.assertNotIn('<script>alert("x")</script>', page)
        self.assertIn("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;", page)
        self.assertIn('let installedModels = ["local:model"];', page)
        self.assertIn("/save?token=test-token", page)
        self.assertIn("fetch('/autosave' + location.search", page)
        self.assertIn('id="save-status"', page)
        self.assertIn('class="settings-layout"', page)
        self.assertIn('class="settings-tabs" role="tablist" aria-orientation="vertical"', page)
        self.assertIn("function activateSettingsCategory", page)
        tab_markup = page.split('<button class="settings-tab"')[1:]
        panel_markup = page.split('<section class="settings-panel"')[1:]
        expected_sections = len(dict.fromkeys(setting.section for setting in configurator.SETTINGS)) + 2  # Diagnostics and GitHub Apps manage their own state.
        self.assertEqual(len(tab_markup), expected_sections)
        self.assertEqual(len(panel_markup), expected_sections)
        self.assertTrue(any(">Apps</button>" in tab for tab in tab_markup))
        self.assertFalse(any(">GitHub Apps</button>" in tab for tab in tab_markup))
        self.assertIn("<h2>GitHub Apps</h2>", page)
        self.assertEqual(
            sum('aria-selected="true"' in item.split('>', 1)[0] for item in tab_markup),
            1,
        )
        self.assertEqual(
            sum(' hidden' not in item.split('>', 1)[0] for item in panel_markup),
            1,
        )
        self.assertNotIn('value="cancel"', page)
        self.assertIn("G4 ponies", page)
        self.assertIn('name="branchNamePack"', page)
        self.assertIn('name="branchCustomNames"', page)
        self.assertIn('name="branchNameImports"', page)
        self.assertIn('name="sourceControlLabel"', page)
        self.assertIn('name="messagePlaceholder"', page)
        self.assertIn('name="openPanelOnStartup"', page)
        self.assertIn("Open Sweetiebot on startup", page)
        self.assertIn('name="commitButtonLabel"', page)
        self.assertIn('name="commitAndSendButtonLabel"', page)
        self.assertIn('name="autoPublishToggle"', page)
        self.assertIn('name="cmdClickCloseOthers"', page)
        self.assertIn('name="browserChatgptHome"', page)
        self.assertIn('name="codexUsagePieIndicator"', page)
        self.assertIn('name="codexResetTimePieIndicator"', page)
        self.assertIn('name="codexHideChatTimestamps"', page)
        self.assertIn('name="codexHideDictation"', page)
        self.assertIn('name="codexShortModelLabels"', page)
        self.assertIn('name="workspaceSearchActivityBar"', page)
        self.assertIn('name="workspaceSearchLabel"', page)
        self.assertIn('name="workspaceSearchPlaceholder"', page)
        self.assertIn('name="workspaceSearchAskOllama"', page)
        self.assertIn('name="workspaceSearchChatModel"', page)
        self.assertNotIn('name="aiCommitCustomInstructions"', page)
        self.assertNotIn("Sync AI commits with Codex instructions", page)
        self.assertIn("updateAskOllamaRequirement", page)
        self.assertIn('name="commitInstructions"', page)
        self.assertIn('id="generate-signing-key"', page)
        self.assertIn('id="open-signing-key-manager"', page)
        self.assertNotIn('name="chatgptCustomInstructions"', page)
        self.assertNotIn('id="sync-chatgpt-instructions"', page)
        self.assertNotIn('name="pgpSecretKey"', page)
        self.assertNotIn("Import ChatGPT personalization", page)


    def test_extension_payload_exposes_startup_user_setting(self):
        parsed = configurator.parse_submission(form_values())
        parsed["openPanelOnStartup"] = False
        parsed["messagePlaceholder"] = "Commit here"
        parsed["commitButtonLabel"] = "Commit"
        parsed["commitAndSendButtonLabel"] = "Commit + Push"
        parsed["sourceControlLabel"] = "Sweetiebot"
        parsed["messageBarLayout"] = '{"before":["branch","home"],"after":["push"]}'

        payload = configurator.extension_settings_payload(parsed)

        self.assertFalse(payload["vscodeSettings"]["openPanelOnStartup"])
        self.assertEqual(payload["vscodeSettings"]["messagePlaceholder"], "Commit here")
        self.assertEqual(payload["vscodeSettings"]["commitButtonLabel"], "Commit")
        self.assertEqual(payload["vscodeSettings"]["commitAndSendButtonLabel"], "Commit + Push")
        self.assertEqual(payload["vscodeSettings"]["sourceControlLabel"], "Sweetiebot")
        self.assertEqual(payload["vscodeSettings"]["messageBarLayout"], parsed["messageBarLayout"])
        self.assertEqual(
            payload["workspaceSearch"]["embeddingModel"],
            install.DEFAULT_SETTINGS["workspaceSearchEmbeddingModel"],
        )

if __name__ == "__main__":
    unittest.main()
