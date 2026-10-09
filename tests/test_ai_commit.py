import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from contextlib import ExitStack
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "scm_toolkit_ai_commit", Path(__file__).parents[1] / "scripts/ai_commit.py"
)
ai_commit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ai_commit)


class GitOutputTests(unittest.TestCase):
    def test_replaces_non_utf8_output(self):
        with patch.object(ai_commit, "REAL_GIT", sys.executable), patch.object(
            ai_commit, "GIT_GLOBAL_ARGS", []
        ):
            output = ai_commit.git_output(
                "-c",
                "import sys; sys.stdout.buffer.write(b'prefix\\x93suffix')",
            )

        self.assertEqual(output, "prefix\ufffdsuffix")


class GithubSplitTests(unittest.TestCase):
    def test_packs_staged_payload_at_100_mib(self):
        mib = 1024**2
        groups = ai_commit._pack_large_commit_groups([
            ("a.bin", 60 * mib), ("b.bin", 40 * mib), ("c.bin", 1 * mib)
        ])
        self.assertEqual(groups, [["a.bin", "b.bin"], ["c.bin"]])

    def test_rejects_single_staged_blob_over_github_limit(self):
        with patch.object(ai_commit, "staged_blob_sizes", return_value=[
            ("huge.bin", ai_commit.GITHUB_FILE_MAX_BYTES + 1)
        ]):
            with self.assertRaisesRegex(RuntimeError, "larger than 100 MiB"):
                ai_commit.github_split_groups(["huge.bin"])

    def test_splits_aggregate_payload_over_target(self):
        mib = 1024**2
        with patch.object(ai_commit, "staged_blob_sizes", return_value=[
            ("a.bin", 60 * mib), ("b.bin", 60 * mib)
        ]):
            self.assertEqual(ai_commit.github_split_groups(["a.bin", "b.bin"]), [["a.bin"], ["b.bin"]])

    def test_split_commits_use_temporary_indexes_and_leave_stage_clean(self):
        git = shutil.which("git")
        if not git:
            self.skipTest("git is unavailable")
        with tempfile.TemporaryDirectory() as tmp:
            def run(*args):
                return subprocess.run([git, "-C", tmp, *args], check=True, capture_output=True, text=True)
            run("init", "--quiet")
            run("config", "user.name", "Sweetiebot Test")
            run("config", "user.email", "sweetiebot@example.test")
            Path(tmp, "base.txt").write_text("base\n", encoding="utf-8")
            run("add", "base.txt")
            run("commit", "--quiet", "-m", "base")
            Path(tmp, "a.txt").write_text("a\n", encoding="utf-8")
            Path(tmp, "b.txt").write_text("b\n", encoding="utf-8")
            run("add", "a.txt", "b.txt")
            with patch.object(ai_commit, "REAL_GIT", git), patch.object(
                ai_commit, "GIT_GLOBAL_ARGS", ["-C", tmp]
            ), patch.object(
                ai_commit, "generate_message", side_effect=[("🐞 Add a", ""), ("🐞 Add b", "")]
            ), patch.object(ai_commit, "should_add_default_branch_description", return_value=False):
                result = ai_commit.commit_split_groups(["-C", tmp, "commit", "--quiet"], [["a.txt"], ["b.txt"]])
            self.assertEqual(result, 0)
            self.assertEqual(run("log", "-2", "--pretty=%s").stdout.splitlines(), ["🐞 Add b", "🐞 Add a"])
            self.assertEqual(run("status", "--porcelain").stdout, "")


