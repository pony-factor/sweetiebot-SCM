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


class BackgroundCommitForkTests(BackgroundCommitFixture):
    def test_new_branch_can_follow_placeholder_or_use_completed_base(self):
        self.git('commit', '-q', '-m', 'Base')
        base = self.git('rev-parse', 'HEAD')
        (self.repo / 'story.txt').write_text('First pending change\n')
        self.git('add', 'story.txt')
        first = self.queue(message='')
        (self.repo / 'story.txt').write_text('Second pending change\n')
        self.git('add', 'story.txt')
        second = self.queue(message='')
        provisional = self.git('rev-parse', 'main')
        self.assertEqual(worker.completed_branch_base('/usr/bin/git', [], 'refs/heads/main'), base)
        script = str(Path(worker.__file__).with_name('ai-commit.py'))
        for flag, name in (('-b', 'checkout-copy'), ('-c', 'switch-copy')):
            command = 'checkout' if flag == '-b' else 'switch'
            result = subprocess.run([sys.executable, script, command, flag, name, base],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.git('rev-parse', 'HEAD'), base)
        result = subprocess.run([sys.executable, script, 'switch', '-c', 'unfinished', provisional],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git('rev-parse', 'HEAD'), provisional)
        self.assertEqual(self.git('rev-parse', 'main'), provisional)
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Complete queued change', '')):
            worker.work(first)
            worker.work(second)
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.git('rev-parse', 'main'))
        self.assertEqual(self.git('rev-parse', 'checkout-copy'), base)
        self.assertEqual(self.git('rev-parse', 'switch-copy'), base)
        self.assertNotEqual(self.git('rev-parse', 'main'), provisional)

    def test_pending_fork_worktree_preserves_main_and_tracks_finalized_base(self):
        first = self.queue(message='')
        destination = self.root / 'isolated-topic'
        before = (self.repo / 'story.txt').read_text()
        worker.fork_branch('main', 'isolated', 'refs/heads/main', str(destination))
        self.assertEqual(self.git('symbolic-ref', '--short', 'HEAD'), 'main')
        self.assertEqual((self.repo / 'story.txt').read_text(), before)
        (destination / 'story.txt').write_text('Independent topic edit\n')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Finish shared base', '')):
            worker.work(first)
        self.assertEqual(self.git('rev-parse', 'isolated'), self.git('rev-parse', 'main'))
        self.assert_no_placeholder_titles('isolated')
        self.assertEqual((destination / 'story.txt').read_text(), 'Independent topic edit\n')
        self.assertEqual((self.repo / 'story.txt').read_text(), before)

    def test_fork_descendants_wait_for_inherited_title_and_keep_staging(self):
        first = self.queue(message='', push=True)
        worker.fork_branch('main', 'fork', 'refs/heads/main')
        (self.repo / 'story.txt').write_text('Fork snapshot\n')
        self.git('add', 'story.txt')
        second = self.queue(message='', push=True)
        (self.repo / 'story.txt').write_text('Later staging\n')
        self.git('add', 'story.txt')
        (self.repo / 'draft.txt').write_text('Untracked draft\n')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Finish fork', '')):
            worker.work(second)
        self.assertEqual(self.job(second)['phase'], 'ready')
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'for-each-ref'), '')
        worker.fork_branch('fork', 'nested', 'refs/heads/fork')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Finish base', '')):
            worker.work(first)
            worker.work(second)
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.job(second)['sha'])
        self.assertEqual(self.git('rev-parse', 'HEAD^'), self.job(first)['sha'])
        self.assertEqual(self.git('rev-parse', 'fork'), self.git('rev-parse', 'nested'))
        self.assertEqual(self.git('show', ':story.txt'), 'Later staging')
        self.assertEqual(self.git('show', 'HEAD:story.txt'), 'Fork snapshot')
        self.assertEqual((self.repo / 'draft.txt').read_text(), 'Untracked draft\n')
        self.assert_no_placeholder_titles()
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'rev-parse', 'fork'), self.job(second)['sha'])

    def test_fork_recovery_moves_all_refs_after_interruption(self):
        first = self.queue(message='')
        worker.fork_branch('main', 'fork', 'refs/heads/main')
        recover = worker.recover_finalization
        def interrupted(meta):
            transaction = worker.read_journal(Path(meta) / worker.TRANSACTION)
            if not transaction:
                return recover(meta)
            raise OSError('Interrupted before ref transaction')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Finish base', '')), patch.object(worker, 'recover_finalization', side_effect=interrupted):
            worker.work(first)
        self.assertTrue((self.repo / '.git' / worker.TRANSACTION).exists())
        worker.work(first)
        self.assertEqual(self.job(first)['phase'], 'done')
        self.assertEqual(self.git('rev-parse', 'main'), self.git('rev-parse', 'fork'))

    def test_fork_ref_rejects_changed_tip_without_overwriting_it(self):
        first = self.queue(message='')
        worker.fork_branch('main', 'fork', 'refs/heads/main')
        self.git('checkout', 'main')
        recover = worker.recover_finalization
        # Use a valid alternate commit, then change the fork between preparation
        # and recovery to exercise compare-and-swap protection.
        alternate = self.git('commit-tree', 'HEAD^{tree}', input='Alternate\n')
        def changed(meta):
            transaction = worker.read_journal(Path(meta) / worker.TRANSACTION)
            if transaction:
                self.git('update-ref', 'refs/heads/fork', alternate)
            return recover(meta)
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Finish base', '')), patch.object(worker, 'recover_finalization', side_effect=changed):
            worker.work(first)
        self.assertEqual(self.job(first)['phase'], 'blocked')
        self.assertEqual(self.git('rev-parse', 'fork'), alternate)
        self.assertEqual(self.git('rev-parse', 'main'), self.job(first)['sha'])

    def test_fork_completed_main_while_unrelated_branch_is_generating(self):
        self.git('commit', '-q', '-m', 'Base')
        base = self.git('rev-parse', 'HEAD')
        self.git('switch', '-q', '-c', 'night-shade')
        (self.repo / 'story.txt').write_text('Pending night-shade change\n')
        self.git('add', 'story.txt')
        directory = self.queue(message='')
        pending = self.git('rev-parse', 'HEAD')
        script = str(Path(worker.__file__).with_name('ai-commit.py'))
        for args in [('checkout', '-b', 'named-copy', 'main'),
                     ('switch', '-c', 'implicit-copy')]:
            result = subprocess.run([sys.executable, script, *args], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.git('rev-parse', 'HEAD'), base)
        result = subprocess.run([sys.executable, script, 'switch', '-c', 'unsafe', 'night-shade'],
                                capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.git('rev-parse', 'night-shade'), pending)
        self.assertTrue(self.job(directory)['provisional'])

    def test_no_completed_base_for_an_unfinished_initial_commit(self):
        self.queue(message='')
        with self.assertRaisesRegex(RuntimeError, 'no completed commit'):
            worker.completed_branch_base('/usr/bin/git', [], 'refs/heads/main')

    def test_copied_placeholder_without_a_job_record_uses_completed_parent(self):
        self.git('commit', '-q', '-m', 'Base')
        base = self.git('rev-parse', 'HEAD')
        self.git('commit', '--allow-empty', '-q', '-m', 'placeholder_123456789AB')
        self.assertEqual(worker.completed_branch_base('/usr/bin/git', [], 'main'), base)
        self.git('commit', '--allow-empty', '-q', '-m', worker.get_placeholder_prefix() + '123456789AB')
        self.assertEqual(worker.completed_branch_base('/usr/bin/git', [], 'main'), base)
        self.git('commit', '--allow-empty', '-q', '-m', 'Later completed message')
        self.assertEqual(worker.completed_branch_base('/usr/bin/git', [], 'main'), base)

    def test_manual_push_is_durable_and_waits_for_generation(self):
        directory = self.queue(message='', push=False)
        provisional = self.git('rev-parse', 'HEAD')
        self.assertEqual(worker.request_push({'remote': 'origin', 'branch': 'main'}, start=False), {'queued': True})
        self.assertTrue(self.job(directory)['push'])
        self.assertEqual(self.git('rev-parse', 'HEAD'), provisional)
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'for-each-ref'), '')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Send finalized commit', '')):
            worker.work(directory)
        remote = self.git('--git-dir=' + str(self.root / 'remote'), 'rev-parse', 'refs/heads/main')
        self.assertEqual(remote, self.git('rev-parse', 'HEAD'))
        self.assertNotEqual(remote, provisional)
        self.assertEqual(self.git('log', '-1', '--format=%s', remote), '🧪 Send finalized commit')

    def test_manual_push_rejects_a_different_destination(self):
        directory = self.queue(message='')
        with self.assertRaisesRegex(RuntimeError, 'different push'):
            worker.request_push({'remote': 'other'}, start=False)
        self.assertEqual(worker.request_push({'branch': 'other'}, start=False), {'queued': False})
        self.assertFalse(self.job(directory)['push'])

    def test_unrelated_branch_can_sync_commit_and_push_while_main_generates(self):
        self.git('commit', '-q', '-m', 'Base')
        base = self.git('rev-parse', 'HEAD')
        self.git('push', '-q', 'origin', 'main')
        self.git('branch', 'other')
        completed = self.git('commit-tree', self.git('rev-parse', 'HEAD^{tree}'), '-p', base, '-m', 'Completed update')
        self.git('update-ref', 'refs/heads/completed', completed)
        (self.repo / 'story.txt').write_text('Pending main work\n')
        self.git('add', 'story.txt')
        directory = self.queue(message='')
        pending = self.git('rev-parse', 'main')
        self.git('switch', '-q', 'other')
        script = os.environ.get('SWEETIEBOT_TEST_GIT_WRAPPER', str(Path(worker.__file__).with_name('ai-commit.py')))
        def run(*args):
            return subprocess.run([sys.executable, script, *args], capture_output=True, text=True, timeout=15)
        for args in [('merge', '--ff-only', 'completed')]:
            result = run(*args)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git('rev-parse', 'HEAD'), completed)
        (self.repo / 'other.txt').write_text('Independent work\n')
        self.git('add', 'other.txt')
        result = run('commit', '-m', 'Record independent work')
        self.assertEqual(result.returncode, 0, result.stderr)
        result = run('push', '-u', 'origin', 'other')
        self.assertEqual(result.returncode, 0, result.stderr)
        result = run('pull', '--ff-only', 'origin', 'other')
        self.assertEqual(result.returncode, 0, result.stderr)
        result = run('pull', '--ff-only', 'origin', 'main')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'rev-parse', 'other'),
                         self.git('rev-parse', 'other'))
        self.git('switch', '-q', 'main')
        result = run('push', 'origin', 'other')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.git('config', 'remote.origin.push', 'other:other')
        result = run('push', 'origin')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.job(directory)['push'], 'An unrelated configured push must not queue main')
        self.git('config', '--unset-all', 'remote.origin.push')
        self.git('switch', '-q', 'other')
        self.git('config', 'remote.origin.push', 'main:configured-copy')
        result = run('push', 'origin')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('still running', result.stderr)
        self.git('config', '--unset-all', 'remote.origin.push')
        self.git('tag', 'completed-tag', 'other')
        result = run('push', '--tags', 'origin')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.git('tag', 'pending-tag', 'main')
        result = run('push', '--tags', 'origin')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('still running', result.stderr)
        for args in [('merge', 'main'), ('push', '--all', 'origin'),
                     ('push', 'origin', 'other', 'main:pending-copy')]:
            result = run(*args)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('still running', result.stderr)
        self.assertEqual(self.git('rev-parse', 'main'), pending)
        self.assertTrue(self.job(directory)['provisional'])

    def test_completed_ancestor_with_pending_push_does_not_block_independent_descendants(self):
        self.git('commit', '-q', '-m', 'Base')
        (self.repo / 'story.txt').write_text('Completed title waiting for push\n')
        self.git('add', 'story.txt')
        directory = self.queue(message='Completed title', push=True)
        self.git('switch', '-q', '-c', 'other')
        worker.wait_for_background('/usr/bin/git', [])
        self.assertEqual(self.job(directory)['phase'], 'committed')

    def test_unrelated_commit_can_queue_while_lindsey_prepares_a_sync(self):
        self.git('commit', '-q', '-m', 'Base')
        base = self.git('rev-parse', 'HEAD')
        self.git('branch', 'other')
        (self.repo / 'story.txt').write_text('Main work\n')
        self.git('add', 'story.txt')
        first = self.queue(message='Completed main work', push=True)
        job = self.job(first)
        self.git('switch', '-q', 'other')
        (self.repo / 'other.txt').write_text('Other work\n')
        self.git('add', 'other.txt')
        lindsey = self.root / 'lindsey'
        (lindsey / 'scripts').mkdir(parents=True)
        (lindsey / 'scripts/sync-local.js').write_text('// Stubbed replay planner\n')
        real_run = subprocess.run
        queued = []
        def run(args, **kwargs):
            if args[0] != 'test-node':
                return real_run(args, **kwargs)
            # A different process must be able to acquire the shared queue lock.
            with (Path(job['gitdir']) / (worker.MARKER + '.lock')).open('a+b') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            queued.append(self.queue(message='Completed other work'))
            return subprocess.CompletedProcess(args, 0, json.dumps(dict(
                version=1, status='ready', before=job['sha'], onto=base, after=job['sha'], commits=[])), '')
        with patch.dict(os.environ, LINDSEY_SYNC_REPO=str(lindsey)), \
                patch.object(worker.shutil, 'which', return_value='test-node'), \
                patch.object(worker.subprocess, 'run', side_effect=run):
            self.assertTrue(worker.sync_with_lindsey(job, base))
        self.assertEqual(self.job(queued[0])['branch'], 'refs/heads/other')
        self.assertEqual(self.git('show', 'HEAD:other.txt'), 'Other work')
        self.assertEqual(self.git('rev-parse', 'main'), job['sha'])
        changed = self.git('commit-tree', job['tree'], '-p', job['sha'], '-m', 'Concurrent main update')
        def changed_run(args, **kwargs):
            if args[0] != 'test-node':
                return real_run(args, **kwargs)
            real_run(['/usr/bin/git', 'update-ref', 'refs/heads/main', changed, job['sha']], check=True)
            return subprocess.CompletedProcess(args, 0, json.dumps(dict(
                version=1, status='ready', before=job['sha'], onto=base, after=job['sha'], commits=[])), '')
        with patch.dict(os.environ, LINDSEY_SYNC_REPO=str(lindsey)), \
                patch.object(worker.shutil, 'which', return_value='test-node'), \
                patch.object(worker.subprocess, 'run', side_effect=changed_run):
            with self.assertRaisesRegex(RuntimeError, 'branch changed'):
                worker.sync_with_lindsey(job, base)
        self.assertEqual(self.git('rev-parse', 'main'), changed, 'A stale sync plan must not overwrite newer work')

    def test_linked_worktrees_are_independent_but_inherited_placeholders_are_guarded(self):
        self.git('commit', '-q', '-m', 'Base')
        linked = self.root / 'linked'
        self.git('worktree', 'add', '-q', '-b', 'other', str(linked))
        (self.repo / 'story.txt').write_text('Pending main work\n')
        self.git('add', 'story.txt')
        first = self.queue(message='')
        pending = self.git('rev-parse', 'main')
        script = os.environ.get('SWEETIEBOT_TEST_GIT_WRAPPER', str(Path(worker.__file__).with_name('ai-commit.py')))
        same_branch = self.root / 'same-branch'
        self.git('worktree', 'add', '-q', '--force', str(same_branch), 'main')
        (same_branch / 'same.txt').write_text('Related work\n')
        self.git('-C', str(same_branch), 'add', 'same.txt')
        background_script = os.environ.get('SWEETIEBOT_TEST_BACKGROUND_WORKER', worker.__file__)
        result = subprocess.run([sys.executable, background_script, '--enqueue'],
                                cwd=same_branch, input=json.dumps({'message': 'Related work'}),
                                capture_output=True, text=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('existing commit message', result.stderr)
        self.assertEqual(self.git('rev-parse', 'main'), pending)
        (linked / 'other.txt').write_text('Independent staged work\n')
        self.git('-C', str(linked), 'add', 'other.txt')
        result = subprocess.run([sys.executable, script, '-C', str(linked), 'commit', '-m', 'Other worktree work'],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        # Both directions discover pending work in sibling worktree metadata.
        previous = os.getcwd()
        try:
            os.chdir(linked)
            (linked / 'other.txt').write_text('Queued independent work\n')
            self.git('add', 'other.txt')
            second = self.queue(message='')
            worker.wait_for_background('/usr/bin/git', [], refs=['refs/heads/completed-missing'])
            with self.assertRaisesRegex(RuntimeError, 'still running'):
                worker.wait_for_background('/usr/bin/git', [], refs=['refs/heads/main'])
        finally:
            os.chdir(previous)
        with self.assertRaisesRegex(RuntimeError, 'still running'):
            worker.wait_for_background('/usr/bin/git', [], refs=['refs/heads/other'])
        self.git('branch', 'inherited', pending)
        self.git('switch', '-q', 'inherited')
        with self.assertRaisesRegex(RuntimeError, 'still running'):
            worker.wait_for_background('/usr/bin/git', [])
        self.assertTrue(self.job(first)['provisional'])
        self.assertTrue(self.job(second)['provisional'])

if __name__ == "__main__":
    unittest.main()
