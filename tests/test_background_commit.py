"""Real Git checks for saved click-time commits and restartable publication."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import background_commit as worker


class BackgroundCommitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.before = os.getcwd()
        self.env = patch.dict(os.environ, {
            'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
            'SWEETIEBOT_COMMIT_JOBS': str(self.root / 'jobs'),
            'SWEETIEBOT_LOG_FILE': str(self.root / 'events.log')})
        self.env.start()
        os.chdir(self.repo)
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.name', 'Test Author')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'scm-toolkit.post-commit-spellcheck', 'false')
        self.git('init', '--bare', '-q', str(self.root / 'remote'))
        self.git('remote', 'add', 'origin', str(self.root / 'remote'))
        (self.repo / 'story.txt').write_text('Captured change\n')
        self.git('add', 'story.txt')

    def tearDown(self):
        os.chdir(self.before)
        self.env.stop()
        self.temp.cleanup()

    def git(self, *args, **kwargs):
        return subprocess.check_output(['/usr/bin/git', *args], text=True, **kwargs).strip()

    def queue(self, **request):
        result = worker.enqueue({'message': '🧪 Record captured change', **request}, start=False)
        directory = self.root / 'jobs' / result['id']
        return directory

    def job(self, directory):
        return json.loads((directory / 'job.json').read_text())

    def test_captured_tree_and_later_staging_survive_detached_process(self):
        directory = self.queue(push=True)
        captured = self.git('write-tree')
        (self.repo / 'story.txt').write_text('Later staged change\n')
        self.git('add', 'story.txt')
        subprocess.run([sys.executable, str(Path(worker.__file__)), '--resume'], check=True)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertEqual(self.git('rev-parse', 'HEAD^{tree}'), captured)
        self.assertEqual(self.git('show', ':story.txt'), 'Later staged change')
        self.assertEqual(self.git('diff', '--cached', '--name-only'), 'story.txt')
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'rev-parse', 'refs/heads/main'), self.git('rev-parse', 'HEAD'))
        self.assertFalse((self.repo / '.git' / worker.MARKER).exists())

    def test_offline_push_resumes_without_recommitting(self):
        directory = self.queue(push=True)
        (self.root / 'remote').rename(self.root / 'offline')
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'pushing')
        sha = self.git('rev-parse', 'HEAD')
        (self.root / 'offline').rename(self.root / 'remote')
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertEqual(self.git('rev-parse', 'HEAD'), sha)
        self.assertEqual(self.git('rev-list', '--count', 'HEAD'), '1')

    def test_restart_after_git_commit_before_checkpoint_is_idempotent(self):
        directory = self.queue(push=True, signoff=True)
        job = self.job(directory)
        job['phase'] = 'committing'
        worker.write_journal(directory / 'job.json', job)
        with patch.dict(os.environ, {'GIT_INDEX_FILE': str(directory / 'index'),
                                    'GIT_REFLOG_ACTION': 'sweetiebot-background:' + job['id']}):
            self.git('read-tree', job['tree'])
            self.git('commit', '-q', '--signoff', '-m', job['message'])
        sha = self.git('rev-parse', 'HEAD')
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertEqual(self.git('rev-parse', 'HEAD'), sha)

    def test_branch_change_blocks_commit_and_push(self):
        directory = self.queue(push=True)
        self.git('symbolic-ref', 'HEAD', 'refs/heads/other')
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        self.assertNotEqual(subprocess.run(['/usr/bin/git', 'rev-parse', '--verify', 'HEAD'], capture_output=True).returncode, 0)
        refs = subprocess.run(['/usr/bin/git', '--git-dir=' + str(self.root / 'remote'), 'show-ref'], capture_output=True)
        self.assertEqual(refs.returncode, 1)

    def test_generation_uses_captured_context_and_index(self):
        directory = self.queue(message='', context='User intent', trailer='Co-authored-by: Codex <noreply@openai.com>')
        (self.repo / 'story.txt').write_text('Newer edits\n')
        self.git('add', 'story.txt')
        def generate(stat, diff, files, **kwargs):
            self.assertIn('+Captured change', diff)
            self.assertNotIn('Newer edits', diff)
            self.assertEqual(kwargs['conversation_context'], 'User intent')
            return '🧪 Preserve original staged change', ''
        with patch.object(worker.core, 'generate_message', side_effect=generate):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertIn('Co-authored-by: Codex', self.git('log', '-1', '--format=%B'))
        self.assertEqual(self.git('show', 'HEAD:story.txt'), 'Captured change')

    def test_ollama_startup_failure_retries_after_restart(self):
        directory = self.queue(message='')
        with patch.object(worker.core, 'generate_message', side_effect=RuntimeError('Model not ready')):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'generating')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Retry generation', '')):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')

    def test_wrapper_blocks_other_operations_while_job_is_pending(self):
        directory = self.queue()
        for command in ('commit', 'push', 'checkout', 'reset'):
            result = subprocess.run([sys.executable, str(Path(worker.__file__).with_name('ai_commit.py')), command], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('background Commit & Push is pending', result.stderr)
        self.assertEqual(self.job(directory)['phase'], 'queued')

    def test_second_request_is_refused_without_changing_snapshot(self):
        directory = self.queue()
        with self.assertRaisesRegex(RuntimeError, 'already queued'):
            self.queue()
        self.assertEqual(self.job(directory)['tree'], self.git('write-tree'))

    def test_parallel_worker_cannot_duplicate_commit(self):
        directory = self.queue(push=True)
        children = [subprocess.Popen([sys.executable, str(Path(worker.__file__)), '--resume']) for _ in range(3)]
        self.assertEqual([child.wait(timeout=15) for child in children], [0, 0, 0])
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertEqual(self.git('rev-list', '--count', 'HEAD'), '1')


if __name__ == '__main__':
    unittest.main()
