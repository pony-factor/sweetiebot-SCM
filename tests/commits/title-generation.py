
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

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from contextlib import ExitStack, contextmanager
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "scm_toolkit_ai_commit", Path(__file__).parents[2] / "scripts/ai-commit.py"
)
ai_commit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ai_commit)


class TitleTests(unittest.TestCase):
    def setUp(self):
        backend = patch.object(ai_commit, "coreml_backend_enabled", return_value=False)
        backend.start()
        self.addCleanup(backend.stop)
        instructions = patch.object(ai_commit, "commit_custom_instructions", return_value="")
        instructions.start()
        self.addCleanup(instructions.stop)
        sleeper = patch.object(ai_commit.time, "sleep")
        self.sleep = sleeper.start()
        self.addCleanup(sleeper.stop)

    def test_budget_setting_is_validated_and_read_for_each_generation(self):
        for value in ('', '0', '-1', '901', '2.5', 'nan', 'invalid'):
            with self.subTest(value=value), patch.object(ai_commit, 'git_config_string', return_value=value):
                self.assertEqual(ai_commit.generation_budget_seconds(), 135)
        bounded = ai_commit.generation_budget(lambda: ai_commit.GENERATION_DEADLINE.get())
        with patch.object(ai_commit, 'git_config_string', side_effect=['1', '2', '900', '10']), \
                patch.object(ai_commit.time, 'monotonic', return_value=10):
            self.assertEqual(bounded(), 12)
            self.assertEqual(bounded(), 9010)
        self.assertIsNone(ai_commit.GENERATION_DEADLINE.get())
        self.assertIsNone(ai_commit.GENERATION_OPTIONS.get())

    def test_transient_failures_retry_then_accept_success(self):
        with ExitStack() as stack:
            for name, value in [
                ("installed_local_model_names", {"local"}), ("selected_model", ("local", False)),
                ("configured_models", ("local", "small")), ("recent_subjects", ""),
                ("staged_file_context", "Change totals: 1 modified"),
            ]:
                stack.enter_context(patch.object(ai_commit, name, return_value=value))
            generate = stack.enter_context(patch.object(ai_commit, "ollama_json", side_effect=[
                ai_commit.urllib.error.URLError(ConnectionRefusedError()),
                TimeoutError(),
                {"response": '{"subject":"📝 Record DTC exhibit references","description":""}'},
            ]))
            self.assertEqual(ai_commit.generate_message("", "+DTC exhibit references", ["notes.md"]),
                             ("📝 Record DTC exhibit references", ""))
            self.assertEqual(generate.call_count, 3)
            self.assertEqual([call.args[0] for call in self.sleep.call_args_list], [1, 2])

    def test_http_failure_retries_three_times_then_falls_back(self):
        with ExitStack() as stack:
            for name, value in [
                ("installed_local_model_names", {"local"}), ("selected_model", ("local", False)),
                ("configured_models", ("local", "small")), ("recent_subjects", ""),
                ("staged_file_context", ""),
            ]:
                stack.enter_context(patch.object(ai_commit, name, return_value=value))
            error = ai_commit.urllib.error.HTTPError("http://127.0.0.1:11434/api/generate", 400, "bad request", {}, None)
            generate = stack.enter_context(patch.object(ai_commit, "ollama_json", side_effect=error))
            self.assertEqual(
                ai_commit.generate_message("", "+Exhibit references", ["notes.md"]),
                ("📝 Update `notes.md`", ""),
            )
            self.assertEqual(generate.call_count, 3)
            self.assertEqual([call.args[0] for call in self.sleep.call_args_list], [1, 2])

    def test_configured_attempt_count_limits_title_generation(self):
        with ExitStack() as stack:
            for name, value in [('installed_local_model_names', {'local'}),
                                ('selected_model', ('local', False)),
                                ('configured_models', ('local', 'small')),
                                ('staged_file_context', ''), ('recent_subjects', ''),
                                ('commit_fallback_enabled', True)]:
                stack.enter_context(patch.object(ai_commit, name, return_value=value))
            stack.enter_context(patch.object(ai_commit, 'git_config_string',
                                             side_effect=lambda key, default: '2' if key.endswith('attempts') else default))
            request = stack.enter_context(patch.object(ai_commit, 'ollama_json', return_value={'response': '{}'}))
            self.assertEqual(ai_commit.generate_message('', '+Fix handler', ['app.py']), ('🔧 Update `app.py`', ''))
            self.assertEqual(request.call_count, 2)

    def test_configured_request_timeout_can_exceed_old_transport_default(self):
        bounded = ai_commit.generation_budget(lambda: ai_commit.ollama_json('/api/generate', {'model': 'local'}))
        with patch.object(ai_commit, 'git_config_string', side_effect=lambda key, default:
                          '900' if key.endswith('timeout-seconds') else '2' if key.endswith('attempts') else default), \
                patch.object(ai_commit.OLLAMA_OPENER, 'open') as request:
            request.return_value.__enter__.return_value.read.return_value = b'{}'
            bounded()
            self.assertEqual(request.call_args.kwargs['timeout'], 900)

    def test_required_model_reports_timeout_connection_and_http_failures(self):
        failures = [
            (TimeoutError("timed out"), "request timed out"),
            (ai_commit.urllib.error.URLError(TimeoutError("timed out")), "request timed out"),
            (ai_commit.urllib.error.URLError(ConnectionRefusedError()), "Check that Ollama is running"),
            (ai_commit.urllib.error.HTTPError("http://127.0.0.1:11434/api/generate", 503, "busy", {}, None), "HTTP 503 for model local"),
        ]
        for error, expected in failures:
            with self.subTest(error=error), ExitStack() as stack:
                for name, value in [
                    ("installed_local_model_names", {"local"}),
                    ("selected_model", ("local", False)),
                    ("configured_models", ("local", "small")),
                    ("recent_subjects", ""), ("staged_file_context", ""),
                ]:
                    stack.enter_context(patch.object(ai_commit, name, return_value=value))
                generate = stack.enter_context(patch.object(ai_commit, "ollama_json", side_effect=error))
                with self.assertRaisesRegex(RuntimeError, expected):
                    ai_commit.generate_message("", "", ["a.py"], require_model=True)
                self.assertEqual(generate.call_count, 3)

    def test_ollama_request_allows_time_queued_behind_ocr(self):
        with patch.object(ai_commit.OLLAMA_OPENER, "open") as request:
            request.return_value.__enter__.return_value.read.return_value = b'{"response":"ok"}'
            self.assertEqual(ai_commit.ollama_json("/api/generate", {"model": "local"}), {"response": "ok"})
            self.assertEqual(request.call_args.kwargs["timeout"], 300)

    def test_expired_budget_falls_back_before_retrying(self):
        clock = [0.0]
        def timeout(*args, **kwargs):
            clock[0] = 135.0
            raise TimeoutError()
        with ExitStack() as stack:
            for name, value in [('installed_local_model_names', {'local'}),
                                ('selected_model', ('local', False)),
                                ('configured_models', ('local', 'small')),
                                ('staged_file_context', ''), ('recent_subjects', ''),
                                ('commit_fallback_enabled', True)]:
                stack.enter_context(patch.object(ai_commit, name, return_value=value))
            stack.enter_context(patch.object(ai_commit.time, 'monotonic', side_effect=lambda: clock[0]))
            request = stack.enter_context(patch.object(ai_commit, 'ollama_json', side_effect=timeout))
            logs = stack.enter_context(patch.object(ai_commit, 'log_event'))
            self.assertEqual(ai_commit.generate_message('', '+Fix handler', ['app.py']),
                             ('🔧 Update `app.py`', ''))
            request.assert_called_once()
            self.sleep.assert_not_called()
            self.assertEqual(logs.call_args_list[-1].kwargs['reason'], 'deadline_exceeded')
            self.assertIsNone(ai_commit.GENERATION_DEADLINE.get())

    def test_commit_endpoint_routes_locally_and_rejects_remote_addresses(self):
        with patch.dict(ai_commit.os.environ, {"SCM_TOOLKIT_AI_OLLAMA_URL": "http://127.0.0.1:11435"}), patch.object(ai_commit.OLLAMA_OPENER, "open") as request:
            request.return_value.__enter__.return_value.read.return_value = b'{}'
            ai_commit.ollama_json("/api/tags")
            self.assertEqual(request.call_args.args[0].full_url, "http://127.0.0.1:11435/api/tags")
        for url in ["https://example.com", "http://example.com", "http://user:password@localhost:11435", "http://localhost:11435/path"]:
            with self.subTest(url=url), patch.dict(ai_commit.os.environ, {"SCM_TOOLKIT_AI_OLLAMA_URL": url}), patch.object(ai_commit.OLLAMA_OPENER, "open") as request:
                with self.assertRaisesRegex(ValueError, "local HTTP"):
                    ai_commit.ollama_json("/api/tags")
                request.assert_not_called()

    def test_refused_model_discovery_starts_ollama_and_retries(self):
        refused = ai_commit.urllib.error.URLError(ConnectionRefusedError())
        with patch.dict(ai_commit.os.environ, {"SCM_TOOLKIT_AI_OLLAMA_URL": "http://127.0.0.1:11435"}), \
                patch.object(ai_commit.OLLAMA_OPENER, 'open') as request, \
                patch.object(ai_commit.ollama_concurrency, 'recover') as recover:
            response = request.return_value
            response.__enter__.return_value.read.return_value = b'{"models":[{"name":"local"}]}'
            request.side_effect = [refused, response]
            self.assertEqual(ai_commit.installed_local_model_names(require_service=True), {'local'})
            recover.assert_called_once_with("http://127.0.0.1:11435", 15,
                                            ai_commit.commit_jobs_directory())
            self.assertEqual(request.call_count, 2)

    def test_busy_ollama_does_not_restart(self):
        unavailable = ai_commit.urllib.error.HTTPError(
            'http://localhost/api/tags', 503, 'busy', None, None)
        with patch.object(ai_commit.OLLAMA_OPENER, 'open', side_effect=unavailable), \
                patch.object(ai_commit.ollama_concurrency, 'recover') as recover:
            with self.assertRaisesRegex(ai_commit.OllamaConnectionError, 'model list'):
                ai_commit.ollama_json('/api/tags')
            recover.assert_not_called()

    def test_missing_ollama_reports_service_problem_and_preserves_fallback(self):
        unavailable = ai_commit.OllamaConnectionError("Install Ollama.", "ollama_missing")
        warnings = []
        token = ai_commit.OLLAMA_WARNING.set(warnings.append)
        try:
            with patch.object(ai_commit, 'installed_local_model_names', side_effect=unavailable), \
                    patch.object(ai_commit, 'configured_backends', return_value=('ollama',)), \
                    patch.object(ai_commit, 'commit_fallback_enabled', return_value=True):
                self.assertEqual(ai_commit.generate_message('', '+Fix handler', ['app.py']),
                                 ('🔧 Update `app.py`', ''))
                with self.assertRaisesRegex(ai_commit.OllamaConnectionError, 'Install Ollama'):
                    ai_commit.generate_message('', '+Fix handler', ['app.py'], require_model=True)
        finally:
            ai_commit.OLLAMA_WARNING.reset(token)
        self.assertEqual(warnings, ['Install Ollama.', 'Install Ollama.'])

    def test_commit_endpoint_uses_git_setting_without_environment_override(self):
        with patch.dict(ai_commit.os.environ, {"SCM_TOOLKIT_AI_OLLAMA_URL": ""}), patch.object(ai_commit, "git_config_string", return_value="http://127.0.0.1:11435"), patch.object(ai_commit.OLLAMA_OPENER, "open") as request:
            request.return_value.__enter__.return_value.read.return_value = b'{}'
            ai_commit.ollama_json("/api/tags")
            self.assertEqual(request.call_args.args[0].full_url, "http://127.0.0.1:11435/api/tags")

if __name__ == "__main__":
    unittest.main()
