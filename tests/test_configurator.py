import json
import io
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


def form_values():
    values = {}
    for pack in branch_names.load_catalog()["packs"]:
        values.setdefault("branchNameKnownPack", []).append(pack["id"])
        values.setdefault("branchNamePack", []).append(pack["id"])

    for setting in configurator.SETTINGS:
        current = install.DEFAULT_SETTINGS[setting.name]
        if setting.kind == "packs":
            continue
        if setting.kind == "bool":
            if current:
                values[setting.name] = ["true"]
        else:
            values[setting.name] = [str(current)]
    return values


class SubmissionTests(unittest.TestCase):
    def test_gear_page_covers_every_toolkit_and_extension_setting(self):
        controls = {setting.name: setting.git_key for setting in configurator.SETTINGS}
        self.assertEqual(controls, toolkit_settings.SETTING_KEYS)
        self.assertEqual(set(controls), set(toolkit_settings.DEFAULT_SETTINGS))
        package = json.loads((Path(__file__).parent.parent / "efs/package.json").read_text())
        properties = set(package["contributes"]["configuration"]["properties"])
        exposed = {
            f"{root}.{key}"
            for group, root in (("workspaceSearch", "scmToolkit.workspaceSearch"), ("vscodeSettings", "scmToolkit"))
            for key in toolkit_settings.VSCODE_SETTINGS[group]
        }
        self.assertEqual(properties, exposed)
        page = configurator.render_form(install.DEFAULT_SETTINGS, [], "Ready", "test-token", "Save")
        for name in controls:
            if name != "branchNameDisabledPacks":
                self.assertIn(f'name="{name}"', page)

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

    def test_post_commit_spellcheck_toggle_defaults_off_and_saves_on(self):
        values = form_values()
        self.assertFalse(install.DEFAULT_SETTINGS["postCommitSpellcheck"])
        self.assertFalse(configurator.parse_submission(values)["postCommitSpellcheck"])
        values["postCommitSpellcheck"] = ["true"]
        self.assertTrue(configurator.parse_submission(values)["postCommitSpellcheck"])

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

    def test_optional_name_packs_default_off(self):
        self.assertEqual(
            set(install.DEFAULT_SETTINGS["branchNameDisabledPacks"].split(",")),
            {"pony-life", "idw-comics"},
        )
        page = configurator.render_form(
            install.DEFAULT_SETTINGS,
            [],
            "Ready",
            "test-token",
            "Save",
        )
        for pack_id in ("pony-life", "idw-comics"):
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
        parsed = configurator.parse_submission(values)
        self.assertEqual(parsed['codexSendBackground'], '#43AF49')
        self.assertEqual(parsed['codexComposerLabelColor'], '#43AF49')
        self.assertEqual(parsed['codexSendForeground'], '')

    def test_rejects_invalid_composer_color(self):
        values = form_values()
        values['codexSendBackground'] = ['#fff;display:none']
        with self.assertRaisesRegex(ValueError, 'hexadecimal'):
            configurator.parse_submission(values)

    def test_parses_checked_and_unchecked_switches(self):
        values = form_values()
        values.pop("branchPicker")

        parsed = configurator.parse_submission(values)

        self.assertFalse(parsed["branchPicker"])
        self.assertTrue(parsed["commitAndPush"])
        self.assertEqual(parsed["aiCommitModel"], "qwen2.5-coder:7b")
        self.assertEqual(parsed["sourceControlLabel"], "Sweetie Bot")
        self.assertTrue(parsed["openPanelOnStartup"])
        self.assertEqual(parsed["commitButtonLabel"], "Send")
        self.assertTrue(parsed["autoPublishToggle"])
        self.assertFalse(parsed["cmdClickCloseOthers"])
        self.assertFalse(parsed["browserChatgptHome"])
        self.assertFalse(parsed["workspaceSearchActivityBar"])
        self.assertEqual(parsed["workspaceSearchLabel"], "EFS")
        self.assertFalse(parsed["workspaceSearchAskOllama"])
        self.assertEqual(parsed["workspaceSearchChatModel"], "")
        self.assertEqual(parsed["branchNameDisabledPacks"], "")
        self.assertEqual(parsed["branchCustomNames"], "")
        self.assertEqual(parsed["branchNameImports"], "[]")
        self.assertEqual(parsed["chatgptCustomInstructions"], "")
        self.assertTrue(parsed["chatgptWebCodexCoauthor"])

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
        self.assertIn('<option value="local:model">', page)
        self.assertIn("/save?token=test-token", page)
        self.assertIn("importKey ? '/save' : '/autosave'", page)
        self.assertIn('id="save-status"', page)
        self.assertNotIn('value="cancel"', page)
        self.assertIn("G4 ponies", page)
        self.assertIn('name="branchNamePack"', page)
        self.assertIn('name="branchCustomNames"', page)
        self.assertIn('name="branchNameImports"', page)
        self.assertIn('name="sourceControlLabel"', page)
        self.assertIn('name="openPanelOnStartup"', page)
        self.assertIn("Open Sweetie Bot on startup", page)
        self.assertIn('name="commitButtonLabel"', page)
        self.assertIn('name="autoPublishToggle"', page)
        self.assertIn('name="cmdClickCloseOthers"', page)
        self.assertIn('name="browserChatgptHome"', page)
        self.assertIn('name="codexHideChatTimestamps"', page)
        self.assertIn('name="codexHideDictation"', page)
        self.assertIn('name="codexShortModelLabels"', page)
        self.assertIn('name="workspaceSearchActivityBar"', page)
        self.assertIn('name="workspaceSearchLabel"', page)
        self.assertIn('name="workspaceSearchAskOllama"', page)
        self.assertIn('name="workspaceSearchChatModel"', page)
        self.assertIn("updateAskOllamaRequirement", page)
        self.assertIn('name="chatgptCustomInstructions"', page)
        self.assertIn('id="sync-chatgpt-instructions"', page)
        self.assertIn('name="pgpSecretKey"', page)
        self.assertNotIn("PGP PRIVATE KEY BLOCK-----\nsecret", page)


    def test_extension_payload_exposes_startup_user_setting(self):
        parsed = configurator.parse_submission(form_values())
        parsed["openPanelOnStartup"] = False

        payload = configurator.extension_settings_payload(parsed)

        self.assertFalse(payload["vscodeSettings"]["openPanelOnStartup"])
        self.assertEqual(
            payload["workspaceSearch"]["embeddingModel"],
            install.DEFAULT_SETTINGS["workspaceSearchEmbeddingModel"],
        )

    def test_custom_instructions_allow_multiline_text(self):
        values = form_values()
        values["chatgptCustomInstructions"] = ["Use ASCII quotes.\nKeep replies compact."]

        parsed = configurator.parse_submission(values)

        self.assertEqual(
            parsed["chatgptCustomInstructions"],
            "Use ASCII quotes.\nKeep replies compact.",
        )


