
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


class ServerTests(unittest.TestCase):
    def test_app_credential_endpoint_requires_exact_origin_and_token(self):
        opened = threading.Event()
        captured = {}

        def open_browser(url):
            captured['url'] = url
            opened.set()
            return True

        with patch('configurator.webbrowser.open', side_effect=open_browser), \
                patch('configurator.print'), \
                patch('configurator.save_app', return_value={'message': 'Saved'}) as save:
            thread = threading.Thread(target=configurator.run_configurator,
                                      args=(install.DEFAULT_SETTINGS,), daemon=True)
            thread.start()
            self.assertTrue(opened.wait(5))
            parsed = urllib.parse.urlsplit(captured['url'])
            origin = f'{parsed.scheme}://{parsed.netloc}'
            endpoint = origin + '/github-apps/save?' + parsed.query
            try:
                for headers, url in [({}, endpoint), ({'Origin': 'https://other.example'}, endpoint),
                                     ({'Origin': origin}, origin + '/github-apps/save')]:
                    request = urllib.request.Request(url, data=b'role=kefania', headers=headers)
                    with self.assertRaises(urllib.error.HTTPError) as denied:
                        urllib.request.urlopen(request, timeout=5)
                    denied.exception.close()
                save.assert_not_called()
                request = urllib.request.Request(endpoint, data=b'role=kefania',
                                                 headers={'Origin': origin})
                with urllib.request.urlopen(request, timeout=5) as response:
                    self.assertEqual(json.load(response), {'message': 'Saved'})
                save.assert_called_once_with({'role': ['kefania']})
            finally:
                request = urllib.request.Request(origin + '/save?' + parsed.query, data=b'action=cancel')
                with urllib.request.urlopen(request, timeout=5):
                    pass
                thread.join(5)
            self.assertFalse(thread.is_alive())

    @patch("configurator.fetch_ollama_models", return_value=([], "Ollama offline"))
    def test_rebuild_endpoint_requires_token_and_prevents_overlap(self, _models):
        for restart_required in (False, True):
            with self.subTest(restart_required=restart_required):
                self.check_rebuild_endpoint(restart_required)

    def check_rebuild_endpoint(self, restart_required):
        opened = threading.Event()
        release = threading.Event()
        captured = {}
        def open_browser(url):
            captured["url"] = url
            opened.set()
            return True
        def rebuild():
            release.wait(5)
            return {"message": "Fully quit VS Code." if restart_required else "Rebuild complete. Reload VS Code.",
                    "restartRequired": restart_required}
        with patch("configurator.webbrowser.open", side_effect=open_browser), \
             patch("configurator._manual_rebuild", side_effect=rebuild) as installer, \
             patch("configurator.print") as protocol:
            thread = threading.Thread(target=configurator.run_configurator, args=(install.DEFAULT_SETTINGS,),
                                      kwargs={"parent_pid": configurator.os.getpid()})
            thread.start()
            self.assertTrue(opened.wait(5))
            parsed = urllib.parse.urlsplit(captured["url"])
            def endpoint(path, authorized=True):
                return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query if authorized else "", ""))
            with self.assertRaises(urllib.error.HTTPError) as denied:
                urllib.request.urlopen(urllib.request.Request(endpoint("/rebuild", False), data=b"", method="POST"))
            self.assertEqual(denied.exception.code, 404)
            with urllib.request.urlopen(urllib.request.Request(endpoint("/rebuild"), data=b"", method="POST")) as response:
                self.assertTrue(json.load(response)["started"])
            with self.assertRaises(urllib.error.HTTPError) as duplicate:
                urllib.request.urlopen(urllib.request.Request(endpoint("/rebuild"), data=b"", method="POST"))
            self.assertEqual(duplicate.exception.code, 409)
            with urllib.request.urlopen(endpoint("/rebuild-status")) as response:
                self.assertTrue(json.load(response)["running"])
            release.set()
            for _ in range(30):
                with urllib.request.urlopen(endpoint("/rebuild-status")) as response:
                    status = json.load(response)
                if status["finished"]:
                    break
                threading.Event().wait(0.05)
            self.assertTrue(status["finished"])
            self.assertFalse(status["error"])
            self.assertEqual(status["restartRequired"], restart_required)
            self.assertIn("Fully quit VS Code" if restart_required else "Reloading this VS Code window", status["message"])
            installer.assert_called_once()
            protocol.assert_any_call(json.dumps({"rebuildComplete": True, "restartRequired": restart_required}), flush=True)
            urllib.request.urlopen(urllib.request.Request(endpoint("/save"), data=b"action=cancel", method="POST")).close()
            thread.join(5)
            self.assertFalse(thread.is_alive())

    def test_settings_server_exits_when_extension_host_disappears(self):
        with patch('configurator.os.kill', side_effect=ProcessLookupError), patch('builtins.print'):
            thread = threading.Thread(target=lambda: configurator.run_configurator(
                install.DEFAULT_SETTINGS, open_browser=False, parent_pid=12345,
            ), daemon=True)
            thread.start()
            thread.join(timeout=4)
            self.assertFalse(thread.is_alive(), 'An orphaned settings server must release its port')

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
                self.assertIn("img-src data:", response.headers["Content-Security-Policy"])
            self.assertIn("<title>Sweetiebot</title>", page)
            self.assertIn('<h1 class="settings-brand"><img src="data:image/png;base64,', page)
            self.assertIn('height="48">Sweetiebot', page)
            setup_url = urllib.parse.urlsplit(captured["url"])
            def endpoint(path):
                return urllib.parse.urlunsplit((setup_url.scheme, setup_url.netloc, path, setup_url.query, ""))
            with urllib.request.urlopen(endpoint("/models"), timeout=5) as response:
                self.assertEqual(json.load(response)["models"], [])
            # A change to VS Code's user settings reaches the already-open page.
            changes = urllib.parse.urlencode({
                "windowHeading": "${rootName} — ${activeRepositoryBranchName}",
                "windowName": "${activeEditorShort}",
                "windowShowModifiedStatus": "false",
                "windowShowPushingStatus": "false",
            }).encode()
            with urllib.request.urlopen(urllib.request.Request(
                endpoint("/sync-window-settings"), data=changes, method="POST"
            )) as response:
                self.assertTrue(json.load(response)["synced"])
            with urllib.request.urlopen(endpoint("/health")) as response:
                self.assertEqual(json.load(response)["windowSettings"], {
                    "windowHeading": "${rootName} — ${activeRepositoryBranchName}",
                    "windowName": "${activeEditorShort}",
                    "windowShowModifiedStatus": False,
                    "windowShowPushingStatus": False,
                })
            with urllib.request.urlopen(endpoint("/")) as response:
                updated_page = response.read().decode()
            self.assertIn('value="${rootName} — ${activeRepositoryBranchName}"', updated_page)
            self.assertIn('value="${activeEditorShort}"', updated_page)
            with self.assertRaises(urllib.error.HTTPError) as bad:
                urllib.request.urlopen(urllib.request.Request(
                    endpoint("/sync-window-settings"), data=b"windowHeading=x", method="POST"
                ))
            self.assertEqual(bad.exception.code, 400)
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
             patch("configurator.save_commit_instructions"), \
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
            values["messageBarLayout"] = ['{"before":[],"after":["codex"]}']
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
             patch("configurator.save_commit_instructions"), \
             patch("configurator.validate_models", side_effect=ValueError("Ollama offline")) as validate:
            thread = threading.Thread(target=run_server)
            thread.start()
            self.assertTrue(ready.wait(5))
            parsed = urllib.parse.urlsplit(captured["url"])
            try:
                self.assertTrue(captured["flushed"])
                with urllib.request.urlopen(captured["url"], timeout=5) as response:
                    page = response.read().decode()
                    self.assertIn("<title>Sweetiebot</title>", page)
                    self.assertIn('value="save" hidden>Done', page)
                    self.assertNotIn("Import signing key", page)
                for path in ("/autosave", "/save", "/autosave"):
                    values = form_values()
                    values.pop("branchPicker")
                    values["messageBarLayout"] = ['{"before":[],"after":["codex"]}']
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
