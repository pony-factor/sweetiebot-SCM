import io
import json
import unittest
from unittest.mock import patch

import local_codex_commit


class LocalCodexCommitTests(unittest.TestCase):
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
            *staged, include_description=True, conversation_context='Current chat', require_model=True
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
