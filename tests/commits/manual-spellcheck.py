
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


class ManualSpellcheckTests(unittest.TestCase):
    def test_safe_grammar_correction_requires_high_similarity_and_preserves_tokens(self):
        original = "🐞 Fix button are brokn"
        self.assertEqual(
            ai_commit.safe_spellcheck_correction(
                original, '{"subject":"🐞 Fix the buttons are broken"}', style="grammar"),
            "🐞 Fix the buttons are broken",
        )
        self.assertEqual(
            ai_commit.safe_spellcheck_correction(
                original, '{"subject":"🐞 Fix the buttons are broken"}'),
            original,
        )
        for before, after in [
            ("Fix API 2", "Fix API 3"),
            ("Fix Instinet name", "Fix Instinett name"),
            ("Fix `--debug` in path", "Fix `--release` in path"),
            ("Fix typo 🐞", "Fix typo 🐛"),
        ]:
            self.assertEqual(
                ai_commit.safe_spellcheck_correction(
                    before, json.dumps({"subject": after}), style="grammar", vocabulary=["Instinet"]),
                before,
            )

    def test_draft_spellchecking_includes_custom_preferences_and_preserves_terms(self):
        def config(key, default=""):
            return {
                "scm-toolkit.draft-spellcheck-style": "grammar",
                "scm-toolkit.draft-spellcheck-vocabulary": "Instinet\nSoroban",
                "scm-toolkit.draft-spellcheck-guidance": "Prefer consistent capitalization.",
            }.get(key, default)
        with patch.object(ai_commit, "git_config_string", side_effect=config), patch.object(
            ai_commit, "manual_spellcheck_enabled", return_value=True
        ), patch.object(
            ai_commit, "installed_local_model_names", return_value={"spell:test"}
        ), patch.object(
            ai_commit, "configured_spellcheck_model", return_value="spell:test"
        ), patch.object(
            ai_commit, "ollama_json",
            return_value={"response": '{"subject":"Fix Instinett phrasing"}'},
        ) as request:
            self.assertEqual(ai_commit.spellcheck_subject("Fix Instinet phrasing"), "Fix Instinet phrasing")
            prompt = request.call_args.args[1]["prompt"]
            self.assertIn("Prefer consistent capitalization.", prompt)
            self.assertIn("Instinet\nSoroban", prompt)
            self.assertIn("grammatical", prompt)

    def test_spellcheck_thinking_detects_named_boolean_and_unsupported_levels(self):
        ai_commit.spellcheck_thinking_capabilities.cache_clear()
        def fake_show(_path, payload, timeout=None):
            if payload["model"] == "named:test":
                return {"thinking": {"values": ["low", "medium", "high"], "default": "medium"}}
            if payload["model"] == "boolean:test":
                return {"thinking": {"values": [False, True], "default": False}}
            return {"thinking": {"values": [False]}}
        with patch.object(ai_commit, "git_config_string",
                          return_value="high"), patch.object(
            ai_commit, "ollama_json", side_effect=fake_show
        ) as show:
            self.assertEqual(ai_commit.spellcheck_thinking_options("named:test"), {"think": "high"})
            self.assertEqual(ai_commit.spellcheck_thinking_options("boolean:test"), {"think": True})
            self.assertEqual(ai_commit.spellcheck_thinking_options("unsupported:test"), {})
            self.assertEqual(show.call_count, 3)
            self.assertEqual(ai_commit.spellcheck_thinking_options("named:test"), {"think": "high"})
            self.assertEqual(show.call_count, 3)
        with patch.object(ai_commit, "git_config_string", return_value="default"), patch.object(
            ai_commit, "ollama_json"
        ) as request:
            self.assertEqual(ai_commit.spellcheck_thinking_options("new:test"), {})
            request.assert_not_called()
        ai_commit.spellcheck_thinking_capabilities.cache_clear()

    def test_draft_high_thinking_increases_budget_without_bypassing_safety(self):
        requests = []
        def generate(endpoint, payload, timeout=None):
            requests.append((endpoint, payload, timeout))
            if endpoint == "/api/show":
                return {"thinking": {"values": ["low", "medium", "high"]}}
            return {"response": '{"subject":"Fix spelling"}'}
        ai_commit.spellcheck_thinking_capabilities.cache_clear()
        with patch.object(ai_commit, "git_config_string", side_effect=lambda key, default="": (
            "high" if key == "scm-toolkit.spellcheck-thinking-effort" else default
        )), patch.object(ai_commit, "manual_spellcheck_enabled", return_value=True), patch.object(
            ai_commit, "installed_local_model_names", return_value={"thinking:test"}
        ), patch.object(ai_commit, "configured_spellcheck_model", return_value="thinking:test"), patch.object(
            ai_commit, "ollama_json", side_effect=generate
        ):
            self.assertEqual(ai_commit.spellcheck_subject("Fxi spelling"), "Fix spelling")
        self.assertEqual(requests[0][0], "/api/show")
        self.assertEqual(requests[1][1]["think"], "high")
        self.assertGreaterEqual(requests[1][1]["options"]["num_predict"], 2048)
        self.assertEqual(requests[1][2], 120)
        ai_commit.spellcheck_thinking_capabilities.cache_clear()

    def test_reviewed_spellcheck_title_uses_the_normal_commit_generation_pipeline(self):
        import io
        argv = ["ai-commit.py", "--spellcheck-generate-message",
                json.dumps({"paths": ["notes/report.md"]})]
        def staged(*args):
            if "--stat" in args:
                return "notes/report.md | 2 + -"
            if "--unified=2" in args:
                return "--- a/notes/report.md\n+++ b/notes/report.md\n-old\n+new"
            return ""
        with patch.object(sys, "argv", argv), patch.object(
            sys, "stdout", io.StringIO()
        ) as output, patch.object(
            ai_commit, "git_output", side_effect=staged
        ) as read, patch.object(
            ai_commit, "staged_file_context", return_value="context"
        ), patch.object(
            ai_commit, "should_add_default_branch_description", return_value=True
        ), patch.object(
            ai_commit, "generate_message", autospec=True, return_value=("🖊️ Fix trading citations", "Correct typos in the citations.")
        ) as generate:
            ai_commit.main()
        self.assertEqual(json.loads(output.getvalue()), {
            "title": "🖊️ Fix trading citations", "description": "Correct typos in the citations."
        })
        generate.assert_called_once_with(
            "notes/report.md | 2 + -",
            "--- a/notes/report.md\n+++ b/notes/report.md\n-old\n+new",
            ["notes/report.md"], include_description=True, file_context_override="context")
        self.assertTrue(all("notes/report.md" in call.args for call in read.call_args_list))

    def test_reviewed_spellcheck_emoji_toggle_formats_only_after_normal_generation(self):
        import io
        argv = ["ai-commit.py", "--spellcheck-generate-message",
                json.dumps({"paths": ["notes/report.md"]})]
        for enabled, expected in (
            (True, "🖊️ Fix Markdown typos"),
            (False, "Fix Markdown typos"),
        ):
            with self.subTest(enabled=enabled), patch.object(
                sys, "argv", argv
            ), patch.object(
                sys, "stdout", io.StringIO()
            ) as output, patch.object(
                ai_commit, "git_output", side_effect=["report.md | 2 +-", "-typo\n+fixed"]
            ), patch.object(
                ai_commit, "staged_file_context", return_value=""
            ), patch.object(
                ai_commit, "should_add_default_branch_description", return_value=False
            ), patch.object(
                ai_commit, "git_config_bool", return_value=enabled
            ) as setting, patch.object(
                ai_commit, "generate_message",
                return_value=("🖊️ Fix Markdown typos", "Full normal-generation description.")
            ) as generator:
                ai_commit.main()
            self.assertEqual(json.loads(output.getvalue()), {
                "title": expected,
                "description": "Full normal-generation description.",
            })
            generator.assert_called_once()
            setting.assert_called_once_with("scm-toolkit.spellcheck-changes-emoji", True)

    def test_reviewed_spellcheck_emoji_removal_only_changes_leading_emoji(self):
        import io
        argv = ["ai-commit.py", "--spellcheck-generate-message",
                json.dumps({"paths": ["notes/report.md"]})]
        cases = (
            ("🧪 Add test coverage", "Add test coverage"),
            ("🐞 🧪 Fix typo", "Fix typo"),
            ("Fix 🐞 icon", "Fix 🐞 icon"),
            ("Fix title", "Fix title"),
        )
        for generated, expected in cases:
            with self.subTest(generated=generated), patch.object(
                sys, "argv", argv
            ), patch.object(
                sys, "stdout", io.StringIO()
            ) as output, patch.object(
                ai_commit, "git_output", side_effect=["report.md | 2 +-", "-typo\n+fixed"]
            ), patch.object(
                ai_commit, "staged_file_context", return_value=""
            ), patch.object(
                ai_commit, "should_add_default_branch_description", return_value=False
            ), patch.object(
                ai_commit, "git_config_bool", return_value=False
            ) as setting, patch.object(
                ai_commit, "generate_message", return_value=(generated, "Normal description.")
            ) as generator:
                ai_commit.main()
            self.assertEqual(json.loads(output.getvalue()), {
                "title": expected, "description": "Normal description.",
            })
            generator.assert_called_once()
            setting.assert_called_once_with("scm-toolkit.spellcheck-changes-emoji", True)

    def test_reviewed_spellcheck_emoji_removal_rejects_empty_title(self):
        import io
        argv = ["ai-commit.py", "--spellcheck-generate-message",
                json.dumps({"paths": ["notes/report.md"]})]
        with patch.object(
            sys, "argv", argv
        ), patch.object(
            sys, "stderr", io.StringIO()
        ) as errors, patch.object(
            ai_commit, "git_output", side_effect=["report.md | 2 +-", "-typo\n+fixed"]
        ), patch.object(
            ai_commit, "staged_file_context", return_value=""
        ), patch.object(
            ai_commit, "should_add_default_branch_description", return_value=False
        ), patch.object(
            ai_commit, "git_config_bool", return_value=False
        ), patch.object(
            ai_commit, "generate_message", return_value=("🐞 🧪", "Normal description.")
        ):
            with self.assertRaises(SystemExit):
                ai_commit.main()
        self.assertIn("Generated title contains no words after its emoji", errors.getvalue())

    def test_reviewed_spellcheck_title_rejects_unsafe_paths_before_git(self):
        import io
        for path in ["../outside.md", "/absolute.md", "other.bin", "bad\x00.md"]:
            with self.subTest(path=path), patch.object(
                sys, "argv", ["ai-commit.py", "--spellcheck-generate-message",
                              json.dumps({"paths": [path]})]
            ), patch.object(
                sys, "stderr", io.StringIO()
            ), patch.object(ai_commit, "git_output") as git:
                with self.assertRaises(SystemExit):
                    ai_commit.main()
                git.assert_not_called()

    def test_professional_emoji_adds_one_suitable_prefix(self):
        with patch.object(ai_commit, "choose_bug_emoji", return_value="🐛"):
            self.assertEqual(ai_commit.add_professional_emoji("Fix commit title"), "🐛 Fix commit title")
        self.assertEqual(ai_commit.add_professional_emoji("Update button layout"), "🖌️ Update button layout")
        self.assertEqual(ai_commit.add_professional_emoji("Add tests"), "🧪 Add tests")
        self.assertEqual(ai_commit.add_professional_emoji(""), "")

    def test_professional_emoji_preserves_existing_user_choice_and_whitespace(self):
        self.assertEqual(ai_commit.add_professional_emoji("🐞 Fix spelling"), "🐞 Fix spelling")
        self.assertEqual(ai_commit.add_professional_emoji("Fix ✅ checkmarks"), "Fix ✅ checkmarks")
        with patch.object(ai_commit, "choose_bug_emoji", return_value="🐛"):
            self.assertEqual(ai_commit.add_professional_emoji("  Fix spelling"), "🐛   Fix spelling")

    def test_cli_emoji_only_never_invokes_spellcheck_or_git(self):
        import io
        with patch.object(sys, "argv", ["ai-commit.py", "--professional-emoji"]), patch.object(
            sys, "stdin", io.StringIO("Fix typo")
        ), patch.object(sys, "stdout", io.StringIO()) as output, patch.object(
            ai_commit, "spellcheck_subject"
        ) as spellcheck, patch.object(ai_commit.os, "execv") as git, patch.object(
            ai_commit, "choose_bug_emoji", return_value="🐛"
        ):
            ai_commit.main()
        self.assertEqual(json.loads(output.getvalue()), {"subject": "🐛 Fix typo"})
        spellcheck.assert_not_called()
        git.assert_not_called()

    def test_cli_spellcheck_and_emoji_share_one_correction(self):
        import io
        with patch.object(sys, "argv", ["ai-commit.py", "--spellcheck-subject", "--professional-emoji"]), patch.object(
            sys, "stdin", io.StringIO("Fxi typo")
        ), patch.object(sys, "stdout", io.StringIO()) as output, patch.object(
            ai_commit, "spellcheck_subject", return_value="Fix typo"
        ) as spellcheck, patch.object(
            ai_commit, "choose_bug_emoji", return_value="🐛"
        ):
            ai_commit.main()
        self.assertEqual(json.loads(output.getvalue()), {"subject": "🐛 Fix typo"})
        spellcheck.assert_called_once_with("Fxi typo")

    @patch.object(ai_commit, "spellcheck_subject", return_value="Fix spelling")
    def test_only_subject_line_is_rewritten(self, _spellcheck):
        message = "Fxi spelling\n\nKeep this body exactly."
        self.assertEqual(
            ai_commit.spellcheck_manual_message(message),
            "Fix spelling\n\nKeep this body exactly.",
        )

    @patch.object(ai_commit, "spellcheck_subject", return_value="Fix spelling")
    def test_message_argument_is_rewritten_in_place(self, _spellcheck):
        args, found = ai_commit.spellcheck_manual_message_args(
            ["--quiet", "--message=Fxi spelling"]
        )
        self.assertTrue(found)
        self.assertEqual(args, ["--quiet", "--message=Fix spelling"])

    @patch.object(ai_commit, "manual_spellcheck_enabled", return_value=False)
    @patch.object(ai_commit, "installed_local_model_names")
    def test_disabled_preview_never_queries_models(self, models, _enabled):
        self.assertEqual(ai_commit.spellcheck_subject("Fxi spelling"), "Fxi spelling")
        models.assert_not_called()

    @patch.object(ai_commit, "manual_spellcheck_enabled", return_value=False)
    @patch.object(ai_commit, "installed_local_model_names", return_value={"spell:test"})
    @patch.object(ai_commit, "configured_spellcheck_model", return_value="spell:test")
    @patch.object(ai_commit, "ollama_json", return_value={"response": '{"subject":"Fix spelling"}'})
    def test_explicit_preview_works_with_automatic_spellcheck_disabled(self, request, *_):
        self.assertEqual(ai_commit.spellcheck_subject("Fxi spelling", manual=True), "Fix spelling")
        request.assert_called_once()

    @patch.object(ai_commit, "manual_spellcheck_enabled", return_value=True)
    @patch.object(ai_commit, "installed_local_model_names", return_value=set())
    @patch.object(ai_commit, "configured_spellcheck_model", return_value="spell:test")
    def test_missing_model_preserves_manual_subject(
        self, _configured, _models, _enabled
    ):
        self.assertEqual(ai_commit.spellcheck_subject("Fxi spelling"), "Fxi spelling")

    @patch.object(ai_commit, "manual_spellcheck_enabled", return_value=True)
    @patch.object(ai_commit, "installed_local_model_names", return_value={"spell:test"})
    @patch.object(ai_commit, "configured_spellcheck_model", return_value="spell:test")
    @patch.object(
        ai_commit,
        "ollama_json",
        return_value={"response": '{"subject":"Fix spelling"}'},
    )
    def test_dedicated_spellcheck_model_correction_is_used(
        self, request, _configured, _models, _enabled
    ):
        self.assertEqual(ai_commit.spellcheck_subject("Fxi spelling"), "Fix spelling")
        self.assertEqual(request.call_args.args[1]["model"], "spell:test")

    def test_rejects_malformed_or_unrelated_spellcheck_output(self):
        subject = "🐜 Fxi commit titel"
        for response in [
            "json",
            '{"subject":"🐜 Change random words"}',
            '{"subject":"🐜 Fix commit title","extra":true}',
            '["🐜 Fix commit title"]',
            '{"subject":"🐜 Fix commit title\nmore"}',
        ]:
            with self.subTest(response=response):
                self.assertEqual(
                    ai_commit.safe_spellcheck_correction(subject, response),
                    subject,
                )

    def test_accepts_close_structured_spelling_correction(self):
        self.assertEqual(
            ai_commit.safe_spellcheck_correction(
                "🐜 Fxi commit titel",
                '{"subject":"🐜 Fix commit title"}',
            ),
            "🐜 Fix commit title",
        )

    def test_spellcheck_request_uses_json_schema(self):
        response = {"response": '{"subject":"Fix spelling"}'}
        with patch.object(ai_commit, "manual_spellcheck_enabled", return_value=True), patch.object(
            ai_commit, "installed_local_model_names", return_value={"spell:test"}
        ), patch.object(
            ai_commit, "configured_spellcheck_model", return_value="spell:test"
        ), patch.object(ai_commit, "ollama_json", return_value=response) as request:
            self.assertEqual(ai_commit.spellcheck_subject("Fxi spelling"), "Fix spelling")
        payload = request.call_args.args[1]
        self.assertEqual(payload["model"], "spell:test")
        self.assertEqual(payload["format"]["required"], ["subject"])
        self.assertFalse(payload["format"]["additionalProperties"])

if __name__ == "__main__":
    unittest.main()