class RoutingTests(unittest.TestCase):
    def test_finds_commit_after_global_option(self):
        self.assertEqual(ai_commit.commit_index(["-C", "/tmp/repo", "commit"]), 2)

    def test_preserves_explicit_message(self):
        self.assertTrue(ai_commit.has_explicit_message_or_special_mode(["-m", "Manual"]))
        self.assertTrue(
            ai_commit.has_explicit_message_or_special_mode(["--message=Manual"])
        )

    def test_finds_manual_message_forms(self):
        self.assertEqual(ai_commit.manual_message_location(["-m", "Manual"]), (1, "value"))
        self.assertEqual(
            ai_commit.manual_message_location(["--message=Manual"]), (0, "long")
        )
        self.assertEqual(ai_commit.manual_message_location(["-mManual"]), (0, "short"))

    def test_special_commit_modes_skip_manual_spellcheck(self):
        self.assertIsNone(
            ai_commit.manual_message_location(["--amend", "-m", "Manual"])
        )
        self.assertIsNone(
            ai_commit.manual_message_location(["--fixup=HEAD", "-m", "Manual"])
        )

    def test_recognizes_manual_staged_messages_without_rewriting_them(self):
        for args in [
            ["-m", "Manual subject"],
            ["--message=Manual subject"],
            ["-mManual subject"],
            ["--quiet", "--message", "Manual subject"],
            ["-m", "Manual subject", "-m", "Manual body"],
            ["-m", "--amend"],
        ]:
            with self.subTest(args=args):
                self.assertTrue(ai_commit.has_manual_staged_message(args))

    def test_skips_manual_messages_in_special_and_non_index_modes(self):
        for args in [
            ["--amend", "-m", "Manual"],
            ["--fixup=HEAD", "-m", "Manual"],
            ["--all", "-m", "Manual"],
            ["--only", "README.md", "-m", "Manual"],
            ["README.md", "-m", "Manual"],
            ["-F", "commit.txt"],
            ["-m"],
        ]:
            with self.subTest(args=args):
                self.assertFalse(ai_commit.has_manual_staged_message(args))

    def test_rejects_path_and_all_modes(self):
        self.assertFalse(ai_commit.uses_staged_index(["README.md"]))
        self.assertFalse(ai_commit.uses_staged_index(["--all"]))

    def test_accepts_plain_staged_commit(self):
        self.assertTrue(ai_commit.uses_staged_index([]))
        self.assertTrue(ai_commit.uses_staged_index(["--quiet"]))

    def test_manual_message_is_never_silently_spellchecked(self):
        with patch.object(sys, "argv", ["wrapper", "commit", "-m", "Fxi title"]), patch.object(
            ai_commit, "feature_enabled", return_value=True
        ), patch.object(
            ai_commit, "spellcheck_manual_message_args"
        ) as spellcheck, patch.object(
            ai_commit.os, "execv", side_effect=RuntimeError("exec")
        ):
            with self.assertRaisesRegex(RuntimeError, "exec"):
                ai_commit.main()
        spellcheck.assert_not_called()


class NewlineRoutingTests(unittest.TestCase):
    @patch.object(ai_commit, "git_config_bool")
    def test_staged_whitespace_normalization_defaults_on(self, config):
        config.return_value = True
        self.assertTrue(ai_commit.staged_whitespace_enabled())
        config.assert_called_once_with("scm-toolkit.normalize-staged-whitespace", True)

    def test_toggle_off_skips_normalization_for_manual_and_generated_commits(self):
        for args in [["commit", "-m", "Keep this message"], ["commit"]]:
            with self.subTest(args=args), patch.object(
                sys, "argv", ["wrapper", *args]
            ), patch.object(ai_commit, "staged_whitespace_enabled", return_value=False), patch.object(
                ai_commit, "feature_enabled", return_value=True
            ), patch.object(ai_commit, "normalize_staged_final_newlines") as normalize, patch.object(
                ai_commit, "staged_diff", return_value=("", "", [])
            ), patch.object(ai_commit.os, "execv", side_effect=RuntimeError("exec")) as execv:
                with self.assertRaisesRegex(RuntimeError, "exec"):
                    ai_commit.main()
                normalize.assert_not_called()
                execv.assert_called_once_with(ai_commit.REAL_GIT, [ai_commit.REAL_GIT, *args])

    def test_manual_staged_commit_normalizes_without_changing_the_message(self):
        for argv in [
            ["commit", "-m", "Manual subject"],
            ["commit", "-m", "Manual subject", "-m", "Manual body"],
            ["commit", "--message=Manual subject"],
        ]:
            with self.subTest(argv=argv), patch.object(
                sys, "argv", ["wrapper", *argv]
            ), patch.object(ai_commit, "feature_enabled") as ai_enabled, patch.object(
                ai_commit, "staged_whitespace_enabled", return_value=True
            ), patch.object(ai_commit, "normalize_staged_final_newlines"
            ) as normalize, patch.object(ai_commit, "staged_diff") as diff, patch.object(
                ai_commit.os, "execv", side_effect=RuntimeError("exec")
            ) as execv:
                with self.assertRaisesRegex(RuntimeError, "exec"):
                    ai_commit.main()
                normalize.assert_called_once_with()
                ai_enabled.assert_not_called()
                diff.assert_not_called()
                execv.assert_called_once_with(ai_commit.REAL_GIT, [ai_commit.REAL_GIT, *argv])

    def test_disabled_and_non_index_commits_skip_normalization(self):
        for args, enabled in [(["commit", "--amend", "-m", "Manual"], True), (["commit", "--all", "-m", "Manual"], True), (["commit"], False), (["commit", "--all"], True), (["status"], True)]:
            with self.subTest(args=args, enabled=enabled), patch.object(
                sys, "argv", ["wrapper", *args]
            ), patch.object(ai_commit, "manual_spellcheck_enabled", return_value=False), patch.object(
                ai_commit, "feature_enabled", return_value=enabled
            ), patch.object(ai_commit, "normalize_staged_final_newlines") as normalize, patch.object(
                ai_commit.os, "execv", side_effect=RuntimeError("exec")
            ):
                with self.assertRaisesRegex(RuntimeError, "exec"):
                    ai_commit.main()
                normalize.assert_not_called()

    def test_normalizes_before_reading_the_automatic_commit_diff(self):
        calls = []
        with patch.object(sys, "argv", ["wrapper", "commit"]), patch.object(
            ai_commit, "manual_spellcheck_enabled", return_value=False
        ), patch.object(ai_commit, "feature_enabled", return_value=True), patch.object(
            ai_commit, "staged_whitespace_enabled", return_value=True
        ), patch.object(ai_commit, "normalize_staged_final_newlines", side_effect=lambda: calls.append("normalize")
        ), patch.object(ai_commit, "staged_diff", side_effect=lambda: (calls.append("diff") or ("", "", []))), patch.object(
            ai_commit.os, "execv", side_effect=RuntimeError("exec")
        ):
            with self.assertRaisesRegex(RuntimeError, "exec"):
                ai_commit.main()
        self.assertEqual(calls, ["normalize", "diff"])