class GitConfigTests(unittest.TestCase):
    @patch("toolkit_settings.read_git_bool")
    @patch("toolkit_settings.read_git_string")
    def test_disabled_pack_setting_can_be_explicitly_empty(self, read_string, read_bool):
        read_bool.side_effect = lambda _key, default: default

        def read_value(key, default, preserve_empty=False):
            if key == "scm-toolkit.branch-name-disabled-packs":
                self.assertTrue(preserve_empty)
                return ""
            return default

        read_string.side_effect = read_value

        settings = toolkit_settings.load_settings()

        self.assertEqual(settings["branchNameDisabledPacks"], "")

    @patch("configurator.shutil.which", return_value="/usr/bin/git")
    @patch("configurator.subprocess.run")
    def test_saves_every_supported_setting(self, run, _which):
        run.side_effect = lambda args, **_kwargs: SimpleNamespace(
            returncode=1 if "--get" in args else 0,
            stdout="",
            stderr="",
        )

        configurator.save_settings(configurator.parse_submission(form_values()))

        writes = [call.args[0] for call in run.call_args_list if "--replace-all" in call.args[0]]
        self.assertEqual(len(writes), len(configurator.SETTINGS))
        self.assertIn(
            [
                "/usr/bin/git",
                "config",
                "--global",
                "--replace-all",
                "scm-toolkit.ai-commit-model",
                "qwen2.5-coder:7b",
            ],
            writes,
        )


class OllamaTests(unittest.TestCase):
    @patch("configurator.urllib.request.build_opener")
    def test_reads_models_from_local_ollama(self, build_opener):
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {"models": [{"name": "qwen:test"}, {"model": "other:test"}]}
        ).encode()
        build_opener.return_value.open.return_value = response

        models, status = configurator.fetch_ollama_models()

        self.assertEqual(models, ["other:test", "qwen:test"])
        self.assertIn("2 local Ollama models", status)
        build_opener.return_value.open.assert_called_once_with(
            "http://127.0.0.1:11434/api/tags", timeout=2
        )


