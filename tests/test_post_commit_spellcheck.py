import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import post_commit_spellcheck as worker


class CorrectionTests(unittest.TestCase):
    def core(self, text):
        return SimpleNamespace(ollama_json=lambda *args, **kwargs: {"response": json.dumps({"text": text})})

    def test_ascii_punctuation(self):
        text = "Alpine’s “fast”—really…"
        self.assertEqual(worker.request_correction(self.core(text), "model", "note.md", text, "", ""), "Alpine's \"fast\"-really...")

    def test_protected_tokens_line_count_and_markdown_prefixes(self):
        for original, corrected in [
            ("Visit https://example.com/a", "Visit https://example.com/b"),
            ("# Heading", "Heading"),
            ("Two lines\nremain", "One line"),
        ]:
            with self.subTest(original=original):
                self.assertIsNone(worker.request_correction(self.core(corrected), "model", "note.md", original, "", ""))

    def test_numeric_ranges_preserve_dates_urls_code_and_numbers(self):
        original = "Pages 12952-12953, 2026-10-11, S7-2026-25, `1-5`, https://example.com/1-5."
        corrected = worker.normalize_smart_punctuation(original)
        self.assertIn("12952–12953", corrected)
        for token in ["2026-10-11", "S7-2026-25", "`1-5`", "https://example.com/1-5."]:
            self.assertIn(token, corrected)
        self.assertTrue(worker.safe_correction(original, corrected))
        self.assertFalse(worker.safe_correction(original, corrected.replace("12953", "12954")))
        self.assertEqual(worker.normalize_smart_punctuation("Use `Alpine’s` here."), "Use `Alpine’s` here.")

    def test_en_dashes_survive_periods_and_markdown_emphasis(self):
        for original, model_output, expected in [
            ("Pages 2413–2559.", "Pages 2413–2559.", "Pages 2413–2559."),
            ("Pages 2413–2559.", "Pages 2413-2559.", "Pages 2413–2559."),
            ("**Study, pages 2413–2559.**", "**Study, pages 2413-2559.**", "**Study, pages 2413–2559.**"),
            ("Pages 2413-2559.", "Pages 2413-2559.", "Pages 2413–2559."),
        ]:
            with self.subTest(original=original, model_output=model_output):
                self.assertEqual(worker.normalize_smart_punctuation(model_output), expected)
                self.assertEqual(worker.request_correction(
                    self.core(model_output), "model", "note.md", original, "", ""
                ), expected)
        text = "2026-10-11, S7-2026-25, `2413-2559.`, https://example.com/2413-2559."
        self.assertEqual(worker.normalize_smart_punctuation(text), text)

    def test_preserves_quotation_mark_style(self):
        cases = [
            ('- transition after 55 years is "too little, too late"',
             "- transition after 55 years is 'too little, too late'"),
            ("The 'draft' is available.", 'The "draft" is available.'),
            ('Use "first" and \'second\'.', "Use 'first' and \"second\"."),
            ('We called it “the first” draft.', "We called it 'the first' draft."),
            ('She said "teh result" was good.', "She said 'the result' was good."),
        ]
        for original, corrected in cases:
            with self.subTest(original=original):
                self.assertIsNone(worker.request_correction(
                    self.core(corrected), "model", "note.md", original, "", ""
                ))

    def test_spelling_inside_quotes_and_apostrophe_corrections_are_allowed(self):
        original = 'She called it "teh best" even though it isnt.'
        corrected = 'She called it "the best" even though it isn\'t.'
        self.assertEqual(worker.request_correction(
            self.core(corrected), "model", "note.md", original, "", ""
        ), corrected)
        prompt = worker.spellcheck_prompt("note.md", original, "", "")
        self.assertIn("keep double-quoted text in double quotes", prompt)

    def test_compact_mode_joins_related_lines_but_can_be_switched_off(self):
        original = "A teh [first](https://example.com/a)\n[second](https://example.com/b) follows."
        joined = "A the [first](https://example.com/a) [second](https://example.com/b) follows."
        self.assertTrue(worker.safe_correction(original, joined))
        self.assertFalse(worker.safe_correction(original, joined, preserve_line_breaks=True))
        self.assertEqual(worker.request_correction(self.core(joined), "model", "note.md", original, "", ""), joined)

        prompts = []
        strict_core = SimpleNamespace(
            git_config_bool=lambda key, default: True,
            ollama_json=lambda endpoint, payload: prompts.append(payload["prompt"])
            or {"response": json.dumps({"text": joined})},
        )
        self.assertIsNone(worker.request_correction(strict_core, "model", "note.md", original, "", ""))
        self.assertIn("Do not move words between lines", prompts[0])
        self.assertIn("adjacent Markdown links together", worker.spellcheck_prompt("note.md", original, "", ""))

    def test_compact_mode_never_inserts_new_breaks_or_moves_wraps_arbitrarily(self):
        original = "A teh sentence.\nSome more prose."
        moved = "A the\nsentence. Some more prose."
        self.assertFalse(worker.safe_correction(original, moved))
        self.assertFalse(worker.safe_correction(original, "A the\nsentence.\nSome more prose."))
        self.assertTrue(worker.safe_correction(original, "A the sentence. Some more prose."))
        self.assertTrue(worker.safe_correction(original, "A the sentence.\nSome more prose."))

    def test_markdown_blocks_and_hard_breaks_are_not_compacted(self):
        cases = [
            ("First.\n\nSecond.", "First. Second."),
            ("# Heading\nThe text.", "# Heading The text."),
            ("- First item\n- Second item", "- First item - Second item"),
            ("A table | cell\nNext | cell", "A table | cell Next | cell"),
            ("An explicit hard break  \nNext line.", "An explicit hard break Next line."),
            ("Paragraph.\n> Blockquote", "Paragraph. > Blockquote"),
        ]
        for original, corrected in cases:
            with self.subTest(original=original):
                self.assertFalse(worker.safe_correction(original, corrected))

    def test_spelling_at_line_boundaries_still_allowed(self):
        original = "Alpha teh\nbravo sentnce."
        corrected = "Alpha the\nbravo sentence."
        self.assertTrue(worker.safe_correction(original, corrected))
        self.assertTrue(worker.safe_correction(original, corrected, preserve_line_breaks=True))
        self.assertEqual(worker.request_correction(self.core(corrected), "model", "note.md", original, "", ""), corrected)
        joined = "Alpha the bravo sentence."
        self.assertTrue(worker.safe_correction(original, joined))
        self.assertFalse(worker.safe_correction(original, joined, preserve_line_breaks=True))

    def test_custom_terminology_is_in_prompt(self):
        prompts = []
        core = SimpleNamespace(
            git_config_string=lambda key, default: "Instinet is a financial market name.",
            ollama_json=lambda endpoint, payload: prompts.append(payload["prompt"]) or {"response": '{"text":"Instinet trading."}'},
        )
        self.assertEqual(worker.request_correction(core, "model", "note.md", "Instinet trading.", "", ""), "Instinet trading.")
        self.assertIn("Instinet is a financial market name.", prompts[0])
        self.assertIn("en dashes for numeric ranges", prompts[0])

    def test_descriptive_title_and_invalid_output_fallback(self):
        proposals = {"note.md": (b"Instnet trading.", b"Instinet trading.")}
        for title in ["Spellcheck Instinet trading and citations", "Too short", "Spellcheck one two three four five six", "Spellcheck trading\nInject new trailer"]:
            core = SimpleNamespace(ollama_json=lambda *args: {"response": json.dumps({"title": title})})
            expected = title if title == "Spellcheck Instinet trading and citations" else worker.DEFAULT_TITLE
            self.assertEqual(worker.spellcheck_title(core, "model", proposals), expected)

    def test_fenced_code_excluded_from_prose(self):
        lines = ["prose\n", "```python\n", "typo in code\n", "```\n", "more prose\n"]
        self.assertEqual(worker.prose_ranges(lines, [(1, 5)]), [(1, 1), (5, 5)])

    def test_preserves_crlf_and_unchanged_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "note.md"
            path.write_bytes(b"Unchanged typo\r\nA teh sentence.\r\n")
            result = subprocess.CompletedProcess([], 0, stdout=str(root).encode())
            with patch.object(worker, "git_run", return_value=result), patch.object(worker, "changed_line_ranges", return_value=[(2, 2)]):
                proposal = worker.spellcheck_file(self.core("A the sentence."), "model", [], "note.md")
            self.assertEqual(proposal[1], b"Unchanged typo\r\nA the sentence.\r\n")
            self.assertEqual(path.read_bytes(), proposal[0])

    def test_compacted_lines_reconstruct_file_and_preserve_crlf(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "note.md"
            path.write_bytes(b"[One](https://example.com/a)\r\n[Two](https://example.com/b)\r\n")
            result = subprocess.CompletedProcess([], 0, stdout=str(root).encode())
            joined = "[One](https://example.com/a) [Two](https://example.com/b)"
            with patch.object(worker, "git_run", return_value=result), patch.object(
                worker, "changed_line_ranges", return_value=[(1, 2)]
            ):
                proposal = worker.spellcheck_file(self.core(joined), "model", [], "note.md")
            self.assertIsNotNone(proposal)
            self.assertEqual(proposal[1], (joined + "\r\n").encode())
            self.assertEqual(path.read_bytes(), proposal[0])

    def test_compacted_chunks_keep_later_edits_at_correct_offsets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "note.md"
            original = ("[One](https://example.com/a)\n[Two](https://example.com/b)\n"
                        "# Heading\nThe teh\nsentence.\n")
            path.write_text(original)
            first = "[One](https://example.com/a) [Two](https://example.com/b)"
            def correction(endpoint, payload):
                target = payload["prompt"]
                return {"response": json.dumps({"text": first if "TARGET:\n[One]" in target else "The the sentence."})}

            core = SimpleNamespace(ollama_json=correction)
            result = subprocess.CompletedProcess([], 0, stdout=str(root).encode())
            with patch.object(worker, "git_run", return_value=result), patch.object(
                worker, "changed_line_ranges", return_value=[(1, 2), (4, 5)]
            ):
                proposal = worker.spellcheck_file(core, "model", [], "note.md")
            self.assertIsNotNone(proposal)
            self.assertEqual(proposal[1].decode(), first + "\n# Heading\nThe the sentence.\n")

    def test_symlink_and_outside_paths_are_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "note.md").symlink_to("target.md")
            result = subprocess.CompletedProcess([], 0, stdout=str(root).encode())
            with patch.object(worker, "git_run", return_value=result):
                self.assertIsNone(worker.spellcheck_file(self.core("text"), "model", [], "note.md"))
                self.assertIsNone(worker.spellcheck_file(self.core("text"), "model", [], "../outside.md"))


