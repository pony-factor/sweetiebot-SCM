
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


class HookEnvironmentTests(unittest.TestCase):
    def test_push_hook_finds_gui_package_manager_and_can_be_skipped(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo, remote, home = root / 'repo', root / 'remote', root / 'home'
            tools = home / 'Library/pnpm'
            tools.mkdir(parents=True)
            tool = tools / 'pnpm'
            tool.write_text('#!/bin/sh\nexit 0\n')
            tool.chmod(0o755)
            def git(*args, env=None):
                return subprocess.run(['/usr/bin/git', '-C', str(repo), *args],
                                      env=env, capture_output=True, text=True)
            subprocess.run(['/usr/bin/git', 'init', str(repo)], check=True, capture_output=True)
            subprocess.run(['/usr/bin/git', 'init', '--bare', str(remote)], check=True, capture_output=True)
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.com',
                '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture')
            hook = repo / '.git/hooks/pre-push'
            hook.write_text('#!/bin/sh\npnpm --version\n')
            hook.chmod(0o755)
            with patch.dict(os.environ, {'PATH': '/usr/bin:/bin'}), \
                    patch.object(ai_commit.Path, 'home', return_value=home), \
                    patch.object(ai_commit, 'git_config_bool', return_value=False):
                env = ai_commit.hook_environment()
            result = git('push', str(remote), 'HEAD:refs/heads/test', env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            hook.write_text('#!/bin/sh\nexit 1\n')
            self.assertNotEqual(git('push', str(remote), 'HEAD:refs/heads/rejected', env=env).returncode, 0)
            with patch.object(ai_commit, 'git_config_bool', return_value=True):
                skipped = ai_commit.hook_environment()
            result = git('push', str(remote), 'HEAD:refs/heads/skipped', env=skipped)
            self.assertEqual(result.returncode, 0, result.stderr)
            hook = repo / '.git/hooks/pre-commit'
            hook.write_text('#!/bin/sh\nexit 1\n')
            hook.chmod(0o755)
            result = git('-c', 'user.name=Test', '-c', 'user.email=test@example.com',
                         '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'skip', env=skipped)
            self.assertEqual(result.returncode, 0, result.stderr)


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
    def test_finds_push_and_branch_changes_after_global_options(self):
        self.assertEqual(ai_commit.git_command_index(["-C", "/tmp/repo", "push", "origin"]), (2, "push"))
        self.assertEqual(ai_commit.git_command_index(["--no-pager", "switch", "topic"]), (1, "switch"))
        self.assertIsNone(ai_commit.commit_index(["-C", "/tmp/repo", "push", "origin"]))


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
    def test_failed_summary_stops_before_invoking_git_commit(self):
        with ExitStack() as stack:
            stack.enter_context(patch.object(sys, "argv", ["wrapper", "commit"]))
            for name, value in [
                ("feature_enabled", True), ("staged_whitespace_enabled", False),
                ("staged_diff", ("1 file", "+Exhibit references", ["notes.md"])),
                ("github_split_groups", [["notes.md"]]),
                ("should_add_default_branch_description", False),
            ]:
                stack.enter_context(patch.object(ai_commit, name, return_value=value))
            stack.enter_context(patch.object(ai_commit, "generate_message", side_effect=RuntimeError("No content-based summary")))
            execute = stack.enter_context(patch.object(ai_commit.os, "execv"))
            with self.assertRaises(SystemExit) as error:
                ai_commit.main()
            self.assertEqual(error.exception.code, 1)
            execute.assert_not_called()

    @patch.object(ai_commit, "git_config_bool")
    def test_staged_whitespace_normalization_defaults_on(self, config):
        config.return_value = True
        self.assertTrue(ai_commit.staged_whitespace_enabled())
        config.assert_called_once_with("sweetiebot.normalize-staged-whitespace", True)

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
                # The mocked Git exec must not leak temporary hook settings to later tests.
                stack.enter_context(patch.dict(os.environ))
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
                stack.enter_context(patch("background_commit.wait_for_background"))
                stack.enter_context(patch.object(ai_commit.subprocess, "run", return_value=SimpleNamespace(returncode=returncode)))
                with self.assertRaises(SystemExit) as exit_result:
                    ai_commit.main()
                self.assertEqual(exit_result.exception.code, returncode)
                self.assertEqual(spawn.called, returncode == 0 and not dirty and new_head != "old")


    def test_retired_provisional_toggle_cannot_create_new_placeholder_commits(self):
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ))
            stack.enter_context(patch.object(sys, "argv", ["wrapper", "commit"]))
            for name, value in [
                ("feature_enabled", True),
                ("staged_whitespace_enabled", False),
                ("staged_diff", ("1 file changed", "+text", ["note.md"])),
                ("github_split_groups", [["note.md"]]),
                ("post_commit_spellcheck_enabled", False),
                ("should_add_default_branch_description", False),
                ("generate_message", ("🗑️ Use final title directly", "")),
            ]:
                stack.enter_context(patch.object(ai_commit, name, return_value=value))
            config = stack.enter_context(patch.object(ai_commit, "git_config_bool", return_value=True))
            stack.enter_context(patch("background_commit.wait_for_background"))
            stack.enter_context(patch("sweetiebot_async_commit.wait_for_completion"))
            execute = stack.enter_context(patch.object(
                ai_commit.os, "execv", side_effect=RuntimeError("direct commit")
            ))
            with self.assertRaisesRegex(RuntimeError, "direct commit"):
                ai_commit.main()
            execute.assert_called_once_with(
                ai_commit.REAL_GIT,
                [ai_commit.REAL_GIT, "commit", "-m", "🗑️ Use final title directly"],
            )
            self.assertNotIn("sweetiebot.ai-commit-async", [
                call.args[0] for call in config.call_args_list
            ])


