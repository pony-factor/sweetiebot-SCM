import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import local_codex_commit


class ReviewedWhitespaceTests(unittest.TestCase):
    def test_reviewed_files_normalize_without_touching_real_index_or_other_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.run(['git', '-C', directory, *args], check=True, capture_output=True).stdout
            git('init', '-q')
            (root / 'review.md').write_bytes(b'original\r\n')
            (root / 'other.md').write_bytes(b'original\n')
            git('add', '.')
            # Create a fixture HEAD without running a commit or hooks.
            tree = git('write-tree').decode().strip()
            env = {**os.environ, 'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.com',
                   'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.com'}
            head = subprocess.run(['git', '-C', directory, 'commit-tree', tree, '-m', 'Fixture'],
                                  env=env, check=True, capture_output=True).stdout.decode().strip()
            git('update-ref', 'HEAD', head)
            (root / 'review.md').write_bytes(b'corrected  \r\n\r\n')
            (root / 'other.md').write_bytes(b'unrelated  \n\n')
            git('add', 'other.md')
            index_before = (root / '.git/index').read_bytes()
            with patch('ai_commit.GIT_GLOBAL_ARGS', ['-C', directory]), \
                 patch('ai_commit.staged_whitespace_enabled', return_value=True):
                local_codex_commit.normalize_reviewed_whitespace(['review.md'])
            self.assertEqual((root / 'review.md').read_bytes(), b'corrected\r\n')
            self.assertEqual((root / 'other.md').read_bytes(), b'unrelated  \n\n')
            self.assertEqual((root / '.git/index').read_bytes(), index_before)
            self.assertEqual(git('rev-parse', 'HEAD').decode().strip(), head)

    def test_disabled_check_leaves_reviewed_files_alone(self):
        with patch('ai_commit.staged_whitespace_enabled', return_value=False), \
             patch('ai_commit.git_bytes') as git:
            local_codex_commit.normalize_reviewed_whitespace(['review.md'])
            git.assert_not_called()


class LocalCodexCommitTests(unittest.TestCase):
    def setUp(self):
        enabled = patch('ai_commit.staged_whitespace_enabled', return_value=True)
        normalize = patch('ai_commit.normalize_staged_final_newlines')
        enabled.start()
        self.normalize = normalize.start()
        self.addCleanup(enabled.stop)
        self.addCleanup(normalize.stop)

    def test_normalizes_before_reading_diff_for_generation(self):
        calls = []
        self.normalize.side_effect = lambda: calls.append('normalize')
        with patch('sys.stdin', io.StringIO('{"context":""}')), \
             patch('sys.stdout', io.StringIO()), \
             patch('ai_commit.staged_diff', side_effect=lambda: (calls.append('diff') or ('stat', 'diff', ['file']))), \
             patch('ai_commit.git_output', return_value='main'), \
             patch('ai_commit.should_add_default_branch_description', return_value=False), \
             patch('ai_commit.generate_message', return_value=('Title', '')):
            local_codex_commit.main()
        self.assertEqual(calls, ['normalize', 'diff', 'diff'])

    def test_normalization_only_honors_toggle_without_generating(self):
        with patch('sys.argv', ['local_codex_commit.py', '--normalize-staged-whitespace']), \
             patch('ai_commit.staged_diff') as diff, \
             patch('ai_commit.generate_message') as generate:
            local_codex_commit.main()
            self.normalize.assert_called_once_with()
            self.normalize.reset_mock()
            with patch('ai_commit.staged_whitespace_enabled', return_value=False):
                local_codex_commit.main()
            self.normalize.assert_not_called()
        diff.assert_not_called()
        generate.assert_not_called()

    def test_disabled_toggle_preserves_formatting_during_generation(self):
        with patch('sys.stdin', io.StringIO('{"context":""}')), \
             patch('sys.stdout', io.StringIO()), \
             patch('ai_commit.staged_whitespace_enabled', return_value=False), \
             patch('ai_commit.staged_diff', return_value=('stat', 'diff', ['file'])), \
             patch('ai_commit.git_output', return_value='main'), \
             patch('ai_commit.should_add_default_branch_description', return_value=False), \
             patch('ai_commit.generate_message', return_value=('Title', '')):
            local_codex_commit.main()
        self.normalize.assert_not_called()

    def test_missing_optional_chat_context_uses_staged_diff(self):
        with patch('sys.stdin', io.StringIO('{"context":""}')), \
             patch('sys.stdout', io.StringIO()), \
             patch('ai_commit.staged_diff', return_value=('stat', 'diff', ['file'])), \
             patch('ai_commit.git_output', return_value='main'), \
             patch('ai_commit.should_add_default_branch_description', return_value=False), \
             patch('ai_commit.generate_message', return_value=('Fix button', '')) as generate:
            local_codex_commit.main()
        self.assertEqual(generate.call_args.kwargs['conversation_context'], '')

    def test_only_generates_from_staged_changes_and_in_memory_context(self):
        staged = ('stat', 'diff', ['file.txt'])
        output = io.StringIO()
        with patch('sys.stdin', io.StringIO(json.dumps({'context': 'Current chat'}))), \
             patch('sys.stdout', output), \
             patch('ai_commit.staged_diff', return_value=staged), \
             patch('ai_commit.git_output', return_value='main'), \
             patch('ai_commit.should_add_default_branch_description', return_value=True), \
             patch('ai_commit.generate_message', return_value=('Fix button', 'Explain change.')) as generate:
            local_codex_commit.main()
        generate.assert_called_once_with(
            *staged, include_description=True, conversation_context='Current chat'
        )
        self.assertEqual(json.loads(output.getvalue())['message'], 'Fix button\n\nExplain change.')

    def test_does_not_generate_or_stage_when_index_is_empty(self):
        with patch('sys.stdin', io.StringIO('{"context":"Current chat"}')), \
             patch('ai_commit.staged_diff', return_value=('', '', [])), \
             patch('ai_commit.generate_message') as generate:
            with self.assertRaisesRegex(ValueError, 'Stage the intended changes'):
                local_codex_commit.main()
        generate.assert_not_called()

    def test_changed_index_stops_before_returning_a_commit_message(self):
        with patch('sys.stdin', io.StringIO('{"context":"Current chat"}')), \
             patch('ai_commit.staged_diff', side_effect=[('stat', 'diff', ['file']), ('new', 'new', ['file'])]), \
             patch('ai_commit.git_output', return_value='main'), \
             patch('ai_commit.should_add_default_branch_description', return_value=False), \
             patch('ai_commit.generate_message', return_value=('Title', '')):
            with self.assertRaisesRegex(ValueError, 'changed during local generation'):
                local_codex_commit.main()
