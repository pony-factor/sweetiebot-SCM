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
            ("Use `Alpine’s` here.", "Use `Alpine’s` here."),
            ("Visit https://example.com/a", "Visit https://example.com/b"),
            ("# Heading", "Heading"),
            ("Two lines\nremain", "One line"),
        ]:
            with self.subTest(original=original):
                self.assertIsNone(worker.request_correction(self.core(corrected), "model", "note.md", original, "", ""))

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

    def test_dialog_keeps_proposals_without_staging_or_committing(self):
        job = {"global_args": [], "paths": ["note.md"], "head": "expected"}
        proposals = {"note.md": (b"original", b"corrected")}
        core = SimpleNamespace(git_config_bool=lambda *args: True)
        for choice in ["Keep edits", "", "Discard"]:
            with self.subTest(choice=choice), patch.dict(worker.os.environ, {worker.SPELLCHECK_JOB_ENV: json.dumps(job)}), patch.object(
                worker, "head_sha", return_value="expected"
            ), patch.object(worker, "has_unstaged_changes", return_value=False), patch.object(
                worker, "index_is_clean", return_value=True
            ), patch.object(worker, "load_core", return_value=core), patch.object(
                worker, "apply_spellcheck", return_value=proposals
            ), patch.object(worker, "dialog_choice", return_value=choice), patch.object(worker, "discard_proposals") as discard, patch.object(worker, "git_run") as git:
                self.assertEqual(worker.run_post_commit_job(), 0)
                self.assertEqual(discard.called, choice == "Discard")
                git.assert_not_called()

    def test_changed_head_after_dialog_preserves_edits(self):
        job = {"global_args": [], "paths": ["note.md"], "head": "expected"}
        with patch.dict(worker.os.environ, {worker.SPELLCHECK_JOB_ENV: json.dumps(job)}), patch.object(
            worker, "head_sha", side_effect=["expected", "changed"]
        ), patch.object(worker, "has_unstaged_changes", return_value=False), patch.object(worker, "index_is_clean", return_value=True), patch.object(
            worker, "load_core", return_value=SimpleNamespace(git_config_bool=lambda *args: True)
        ), patch.object(worker, "apply_spellcheck", return_value={"note.md": (b"original", b"corrected")}), patch.object(
            worker, "dialog_choice", return_value="Discard"
        ), patch.object(worker, "discard_proposals") as discard:
            worker.run_post_commit_job()
            discard.assert_not_called()

    def test_discard_refuses_modified_proposals(self):
        with patch.object(worker, "proposal_is_untouched", return_value=False), patch.object(worker, "git_run") as git:
            worker.discard_proposals([], {"note.md": (b"original", b"corrected")})
            git.assert_not_called()

    def test_toggle_off_skips_job_without_loading_model(self):
        job = {"global_args": [], "paths": ["note.md"], "head": "expected"}
        with patch.dict(worker.os.environ, {worker.SPELLCHECK_JOB_ENV: json.dumps(job)}), patch.object(worker, "head_sha", return_value="expected"), patch.object(
            worker, "has_unstaged_changes", return_value=False
        ), patch.object(worker, "index_is_clean", return_value=True), patch.object(
            worker, "load_core", return_value=SimpleNamespace(git_config_bool=lambda *args: False)
        ), patch.object(worker, "apply_spellcheck") as apply:
            worker.run_post_commit_job()
            apply.assert_not_called()


if __name__ == '__main__':
    unittest.main()