class ProposalTests(unittest.TestCase):
    def test_applies_only_while_head_index_toggle_and_worktree_match(self):
        for reason in ["safe", "head", "index", "dirty", "toggle", "edited", "no_model"]:
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                original, corrected = b"A teh sentence.\n", b"A the sentence.\n"
                path = root / "note.md"
                path.write_bytes(b"local edits\n" if reason == "edited" else original)
                before = path.read_bytes()
                core = SimpleNamespace(
                    installed_local_model_names=lambda: {"model"},
                    selected_model=lambda installed: (None if reason == "no_model" else "model", False),
                    git_config_bool=lambda *args: reason != "toggle",
                )
                result = subprocess.CompletedProcess([], 0, stdout=str(root).encode())
                with patch.object(worker, "git_run", return_value=result), patch.object(
                    worker, "spellcheck_file", return_value=(original, corrected)
                ), patch.object(worker, "head_sha", return_value="other" if reason == "head" else "expected"), patch.object(
                    worker, "index_is_clean", return_value=reason != "index"
                ), patch.object(worker, "has_unstaged_changes", return_value=reason == "dirty"):
                    proposals = worker.apply_spellcheck(core, [], ["note.md"], "expected")
                self.assertEqual(bool(proposals), reason == "safe")
                self.assertEqual(path.read_bytes(), corrected if reason == "safe" else before)

    def test_push_gate_waits_for_push_and_skips_failure_or_branch_change(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            gate_path = Path(directory) / worker.PUSH_GATE_NAME
            gate = {"token": "test-token", "state": "pending", "previous_head": "old",
                    "branch": "topic", "created_ms": worker.time.time() * 1000}
            gate_path.write_text(json.dumps(gate))
            result = subprocess.CompletedProcess([], 0, stdout=directory)
            with patch.object(worker, "git_run", return_value=result), patch.object(
                worker, "active_branch", return_value="topic"
            ), patch.object(worker, "head_sha", return_value="new"):
                self.assertEqual(worker.read_push_gate([], "old")["token"], "test-token")
                self.assertIsNone(worker.read_push_gate([], "another"))
                def mark_pushed(_):
                    gate["state"] = "pushed"
                    gate_path.write_text(json.dumps(gate))
                with patch.object(worker.time, "sleep", side_effect=mark_pushed):
                    self.assertTrue(worker.wait_for_push_gate([], "test-token", "new", "topic"))
                gate["state"] = "failed"
                gate_path.write_text(json.dumps(gate))
                self.assertFalse(worker.wait_for_push_gate([], "test-token", "new", "topic"))
            with patch.object(worker, "git_run", return_value=result), patch.object(
                worker, "active_branch", return_value="other"
            ), patch.object(worker, "head_sha", return_value="new"):
                self.assertFalse(worker.wait_for_push_gate([], "test-token", "new", "topic"))

    def test_spellcheck_emits_notice_without_a_keep_or_discard_dialog(self):
        job = {"global_args": [], "paths": ["note.md"], "head": "expected"}
        proposals = {"note.md": (b"original", b"corrected")}
        core = SimpleNamespace(git_config_bool=lambda *args: True, installed_local_model_names=lambda: {"model"}, selected_model=lambda installed: ("model", False))
        with patch.dict(worker.os.environ, {worker.SPELLCHECK_JOB_ENV: json.dumps(job)}), patch.object(
            worker, "head_sha", return_value="expected"
        ), patch.object(worker, "has_unstaged_changes", return_value=False), patch.object(
            worker, "index_is_clean", return_value=True
        ), patch.object(worker, "load_core", return_value=core), patch.object(
            worker, "apply_spellcheck", return_value=proposals
        ), patch.object(worker, "proposal_is_untouched", return_value=True), patch.object(
            worker, "write_spellcheck_notice"
        ) as notice, patch.object(worker, "spellcheck_title") as title, patch.object(worker, "git_run") as git:
            self.assertEqual(worker.run_post_commit_job(), 0)
            notice.assert_called_once_with([], "expected", ["note.md"], "model")
            title.assert_not_called()
            git.assert_not_called()

    def test_changed_head_preserves_proposals_without_showing_stale_notice(self):
        job = {"global_args": [], "paths": ["note.md"], "head": "expected"}
        with patch.dict(worker.os.environ, {worker.SPELLCHECK_JOB_ENV: json.dumps(job)}), patch.object(
            worker, "head_sha", side_effect=["expected", "changed"]
        ), patch.object(worker, "has_unstaged_changes", return_value=False), patch.object(
            worker, "index_is_clean", return_value=True
        ), patch.object(worker, "load_core", return_value=SimpleNamespace(git_config_bool=lambda *args: True, installed_local_model_names=lambda: {"model"}, selected_model=lambda installed: ("model", False))
        ), patch.object(worker, "apply_spellcheck", return_value={"note.md": (b"original", b"corrected")}), patch.object(
            worker, "write_spellcheck_notice"
        ) as notice:
            self.assertEqual(worker.run_post_commit_job(), 0)
            notice.assert_not_called()

    def test_toggle_off_skips_job_without_loading_model(self):
        job = {"global_args": [], "paths": ["note.md"], "head": "expected"}
        with patch.dict(worker.os.environ, {worker.SPELLCHECK_JOB_ENV: json.dumps(job)}), patch.object(worker, "head_sha", return_value="expected"), patch.object(
            worker, "has_unstaged_changes", return_value=False
        ), patch.object(worker, "index_is_clean", return_value=True), patch.object(
            worker, "load_core", return_value=SimpleNamespace(git_config_bool=lambda *args: False)
        ), patch.object(worker, "apply_spellcheck") as apply:
            worker.run_post_commit_job()
            apply.assert_not_called()


    def test_notice_is_written_only_inside_git_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gitdir = root / ".git"
            gitdir.mkdir()
            result = subprocess.CompletedProcess([], 0, stdout=str(gitdir))
            with patch.object(worker, "git_run", return_value=result):
                self.assertTrue(worker.write_spellcheck_notice([], "a" * 40, ["readme.md"], "qwen:3b", "Spellcheck Instinet trading and citations"))
                notice = gitdir / worker.NOTICE_FILE_NAME
                self.assertEqual(json.loads(notice.read_text()), {
                    "version": 1, "head": "a" * 40, "paths": ["readme.md"], "model": "qwen:3b", "title": "Spellcheck Instinet trading and citations",
                })
                self.assertFalse((root / worker.NOTICE_FILE_NAME).exists())

    def test_notice_write_handles_missing_metadata(self):
        result = subprocess.CompletedProcess([], 1, stdout="")
        with patch.object(worker, "git_run", return_value=result):
            self.assertFalse(worker.write_spellcheck_notice([], "a" * 40, ["readme.md"], "qwen:3b", "Spellcheck Instinet trading and citations"))

    def test_no_notice_after_intervening_edit(self):
        job = {"global_args": [], "paths": ["note.md"], "head": "expected"}
        proposals = {"note.md": (b"before", b"after")}
        with patch.dict(worker.os.environ, {worker.SPELLCHECK_JOB_ENV: json.dumps(job)}), patch.object(
            worker, "head_sha", return_value="expected"
        ), patch.object(worker, "has_unstaged_changes", return_value=False), patch.object(
            worker, "index_is_clean", return_value=True
        ), patch.object(worker, "load_core", return_value=SimpleNamespace(git_config_bool=lambda *args: True, installed_local_model_names=lambda: {"model"}, selected_model=lambda installed: ("model", False))
        ), patch.object(worker, "apply_spellcheck", return_value=proposals), patch.object(
            worker, "proposal_is_untouched", return_value=False
        ), patch.object(worker, "write_spellcheck_notice") as notice:
            self.assertEqual(worker.run_post_commit_job(), 0)
            notice.assert_not_called()


if __name__ == '__main__':
    unittest.main()