class PostCommitRoutingTests(unittest.TestCase):
    def test_job_only_follows_a_successful_new_automatic_commit(self):
        for returncode, dirty, new_head in [(0, False, "new"), (1, False, "old"), (0, True, "new"), (0, False, "old")]:
            with self.subTest(returncode=returncode, dirty=dirty, new_head=new_head), ExitStack() as stack:
                worker = SimpleNamespace(
                    has_unstaged_changes=lambda args: dirty,
                    staged_markdown_paths=lambda args: ["note.md"],
                    head_sha=lambda args: "old",
                )
                worker.head_sha = stack.enter_context(patch.object(worker, "head_sha", create=True, side_effect=["old", new_head]))
                spawn = stack.enter_context(patch.object(worker, "spawn_post_commit", create=True))
                stack.enter_context(patch.object(sys, "argv", ["wrapper", "commit"]))
                for name, value in [
                    ("manual_spellcheck_enabled", False), ("feature_enabled", True),
                    ("normalize_staged_final_newlines", []), ("staged_diff", ("1 file", "diff", ["note.md"])),
                    ("github_split_groups", [["note.md"]]),
                    ("generate_message", ("Title", "")), ("should_add_default_branch_description", False),
                    ("git_config_bool", True), ("load_post_commit_spellcheck", worker),
                ]:
                    stack.enter_context(patch.object(ai_commit, name, return_value=value))
                stack.enter_context(patch.object(ai_commit.subprocess, "run", return_value=SimpleNamespace(returncode=returncode)))
                with self.assertRaises(SystemExit) as exit_result:
                    ai_commit.main()
                self.assertEqual(exit_result.exception.code, returncode)
                self.assertEqual(spawn.called, returncode == 0 and not dirty and new_head != "old")