class ModelSetupTests(unittest.TestCase):
    def test_missing_embedding_model_blocks_save_even_with_chat_models(self):
        settings = dict(install.DEFAULT_SETTINGS)
        with patch("configurator.fetch_ollama_models", return_value=(["qwen2.5-coder:7b", "qwen2.5-coder:3b"], "Ollama ready")):
            with self.assertRaisesRegex(ValueError, "Search embedding model.*not installed"):
                configurator.validate_models(settings)

    def test_chat_model_cannot_be_used_for_embeddings(self):
        settings = dict(install.DEFAULT_SETTINGS, workspaceSearchEmbeddingModel="qwen2.5-coder:3b")
        with patch("configurator.fetch_ollama_models", return_value=(["qwen2.5-coder:7b", "qwen2.5-coder:3b"], "Ready")), patch("configurator.ollama_request", return_value=io.BytesIO(b'{"capabilities":["completion"]}')):
            with self.assertRaisesRegex(ValueError, "does not support embeddings"):
                configurator.validate_models(settings)

    def test_optional_chat_model_need_not_be_installed_when_disabled(self):
        settings = dict(install.DEFAULT_SETTINGS, aiCommit=False, workspaceSearchEmbeddingModel="embed", workspaceSearchChatModel="missing:chat")
        with patch("configurator.fetch_ollama_models", return_value=(["embed:latest"], "Ready")), patch("configurator.ollama_request", return_value=io.BytesIO(b'{"capabilities":["embedding"]}')):
            configurator.validate_models(settings)

    def test_rejects_empty_or_invalid_download_tag(self):
        for value in ["", "name\nother", "-option", "name;command"]:
            with self.assertRaises(ValueError):
                configurator.model_tag(value)

    def test_rendered_setup_script_is_valid_javascript(self):
        import subprocess
        import tempfile
        from pathlib import Path
        page = configurator.render_form(install.DEFAULT_SETTINGS, ["</script>"], "Ready", "test-token", "Save")
        script = page.split("<script>")[1].split("</script>")[0]
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "setup.js"
            path.write_text(script)
            subprocess.run(["node", "--check", str(path)], check=True, capture_output=True)
        self.assertIn('name="workspaceSearchEmbeddingModel"', page)
        self.assertIn('class="download-model"', page)


