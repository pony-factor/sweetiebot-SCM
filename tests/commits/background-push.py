"""Real Git checks for saved click-time commits and restartable publication."""

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

import json
import fcntl
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
import merged_branch



# Allow direct script execution as well as the CI unittest module runner.
_sb_root = str(_sb_path(__file__).resolve().parents[2])
if _sb_root not in _sb_sys.path:
    _sb_sys.path.insert(0, _sb_root)

from tests.fixtures.background_commit_support import BackgroundCommitFixture


class BackgroundCommitPushTests(BackgroundCommitFixture):
    def test_rejected_placeholder_keeps_staged_changes(self):
        hook = self.repo / '.git' / 'hooks' / 'pre-commit'
        hook.write_text('#!/bin/sh\nexit 1\n')
        hook.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, 'Git commit failed'):
            self.queue(message='')
        self.assertEqual(self.git('diff', '--cached', '--name-only'), 'story.txt')
        result = subprocess.run(['/usr/bin/git', 'rev-parse', '--verify', 'HEAD'], capture_output=True)
        self.assertNotEqual(result.returncode, 0)

    def test_next_attempt_replaces_rejected_snapshot_with_latest_staging(self):
        hook, failed = self.reject_initial_commit()
        captured = self.job(failed)['tree']
        (self.repo / 'story.txt').write_text('Latest reviewed change\n')
        self.git('add', 'story.txt')
        latest = self.git('write-tree')
        hook.unlink()
        replacement = self.queue()
        self.assertEqual(self.git('rev-parse', 'HEAD^{tree}'), latest)
        self.assertNotEqual(latest, captured)
        self.assertEqual(self.job(failed)['phase'], 'cancelled')
        self.assertTrue(self.job(failed)['superseded_uncommitted'])
        self.assertEqual(self.git('rev-parse', 'refs/sweetiebot/jobs/' + failed.name), captured)
        self.assertNotEqual(replacement, failed)

    def test_retrying_current_changes_does_not_bypass_rejecting_hook(self):
        _, failed = self.reject_initial_commit()
        with self.assertRaisesRegex(RuntimeError, 'commit hook rejected'):
            self.queue()
        self.assertEqual(self.job(failed)['phase'], 'cancelled')
        self.assertEqual(self.git('diff', '--cached', '--name-only'), 'story.txt')
        self.assertNotEqual(subprocess.run(['/usr/bin/git', 'rev-parse', '--verify', 'HEAD'],
                                          capture_output=True).returncode, 0)

    def test_cancelling_uncommitted_placeholder_preserves_files_and_index(self):
        _, failed = self.reject_initial_commit()
        captured = self.git('write-tree')
        (self.repo / 'story.txt').write_text('Later unstaged edits\n')
        worker.control('cancel')
        self.assertEqual(self.job(failed)['phase'], 'cancelled')
        self.assertEqual(self.git('write-tree'), captured)
        self.assertEqual((self.repo / 'story.txt').read_text(), 'Later unstaged edits\n')
        self.assertFalse((self.repo / '.git' / worker.MARKER).exists())

    def test_failed_job_is_not_retired_after_branch_moves(self):
        hook, failed = self.reject_initial_commit()
        hook.unlink()
        self.git('commit', '-qm', 'External commit')
        with worker.repository_lock(self.repo / '.git'):
            worker.retire_failed_uncommitted_job(self.repo / '.git', 'refs/heads/main', self.git('rev-parse', 'HEAD'))
        self.assertEqual(self.job(failed)['phase'], 'blocked')

    def test_failed_job_is_not_retired_while_worker_is_active(self):
        _, failed = self.reject_initial_commit()
        with (failed / 'worker.lock').open('a+b') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with worker.repository_lock(self.repo / '.git'):
                worker.retire_failed_uncommitted_job(self.repo / '.git', 'refs/heads/main', '')
        self.assertEqual(self.job(failed)['phase'], 'blocked')

    def test_failed_job_with_recorded_commit_is_not_retired(self):
        hook, failed = self.reject_initial_commit()
        hook.unlink()
        self.git('commit', '-qm', 'Existing commit')
        sha = self.git('rev-parse', 'HEAD')
        job = self.job(failed)
        job.update(sha=sha, parent=sha)
        worker.write_journal(failed / 'job.json', job)
        with worker.repository_lock(self.repo / '.git'):
            worker.retire_failed_uncommitted_job(self.repo / '.git', 'refs/heads/main', sha)
        self.assertEqual(self.job(failed)['phase'], 'blocked')
        self.assertEqual(self.git('rev-parse', 'HEAD'), sha)

    def test_gui_commit_finds_hook_tools_without_changing_parent_environment(self):
        home = self.root / 'home'
        tools = home / '.local/bin'
        tools.mkdir(parents=True)
        tool = tools / 'sweetiebot-test-hook-tool'
        tool.write_text('#!/bin/sh\nexit 0\n')
        tool.chmod(0o755)
        hook = self.repo / '.git/hooks/pre-commit'
        hook.write_text('#!/bin/sh\nsweetiebot-test-hook-tool\n')
        hook.chmod(0o755)
        with patch.dict(os.environ, {'PATH': '/usr/bin:/bin'}), patch.object(worker.Path, 'home', return_value=home):
            directory = self.queue()
            self.assertEqual(os.environ['PATH'], '/usr/bin:/bin')
        self.assertTrue(self.job(directory).get('sha'))

    def test_hook_environment_preserves_existing_tool_precedence(self):
        home = self.root / 'home'
        tools = home / '.local/bin'
        tools.mkdir(parents=True)
        current = str(tools) + os.pathsep + '/usr/bin:/bin'
        with patch.dict(os.environ, {'PATH': current}), patch.object(worker.Path, 'home', return_value=home):
            result = worker.commit_hook_environment()
        self.assertTrue(result['PATH'].startswith(current))
        self.assertEqual(result['PATH'].split(os.pathsep).count(str(tools)), 1)

    def test_missing_push_hook_tool_has_actionable_error(self):
        result = subprocess.CompletedProcess([], 1, '', '.husky/pre-push: line 1: pnpm: command not found')
        message = worker.permanent_push_error({}, result)
        self.assertIn('Skip Git hooks', message)
        self.assertNotIn('line 1', message)

    def test_commit_failure_diagnostics_classify_without_exposing_hook_output(self):
        cases = [
            ('error: gpg failed to sign the data', 'Commit signing failed'),
            ('.husky/pre-commit: pnpm: command not found', 'could not find Node'),
            ('Author identity unknown', 'author identity is missing'),
            ("Unable to create index.lock: File exists", 'index is locked'),
            ('husky - pre-commit script failed', 'commit hook rejected'),
            ('arbitrary hook output', 'Check the repository commit hooks'),
        ]
        for output, expected in cases:
            with self.subTest(output=output):
                result = subprocess.CompletedProcess([], 1, stdout='private fixture text', stderr=output)
                message = worker.commit_failure_message(result)
                self.assertIn(expected, message)
                self.assertIn('exit 1', message)
                self.assertNotIn('private fixture text', message)
                self.assertNotIn('arbitrary hook output', message)

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

    def test_remote_branch_namespace_collision_blocks_push_without_retry(self):
        # Git cannot create remote "fix" while "fix/..." already exists.
        self.git('checkout', '-q', '-b', 'fix')
        directory = self.queue(push=True)
        sha = self.git('rev-parse', 'HEAD')
        nested = 'refs/heads/fix/efs-repository-relative-copy-links-20261024'
        self.git('push', '-q', 'origin', f'HEAD:{nested}')
        worker.work(directory)
        job = self.job(directory)
        self.assertEqual(job['phase'], 'blocked')
        self.assertIn('conflicts with an existing remote branch name', job['error'])
        self.assertIn('Stop background push', job['error'])
        self.assertEqual(self.git('rev-parse', 'HEAD'), sha)
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'),
                                  'rev-parse', nested), sha)
        self.assertNotIn('refs/heads/fix\n', self.git('--git-dir=' + str(self.root / 'remote'),
                                                     'for-each-ref', '--format=%(refname)') + '\n')
        status = json.loads(subprocess.check_output(
            [sys.executable, worker.__file__, '--status'], text=True))
        self.assertEqual(status['phase'], 'blocked')
        self.assertFalse(status['pushPending'])
        worker.work(directory)
        self.assertEqual(self.job(directory), job, 'Blocked ref conflicts are not retried')

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

    def test_rejected_push_reports_binary_merge_conflicts(self):
        self.check_divergent_push(conflict=True)

    def test_rejected_push_reports_clean_divergence(self):
        self.check_divergent_push(conflict=False)

    def test_git_merges_clean_divergence_and_pushes(self):
        self.check_divergent_push(conflict=False, dirty=False)

    def test_git_merges_all_finalized_queued_descendants(self):
        self.check_divergent_push(conflict=False, dirty=False, descendants=True)

    def test_git_recovery_does_not_push_a_local_only_descendant(self):
        self.check_divergent_push(conflict=False, dirty=False, local_only_descendant=True)

    def test_git_recovery_does_not_combine_different_push_destinations(self):
        self.check_divergent_push(conflict=False, dirty=False, different_destination=True)

    def test_git_recovers_checkout_before_ref_move(self):
        self.check_divergent_push(conflict=False, dirty=False, crash='before-ref')

    def test_git_recovers_ref_move_before_job_checkpoint(self):
        self.check_divergent_push(conflict=False, dirty=False, crash='after-ref')

    def test_git_preserves_signed_commits(self):
        self.check_divergent_push(conflict=False, dirty=False, signed=True)

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

    def test_switched_branch_keeps_running_and_pushes_captured_ref(self):
        self.git('commit', '-q', '-m', 'Base')
        self.git('branch', 'other')
        (self.repo / 'story.txt').write_text('Queued main change\n')
        self.git('add', 'story.txt')
        directory = self.queue(message='', push=True)
        self.git('switch', '-q', 'other')
        other = self.git('rev-parse', 'HEAD')
        (self.repo / 'story.txt').write_text('Other staged work\n')
        self.git('add', 'story.txt')
        (self.repo / 'draft.txt').write_text('Untracked other work\n')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Finish original branch', '')):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertEqual(self.git('branch', '--show-current'), 'other')
        self.assertEqual(self.git('rev-parse', 'HEAD'), other)
        self.assertEqual(self.git('show', ':story.txt'), 'Other staged work')
        self.assertEqual((self.repo / 'draft.txt').read_text(), 'Untracked other work\n')
        self.assertEqual(self.git('log', '-1', '--format=%s', 'main'), '🧪 Finish original branch')
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'rev-parse', 'main'), self.git('rev-parse', 'main'))
        self.assertEqual(self.git('config', 'branch.main.merge'), 'refs/heads/main')
        self.assertNotEqual(subprocess.run(['/usr/bin/git', 'config', 'branch.other.remote'], capture_output=True).returncode, 0)

    def test_each_branch_has_its_own_pending_chain_and_push(self):
        self.git('commit', '-q', '-m', 'Base')
        self.git('branch', 'other')
        (self.repo / 'story.txt').write_text('Main snapshot\n')
        self.git('add', 'story.txt')
        first = self.queue(message='', push=True)
        self.git('switch', '-q', 'other')
        (self.repo / 'story.txt').write_text('Other snapshot\n')
        self.git('add', 'story.txt')
        second = self.queue(message='', push=True)
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Finish other branch', '')):
            worker.work(second)
        self.assertEqual(self.job(second)['phase'], 'done')
        self.assertTrue(self.job(first)['provisional'])
        other = self.git('rev-parse', 'HEAD')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Finish main branch', '')):
            worker.work(first)
        self.assertEqual(self.job(first)['phase'], 'done')
        self.assertEqual(self.git('rev-parse', 'HEAD'), other)
        for branch in ('main', 'other'):
            self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'rev-parse', branch), self.git('rev-parse', branch))
        self.assertFalse((self.repo / '.git' / worker.MARKER).exists())

    def test_changed_inactive_branch_still_blocks_publication(self):
        self.git('commit', '-q', '-m', 'Base')
        self.git('branch', 'other')
        (self.repo / 'story.txt').write_text('Queued snapshot\n')
        self.git('add', 'story.txt')
        directory = self.queue(message='', push=True)
        self.git('switch', '-q', 'other')
        self.git('branch', '-f', 'main', 'other')
        with patch.object(worker.core, 'generate_message', side_effect=AssertionError('Changed ref')):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'for-each-ref'), '')

    def test_old_worker_branch_change_error_recovers_on_original_ref(self):
        self.git('commit', '-q', '-m', 'Base')
        self.git('branch', 'other')
        (self.repo / 'story.txt').write_text('Queued snapshot\n')
        self.git('add', 'story.txt')
        directory = self.queue(message='', push=True)
        job = self.job(directory)
        job.update(phase='blocked', error='The branch changed; background work was paused.')
        worker.write_journal(directory / 'job.json', job)
        self.git('switch', '-q', 'other')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Recover original branch', '')):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertEqual(self.git('branch', '--show-current'), 'other')
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'rev-parse', 'main'), self.git('rev-parse', 'main'))

    def test_switch_during_detached_generation_finishes_original_push(self):
        self.git('commit', '-q', '-m', 'Base')
        self.git('branch', 'other')
        (self.repo / 'story.txt').write_text('Queued snapshot\n')
        self.git('add', 'story.txt')
        directory = self.queue(message='', push=True)
        started, release = self.root / 'started', self.root / 'release'
        script = """
import sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import importaliases
importaliases.install()
import background_commit as worker
def generate(*args, **kwargs):
    Path(sys.argv[3]).touch()
    deadline = time.monotonic() + 15
    while not Path(sys.argv[4]).exists():
        if time.monotonic() > deadline: raise RuntimeError('Test timed out')
        time.sleep(.02)
    return '🧪 Finish detached original push', ''
worker.core.generate_message = generate
worker.work(Path(sys.argv[2]))
"""
        child = subprocess.Popen([sys.executable, '-c', script, str(Path(worker.__file__).parent), str(directory), str(started), str(release)])
        try:
            deadline = time.monotonic() + 10
            while not started.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(started.exists())
            subprocess.run([sys.executable, str(Path(worker.__file__).with_name('ai-commit.py')), 'switch', 'other'], check=True, capture_output=True)
            self.assertIsNone(child.poll())
            other = self.git('rev-parse', 'HEAD')
            release.touch()
            self.assertEqual(child.wait(timeout=15), 0)
            self.assertEqual(self.job(directory)['phase'], 'done')
            self.assertEqual(self.git('branch', '--show-current'), 'other')
            self.assertEqual(self.git('rev-parse', 'HEAD'), other)
            self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'rev-parse', 'main'), self.git('rev-parse', 'main'))
            self.assertEqual(self.git('log', '-1', '--format=%s', 'main'), '🧪 Finish detached original push')
        finally:
            release.touch()
            child.wait(timeout=15)

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
        for command in ('commit', 'reset'):
            result = subprocess.run([sys.executable, str(Path(worker.__file__).with_name('ai-commit.py')), command], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Commit & Push is still running', result.stderr)
        self.assertEqual(self.job(directory)['phase'], 'committed')

    def test_wrapper_allows_switch_and_checkout_while_push_is_pending(self):
        self.git('commit', '-q', '-m', 'Base')
        self.git('branch', 'other')
        (self.repo / 'story.txt').write_text('Queued main change\n')
        self.git('add', 'story.txt')
        directory = self.queue(push=True)
        script = str(Path(worker.__file__).with_name('ai-commit.py'))
        for args, expected in ((('switch', 'other'), 'other'), (('checkout', 'main'), 'main')):
            result = subprocess.run([sys.executable, script, *args], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.git('branch', '--show-current'), expected)
        result = subprocess.run([sys.executable, script, 'switch', '-c', 'copied'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git('branch', '--show-current'), 'copied')
        self.assertEqual(self.job(directory)['phase'], 'committed')

if __name__ == "__main__":
    unittest.main()