class ConfigurationTests(unittest.TestCase):
    @patch.object(ai_commit, "git_config_bool", return_value=False)
    def test_ai_commit_can_be_disabled_globally(self, _config):
        self.assertFalse(ai_commit.feature_enabled())

    @patch.object(ai_commit, "git_config_bool", return_value=False)
    def test_default_branch_description_can_be_disabled(self, _config):
        self.assertFalse(ai_commit.default_branch_description_enabled())

    def test_manual_spellcheck_defaults_off(self):
        with patch.object(
            ai_commit, "git_config_bool", side_effect=lambda _key, default: default
        ) as config:
            self.assertFalse(ai_commit.manual_spellcheck_enabled())
        config.assert_called_once_with("scm-toolkit.spellcheck-preview", False)

    def test_description_is_limited_to_the_configured_default_branch(self):
        with patch.object(
            ai_commit, "default_branch_description_enabled", return_value=True
        ), patch.object(
            ai_commit, "configured_default_branch", return_value="main"
        ), patch.object(
            ai_commit, "current_branch", return_value="main"
        ):
            self.assertTrue(ai_commit.should_add_default_branch_description())

        with patch.object(
            ai_commit, "default_branch_description_enabled", return_value=True
        ), patch.object(
            ai_commit, "configured_default_branch", return_value="main"
        ), patch.object(
            ai_commit, "current_branch", return_value="feature/test"
        ):
            self.assertFalse(ai_commit.should_add_default_branch_description())

    def test_spellcheck_model_has_independent_git_config(self):
        with patch.object(
            ai_commit, "git_config_string", return_value="spell:test"
        ) as config:
            self.assertEqual(ai_commit.configured_spellcheck_model(), "spell:test")
        config.assert_called_once_with(
            "scm-toolkit.spellcheck-model", ai_commit.DEFAULT_SPELLCHECK_MODEL
        )

    def test_models_can_be_selected_from_git_config(self):
        values = {
            "scm-toolkit.ai-commit-model": "primary:test",
            "scm-toolkit.ai-commit-low-memory-model": "fallback:test",
        }
        with patch.object(
            ai_commit,
            "git_config_string",
            side_effect=lambda key, default: values.get(key, default),
        ), patch.dict(
            ai_commit.os.environ,
            {"SCM_TOOLKIT_AI_MODEL": "", "SCM_TOOLKIT_AI_LOW_MEMORY_MODEL": ""},
        ):
            self.assertEqual(
                ai_commit.configured_models(),
                ("primary:test", "fallback:test"),
            )

    def test_primary_model_is_used_with_memory_headroom(self):
        with patch.object(
            ai_commit, "configured_models", return_value=("primary:test", "fallback:test")
        ), patch.object(
            ai_commit, "available_memory_bytes", return_value=8 * 1024**3
        ), patch.object(
            ai_commit, "low_memory_threshold_gib", return_value=4
        ):
            self.assertEqual(
                ai_commit.selected_model({"primary:test", "fallback:test"}),
                ("primary:test", False),
            )

    def test_low_memory_model_is_used_below_threshold(self):
        with patch.object(
            ai_commit, "configured_models", return_value=("primary:test", "fallback:test")
        ), patch.object(
            ai_commit, "available_memory_bytes", return_value=2 * 1024**3
        ), patch.object(
            ai_commit, "low_memory_threshold_gib", return_value=4
        ):
            self.assertEqual(
                ai_commit.selected_model({"primary:test", "fallback:test"}),
                ("fallback:test", True),
            )

    def test_low_memory_mode_does_not_escalate_to_primary(self):
        with patch.object(
            ai_commit, "configured_models", return_value=("primary:test", "fallback:test")
        ), patch.object(
            ai_commit, "available_memory_bytes", return_value=2 * 1024**3
        ), patch.object(
            ai_commit, "low_memory_threshold_gib", return_value=4
        ):
            self.assertEqual(
                ai_commit.selected_model({"primary:test"}),
                (None, True),
            )

    @patch.object(
        ai_commit,
        "ollama_json",
        return_value={"models": [{"name": "primary:test"}]},
    )
    def test_local_model_inventory_does_not_require_staged_files(self, _request):
        self.assertEqual(ai_commit.installed_local_model_names(), {"primary:test"})


class ManualSpellcheckTests(unittest.TestCase):
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