class ServerTests(unittest.TestCase):
    @patch("configurator.fetch_ollama_models", return_value=([], "Ollama offline"))
    def test_local_server_serves_form_and_can_cancel(self, _models):
        opened = threading.Event()
        captured = {}
        result = {}

        def open_browser(url):
            captured["url"] = url
            opened.set()
            return True

        def run_server():
            result["saved"] = configurator.run_configurator(install.DEFAULT_SETTINGS)

        with patch("configurator.webbrowser.open", side_effect=open_browser), patch("configurator.print"):
            thread = threading.Thread(target=run_server)
            thread.start()
            self.assertTrue(opened.wait(5))
            with urllib.request.urlopen(captured["url"], timeout=5) as response:
                page = response.read().decode()
            self.assertIn("Sweetiebot SCM Setup", page)
            setup_url = urllib.parse.urlsplit(captured["url"])
            def endpoint(path):
                return urllib.parse.urlunsplit((setup_url.scheme, setup_url.netloc, path, setup_url.query, ""))
            with urllib.request.urlopen(endpoint("/models"), timeout=5) as response:
                self.assertEqual(json.load(response)["models"], [])
            request = urllib.request.Request(endpoint("/pull"), data=b"model=embed:test", method="POST")
            with patch("configurator.ollama_request", return_value=io.BytesIO(b'{"status":"downloading","completed":1,"total":2}\n{"status":"success"}\n')) as pull:
                with urllib.request.urlopen(request, timeout=5) as response:
                    events = [json.loads(line) for line in response]
                self.assertEqual(events[-1]["status"], "success")
                pull.assert_called_once_with("/api/pull", {"model": "embed:test", "stream": True}, timeout=3600)

            parsed_url = urllib.parse.urlsplit(captured["url"])
            cancel_url = urllib.parse.urlunsplit(
                (parsed_url.scheme, parsed_url.netloc, "/save", parsed_url.query, "")
            )
            request = urllib.request.Request(
                cancel_url,
                data=b"action=cancel",
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=5) as response:
                self.assertIn("Configuration cancelled", response.read().decode())
            thread.join(5)

        self.assertFalse(thread.is_alive())
        self.assertFalse(result["saved"])

    @patch("configurator.fetch_ollama_models", return_value=([], "Ollama offline"))
    def test_autosave_persists_without_closing_server(self, _models):
        opened = threading.Event()
        captured = {}
        result = {}

        def open_browser(url):
            captured["url"] = url
            opened.set()
            return True

        def run_server():
            result["saved"] = configurator.run_configurator(install.DEFAULT_SETTINGS)

        with patch("configurator.webbrowser.open", side_effect=open_browser), \
             patch("configurator.validate_models") as validate, \
             patch("configurator.save_settings") as save, \
             patch("configurator.sync_codex_instructions"), \
             patch("configurator.import_pgp_secret_key"), \
             patch("configurator.print"):
            thread = threading.Thread(target=run_server)
            thread.start()
            self.assertTrue(opened.wait(5))
            parsed = urllib.parse.urlsplit(captured["url"])

            def endpoint(path):
                return urllib.parse.urlunsplit(
                    (parsed.scheme, parsed.netloc, path, parsed.query, "")
                )

            values = form_values()
            values.pop("branchPicker")
            request = urllib.request.Request(
                endpoint("/autosave"),
                data=urllib.parse.urlencode(values, doseq=True).encode(),
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=5) as response:
                self.assertTrue(json.load(response)["saved"])
            self.assertTrue(thread.is_alive())
            self.assertFalse(save.call_args.args[0]["branchPicker"])
            validate.assert_not_called()

            finish_values = form_values()
            finish_values["action"] = ["save"]
            request = urllib.request.Request(
                endpoint("/save"),
                data=urllib.parse.urlencode(finish_values, doseq=True).encode(),
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=5) as response:
                self.assertIn("Configuration saved", response.read().decode())
            thread.join(5)

        self.assertFalse(thread.is_alive())
        self.assertTrue(result["saved"])

    @patch("configurator.fetch_ollama_models", return_value=([], "Ollama offline"))
    def test_extension_mode_emits_url_without_opening_external_browser(self, _models):
        ready = threading.Event()
        captured = {}
        result = {}

        def capture_output(line, **kwargs):
            message = json.loads(line)
            if "url" not in message:
                captured["settings"] = message
                return
            captured["url"] = message["url"]
            captured["flushed"] = kwargs.get("flush")
            ready.set()

        def run_server():
            result["saved"] = configurator.run_configurator(
                install.DEFAULT_SETTINGS, open_browser=False
            )

        with patch("configurator.print", side_effect=capture_output), \
             patch("configurator.webbrowser.open") as browser, \
             patch("configurator.save_settings") as save, \
             patch("configurator.sync_codex_instructions"), \
             patch("configurator.import_pgp_secret_key"), \
             patch("configurator.validate_models", side_effect=ValueError("Ollama offline")) as validate:
            thread = threading.Thread(target=run_server)
            thread.start()
            self.assertTrue(ready.wait(5))
            parsed = urllib.parse.urlsplit(captured["url"])
            try:
                self.assertTrue(captured["flushed"])
                with urllib.request.urlopen(captured["url"], timeout=5) as response:
                    page = response.read().decode()
                    self.assertIn("Sweetiebot SCM Setup", page)
                    self.assertIn('value="save" hidden>Import signing key', page)
                for path in ("/autosave", "/save", "/autosave"):
                    values = form_values()
                    values.pop("branchPicker")
                    endpoint = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, ""))
                    request = urllib.request.Request(endpoint, data=urllib.parse.urlencode(values, doseq=True).encode(), method="POST")
                    with urllib.request.urlopen(request, timeout=5) as response:
                        self.assertTrue(json.load(response)["saved"])
                    self.assertTrue(thread.is_alive())
                    self.assertFalse(save.call_args.args[0]["branchPicker"])
                    with urllib.request.urlopen(captured["url"], timeout=5) as response:
                        self.assertEqual(response.status, 200)
                validate.assert_not_called()
                self.assertIn("workspaceSearch", captured["settings"])
                unauthorized = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/", "", ""))
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    urllib.request.urlopen(unauthorized, timeout=5)
                self.assertEqual(denied.exception.code, 404)
                denied.exception.close()
            finally:
                cancel_url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/save", parsed.query, ""))
                request = urllib.request.Request(cancel_url, data=b"action=cancel", method="POST")
                with urllib.request.urlopen(request, timeout=5) as response:
                    self.assertIn("Configuration cancelled", response.read().decode())
                thread.join(5)
            browser.assert_not_called()
        self.assertFalse(thread.is_alive())
        self.assertFalse(result["saved"])


if __name__ == "__main__":
    unittest.main()
