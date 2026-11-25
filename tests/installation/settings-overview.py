
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


class SettingsOverviewTests(unittest.TestCase):
    def test_lindsey_comment_credential_setup_is_reachable_from_settings(self):
        page = configurator.render_form(
            dict(install.DEFAULT_SETTINGS), [], "Ready", "test-token", "Save",
        )
        self.assertIn('id="lindsey-comments-settings"', page)
        self.assertIn("Configure Lindsey comments", page)
        self.assertIn("Check comment permissions", page)
        self.assertIn("github-app-card-lindsey", page)
        self.assertIn("tab.click();", page)
        self.assertIn("appRequest('/check'", page)

    def test_kefania_setup_button_is_in_settings_and_uses_authenticated_route(self):
        page = configurator.render_form(dict(install.DEFAULT_SETTINGS), [], "Ready", "test-token", "Save")
        self.assertIn('id="kefania-open-setup"', page)
        self.assertIn("'/kefania-setup/open' + location.search", page)
        self.assertIn('GitHub account and Kefania setup', page)

    def test_kefania_setup_launcher_uses_installed_companion_layout(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            launcher = directory / "codex" / "kefania-setup.js"
            launcher.parent.mkdir()
            launcher.touch()
            with patch.object(configurator, "__file__", str(directory / "configurator.py")), \
                 patch.object(configurator.shutil, "which", return_value="/usr/local/bin/node"), \
                 patch.object(configurator.subprocess, "run", return_value=SimpleNamespace(
                     returncode=0, stdout=json.dumps({"url": "http://127.0.0.1:8766/"}), stderr="")) as run:
                configurator._open_kefania_setup()
                self.assertEqual(Path(run.call_args.args[0][1]).resolve(), launcher.resolve())

    def test_kefania_setup_launcher_accepts_only_local_service_urls(self):
        def launch(url):
            return SimpleNamespace(returncode=0, stdout=json.dumps({"url": url, "reused": True}), stderr="")
        with patch.object(configurator.shutil, "which", return_value="/usr/local/bin/node"), \
             patch.object(configurator.subprocess, "run", return_value=launch("http://127.0.0.1:8766/")) as run:
            self.assertEqual(configurator._open_kefania_setup(), {
                "url": "http://127.0.0.1:8766/", "reused": True,
            })
            self.assertEqual(run.call_args.args[0][0], "/usr/local/bin/node")
            self.assertIn("kefania-setup.js", run.call_args.args[0][1])
        with patch.object(configurator.shutil, "which", return_value="/usr/local/bin/node"), \
             patch.object(configurator.subprocess, "run", return_value=launch("https://example.com/")):
            with self.assertRaisesRegex(RuntimeError, "invalid local setup URL"):
                configurator._open_kefania_setup()

    def test_welcome_tour_reuses_real_settings_controls(self):
        page = configurator.render_form(dict(install.DEFAULT_SETTINGS), [], "Ready", "test-token", "Save")
        self.assertIn('id="welcome-tour"', page)
        self.assertIn('id="welcome-reopen"', page)
        self.assertIn("data-welcome-step=\"2\"", page)
        self.assertIn("data-welcome-step=\"3\"", page)
        self.assertIn('data-welcome-section="Message bar"', page)
        self.assertIn('data-welcome-section="Codex"', page)
        for name in ("branchPicker", "compactWindowButton", "newWorkspaceWindowButton",
                     "filledButtons", "codexSendWing"):
            self.assertIn(f'data-welcome-setting="{name}"', page)
            self.assertIn(f'name="{name}"', page)
        for name in ("codexSendBackground", "codexSendForeground",
                     "codexComposerLabelColor", "codexDropAccent"):
            self.assertIn(f'data-welcome-color="{name}"', page)
            self.assertIn(f'name="{name}"', page)
        self.assertIn("field.dispatchEvent(new Event('input', {bubbles: true}))", page)
        self.assertIn("queueAutosave()", page)

    def test_header_build_pill_shows_short_installed_commit(self):
        revision = "a" * 40
        page = configurator.render_form(
            dict(install.DEFAULT_SETTINGS), [], "Ready", "test-token", "Save",
            build_revision=revision,
        )
        self.assertIn(
            'class="settings-build-revision" title="Built from commit ' + revision + '"',
            page,
        )
        self.assertIn('aria-label="Built from commit ' + revision + '">aaaaaaaa</span>', page)
        self.assertIn(".settings-build-revision{display:inline-flex", page)
        self.assertNotIn('class="settings-build-revision" title=', configurator.render_form(
            dict(install.DEFAULT_SETTINGS), [], "Ready", "test-token", "Save",
            build_revision="not-a-commit",
        ))

    def test_build_revision_reads_bundled_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "build-revision.json"
            with patch.object(configurator, "BUILD_REVISION_FILE", marker):
                self.assertEqual(configurator.read_build_revision(), "")
                marker.write_text(json.dumps({"commit": "b" * 40}) + "\n")
                self.assertEqual(configurator.read_build_revision(), "b" * 40)
                marker.write_text('{"commit": "malformed"}')
                self.assertEqual(configurator.read_build_revision(), "")

    def test_build_age_shows_inside_revision_pill_with_hours_until_two_days(self):
        now = 1800000000
        for seconds, label in (
            (-86400, "just now"),
            (59, "just now"),
            (60, "1 minute ago"),
            (3599, "59 minutes ago"),
            (3600, "60 minutes ago"),
            (2 * 3600 - 1, "119 minutes ago"),
            (2 * 3600, "2 hours ago"),
            (86400, "24 hours ago"),
            (48 * 3600 - 1, "47 hours ago"),
            (48 * 3600, "2 days ago"),
            (3 * 86400 + 3600, "3 days ago"),
        ):
            with self.subTest(seconds=seconds), patch.object(configurator.time, "time", return_value=now):
                revision = "a" * 40
                page = configurator.render_form(
                    dict(install.DEFAULT_SETTINGS), [], "Ready", "test-token", "Save",
                    build_revision=revision, build_committed_at=now - seconds,
                )
                self.assertEqual(page.count('class="settings-build-revision"'), 1)
                self.assertIn(
                    f'aria-label="Built from commit {revision}, {label}">'
                    f'{revision[:8]}<small class="settings-build-age">{label}</small></span>',
                    page,
                )

    def test_build_age_reads_bundled_timestamp(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "build-revision.json"
            with patch.object(configurator, "BUILD_REVISION_FILE", marker):
                for value, expected in ((1795000000, 1795000000), ("bad", None),
                                        (True, None), (-1, None)):
                    marker.write_text(json.dumps({"committed_at": value}))
                    self.assertEqual(configurator.read_build_committed_at(), expected)

    def test_sidebar_centers_pill_headings_and_tabs(self):
        page = configurator.render_form(dict(install.DEFAULT_SETTINGS), [], "Ready", "test-token", "Save")
        styles = page.split("<style>", 1)[1].split("</style>", 1)[0]
        category = re.search(r"\.settings-tab-category\{([^}]*)\}", styles).group(1)
        tab = re.search(r"\.settings-tab\{([^}]*)\}", styles).group(1)
        for rule in (category, tab):
            self.assertIn("border-radius:999px", rule)
            self.assertIn("text-align:center", rule)
            self.assertIn("text-wrap:balance", rule)
        self.assertIn("place-items:center", category)
        self.assertIn("justify-content:center", tab)
        self.assertIn("white-space:normal", tab)
        self.assertIn('.settings-tab[aria-selected="true"]', styles)
        self.assertIn(".settings-tab:focus-visible", styles)

    def test_sidebar_categories_keep_every_settings_page(self):
        page = configurator.render_form(dict(install.DEFAULT_SETTINGS), [], "Ready", "test-token", "Save")
        sidebar = page.split('<nav class="settings-tabs"', 1)[1].split("</nav>", 1)[0]
        groups = re.findall(
            r'<div class="settings-tab-group" role="presentation">'
            r'<div class="settings-tab-category" aria-hidden="true">([^<]+)</div>'
            r'(.*?)</div>', sidebar, re.S
        )
        self.assertEqual([label for label, _ in groups], [
            "Source Control &amp; Commits", "Branches &amp; Workspaces",
            "AI &amp; Spellcheck", "GitHub &amp; Pull Requests",
            "Interface &amp; Customization", "System &amp; Diagnostics",
        ])
        tabs = re.findall(
            r'<button class="settings-tab"[^>]+aria-controls="(settings-panel-\d+)"'
            r'[^>]*>([^<]+)</button>', sidebar
        )
        expected = {s.section for s in configurator.SETTINGS} | {"GitHub Apps", "Diagnostics"}
        expected_labels = {"Apps" if name == "GitHub Apps" else name for name in expected}
        self.assertEqual({name for _, name in tabs}, expected_labels)
        self.assertEqual(len(tabs), len(expected), "Every page appears exactly once")
        self.assertEqual(
            [target for target, _ in tabs],
            [f"settings-panel-{i}" for i in range(len(expected))],
        )
        grouped_tabs = [
            name for _, group in groups
            for name in re.findall(r'<button class="settings-tab"[^>]*>([^<]+)</button>', group)
        ]
        self.assertEqual(grouped_tabs, [name for _, name in tabs])
        for i in range(len(expected)):
            self.assertIn(f'id="settings-panel-{i}"', page)
        self.assertNotIn('>Other</div>', sidebar)

    def test_ai_commit_controls_and_instructions_share_one_panel(self):
        with patch.object(configurator, "load_commit_instructions", return_value="Use <emojis> & concise titles"):
            page = configurator.render_form(dict(install.DEFAULT_SETTINGS), [], "Ready", "test-token", "Save")

        def panel(section):
            match = re.search(
                r'<section class="settings-panel"[^>]*><h2>' + re.escape(section) + r'</h2>(.*?)</section>',
                page, re.S,
            )
            self.assertIsNotNone(match, section)
            return match.group(1)

        ai = panel("AI")
        commits = panel("Commits")
        source = panel("Source control")
        self.assertIn("<h3>AI commit generation</h3>", ai)
        self.assertIn("Use &lt;emojis&gt; &amp; concise titles", ai)
        for name in ("commitInstructions", "aiCommit", "aiBackend", "aiCommitModel",
                     "aiCommitRequestTimeoutSeconds", "aiCommitAttempts",
                     "aiDetailedCommitStyle", "aiEmojiPriorityRules",
                     "codexCommitContext", "chatgptReviewProjectUrl"):
            self.assertIn(f'name="{name}"', ai)
        self.assertEqual(page.count('name="commitInstructions"'), 1)
        self.assertNotIn('name="commitInstructions"', source)
        self.assertNotIn('name="aiCommit"', commits)
        self.assertIn('name="durableBackgroundCommits"', commits)
        self.assertIn('name="placeholderPrefix"', commits)
        self.assertIn('id="signing-key"', source)
        self.assertRegex(source, r'name="singleRepositoryPerWindow"[^>]*\bchecked\b')
        self.assertIn('>AI</button>', page)

    def test_missing_gpg_does_not_claim_no_keys_exist(self):
        status = {"gpgAvailable": False, "configured": "0123456789ABCDEF", "enabled": True, "keys": []}
        with patch.object(configurator, "signing_status", return_value=status), \
             patch.object(configurator, "load_commit_instructions", return_value=""):
            controls = configurator._local_setup_controls()
        self.assertIn("Cannot list OpenPGP keys: GnuPG unavailable", controls)
        self.assertIn("local OpenPGP keys could not be checked", controls)
        self.assertNotIn("No local OpenPGP signing keys found", controls)

    def test_configured_key_does_not_imply_signing_enabled(self):
        status = {"gpgAvailable": True, "configured": "0123456789ABCDEF", "enabled": False, "keys": []}
        with patch.object(configurator, "signing_status", return_value=status), \
             patch.object(configurator, "load_commit_instructions", return_value=""):
            controls = configurator._local_setup_controls()
        self.assertIn("Git commit signing is disabled.", controls)
        self.assertIn("A signing key is configured", controls)

    def test_backend_preference_order_renders_and_round_trips(self):
        for value, label in [("ollama", "Ollama only"), ("coreml", "Core ML only"),
                             ("coreml,ollama", "Core ML → Ollama"),
                             ("ollama,coreml", "Ollama → Core ML")]:
            with self.subTest(value=value):
                values = form_values()
                values["aiBackend"] = [value]
                parsed = configurator.parse_submission(values)
                self.assertEqual(parsed["aiBackend"], value)
                page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
                self.assertIn("Backend preference order", page)
                self.assertIn(f'<option value="{value}" selected>{label}</option>', page)

    def test_default_branch_pull_remote_is_separate_from_publish_remote(self):
        self.assertEqual(install.DEFAULT_SETTINGS["remote"], "origin")
        self.assertEqual(install.DEFAULT_SETTINGS["pullRemote"], "auto")
        values = form_values()
        values["remote"] = ["origin"]
        values["pullRemote"] = ["upstream"]
        parsed = configurator.parse_submission(values)
        self.assertEqual(parsed["remote"], "origin")
        self.assertEqual(parsed["pullRemote"], "upstream")
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('name="pullRemote"', page)

    def test_window_heading_and_name_preserve_vscode_defaults_and_round_trip(self):
        values = form_values()
        for name in ('windowHeading', 'windowName'):
            self.assertEqual(install.DEFAULT_SETTINGS[name], '')
        values.update(windowHeading=['${rootName} (${activeRepositoryBranchName})'],
                      windowName=['${activeEditorShort}${separator}${appName}'])
        parsed = configurator.parse_submission(values)
        payload = configurator.extension_settings_payload(parsed)
        current = dict(install.DEFAULT_SETTINGS)
        configurator.apply_vscode_settings(current, payload)
        for name in ('windowHeading', 'windowName'):
            self.assertEqual(current[name], values[name][0])
            self.assertEqual(payload['vscodeSettings'][name], values[name][0])
        page = configurator.render_form(current, [], 'Ready', 'test-token', 'Save')
        for name in ('windowHeading', 'windowName'):
            self.assertIn(f'name="{name}"', page)
        self.assertIn('placeholder="VS Code default"', page)
        self.assertIn("window.title", page)
        self.assertIn('id="heading-layout"', page)
        self.assertIn('id="heading-available"', page)
        self.assertIn('id="heading-add-text"', page)
        self.assertIn('name="windowShowModifiedStatus"', page)
        self.assertIn('name="windowShowPushingStatus"', page)
        values.update(windowHeading=[''], windowName=[''])
        restored = configurator.parse_submission(values)
        self.assertEqual(restored['windowHeading'], '')
        self.assertEqual(restored['windowName'], '')
        values['windowName'] = ['one\ntwo']
        with self.assertRaises(ValueError):
            configurator.parse_submission(values)

    def test_git_graph_relative_dates_setting_round_trips(self):
        values = form_values()
        self.assertFalse(toolkit_settings.DEFAULT_SETTINGS["gitGraphRelativeDates"])
        self.assertNotIn("gitGraphRelativeDates", values)
        values["gitGraphRelativeDates"] = ["true"]
        parsed = configurator.parse_submission(values)
        self.assertTrue(parsed["gitGraphRelativeDates"])
        payload = configurator.extension_settings_payload(parsed)
        self.assertTrue(payload["vscodeSettings"]["gitGraphRelativeDates"])
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('name="gitGraphRelativeDates"', page)
        self.assertIn("Enforce relative dates in Git Graph", page)
        values.pop("gitGraphRelativeDates")
        self.assertFalse(configurator.parse_submission(values)["gitGraphRelativeDates"])

    def test_retired_provisional_setting_is_not_available_or_resubmitted(self):
        self.assertNotIn("aiCommitAsync", toolkit_settings.DEFAULT_SETTINGS)
        self.assertNotIn("aiCommitAsync", toolkit_settings.SETTING_KEYS)
        self.assertNotIn("aiCommitAsync", {setting.name for setting in configurator.SETTINGS})
        values = form_values()
        values["aiCommitAsync"] = ["true"]  # Old saved forms cannot reactivate it.
        parsed = configurator.parse_submission(values)
        self.assertNotIn("aiCommitAsync", parsed)
        self.assertFalse(parsed["durableBackgroundCommits"])
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertNotIn("Legacy provisional commit finalization", page)
        self.assertIn("Durable background Commit and Push", page)

    def test_placeholder_prefix_is_user_configurable_and_validated(self):
        self.assertEqual(toolkit_settings.DEFAULT_SETTINGS["placeholderPrefix"], "hoof_")
        self.assertEqual(toolkit_settings.SETTING_KEYS["placeholderPrefix"], "sweetiebot.placeholder-prefix")
        setting = next(item for item in configurator.SETTINGS if item.name == "placeholderPrefix")
        self.assertEqual(setting.kind, "placeholder_prefix")

        values = form_values()
        values["placeholderPrefix"] = ["pony_"]
        parsed = configurator.parse_submission(values)
        self.assertEqual(parsed["placeholderPrefix"], "pony_")
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('name="placeholderPrefix"', page)

        for invalid in ("", "pony", "_pony_", "pony!_", "pony\n_", "1pony_", "x" * 16 + "_"):
            with self.subTest(invalid=invalid):
                values["placeholderPrefix"] = [invalid]
                with self.assertRaisesRegex(ValueError, "Provisional commit prefix"):
                    configurator.parse_submission(values)

    def test_lindsey_has_its_own_dashboard_settings_page(self):
        names = {"mergeTimelineTimestampMode", "mergeSidebarWidthPercent", "mergeTimelineHeightPercent", "mergeShowPrCommits"}
        controls = [setting for setting in configurator.SETTINGS if setting.name in names]
        self.assertEqual({setting.section for setting in controls}, {"Lindsey"})
        values = form_values()
        values.update(mergeTimelineTimestampMode=["clock"], mergeSidebarWidthPercent=["45"], mergeTimelineHeightPercent=["60"])
        parsed = configurator.parse_submission(values)
        payload = configurator.extension_settings_payload(parsed)["vscodeSettings"]
        self.assertEqual(payload["mergeTimelineTimestampMode"], "clock")
        self.assertEqual(payload["mergeSidebarWidthPercent"], 45)
        self.assertEqual(payload["mergeTimelineHeightPercent"], 60)
        for name, bad in [("mergeTimelineTimestampMode", "invalid"), ("mergeSidebarWidthPercent", "76"), ("mergeTimelineHeightPercent", "14")]:
            invalid = dict(values, **{name: [bad]})
            with self.assertRaises(ValueError):
                configurator.parse_submission(invalid)
        page = configurator.render_form(parsed, [], "Ready", "test-token", "Save")
        self.assertIn('>Lindsey</button>', page)
        for name in names:
            self.assertIn(f'name="{name}"', page)

if __name__ == "__main__":
    unittest.main()