class TitleTests(unittest.TestCase):
    def test_required_model_reports_timeout_connection_and_http_failures(self):
        failures = [
            (TimeoutError("timed out"), "timed out after 300 seconds"),
            (ai_commit.urllib.error.URLError(TimeoutError("timed out")), "timed out after 300 seconds"),
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
                stack.enter_context(patch.object(ai_commit, "ollama_json", side_effect=error))
                with self.assertRaisesRegex(RuntimeError, expected):
                    ai_commit.generate_message("", "", ["a.py"], require_model=True)

    def test_ollama_request_allows_time_queued_behind_ocr(self):
        with patch.object(ai_commit.OLLAMA_OPENER, "open") as request:
            request.return_value.__enter__.return_value.read.return_value = b'{"response":"ok"}'
            self.assertEqual(ai_commit.ollama_json("/api/generate", {"model": "local"}), {"response": "ok"})
            self.assertEqual(request.call_args.kwargs["timeout"], 300)

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

    def test_commit_endpoint_uses_git_setting_without_environment_override(self):
        with patch.dict(ai_commit.os.environ, {"SCM_TOOLKIT_AI_OLLAMA_URL": ""}), patch.object(ai_commit, "git_config_string", return_value="http://127.0.0.1:11435"), patch.object(ai_commit.OLLAMA_OPENER, "open") as request:
            request.return_value.__enter__.return_value.read.return_value = b'{}'
            ai_commit.ollama_json("/api/tags")
            self.assertEqual(request.call_args.args[0].full_url, "http://127.0.0.1:11435/api/tags")

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
                self.assertEqual(generate.call_count, 2)

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
                ("🔧 Update parser.py", ""),
            )
            self.assertEqual(generate.call_count, 2)

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
                    self.assertEqual(
                        ai_commit.generate_message("18 files changed", "rename diff", ["a.md", "b.md"], include_description=True, conversation_context=context, require_model=bool(context)),
                        ("📝 Update 2 staged files", "Update the 2 staged files."),
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

    def test_sanitize_title_limits_output(self):
        title = ai_commit.sanitize_title(
            "\""
            "This is a deliberately long generated commit title that should be shortened "
            "without leaving a trailing punctuation mark.\""
        )
        self.assertLessEqual(len(title), 72)
        self.assertFalse(title.endswith("."))

    def test_fallback_uses_staged_paths_only(self):
        self.assertEqual(ai_commit.fallback_title(["src/widget.js"]), "🔧 Update widget.js")
        self.assertEqual(
            ai_commit.fallback_title(["src/a.js", "src/b.js"]),
            "🔧 Update 2 staged files",
        )

    @patch.object(ai_commit, "installed_local_model_names", return_value=set())
    def test_missing_model_uses_local_fallback(self, _models):
        self.assertEqual(
            ai_commit.generate_title("1 file", "diff", ["README.md"]),
            "📝 Update README.md",
        )


class InstructionFileTests(unittest.TestCase):
    def test_standalone_commit_instructions_are_read_directly(self):
        with tempfile.TemporaryDirectory() as tmp:
            instructions = Path(tmp) / "commit-instructions.md"
            instructions.write_text(
                "Prefer compact wording.\n"
                "Commit titles should use one emoji and an imperative verb.\n"
                "Use plain language.\n",
                encoding="utf-8",
            )
            with patch.object(
                ai_commit, "commit_instructions_path", return_value=instructions
            ):
                self.assertEqual(
                    ai_commit.commit_title_preference(),
                    "Commit titles should use one emoji and an imperative verb.",
                )
                custom = ai_commit.commit_custom_instructions()

        self.assertIn("Prefer compact wording.", custom)
        self.assertIn("Use plain language.", custom)
        self.assertNotIn("Commit titles should", custom)

    def test_long_standalone_instructions_are_not_truncated(self):
        long_rule = "Keep this entire preference. " * 120
        self.assertGreater(len(long_rule), 1800)
        with patch.object(
            ai_commit,
            "commit_custom_instructions",
            return_value=long_rule,
        ):
            prompt = ai_commit.prompt_for_diff(
                "1 file changed",
                "diff --git a/README.md b/README.md\n+text",
            )

        self.assertIn(long_rule, prompt)
        self.assertNotIn("[custom instructions truncated]", prompt)

    def test_missing_standalone_file_uses_default_title_rule(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "missing.md"
            with patch.object(
                ai_commit, "commit_instructions_path", return_value=missing
            ):
                self.assertEqual(ai_commit.commit_custom_instructions(), "")
                self.assertEqual(
                    ai_commit.commit_title_preference(),
                    ai_commit.DEFAULT_COMMIT_TITLE_PREFERENCE,
                )

    @patch.object(ai_commit, "recent_subjects", return_value="🖌️ Refine controls")
    def test_prompt_includes_standalone_custom_instructions(self, _subjects):
        with patch.object(
            ai_commit,
            "commit_custom_instructions",
            return_value="Prefer compact wording and sentence case.",
        ):
            prompt = ai_commit.prompt_for_diff(
                "1 file changed",
                "diff --git a/README.md b/README.md\n+text",
            )

        self.assertIn("Sweetiebot commit-writing instructions:", prompt)
        self.assertIn("Prefer compact wording and sentence case.", prompt)
        self.assertNotIn("User commit-writing preferences from the global Codex instructions:", prompt)
        self.assertIn("Do not add trailers or metadata", prompt)


class ArtifactContextTests(unittest.TestCase):
    def test_artifact_fallbacks(self):
        self.assertEqual(ai_commit.fallback_title(["assets/DASH.PNG"]), "🖼️ Update DASH.PNG")
        self.assertEqual(ai_commit.fallback_title(["docs/report.pdf"]), "🖋️ Update report.pdf")
        self.assertEqual(
            ai_commit.fallback_title(["assets/a.png", "assets/b.svg"]),
            "🖼️ Update 2 image assets",
        )
        self.assertEqual(
            ai_commit.fallback_title(["assets/a.png", "src/app.js"]),
            "🔧 Update 2 staged files",
        )
        self.assertEqual(ai_commit.fallback_title([]), "🔧 Update staged changes")

    @patch.object(ai_commit, "installed_local_model_names", return_value=set())
    def test_missing_model_uses_image_fallback(self, _models):
        self.assertEqual(
            ai_commit.generate_title("1 binary file", "Binary files differ", ["assets/logo.png"]),
            "🖼️ Update logo.png",
        )

    def test_large_single_file_diff_keeps_beginning_and_tail(self):
        diff = (
            "diff --git a/docs/report.md b/docs/report.md\n"
            "HEAD_SIGNAL\n"
            + ("x" * 900)
            + "\nTAIL_SIGNAL"
        )
        with patch.object(ai_commit, "MAX_DIFF_CHARS", 400):
            sampled = ai_commit.sample_diff_for_prompt(diff)

        self.assertIn("HEAD_SIGNAL", sampled)
        self.assertIn("TAIL_SIGNAL", sampled)
        self.assertLessEqual(len(sampled), 400)
        self.assertIn("diff sampled", sampled)

    def test_large_multifile_diff_samples_across_files(self):
        sections = []
        for name in ("first.md", "middle.md", "last.md"):
            sections.append(
                f"diff --git a/{name} b/{name}\n{name}\n" + ("z" * 700)
            )

        with patch.object(ai_commit, "MAX_DIFF_CHARS", 900), patch.object(
            ai_commit, "MAX_DIFF_SECTIONS", 3
        ):
            sampled = ai_commit.sample_diff_for_prompt("\n".join(sections))

        for name in ("first.md", "middle.md", "last.md"):
            self.assertIn(name, sampled)
        self.assertLessEqual(len(sampled), 900)

    def test_file_context_marks_binary_images_and_documents(self):
        def fake_git_output(*args):
            if "--name-status" in args:
                return "A\tassets/logo.png\nM\tdocs/report.pdf\nM\tREADME.md\n"
            if "--numstat" in args:
                return (
                    "-\t-\tassets/logo.png\n"
                    "-\t-\tdocs/report.pdf\n"
                    "4\t1\tREADME.md\n"
                )
            self.fail(f"unexpected git call: {args}")

        with patch.object(ai_commit, "git_output", side_effect=fake_git_output):
            context = ai_commit.staged_file_context(
                ["assets/logo.png", "docs/report.pdf", "README.md"]
            )

        self.assertIn("image: assets/logo.png (binary)", context)
        self.assertIn("document: docs/report.pdf (binary)", context)
        self.assertIn("README.md", context)

    @patch.object(ai_commit, "recent_subjects", return_value="Update parser")
    def test_prompt_includes_context_without_claiming_opaque_contents(self, _subjects):
        prompt = ai_commit.prompt_for_diff(
            "2 files changed",
            "diff --git a/README.md b/README.md\n+text",
            "- image: assets/logo.png (binary)",
        )
        self.assertIn("Staged file context:", prompt)
        self.assertIn("do not invent contents", prompt)


if __name__ == "__main__":
    unittest.main()
