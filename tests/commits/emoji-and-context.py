
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


class EmojiPriorityTests(unittest.TestCase):
    instructions = """When selecting the emoji, follow this priority list:
- If fixing a bug in code, use 🐛 🐞. Pick one at random. On a branch use the same one.
- For technical code:
  - If connecting functions, use 🔩
  - If tuning parameters, use 🔧
- If none of these scenarios fit with high confidence, choose 📦 ➕

Describe the staged change.
"""

    def setUp(self):
        enabled = patch.object(ai_commit, "emoji_priority_enabled", return_value=True)
        enabled.start()
        self.addCleanup(enabled.stop)
        self.rules = ai_commit.emoji_priority_rules(self.instructions)

    def test_disabled_enforcement_preserves_normal_generation_with_priority_instructions(self):
        with patch.object(ai_commit, "emoji_priority_enabled", return_value=False), \
                patch.object(ai_commit, "commit_custom_instructions", return_value=self.instructions), \
                patch.object(ai_commit, "emoji_priority_rules") as parse, \
                patch.object(ai_commit, "installed_local_model_names", return_value=set()), \
                patch.object(ai_commit, "selected_model", return_value=(None, False)), \
                patch.object(ai_commit, "configured_models", return_value=("local", "small")), \
                patch.object(ai_commit, "select_priority_emoji") as classify:
            self.assertEqual(ai_commit.generate_message("", "Binary files differ", ["icon.png"]),
                             ("🖼️ Update `icon.png`", ""))
            parse.assert_not_called()
            classify.assert_not_called()

    def test_enabled_without_priority_list_preserves_normal_generation(self):
        with patch.object(ai_commit, "commit_custom_instructions", return_value="Use concise titles."), \
                patch.object(ai_commit, "installed_local_model_names", return_value=set()), \
                patch.object(ai_commit, "selected_model", return_value=(None, False)), \
                patch.object(ai_commit, "configured_models", return_value=("local", "small")), \
                patch.object(ai_commit, "select_priority_emoji") as classify:
            self.assertEqual(ai_commit.generate_message("", "Binary files differ", ["icon.png"]),
                             ("🖼️ Update `icon.png`", ""))
            classify.assert_not_called()

    def test_nested_conditions_and_fallback_remain_ordered(self):
        self.assertEqual([rule[1] for rule in self.rules], [["🐛", "🐞"], ["🔩"], ["🔧"], ["📦", "➕"]])
        self.assertIn("For technical code:", self.rules[1][0])
        self.assertEqual([rule[2] for rule in self.rules], [False, False, False, True])

    def test_explicit_ban_overrides_fallback_choices(self):
        rules = ai_commit.emoji_priority_rules("Never use ➕ as a commit emoji.\n\n" + self.instructions)
        self.assertEqual(rules[-1][1], ["📦"])

    def test_priority_rules_allow_missing_model_fallback_unless_strict(self):
        with patch.object(ai_commit, "commit_custom_instructions", return_value=self.instructions), \
                patch.object(ai_commit, "installed_local_model_names", return_value=set()), \
                patch.object(ai_commit, "selected_model", return_value=(None, False)), \
                patch.object(ai_commit, "configured_models", return_value=("local", "small")):
            self.assertEqual(ai_commit.generate_message("", "Binary files differ", ["icon.png"]),
                             ("🖼️ Update `icon.png`", ""))
            with patch.object(ai_commit, "commit_fallback_enabled", return_value=False):
                with self.assertRaisesRegex(RuntimeError, "Install.*model"):
                    ai_commit.generate_message("", "Binary files differ", ["icon.png"])

    def test_priority_classifier_failure_uses_simple_message(self):
        with patch.object(ai_commit, "commit_custom_instructions", return_value=self.instructions), \
                patch.object(ai_commit, "installed_local_model_names", return_value={"local"}), \
                patch.object(ai_commit, "selected_model", return_value=("local", False)), \
                patch.object(ai_commit, "configured_models", return_value=("local", "small")), \
                patch.object(ai_commit, "staged_file_context", return_value=""), \
                patch.object(ai_commit, "select_priority_emoji", side_effect=RuntimeError("Cannot classify")), \
                patch.object(ai_commit, "log_event") as logs:
            self.assertEqual(ai_commit.generate_message("", "+Update handler", ["app.py"]),
                             ("🔧 Update `app.py`", ""))
            self.assertEqual(logs.call_args_list[-1].kwargs["reason"], "priority_validation_failed")

    def test_priority_requests_share_budget_and_preserve_strict_mode(self):
        for strict in (False, True):
            with self.subTest(strict=strict), ExitStack() as stack:
                clock, timeouts = [0.0], []
                @contextmanager
                def response(_request, timeout):
                    timeouts.append(timeout)
                    clock[0] += timeout
                    if timeout < 45:
                        raise TimeoutError()
                    data = json.dumps({'response': '{"result":"NO_MATCH"}'}).encode()
                    yield SimpleNamespace(read=lambda: data)
                for name, value in [('commit_custom_instructions', self.instructions),
                                    ('installed_local_model_names', {'local'}),
                                    ('selected_model', ('local', False)),
                                    ('configured_models', ('local', 'small')),
                                    ('staged_file_context', ''), ('commit_fallback_enabled', True),
                                    ('git_config_string', 'http://127.0.0.1:11435')]:
                    stack.enter_context(patch.object(ai_commit, name, return_value=value))
                stack.enter_context(patch.object(ai_commit.time, 'monotonic', side_effect=lambda: clock[0]))
                stack.enter_context(patch.object(ai_commit.OLLAMA_OPENER, 'open', side_effect=response))
                if strict:
                    with self.assertRaisesRegex(RuntimeError, 'configured time budget'):
                        ai_commit.generate_message('', '+Fix handler', ['app.py'], require_model=True)
                else:
                    self.assertEqual(ai_commit.generate_message('', '+Fix handler', ['app.py']),
                                     ('🔧 Update `app.py`', ''))
                self.assertEqual(timeouts, [45, 45, 45])
                self.assertIsNone(ai_commit.GENERATION_DEADLINE.get())

    def test_first_match_stops_evaluation_before_later_rules(self):
        with patch.object(ai_commit, "ollama_json", return_value={"response": '{"result":"MATCH"}'}) as generate, \
                patch.object(ai_commit, "current_branch", return_value="main"), \
                patch.object(ai_commit, "configured_default_branch", return_value="main"):
            self.assertIn(ai_commit.select_priority_emoji("local", self.rules, "", "", "", ""), ["🐛", "🐞"])
            self.assertEqual(generate.call_count, 1)
            self.assertNotIn("Pick one at random", generate.call_args.args[1]["prompt"])

    def test_contextual_choices_follow_the_matching_rule_instead_of_randomizing(self):
        rules = ai_commit.emoji_priority_rules("Follow this priority list:\n- When writing about freedom, use 🕊️ for policy and 🦅 for code")
        with patch.object(ai_commit, "ollama_json", side_effect=[
                {"response": '{"result":"MATCH"}'}, {"response": '{"emoji":"🦅"}'}]), \
                patch.object(ai_commit, "current_branch", return_value="main"):
            self.assertEqual(ai_commit.select_priority_emoji("local", rules, "", "+freedom()", "", ""), "🦅")

    def test_classifier_keeps_file_operations_without_raw_codes_or_counts(self):
        rules = ai_commit.emoji_priority_rules("Follow this priority list:\n- When deleting entire files, use 🗑️")
        with patch.object(ai_commit, "ollama_json", return_value={"response": '{"result":"MATCH"}'}) as generate, \
                patch.object(ai_commit, "current_branch", return_value="main"), \
                patch.object(ai_commit, "configured_default_branch", return_value="main"):
            ai_commit.select_priority_emoji("local", rules, "1 file changed", "+handler()",
                                            "Change totals: 1 modified\nM\tapp.py", "")
            prompt = generate.call_args.args[1]["prompt"]
            self.assertIn("Modified existing file: app.py", prompt)
            self.assertNotIn("Change totals", prompt)
            self.assertNotIn("M\tapp.py", prompt)

    def select(self, matches):
        responses = [{"response": json.dumps({"result": "MATCH" if matches[str(index)] else "NO_MATCH"})}
                     for index in range(3)]
        with patch.object(ai_commit, "ollama_json", side_effect=responses), \
                patch.object(ai_commit, "current_branch", return_value="main"), \
                patch.object(ai_commit, "configured_default_branch", return_value="main"):
            return ai_commit.select_priority_emoji("local", self.rules, "", "+wire handler", "", "")

    def test_first_matching_rule_wins_even_when_later_rules_match(self):
        self.assertIn(self.select({"0": True, "1": True, "2": True}), ["🐛", "🐞"])
        self.assertEqual(self.select({"0": False, "1": True, "2": True}), "🔩")

    def test_fallback_only_when_every_condition_is_false(self):
        self.assertEqual(self.select({"0": False, "1": False, "2": False}), "📦")

    def test_main_bug_emoji_is_chosen_afresh_for_each_commit(self):
        with patch.object(ai_commit, "ollama_json", return_value={"response": '{"result":"MATCH"}'}), \
                patch.object(ai_commit, "current_branch", return_value="main"), \
                patch.object(ai_commit, "configured_default_branch", return_value="main"), \
                patch.object(ai_commit.secrets, "choice", side_effect=["🐞", "🐛"]) as pick, \
                patch.object(ai_commit, "git_output", side_effect=[
                    "🐛 Fix an earlier defect\\n".replace("\\n", "\n"),
                    "🐞 Fix a different defect\\n".replace("\\n", "\n"),
                ]) as git:
            selections = [
                ai_commit.select_priority_emoji("local", self.rules, "", "+fix a bug", "", "")
                for _ in range(2)
            ]
        self.assertEqual(selections, ["🐞", "🐛"])
        self.assertEqual(pick.call_args_list[0].args[0], ["🐞"])
        self.assertEqual(pick.call_args_list[1].args[0], ["🐛"])
        self.assertEqual(git.call_count, 2)

    def test_missing_string_and_truncated_classifications_block_instead_of_falling_back(self):
        for response in [{"response": '{}'},
                         {"response": '{"result":false}'},
                         {"response": '{"result":"NO_MATCH"}', "done_reason": "length"}]:
            with self.subTest(response=response), patch.object(ai_commit, "ollama_json", return_value=response) as generate:
                with self.assertRaisesRegex(RuntimeError, "verify.*priority"):
                    ai_commit.select_priority_emoji("local", self.rules, "", "", "", "")
                self.assertEqual(generate.call_count, 3)

    def test_branch_bug_emoji_reused_from_branch_only(self):
        def branch_git(*args):
            if args[:4] == ("config", "--local", "--get", "branch.repair.sweetiebot-stack-parent"):
                return ""
            if args == ("log", "main..HEAD", "--format=%s"):
                return "🐞 Fix first handler\\n🐛 Fix later handler\\n".replace("\\n", "\n")
            raise AssertionError(args)
        with patch.object(ai_commit, "ollama_json", return_value={"response": '{"result":"MATCH"}'}), \
                patch.object(ai_commit, "current_branch", return_value="repair"), \
                patch.object(ai_commit, "configured_default_branch", return_value="main"), \
                patch.object(ai_commit, "git_output", side_effect=branch_git) as history, \
                patch.object(ai_commit.secrets, "choice") as pick:
            self.assertEqual(ai_commit.select_priority_emoji("local", self.rules, "", "", "", ""), "🐛")
            pick.assert_not_called()
            self.assertEqual(history.call_count, 2)

    def test_new_branch_keeps_its_first_random_bug_choice_across_generators(self):
        selected = {}
        with tempfile.TemporaryDirectory() as gitdir:
            def branch_git(*args):
                if args[0] == "config" and args[3].endswith("sweetiebot-stack-parent"):
                    return ""
                if args[0] == "log":
                    return ""
                if args == ("rev-parse", "--git-common-dir"):
                    return gitdir
                if args[0] == "config" and args[3].endswith("sweetiebot-bug-emoji"):
                    return selected.get(args[3], "")
                raise AssertionError(args)
            def save_config(args, **kwargs):
                selected[args[-2]] = args[-1]
                return SimpleNamespace(returncode=0)
            with patch.object(ai_commit, "current_branch", return_value="feature/fix"), \
                    patch.object(ai_commit, "configured_default_branch", return_value="main"), \
                    patch.object(ai_commit, "git_output", side_effect=branch_git), \
                    patch.object(ai_commit.subprocess, "run", side_effect=save_config) as save, \
                    patch.object(ai_commit.secrets, "choice", side_effect=["🐝", "🐜"]) as pick:
                self.assertEqual(ai_commit.choose_bug_emoji(["🐛", "🐜", "🐝"]), "🐝")
                self.assertEqual(ai_commit.choose_bug_emoji(["🐛", "🐜", "🐝"]), "🐝")
                save.assert_called_once()
                pick.assert_called_once()

    def test_stacked_branch_ignores_its_parent_bug_history(self):
        def branch_git(*args):
            if args[0] == "config" and args[3].endswith("stack-parent"):
                return "parent-pr"
            if args[0] == "log":
                self.assertEqual(args[1], "parent-pr..HEAD")
                return "🐞 Fix this stack layer\n"
            raise AssertionError(args)
        with patch.object(ai_commit, "current_branch", return_value="stack-child"), \
                patch.object(ai_commit, "configured_default_branch", return_value="main"), \
                patch.object(ai_commit, "git_output", side_effect=branch_git):
            self.assertEqual(ai_commit.choose_bug_emoji(["🐛", "🐞"]), "🐞")

    def test_generation_replaces_plus_with_first_matching_rule(self):
        with ExitStack() as stack:
            for name, value in [("commit_custom_instructions", self.instructions),
                                ("installed_local_model_names", {"local"}),
                                ("selected_model", ("local", False)),
                                ("configured_models", ("local", "small")),
                                ("staged_file_context", "Change totals: 1 modified"),
                                ("recent_subjects", "➕ Add a handler")]:
                stack.enter_context(patch.object(ai_commit, name, return_value=value))
            generate = stack.enter_context(patch.object(ai_commit, "ollama_json", side_effect=[
                {"response": '{"result":"NO_MATCH"}'},
                {"response": '{"result":"MATCH"}'},
                {"response": '{"subject":"➕ Add handler wiring","description":""}'},
            ]))
            self.assertEqual(ai_commit.generate_message("", "+connect(handler)", ["app.py"]),
                             ("🔩 Add handler wiring", ""))
            classification_prompt = generate.call_args_list[0].args[1]["prompt"]
            self.assertNotIn("➕", classification_prompt)
            self.assertNotIn("Recent repository subjects", classification_prompt)


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
    def setUp(self):
        instructions = patch.object(ai_commit, "commit_custom_instructions", return_value="")
        instructions.start()
        self.addCleanup(instructions.stop)

    def test_artifact_fallbacks(self):
        self.assertEqual(ai_commit.fallback_title(["assets/DASH.PNG"]), "🖼️ Update `DASH.PNG`")
        self.assertEqual(ai_commit.fallback_title(["docs/report.pdf"]), "🖋️ Update `report.pdf`")
        self.assertEqual(
            ai_commit.fallback_title(["assets/a.png", "assets/b.svg"]),
            "🖼️ Update 2 image assets",
        )
        self.assertEqual(
            ai_commit.fallback_title(["assets/a.png", "src/app.js"]),
            "🔧 Update image assets and code",
        )
        self.assertEqual(ai_commit.fallback_title([]), "🔧 Update repository files")


    def test_offline_path_and_status_based_fallbacks(self):
        # Borrow action and path classification from auto-commit-msg without
        # requiring an extra extension, network service, or model.
        cases = [
            (
                ["extension/github_session.py", "tests/github_session.py"],
                "",
                "🔧 Update GitHub session code and tests",
            ),
            (
                [".github/workflows/test.yml", ".github/workflows/release.yml"],
                "",
                "⚙️ Update CI workflows",
            ),
            (
                ["docs/howto.md", "docs/overview.md"],
                "",
                "📝 Update documentation",
            ),
            (
                ["requirements.txt", "poetry.lock"],
                "",
                "🧰 Update dependencies",
            ),
            (
                ["tests/commit.py", "tests/push.py"],
                "Change totals: 2 added\n\nStatus:\nA\ttests/commit.py\nA\ttests/push.py",
                "🧪 Add tests",
            ),
            (
                ["assets/logo.svg", "src/sidebar.ts"],
                "",
                "🔧 Update image assets and code",
            ),
        ]
        for files, context, expected in cases:
            with self.subTest(files=files):
                self.assertEqual(ai_commit.fallback_title(files, context), expected)
                self.assertNotIn("staged", expected.lower())

    def test_offline_fallback_uses_captured_diff_for_added_files(self):
        diff = (
            "diff --git a/src/session.ts b/src/session.ts\n"
            "new file mode 100644\n"
            "--- /dev/null\n"
            "+++ b/src/session.ts\n"
            "+export function session() {}\n"
        )
        self.assertEqual(
            ai_commit.fallback_title(["src/session.ts"], diff=diff),
            "🔧 Add `session.ts`",
        )
        self.assertEqual(
            ai_commit.fallback_message(["src/session.ts"], False, diff=diff),
            ("🔧 Add `session.ts`", ""),
        )

    def test_offline_fallback_describes_deletions_without_staged_claims(self):
        context = (
            "Change totals: 2 deleted\n\nStatus:\n"
            "D\tdocs/old.md\nD\tdocs/unused.md"
        )
        self.assertEqual(
            ai_commit.fallback_message(["docs/old.md", "docs/unused.md"], True, context),
            ("📝 Remove documentation", "Remove 2 files."),
        )

    def test_offline_fallback_preserves_non_english_and_spaces_in_paths(self):
        self.assertEqual(
            ai_commit.fallback_title(["docs/rapport final.md"]),
            "📝 Update `rapport final.md`",
        )
        self.assertEqual(
            ai_commit.fallback_title(["src/überarbeitet.py", "src/ändern.py"]),
            "🔧 Update code",
        )

    def test_missing_model_uses_smart_fallback_without_querying_ollama(self):
        with patch.object(ai_commit, "installed_local_model_names", return_value=set()), \
                patch.object(ai_commit, "ollama_json") as ollama:
            title, description = ai_commit.generate_message(
                "", "diff --git a/tests/api.py b/tests/api.py",
                ["tests/api.py", "tests/ui.py"], include_description=True,
                file_context_override="Change totals: 2 modified",
            )
            self.assertEqual(title, "🧪 Update tests")
            self.assertEqual(description, "Update 2 files.")
            ollama.assert_not_called()

    def test_single_file_status_tracks_rename(self):
        context = "Change totals: 1 renamed\n\nStatus:\nR100\told.py\tnew.py"
        self.assertEqual(ai_commit.fallback_title(["new.py"], context), "🔧 Rename `old.py` to `new.py`")
        diff = (
            "diff --git a/old.py b/new.py\n"
            "similarity index 98%\n"
            "rename from old.py\n"
            "rename to new.py\n"
        )
        self.assertEqual(ai_commit.fallback_title(["new.py"], diff=diff),
                         "🔧 Rename `old.py` to `new.py`")

    @patch.object(ai_commit, "installed_local_model_names", return_value=set())
    def test_missing_model_uses_image_fallback(self, _models):
        self.assertEqual(
            ai_commit.generate_title("1 binary file", "Binary files differ", ["assets/logo.png"]),
            "🖼️ Update `logo.png`",
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
