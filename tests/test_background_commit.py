"""Real Git checks for saved click-time commits and restartable publication."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import threading
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

    def test_status_tracks_title_jobs_independently_of_pending_push(self):
        first = self.queue(push=True)
        (self.repo / 'story.txt').write_text('Second change\n')
        self.git('add', 'story.txt')
        second = self.queue(message='')
        command = [sys.executable, worker.__file__, '--status']
        status = json.loads(subprocess.check_output(command, text=True))
        self.assertEqual(status['id'], first.name)
        self.assertEqual(status['titleJobs'], [second.name])
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Apply final title', 'Explanation')):
            worker.work(second)
        status = json.loads(subprocess.check_output(command, text=True))
        self.assertEqual(status['id'], first.name)
        self.assertEqual(status['titleJobs'], [])

    def test_placeholder_clears_staging_before_generation_and_push(self):
        with patch.object(worker.core, 'generate_message', side_effect=AssertionError('Must run later')):
            directory = self.queue(message='', push=True, signoff=True)
        provisional = self.git('rev-parse', 'HEAD')
        self.assertRegex(directory.name, r'^[0-9a-f]{16}$')
        self.assertEqual(self.git('log', '-1', '--format=%s'), 'placeholder_' + directory.name)
        identity = self.git('show', '-s', '--format=%an|%ae|%aI|%cn|%ce|%cI')
        self.assertIn(worker.PLACEHOLDER, self.git('log', '-1', '--format=%s'))
        self.assertEqual(self.git('diff', '--cached', '--name-only'), '')
        self.assertEqual(self.git('status', '--porcelain'), '')
        remote = '--git-dir=' + str(self.root / 'remote')
        self.assertEqual(self.git(remote, 'for-each-ref'), '')
        (self.repo / 'story.txt').write_text('Later staged change\n')
        self.git('add', 'story.txt')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Apply final title', 'Explanation')):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertNotEqual(self.git('rev-parse', 'HEAD'), provisional)
        self.assertEqual(self.git('show', '-s', '--format=%an|%ae|%aI|%cn|%ce|%cI'), identity)
        self.assertEqual(self.git('log', '-1', '--format=%s'), '🧪 Apply final title')
        self.assertIn('Signed-off-by: Test Author', self.git('log', '-1', '--format=%B'))
        self.assertEqual(self.git('show', ':story.txt'), 'Later staged change')
        self.assertEqual(self.git('show', 'HEAD:story.txt'), 'Captured change')
        self.assertEqual(self.git(remote, 'rev-parse', 'refs/heads/main'), self.git('rev-parse', 'HEAD'))

    def test_finalization_resumes_after_ref_update_before_checkpoint(self):
        directory = self.queue(message='')
        recover = worker.recover_finalization
        def interrupted(meta):
            transaction = worker.read_journal(Path(meta) / worker.TRANSACTION)
            if not transaction:
                return recover(meta)
            self.git('update-ref', transaction['branch'], transaction['after'], transaction['before'])
            raise OSError('Interrupted before checkpoint')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Recover final title', '')), patch.object(worker, 'recover_finalization', side_effect=interrupted):
            worker.work(directory)
        sha = self.git('rev-parse', 'HEAD')
        with patch.object(worker.core, 'generate_message', side_effect=AssertionError('Already generated')):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertEqual(self.git('rev-parse', 'HEAD'), sha)
        self.assertEqual(self.git('rev-list', '--count', 'HEAD'), '1')

    def test_finalization_preserves_existing_parent_and_unstaged_edits(self):
        self.git('commit', '-q', '-m', 'Initial history')
        parent = self.git('rev-parse', 'HEAD')
        (self.repo / 'story.txt').write_text('Captured second change\n')
        self.git('add', 'story.txt')
        directory = self.queue(message='')
        (self.repo / 'story.txt').write_text('New unstaged work\n')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Finalize second change', '')):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertEqual(self.git('rev-parse', 'HEAD^'), parent)
        self.assertEqual(self.git('rev-list', '--count', 'HEAD'), '2')
        self.assertEqual(self.git('show', 'HEAD:story.txt'), 'Captured second change')
        self.assertEqual(self.git('diff', '--cached', '--name-only'), '')
        self.assertEqual((self.repo / 'story.txt').read_text(), 'New unstaged work\n')

    def test_external_commit_blocks_placeholder_replacement(self):
        directory = self.queue(message='', push=True)
        self.git('commit', '-q', '--allow-empty', '-m', 'Later external commit')
        sha = self.git('rev-parse', 'HEAD')
        with patch.object(worker.core, 'generate_message', side_effect=AssertionError('Branch advanced')):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        self.assertEqual(self.git('rev-parse', 'HEAD'), sha)
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'for-each-ref'), '')

    def test_rejected_placeholder_keeps_staged_changes(self):
        hook = self.repo / '.git' / 'hooks' / 'pre-commit'
        hook.write_text('#!/bin/sh\nexit 1\n')
        hook.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, 'Git commit failed'):
            self.queue(message='')
        self.assertEqual(self.git('diff', '--cached', '--name-only'), 'story.txt')
        result = subprocess.run(['/usr/bin/git', 'rev-parse', '--verify', 'HEAD'], capture_output=True)
        self.assertNotEqual(result.returncode, 0)

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
        job.pop('sha')  # Crash after Git updates HEAD, before the journal checkpoint.
        worker.write_journal(directory / 'job.json', job)
        sha = self.git('rev-parse', 'HEAD')
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertEqual(self.git('rev-parse', 'HEAD'), sha)

    def test_branch_change_blocks_commit_and_push(self):
        directory = self.queue(push=True)
        self.git('symbolic-ref', 'HEAD', 'refs/heads/other')
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        self.assertTrue(self.job(directory).get('sha'))
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
        self.assertEqual(self.job(directory)['phase'], 'committed')

    def test_multiple_placeholders_finalize_in_order_and_preserve_later_staging(self):
        directories = []
        for n in range(3):
            (self.repo / 'story.txt').write_text(f'Captured change {n}\n')
            self.git('add', 'story.txt')
            directories.append(self.queue(message='', push=True))
            self.assertEqual(self.git('diff', '--cached', '--name-only'), '')
        original = [self.job(directory) for directory in directories]
        identities = [self.git('show', '-s', '--format=%an|%ae|%aI|%cn|%ce|%cI', job['sha']) for job in original]
        (self.repo / 'story.txt').write_text('Later staged work\n')
        self.git('add', 'story.txt')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Final title 2', '')):
            worker.work(directories[2])
        self.assertEqual(self.job(directories[2])['phase'], 'ready')
        for n, directory in enumerate(directories):
            with patch.object(worker.core, 'generate_message', return_value=(f'🧪 Final title {n}', '')):
                worker.work(directory)
            self.assertEqual(self.job(directory)['phase'], 'done')
            remote_tip = self.git('--git-dir=' + str(self.root / 'remote'), 'rev-parse', 'refs/heads/main')
            self.assertNotIn('placeholder_', self.git('log', '--format=%s', remote_tip))
            self.assertEqual(self.git('show', 'HEAD:story.txt'), 'Captured change 2')
            self.assertEqual(self.git('show', ':story.txt'), 'Later staged work')
        self.assertEqual(self.git('rev-list', '--count', 'HEAD'), '3')
        for n, directory in enumerate(directories):
            job = self.job(directory)
            self.assertEqual(self.git('show', '-s', '--format=%s', job['sha']), f'🧪 Final title {n}')
            self.assertEqual(self.git('show', '-s', '--format=%T', job['sha']), original[n]['tree'])
            self.assertEqual(self.git('show', '-s', '--format=%an|%ae|%aI|%cn|%ce|%cI', job['sha']), identities[n])
        self.assertFalse((self.repo / '.git' / worker.MARKER).exists())

    def test_enqueue_during_generation_returns_before_the_model_finishes(self):
        first = self.queue(message='')
        started, release = self.root / 'started', self.root / 'release'
        script = '''
import sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import background_commit as worker
calls = 0
def generate(*args, **kwargs):
    global calls
    calls += 1
    if calls > 1:
        return '🧪 Second final title', ''
    Path(sys.argv[3]).touch()
    deadline = time.monotonic() + 15
    while not Path(sys.argv[4]).exists():
        if time.monotonic() > deadline: raise RuntimeError('Test release timed out')
        time.sleep(.02)
    return '🧪 First final title', ''
worker.core.generate_message = generate
worker.resume(parallel=False)
'''
        child = subprocess.Popen([sys.executable, '-c', script, str(Path(worker.__file__).parent), str(first), str(started), str(release)])
        try:
            deadline = time.monotonic() + 10
            while not started.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(started.exists())
            (self.repo / 'story.txt').write_text('Second captured change\n')
            self.git('add', 'story.txt')
            second = self.queue(message='')
            self.assertIsNone(child.poll(), 'the model remains busy while another commit is accepted')
            self.assertEqual(self.git('diff', '--cached', '--name-only'), '')
            release.touch()
            self.assertEqual(child.wait(timeout=10), 0)
            self.assertEqual(self.job(second)['phase'], 'done', 'the same worker drains jobs added during generation')
            self.assertEqual(self.git('log', '--reverse', '--format=%s'), '🧪 First final title\n🧪 Second final title')
        finally:
            release.touch()
            child.wait(timeout=15)

    def test_parallel_worker_cannot_duplicate_commit(self):
        directory = self.queue(push=True)
        children = [subprocess.Popen([sys.executable, str(Path(worker.__file__)), '--resume']) for _ in range(3)]
        self.assertEqual([child.wait(timeout=15) for child in children], [0, 0, 0])
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertEqual(self.git('rev-list', '--count', 'HEAD'), '1')

    def check_parallel_generation(self, second_finishes_first):
        first = self.queue(message='', push=True)
        (self.repo / 'story.txt').write_text('Second parallel snapshot\n')
        self.git('add', 'story.txt')
        second = self.queue(message='', push=True)
        original_second = self.job(second)['sha']
        (self.repo / 'story.txt').write_text('Later staged work\n')
        self.git('add', 'story.txt')
        signals = self.root / 'signals'
        signals.mkdir()
        script = '''
import sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import background_commit as worker
directory, signals = Path(sys.argv[2]), Path(sys.argv[3])
def generate(*args, **kwargs):
    with (signals / (directory.name + '.calls')).open('a') as output: output.write('generate\\n')
    (signals / (directory.name + '.started')).touch()
    deadline = time.monotonic() + 20
    while not (signals / (directory.name + '.release')).exists():
        if time.monotonic() > deadline: raise RuntimeError('Parallel test timed out')
        time.sleep(.02)
    return ('🧪 First parallel title' if directory.name == sys.argv[4] else '🧪 Second parallel title'), ''
worker.core.generate_message = generate
worker.work(directory)
'''
        children, errors = [], []
        def launch(directory):
            child = subprocess.Popen([sys.executable, '-c', script, str(Path(worker.__file__).parent), str(directory), str(signals), first.name])
            children.append(child)
            return child
        def coordinate():
            try:
                worker.drain_parallel(str(self.repo / '.git'))
            except BaseException as exc:
                errors.append(exc)
        def wait_until(predicate):
            deadline = time.monotonic() + 15
            while not predicate() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(predicate())
        with patch.object(worker, 'launch_job', side_effect=launch):
            coordinator = threading.Thread(target=coordinate)
            coordinator.start()
            try:
                wait_until(lambda: all((signals / (directory.name + '.started')).exists() for directory in (first, second)))
                # Both model requests entered generation before either finished.
                early, late = (second, first) if second_finishes_first else (first, second)
                (signals / (early.name + '.release')).touch()
                if second_finishes_first:
                    wait_until(lambda: self.job(second)['phase'] == 'ready')
                    self.assertEqual(self.git('rev-parse', 'HEAD'), original_second)
                    self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'for-each-ref'), '')
                else:
                    wait_until(lambda: self.job(first)['phase'] == 'done')
                    self.assertNotEqual(self.job(second)['sha'], original_second, 'reparent a descendant while its model request is running')
                (signals / (late.name + '.release')).touch()
                coordinator.join(timeout=15)
                self.assertFalse(coordinator.is_alive())
                self.assertEqual(errors, [])
                self.assertEqual([self.job(directory)['phase'] for directory in (first, second)], ['done', 'done'])
                self.assertEqual(self.git('log', '--reverse', '--format=%s'), '🧪 First parallel title\n🧪 Second parallel title')
                self.assertEqual(self.git('show', 'HEAD:story.txt'), 'Second parallel snapshot')
                self.assertEqual(self.git('show', ':story.txt'), 'Later staged work')
                self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'rev-parse', 'refs/heads/main'), self.git('rev-parse', 'HEAD'))
                for directory in (first, second):
                    self.assertEqual((signals / (directory.name + '.calls')).read_text(), 'generate\n', 'reuse ready results rather than generating again')
            finally:
                for directory in (first, second):
                    (signals / (directory.name + '.release')).touch()
                coordinator.join(timeout=20)
                for child in children:
                    child.wait(timeout=10)

    def test_parallel_generation_applies_out_of_order_results_in_commit_order(self):
        self.check_parallel_generation(second_finishes_first=True)

    def test_parallel_generation_preserves_reparenting_during_an_active_request(self):
        self.check_parallel_generation(second_finishes_first=False)

    def test_partial_descendant_checkpoint_is_recovered_before_another_enqueue(self):
        first = self.queue(message='')
        (self.repo / 'story.txt').write_text('Second snapshot\n')
        self.git('add', 'story.txt')
        second = self.queue(message='')
        recover = worker.recover_finalization
        def interrupted(meta):
            transaction = worker.read_journal(Path(meta) / worker.TRANSACTION)
            if not transaction:
                return recover(meta)
            self.git('update-ref', transaction['branch'], transaction['after'], transaction['before'])
            update = transaction['updates'][0]
            journal = Path(update['directory']) / 'job.json'
            job = worker.read_journal(journal)
            job.update(update['values'])
            worker.write_journal(journal, job)
            raise OSError('Interrupted between descendant checkpoints')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Recovered ancestor', '')), patch.object(worker, 'recover_finalization', side_effect=interrupted):
            worker.work(first)
        self.assertTrue((self.repo / '.git' / worker.TRANSACTION).exists())
        (self.repo / 'story.txt').write_text('Third snapshot\n')
        self.git('add', 'story.txt')
        third = self.queue(message='')
        self.assertFalse((self.repo / '.git' / worker.TRANSACTION).exists())
        self.assertEqual(self.git('rev-parse', 'HEAD~2'), self.job(first)['sha'])
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Recovered descendant', '')):
            worker.resume(parallel=False)
        self.assertEqual([self.job(directory)['phase'] for directory in (first, second, third)], ['done'] * 3)
        self.assertEqual(self.git('rev-list', '--count', 'HEAD'), '3')
        self.assertNotIn('placeholder_', self.git('log', '--format=%s'))

    def test_offline_earlier_push_does_not_block_later_title_or_push(self):
        first = self.queue(message='', push=True)
        (self.repo / 'story.txt').write_text('Second snapshot\n')
        self.git('add', 'story.txt')
        second = self.queue(message='', push=True)
        (self.root / 'remote').rename(self.root / 'offline')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 First final title', '')):
            worker.work(first)
        self.assertEqual(self.job(first)['phase'], 'pushing')
        (self.root / 'offline').rename(self.root / 'remote')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Second final title', '')):
            worker.work(second)
        self.assertEqual(self.job(second)['phase'], 'done')
        worker.work(first)
        self.assertEqual(self.job(first)['phase'], 'done')
        self.assertFalse((self.repo / '.git' / worker.MARKER).exists())
        remote_tip = self.git('--git-dir=' + str(self.root / 'remote'), 'rev-parse', 'refs/heads/main')
        self.assertEqual(remote_tip, self.git('rev-parse', 'HEAD'))
        self.assertNotIn('placeholder_', self.git('log', '--format=%s', remote_tip))

    def test_inflight_older_worker_can_recover_after_a_new_placeholder(self):
        first = self.queue(message='')
        (self.repo / 'story.txt').write_text('Second snapshot\n')
        self.git('add', 'story.txt')
        second = self.queue(message='')
        job = self.job(first)
        job.update(phase='blocked', message='🧪 Preserve already generated title',
                   error='The branch advanced; message finalization was paused.')
        worker.write_journal(first / 'job.json', job)
        with patch.object(worker.core, 'generate_message', side_effect=AssertionError('Reuse completed generation')):
            worker.work(first)
        self.assertEqual(self.job(first)['phase'], 'done')
        self.assertEqual(self.git('log', '-1', '--format=%s', self.job(first)['sha']), '🧪 Preserve already generated title')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Finish second title', '')):
            worker.work(second)
        self.assertEqual(self.job(second)['phase'], 'done')

    def test_cancelling_an_ancestor_finalizes_it_locally_before_releasing_descendants(self):
        first = self.queue(message='', push=True)
        (self.repo / 'story.txt').write_text('Second snapshot\n')
        self.git('add', 'story.txt')
        second = self.queue(message='', push=True)
        with patch.object(worker.core, 'fallback_message', return_value=('🧪 Retain cancelled local snapshot', '')):
            worker.control('cancel')
        self.assertEqual(self.job(first)['phase'], 'cancelled')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Finish descendant', '')):
            worker.work(second)
        self.assertEqual(self.job(second)['phase'], 'done')
        self.assertEqual(self.git('rev-list', '--count', 'HEAD'), '2')
        self.assertNotIn('placeholder_', self.git('log', '--format=%s'))

    def test_cancel_preserves_staging_and_releases_gate(self):
        directory = self.queue()
        tree = self.git('write-tree')
        worker.control('cancel')
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'cancelled')
        self.assertEqual(self.git('write-tree'), tree)
        self.assertFalse((self.repo / '.git' / worker.MARKER).exists())
        self.assertEqual(self.git('for-each-ref', 'refs/sweetiebot/jobs'), '')

    def test_restart_cleans_marker_after_completed_checkpoint(self):
        directory = self.queue()
        worker.work(directory)
        marker = self.repo / '.git' / worker.MARKER
        worker.write_journal(marker, {'id': directory.name, 'directory': str(directory)})
        worker.work(directory)
        self.assertFalse(marker.exists())
        self.assertEqual(self.git('rev-list', '--count', 'HEAD'), '1')

    def test_restart_recovers_preparing_checkpoint(self):
        directory = self.queue()
        job = self.job(directory)
        job['phase'] = 'preparing'
        job['enqueue_pid'] = 0
        worker.write_journal(directory / 'job.json', job)
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')

    def test_snapshot_is_protected_from_git_gc(self):
        directory = self.queue()
        tree = self.job(directory)['tree']
        self.assertEqual(self.git('rev-parse', 'refs/sweetiebot/jobs/' + directory.name), tree)
        (self.repo / 'story.txt').write_text('Newer staged version\n')
        self.git('add', 'story.txt')
        self.git('gc', '--prune=now')
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertEqual(self.git('show', 'HEAD:story.txt'), 'Captured change')

    def test_login_agent_runs_without_vscode_and_retries_periodically(self):
        import plistlib
        with patch.object(worker.sys, 'platform', 'darwin'), patch.object(Path, 'home', return_value=self.root), patch.object(worker.subprocess, 'run') as run:
            run.return_value.returncode = 1
            worker.install_agent(Path('/stable/runtime/background_commit.py'))
        agent = self.root / 'Library/LaunchAgents' / (worker.LABEL + '.plist')
        data = plistlib.loads(agent.read_bytes())
        self.assertTrue(data['RunAtLoad'])
        self.assertEqual(data['StartInterval'], 60)
        self.assertEqual(data['ProgramArguments'][1:], ['/stable/runtime/background_commit.py', '--resume'])


if __name__ == '__main__':
    unittest.main()
