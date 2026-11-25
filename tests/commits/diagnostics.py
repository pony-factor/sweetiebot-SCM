
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


class CommitDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        instructions = patch.object(ai_commit, "commit_custom_instructions", return_value="")
        instructions.start()
        self.addCleanup(instructions.stop)

    def test_opt_in_title_explanation_uses_same_ollama_request(self):
        response = json.dumps({
            "subject": "🔧 Improve parser validation",
            "description": "",
            "explanation": "Validation changes motivated the parser wording.",
        })
        for enabled in (False, True):
            with self.subTest(enabled=enabled), ExitStack() as stack:
                for name, value in [
                    ("installed_local_model_names", {"local"}),
                    ("selected_model", ("local", False)),
                    ("configured_models", ("local", "small")),
                    ("staged_file_context", ""),
                    ("recent_subjects", ""),
                    ("emoji_priority_enabled", False),
                    ("emoji_for_change", "🔧"),
                    ("title_explanations_enabled", enabled),
                ]:
                    stack.enter_context(patch.object(ai_commit, name, return_value=value))
                generate = stack.enter_context(patch.object(
                    ai_commit, "ollama_json", return_value={"response": response}
                ))
                events = stack.enter_context(patch.object(ai_commit, "log_event"))
                self.assertEqual(
                    ai_commit.generate_message("1 file changed", "+Validate parser inputs.", ["parser.py"]),
                    ("🔧 Improve parser validation", ""),
                )
                self.assertEqual(generate.call_count, 1)
                payload = generate.call_args.args[1]
                self.assertEqual("explanation" in payload["format"]["properties"], enabled)
                self.assertEqual("explanation field" in payload["prompt"], enabled)
                self.assertEqual(payload["format"]["required"], ["subject", "description"])
                complete = [call.kwargs for call in events.call_args_list
                            if call.args[1] == "generation_completed"]
                self.assertEqual(len(complete), 1)
                self.assertEqual(complete[0]["title"], "🔧 Improve parser validation")
                self.assertEqual("explanation" in complete[0], enabled)
                self.assertEqual("rule" in complete[0], enabled)
                if enabled:
                    self.assertEqual(complete[0]["explanation"],
                                     "Validation changes motivated the parser wording.")
                    self.assertEqual(complete[0]["rule"], "change_type")

    def test_invalid_explanations_never_reject_valid_titles(self):
        for explanation in (None, "Too short", "x" * 300, "A line.\nAnother line."):
            with self.subTest(explanation=explanation), ExitStack() as stack:
                for name, value in [
                    ("installed_local_model_names", {"local"}),
                    ("selected_model", ("local", False)),
                    ("configured_models", ("local", "small")),
                    ("staged_file_context", ""),
                    ("recent_subjects", ""),
                    ("emoji_priority_enabled", False),
                    ("emoji_for_change", "🔧"),
                    ("title_explanations_enabled", True),
                ]:
                    stack.enter_context(patch.object(ai_commit, name, return_value=value))
                payload = {"subject": "🔧 Improve parser validation", "description": ""}
                if explanation is not None:
                    payload["explanation"] = explanation
                generate = stack.enter_context(patch.object(
                    ai_commit, "ollama_json", return_value={"response": json.dumps(payload)}
                ))
                events = stack.enter_context(patch.object(ai_commit, "log_event"))
                self.assertEqual(
                    ai_commit.generate_message("1 file changed", "+Validate inputs.", ["parser.py"]),
                    ("🔧 Improve parser validation", ""),
                )
                generate.assert_called_once()
                completed = next(call.kwargs for call in events.call_args_list
                                 if call.args[1] == "generation_completed")
                self.assertNotIn("explanation", completed)
                self.assertEqual(completed["rule"], "change_type")

    def test_missing_model_is_logged_without_diff(self):
        with ExitStack() as stack:
            stack.enter_context(patch.object(ai_commit, "installed_local_model_names", return_value=set()))
            stack.enter_context(patch.object(ai_commit, "selected_model", return_value=(None, False)))
            stack.enter_context(patch.object(ai_commit, "configured_models", return_value=("primary", "small")))
            events = stack.enter_context(patch.object(ai_commit, "log_event"))
            self.assertEqual(
                ai_commit.generate_message("private stat", "+private text", ["notes.md"]),
                ("📝 Update `notes.md`", ""),
            )
            self.assertEqual(
                [call.args[1] for call in events.call_args_list],
                ["model_unavailable", "fallback_used"],
            )
            self.assertEqual(events.call_args_list[0].kwargs["outcome"], "fallback")
            self.assertEqual(events.call_args_list[1].kwargs["reason"], "model_not_installed")
            self.assertNotIn("private text", str(events.call_args_list))

    def test_rejected_output_is_logged_without_model_response(self):
        with ExitStack() as stack:
            for name, value in [
                ("installed_local_model_names", {"local"}),
                ("selected_model", ("local", False)),
                ("configured_models", ("local", "small")),
                ("staged_file_context", ""),
                ("recent_subjects", ""),
                ("ollama_json", {"response": '{"subject":"Fix","description":""}'}),
            ]:
                stack.enter_context(patch.object(ai_commit, name, return_value=value))
            events = stack.enter_context(patch.object(ai_commit, "log_event"))
            ai_commit.generate_message("", "", ["parser.py"])
            self.assertEqual(
                [call.args[1] for call in events.call_args_list],
                ["output_rejected", "output_rejected", "output_rejected", "fallback_used"],
            )
            self.assertEqual(events.call_args_list[0].kwargs["reason"], "invalid_message")
            self.assertNotIn("response", str(events.call_args_list))

    def test_request_errors_are_logged_with_retry_status(self):
        from urllib.error import HTTPError
        with ExitStack() as stack:
            for name, value in [
                ("installed_local_model_names", {"local"}),
                ("selected_model", ("local", False)),
                ("configured_models", ("local", "small")),
                ("staged_file_context", ""),
                ("recent_subjects", ""),
            ]:
                stack.enter_context(patch.object(ai_commit, name, return_value=value))
            stack.enter_context(patch.object(
                ai_commit, "ollama_json", side_effect=HTTPError("http://localhost", 503, "busy", None, None)
            ))
            stack.enter_context(patch.object(ai_commit.time, "sleep"))
            events = stack.enter_context(patch.object(ai_commit, "log_event"))
            self.assertEqual(
                ai_commit.generate_message("one file", "+secret text", ["notes.md"]),
                ("📝 Update `notes.md`", ""),
            )
            attempts = [call.kwargs for call in events.call_args_list if call.args[1] == "request_failed"]
            self.assertEqual([event["outcome"] for event in attempts], ["retry", "retry", "stopped"])
            self.assertEqual([event["http_status"] for event in attempts], [503, 503, 503])
            self.assertEqual(events.call_args_list[-1].args[1], "fallback_used")
            self.assertNotIn("secret text", str(events.call_args_list))

if __name__ == "__main__":
    unittest.main()