class ConfigurationTests(unittest.TestCase):
    def test_emoji_priority_enforcement_defaults_on(self):
        with patch.object(ai_commit, "git_config_bool", return_value=True) as config:
            self.assertTrue(ai_commit.emoji_priority_enabled())
            config.assert_called_once_with("sweetiebot.ai-emoji-priority-rules", True)

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
        config.assert_called_once_with("sweetiebot.spellcheck-preview", False)

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
            "sweetiebot.spellcheck-model", ai_commit.DEFAULT_SPELLCHECK_MODEL
        )

    def test_models_can_be_selected_from_git_config(self):
        values = {
            "sweetiebot.ai-commit-model": "primary:test",
            "sweetiebot.ai-commit-low-memory-model": "fallback:test",
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


class TitleGenerationAdmissionTests(unittest.TestCase):
    def test_memory_pressure_adapts_global_parallelism(self):
        gib = 1024**3
        expected = {
            None: 2, 0: 1, 3 * gib: 1, 7 * gib: 1,
            8 * gib: 2, 15 * gib: 2, 16 * gib: 3,
            23 * gib: 3, 24 * gib: 4, 31 * gib: 4,
            32 * gib: 5, 39 * gib: 5, 40 * gib: 6,
            48 * gib: 6, 96 * gib: 6,
        }
        for available, slots in expected.items():
            with self.subTest(available=available):
                self.assertEqual(ai_commit.title_generation_parallelism(available), slots)

    def test_title_slots_are_shared_and_released_under_pressure(self):
        gib = 1024**3
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            ai_commit.os.environ, {"SWEETIEBOT_COMMIT_JOBS": tmp}
        ), patch.object(ai_commit, "available_memory_bytes", return_value=7 * gib):
            with ai_commit.title_generation_slot() as first:
                self.assertEqual(first, 0)
                with patch.object(ai_commit.time, "sleep", side_effect=RuntimeError("slot busy")):
                    with self.assertRaisesRegex(RuntimeError, "slot busy"):
                        with ai_commit.title_generation_slot():
                            self.fail("A second worker entered the only safe slot")
            with ai_commit.title_generation_slot() as reopened:
                self.assertEqual(reopened, 0, "The slot must be reusable after finishing")

    def test_available_headroom_allows_independent_concurrent_slots(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            ai_commit.os.environ, {"SWEETIEBOT_COMMIT_JOBS": tmp}
        ), patch.object(ai_commit, "available_memory_bytes", return_value=16 * 1024**3):
            with ai_commit.title_generation_slot() as first:
                with ai_commit.title_generation_slot() as second:
                    self.assertEqual((first, second), (0, 1))

    def test_title_slot_is_released_after_generation_error(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            ai_commit.os.environ, {"SWEETIEBOT_COMMIT_JOBS": tmp}
        ), patch.object(ai_commit, "available_memory_bytes", return_value=0):
            failing = ai_commit.generation_budget(lambda: (_ for _ in ()).throw(
                RuntimeError("generation failed")))
            with self.assertRaisesRegex(RuntimeError, "generation failed"):
                failing()
            with ai_commit.title_generation_slot() as available_again:
                self.assertEqual(available_again, 0)

if __name__ == "__main__":
    unittest.main()
