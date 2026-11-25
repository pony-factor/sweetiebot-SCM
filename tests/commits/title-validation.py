
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

    @patch.object(ai_commit, "recent_subjects", return_value="Fix parser\nAdd tests")
    def test_prompt_is_repository_scoped(self, _subjects):
        prompt = ai_commit.prompt_for_diff("1 file changed", "diff --git a/a b/a")
        self.assertIn("Recent repository subjects:", prompt)
        self.assertIn("Output rules:", prompt)
        self.assertIn("Staged diff:", prompt)
        self.assertIn("one professional emoji", prompt)
        self.assertIn("dedicated Sync button", prompt)
        self.assertIn("file count, diff size, and file moves", prompt)

    @patch.object(ai_commit, "commit_custom_instructions", return_value="")
    def test_entire_large_prompt_is_bounded_and_keeps_rules_and_totals(self, _instructions):
        with patch.object(ai_commit, "recent_subjects", return_value="Update notes\n" * 500):
            prompt = ai_commit.prompt_for_diff(
                "file | 1000 +++\n" * 1000,
                "\n".join(f"diff --git a/{i}.eml b/{i}.eml\n-Subject: Message {i}\n" + "-QUJD" * 500 for i in range(100)),
                "Change totals: 100 deleted\n" + "D\tarchive/email.eml\n" * 1000,
                include_description=True, conversation_context="Background " * 3000,
            )
        self.assertLessEqual(len(prompt), (ai_commit.NUM_CTX - 768) * 2)
        self.assertIn("100 deleted", prompt)
        self.assertIn("99.eml", prompt)
        self.assertTrue(prompt.endswith("complete sentences."))

    def test_encoded_attachment_does_not_dominate_patch(self):
        diff = "diff --git a/mail.eml b/mail.eml\n-Subject: Archive notice\n" + ("-QUJD" + "QUJD" * 200 + "\n") * 500 + "+Subject: Updated archive notice"
        sampled = ai_commit.sample_diff_for_prompt(diff)
        self.assertIn("Archive notice", sampled)
        self.assertIn("Updated archive notice", sampled)
        self.assertLess(len(sampled), 250)

    def test_long_style_instructions_leave_room_for_actual_changes(self):
        instructions = "Emoji preference.\n" * 1000
        with patch.object(ai_commit, "commit_custom_instructions", return_value=instructions), patch.object(ai_commit, "recent_subjects", return_value=""):
            prompt = ai_commit.prompt_for_diff(
                "1 file changed", "+Exhibit 3 redaction\n+Exhibit 5 fee references", "Change totals: 1 modified"
            )
        self.assertLessEqual(len(prompt), (ai_commit.NUM_CTX - 768) * 2 + len(instructions))
        self.assertIn(instructions, prompt)
        self.assertIn("+Exhibit 3 redaction\n+Exhibit 5 fee references", prompt)

    def test_generated_title_preserves_quotes_and_inline_code(self):
        title, body = ai_commit.sanitize_generated_message(json.dumps({
            "subject": "🗣️ Update tab title from 'Meeting Notes' to 'Meetings'",
            "description": "",
        }))
        self.assertEqual(title, "🗣️ Update tab title from 'Meeting Notes' to 'Meetings'")
        self.assertTrue(ai_commit.valid_generated_message(title, body, False))
        title, body = ai_commit.sanitize_generated_message(json.dumps({
            "subject": "🔧 Update `docs.json` on `mintlify`", "description": "",
        }))
        self.assertEqual(title, "🔧 Update `docs.json` on `mintlify`")
        self.assertTrue(ai_commit.valid_generated_message(title, body, False))
        title, body = ai_commit.sanitize_generated_message(json.dumps({
            "subject": "🔧 Update `__init__.py` settings", "description": "",
        }))
        self.assertEqual(title, "🔧 Update `__init__.py` settings")

    def test_generated_title_rejects_unclosed_delimiters(self):
        for title in (
            "🗣️ Update tab title from 'Meeting Notes' to 'Meetings",
            "🔧 Update parser (draft",
            "🔧 Update parser draft)",
            "🔧 Update `docs.json",
            "🔧 Update docs [pending",
            '🔧 Update "draft',
        ):
            with self.subTest(title=title):
                self.assertFalse(ai_commit.valid_generated_message(title, "", False))
        for title in (
            "🗣️ Update tab title from 'Meeting Notes' to 'Meetings'",
            "🔧 Update parser (draft)",
            "🔧 Update `docs.json` on `main`",
            "🔧 Update O'Reilly's parser (draft)",
        ):
            with self.subTest(title=title):
                self.assertTrue(ai_commit.valid_generated_message(title, "", False))

    def test_generated_title_prompt_prefers_backticked_identifiers(self):
        with patch.object(ai_commit, "recent_subjects", return_value=""):
            prompt = ai_commit.prompt_for_diff("", "")
        self.assertIn("inline Markdown backticks in the subject", prompt)
        self.assertIn("branch names", prompt)
        self.assertIn("closing delimiters", prompt)

    def test_json_response_has_plain_text_and_complete_sentences(self):
        title, body = ai_commit.sanitize_generated_message(
            '{"subject":"📧 **Remove redundant emails**","description":"Remove `duplicate.eml` from the **archive**. Preserve [metadata](https://example.test)."}',
            include_description=True,
        )
        self.assertEqual(title, "📧 Remove redundant emails")
        self.assertEqual(body, "Remove duplicate.eml from the archive. Preserve metadata.")
        self.assertEqual(ai_commit.sanitize_description("Remove duplicates while preserving"), "")
        self.assertEqual(ai_commit.sanitize_description("Remove duplicates. " + "Continue " * 60 + "."), "Remove duplicates.")

    def test_bad_model_response_retries_then_uses_operation_summary(self):
        for bad in [
            {"response": "The provided text appears to be a Git diff.\n\nHere is a breakdown."},
            {"response": '{"subject":"📧 Remove redundant emails","description":"This appears to remove duplicates."}'},
            {"response": '{"subject":"📧 Remove redundant emails","description":"Remove duplicate email files while"}'},
            {"response": '{"subject":"📧 Remove redundant emails","description":"Remove duplicates."}', "done_reason": "length"},
        ]:
            with self.subTest(bad=bad), ExitStack() as stack:
                for name, value in [
                    ("installed_local_model_names", {"local"}), ("selected_model", ("local", False)),
                    ("configured_models", ("local", "small")), ("recent_subjects", ""),
                    ("staged_file_context", "Change totals: 2 deleted"),
                ]:
                    stack.enter_context(patch.object(ai_commit, name, return_value=value))
                generate = stack.enter_context(patch.object(ai_commit, "ollama_json", return_value=bad))
                self.assertEqual(ai_commit.generate_message("", "", ["a.eml", "b.eml"], include_description=True),
                                 ("📧 Remove 2 archived emails", "Remove 2 email files from the repository."))
                self.assertEqual(generate.call_count, 3)

    def test_removal_claims_require_evidence_from_this_change(self):
        self.assertTrue(ai_commit.has_unsupported_removal_claim("Remove redundant emails.", "deleted file mode 100644"))
        self.assertTrue(ai_commit.has_unsupported_removal_claim("These files are no longer needed.", "800 deleted"))
        self.assertFalse(ai_commit.has_unsupported_removal_claim("Remove duplicate emails.", "archive/duplicate.eml"))
        with patch.object(ai_commit, "recent_subjects", return_value="📦 Preserve archive metadata\n🧹 Remove redundant MBOX chunks"):
            prompt = ai_commit.prompt_for_diff("", "")
        history = prompt.split("Recent repository subjects:\n")[1].split("Staged diff stat:")[0]
        self.assertNotIn("redundant", history)
        self.assertNotIn("metadata", history)

    def test_retry_accepts_valid_structured_message(self):
        with ExitStack() as stack:
            output = stack.enter_context(patch("sys.stderr"))
            for name, value in [
                ("installed_local_model_names", {"local"}), ("selected_model", ("local", False)),
                ("configured_models", ("local", "small")), ("recent_subjects", ""), ("staged_file_context", ""),
            ]:
                stack.enter_context(patch.object(ai_commit, name, return_value=value))
            generate = stack.enter_context(patch.object(ai_commit, "ollama_json", side_effect=[
                {"response": "It appears to be a diff"},
                {"response": '{"subject":"📧 Remove duplicate archived emails","description":"Remove redundant email copies from the archive."}'},
            ]))
            self.assertEqual(ai_commit.generate_message("", "-Subject: duplicate copy", ["a.eml"], include_description=True),
                             ("📧 Remove duplicate archived emails", "Remove redundant email copies from the archive."))
            self.assertEqual(generate.call_count, 2)
            self.assertEqual(generate.call_args.args[1]["format"]["type"], "object")
            output.write.assert_not_called()

    def test_refine_heading_summary_is_accepted_without_retry(self):
        title = "🔧 Refine heading detection in tag-ocr-pdf.py"
        with ExitStack() as stack:
            for name, value in [
                ("installed_local_model_names", {"local"}), ("selected_model", ("local", False)),
                ("configured_models", ("local", "small")), ("recent_subjects", ""),
                ("staged_file_context", ""),
            ]:
                stack.enter_context(patch.object(ai_commit, name, return_value=value))
            generate = stack.enter_context(patch.object(ai_commit, "ollama_json", return_value={
                "response": json.dumps({"subject": title, "description": ""}), "done_reason": "stop",
            }))
            self.assertEqual(ai_commit.generate_message(
                "1 file changed", "+Promote only paragraphs matching recognized headings.",
                ["tag-ocr-pdf.py"], require_model=True,
            ), (title, ""))
            self.assertEqual(generate.call_count, 1)

    def test_invalid_summary_retry_names_accepted_imperative_verbs(self):
        with ExitStack() as stack:
            for name, value in [
                ("installed_local_model_names", {"local"}), ("selected_model", ("local", False)),
                ("configured_models", ("local", "small")), ("recent_subjects", ""),
                ("staged_file_context", ""),
            ]:
                stack.enter_context(patch.object(ai_commit, name, return_value=value))
            prompts = []
            responses = iter(["Strengthen heading detection", "Improve heading detection"])
            def respond(_endpoint, payload):
                prompts.append(payload["prompt"])
                return {"response": json.dumps({"subject": next(responses), "description": ""})}
            stack.enter_context(patch.object(ai_commit, "ollama_json", side_effect=respond))
            self.assertEqual(ai_commit.generate_message(
                "1 file changed", "+Match recognized headings exactly.", ["tag-ocr-pdf.py"],
            ), ("🔧 Improve heading detection", ""))
            self.assertIn("Begin the subject wording with Add, Fix, Update", prompts[1])

    def test_title_preference_references_standalone_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            instructions = Path(tmp) / "commit-instructions.md"
            instructions.write_text(
                "Never stage changes.\nCommit titles should use my current title style.\n",
                encoding="utf-8",
            )
            with patch.object(
                ai_commit, "commit_instructions_path", return_value=instructions
            ):
                self.assertEqual(
                    ai_commit.commit_title_preference(),
                    "Commit titles should use my current title style.",
                )

    @patch.object(ai_commit, "git_output", return_value="🔄 Sync branch to main\nSync branch with main\n📝 Reorganize research notes\nFix parser\n")
    def test_history_excludes_sync_titles(self, _git):
        self.assertEqual(ai_commit.recent_subjects(), "📝 Reorganize research notes\nFix parser")

    def test_generated_titles_require_at_least_two_words(self):
        for title in ["🐛 Fix", "📝 Update", "🔧 Refactor"]:
            with self.subTest(title=title):
                self.assertFalse(ai_commit.valid_generated_message(title, "", False))
        self.assertTrue(
            ai_commit.valid_generated_message("🐛 Fix parser", "", False)
        )

    def test_one_word_model_title_retries_then_falls_back(self):
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
            generate = ai_commit.ollama_json
            self.assertEqual(
                ai_commit.generate_message("", "", ["parser.py"]),
                ("🔧 Update `parser.py`", ""),
            )
            self.assertEqual(generate.call_count, 3)

    def test_generated_sync_titles_are_rejected_for_normal_and_context_commits(self):
        for title in ["🔄 Sync branch to main", "Sync branch with main", "Synchronize repository changes"]:
            for context in ["", "Moved the research notes into an archive"]:
                with self.subTest(title=title, context=context), ExitStack() as stack:
                    for name, value in [
                        ("installed_local_model_names", {"local"}),
                        ("selected_model", ("local", False)),
                        ("configured_models", ("local", "small")),
                        ("staged_file_context", "renamed research notes"),
                        ("recent_subjects", ""),
                        ("ollama_json", {"response": title + "\n\nSync the branch to main."}),
                    ]:
                        stack.enter_context(patch.object(ai_commit, name, return_value=value))
                    if context:
                        with self.assertRaisesRegex(RuntimeError, "after 3 attempts"):
                            ai_commit.generate_message("18 files changed", "rename diff", ["a.md", "b.md"], include_description=True, conversation_context=context, require_model=True)
                    else:
                        self.assertEqual(
                            ai_commit.generate_message("18 files changed", "rename diff", ["a.md", "b.md"], include_description=True),
                            ("📝 Update documentation", "Update 2 files in the repository."),
                        )

    def test_filename_only_title_retries_with_content_instructions(self):
        path = "comments/transfer-agent-rules/DTCC-DA-ICSD/2026-30.md"
        diff = "@@ -14,0 +15,2 @@\n+Exhibit 3 is redacted.\n+Exhibit 5 lists items and fines."
        with ExitStack() as stack:
            for name, value in [
                ("installed_local_model_names", {"local"}), ("selected_model", ("local", False)),
                ("configured_models", ("local", "small")), ("recent_subjects", ""),
                ("staged_file_context", "Change totals: 1 modified"),
            ]:
                stack.enter_context(patch.object(ai_commit, name, return_value=value))
            prompts = []
            responses = iter([
                {"response": '{"subject":"📝 Add DTCC-DA-ICSD 2026-30.md","description":""}'},
                {"response": '{"subject":"📝 Record DTC exhibit redaction and fee references","description":""}'},
            ])
            def respond(_endpoint, payload):
                prompts.append(payload["prompt"])
                self.assertGreaterEqual(payload["options"]["num_ctx"], (len(payload["prompt"]) + 1) // 2 + 768)
                return next(responses)
            generate = stack.enter_context(patch.object(ai_commit, "ollama_json", side_effect=respond))
            self.assertEqual(ai_commit.generate_message("1 file changed", diff, [path]),
                             ("📝 Record DTC exhibit redaction and fee references", ""))
            self.assertEqual(generate.call_count, 2)
            self.assertIn("not just a filename or file count", prompts[1])
            self.assertIn("+Exhibit 5 lists items and fines.", prompts[1])

    def test_text_changes_use_simple_fallback_after_failed_generation(self):
        for response in [None, {"response": '{"subject":"📝 Add notes.md","description":""}'},
                         {"response": "invalid"}]:
            with self.subTest(response=response), ExitStack() as stack:
                for name, value in [
                    ("installed_local_model_names", {"local"} if response else set()),
                    ("selected_model", ("local", False) if response else (None, False)),
                    ("configured_models", ("local", "small")), ("recent_subjects", ""),
                    ("staged_file_context", "Change totals: 1 modified"),
                ]:
                    stack.enter_context(patch.object(ai_commit, name, return_value=value))
                generate = stack.enter_context(patch.object(ai_commit, "ollama_json", return_value=response))
                self.assertEqual(
                    ai_commit.generate_message("1 file changed", "+Document DTC exhibit references.", ["notes.md"]),
                    ("📝 Update `notes.md`", ""),
                )
                self.assertEqual(generate.call_count, 3 if response else 0)

    def test_disabling_fallback_blocks_invalid_generated_titles(self):
        with ExitStack() as stack:
            for name, value in [
                ("installed_local_model_names", {"local"}), ("selected_model", ("local", False)),
                ("configured_models", ("local", "small")), ("recent_subjects", ""),
                ("staged_file_context", ""),
                ("commit_fallback_enabled", False),
                ("ollama_json", {"response": '{"subject":"Fix","description":""}'}),
            ]:
                stack.enter_context(patch.object(ai_commit, name, return_value=value))
            fallback = stack.enter_context(patch.object(ai_commit, "fallback_message"))
            with self.assertRaisesRegex(RuntimeError, "after 3 attempts"):
                ai_commit.generate_message("", "+Document facts.", ["notes.md"])
            fallback.assert_not_called()

    def test_filename_guard_preserves_specific_summaries_and_opaque_changes(self):
        self.assertTrue(ai_commit.is_filename_only_title(
            "📝 Add DTCC-DA-ICSD 2026-30 transfer agent rules",
            ["comments/transfer-agent-rules/DTCC-DA-ICSD/2026-30.md"],
        ))
        for title in ["📝 Add notes.md", "📝 Update notes", "📝 Add explanation for notes", "📝 Add 1 staged file"]:
            self.assertTrue(ai_commit.is_filename_only_title(title, ["notes.md"]))
        self.assertFalse(ai_commit.is_filename_only_title("📝 Add exhibit references to notes.md", ["notes.md"]))
        for diff in ["diff --git a/a b/a\n--- a/a\n+++ b/a\n+\n-  ", "Binary files a/a and b/a differ", "rename from a\nrename to b"]:
            self.assertFalse(ai_commit.has_text_changes(diff))

    def test_unrelated_model_emojis_are_replaced_by_change_type(self):
        cases = [
            ("🏆 Refine badge colors", "🎨 Refine badge colors"),
            ("🗳️ Fix reset handling", "🐛 Fix reset handling"),
            ("📱 Add patch validation coverage", "🧪 Add patch validation coverage"),
            ("🏆 Refactor helper blocks", "🏗️ Refactor helper blocks"),
            ("📱 Update handler logic", "🔧 Update handler logic"),
        ]
        for subject, expected in cases:
            with self.subTest(subject=subject), ExitStack() as stack:
                stack.enter_context(patch.object(ai_commit, "choose_bug_emoji", return_value="🐛"))
                for name, value in [
                    ("installed_local_model_names", {"local"}),
                    ("selected_model", ("local", False)),
                    ("configured_models", ("local", "small")),
                    ("staged_file_context", ""),
                    ("recent_subjects", ""),
                    ("ollama_json", {"response": json.dumps({"subject": subject, "description": ""})}),
                ]:
                    stack.enter_context(patch.object(ai_commit, name, return_value=value))
                self.assertEqual(
                    ai_commit.generate_message("", "+Update handler behavior", ["src/handler.py"]),
                    (expected, ""),
                )

    def test_extra_model_emojis_cannot_appear_in_subject_or_body(self):
        self.assertEqual(ai_commit.apply_priority_emoji("🏆 Fix 🗳️ handler", "🐛"), "🐛 Fix handler")
        self.assertEqual(
            ai_commit.sanitize_description("Body: 🏆 Improve the implementation. 🗳️ Preserve the behavior."),
            "Improve the implementation. Preserve the behavior.",
        )

    def test_generated_title_without_emoji_gets_one_and_preserves_description(self):
        with ExitStack() as stack:
            for name, value in [
                ("installed_local_model_names", {"local"}),
                ("selected_model", ("local", False)),
                ("configured_models", ("local", "small")),
                ("staged_file_context", ""),
                ("recent_subjects", ""),
                ("ollama_json", {"response": "Reorganize research notes\n\nGroup unfinished drafts together."}),
            ]:
                stack.enter_context(patch.object(ai_commit, name, return_value=value))
            self.assertEqual(ai_commit.generate_message("18 files changed", "rename diff", ["notes.md"], include_description=True), ("📝 Reorganize research notes", "Group unfinished drafts together."))

    @patch.object(ai_commit, "recent_subjects", return_value="Update parser")
    def test_default_branch_prompt_requests_one_or_two_sentences(self, _subjects):
        prompt = ai_commit.prompt_for_diff(
            "1 file changed",
            "diff --git a/a b/a",
            include_description=True,
        )
        self.assertIn("one or two complete sentences", prompt)
        self.assertIn("leave one blank line after the subject", prompt)

    def test_description_sanitizer_keeps_at_most_two_sentences(self):
        description = ai_commit.sanitize_description(
            "Body: First substantive sentence. Second useful sentence. Third extra sentence."
        )
        self.assertEqual(
            description,
            "First substantive sentence. Second useful sentence.",
        )

    def test_generated_message_separates_subject_and_description(self):
        title, description = ai_commit.sanitize_generated_message(
            "Add useful behavior\n\nExplain what changed. Explain why it matters.",
            include_description=True,
        )
        self.assertEqual(title, "Add useful behavior")
        self.assertEqual(
            description,
            "Explain what changed. Explain why it matters.",
        )

    def test_conventional_label_preserves_imperative_wording(self):
        for subject, expected in [
            ("Fix: Improve footnote handling in markdown-copy.js", "Improve footnote handling in markdown-copy.js"),
            ("🐛 fix(selection): Preserve italic footnotes", "🐛 Preserve italic footnotes"),
        ]:
            with self.subTest(subject=subject):
                title, body = ai_commit.sanitize_generated_message(json.dumps({
                    "subject": subject, "description": "",
                }))
                self.assertEqual(title, expected)
                self.assertTrue(ai_commit.valid_generated_message(
                    title if title.startswith("🐛") else "🔧 " + title, body, False,
                ))

    def test_conventional_label_does_not_bypass_wording_validation(self):
        title, body = ai_commit.sanitize_generated_message(
            '{"subject":"fix: footnotes","description":""}'
        )
        self.assertFalse(ai_commit.valid_generated_message("🔧 " + title, body, False))

    def test_sanitize_title_limits_output(self):
        title = ai_commit.sanitize_title(
            "\""
            "This is a deliberately long generated commit title that should be shortened "
            "without leaving a trailing punctuation mark.\""
        )
        self.assertLessEqual(len(title), 72)
        self.assertFalse(title.endswith("."))

    def test_fallback_uses_staged_paths_only(self):
        self.assertEqual(ai_commit.fallback_title(["src/widget.js"]), "🔧 Update `widget.js`")
        self.assertEqual(
            ai_commit.fallback_title(["src/a.js", "src/b.js"]),
            "🔧 Update code",
        )

    @patch.object(ai_commit, "installed_local_model_names", return_value=set())
    def test_missing_model_uses_local_fallback(self, _models):
        self.assertEqual(
            ai_commit.generate_title("1 file", "diff", ["README.md"]),
            "📝 Update `README.md`",
        )

    def test_fallback_setting_is_enabled_by_default_and_can_be_disabled(self):
        with patch.object(ai_commit, "git_config_bool", side_effect=lambda _key, default: default) as setting:
            self.assertTrue(ai_commit.commit_fallback_enabled())
        setting.assert_called_once_with("scm-toolkit.ai-commit-fallback", True)
        with patch.object(ai_commit, "git_config_bool", return_value=False):
            self.assertFalse(ai_commit.commit_fallback_enabled())

if __name__ == "__main__":
    unittest.main()
