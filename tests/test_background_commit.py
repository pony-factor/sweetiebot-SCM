"""Real Git checks for saved click-time commits and restartable publication."""
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

    def published_blocked_job(self):
        directory = self.queue(push=True)
        self.git('commit', '--allow-empty', '-qm', 'External follow-up')
        self.git('push', '-q', 'origin', 'main')
        job = self.job(directory)
        job.update(phase='blocked', error='The branch advanced outside the queued commits; background work was paused.')
        worker.write_journal(directory / 'job.json', job)
        return directory

    def test_durable_commit_rejects_changed_stage_after_approved_preflight(self):
        """A cheap tree comparison must guard the one size inspection."""
        approved_tree = self.git('write-tree')
        self.assertRegex(approved_tree, r'^[0-9a-f]{40,64}
        first = self.queue(push=True)
        self.git('branch', 'side')
        (self.repo / 'story.txt').write_text('Second change\n')
        self.git('add', 'story.txt')
        second = self.queue(push=True)
        self.git('checkout', '-q', 'side')
        self.git('commit', '--allow-empty', '-qm', 'External side change')
        self.git('checkout', '-q', 'main')
        self.git('merge', '--no-ff', '-qm', 'External reconciliation', 'side')
        self.git('push', '-q', 'origin', 'main')
        for directory in (first, second):
            job = self.job(directory)
            job.update(phase='blocked', error='The branch advanced outside the queued commits; background work was paused.')
            worker.write_journal(directory / 'job.json', job)
        (self.repo / 'story.txt').write_text('Staged work\n')
        self.git('add', 'story.txt')
        (self.repo / 'story.txt').write_text('Unstaged work\n')
        before = [self.git('rev-parse', 'HEAD'), self.git('write-tree'), self.git('diff')]
        status = json.loads(subprocess.check_output([sys.executable, worker.__file__, '--status'], text=True))
        self.assertFalse(status.get('id'))
        self.assertEqual([self.job(d)['phase'] for d in (first, second)], ['done', 'done'])
        self.assertEqual(before, [self.git('rev-parse', 'HEAD'), self.git('write-tree'), self.git('diff')])
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.git('ls-remote', 'origin', 'refs/heads/main').split()[0])
        worker.wait_for_background('/usr/bin/git', [])

    def test_stale_tracking_ref_cannot_release_unpublished_job(self):
        directory = self.published_blocked_job()
        parent = self.job(directory)['sha']
        # Tracking says published, but the real destination no longer includes it.
        self.git('checkout', '--orphan', 'unrelated')
        self.git('commit', '-qm', 'Unrelated history')
        other = self.git('rev-parse', 'HEAD')
        self.git('push', '-q', 'origin', 'HEAD:refs/heads/unrelated')
        self.git('checkout', '-q', 'main')
        self.git('--git-dir=' + str(self.root / 'remote'), 'update-ref', 'refs/heads/main', other)
        worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        self.assertEqual(self.git('rev-parse', 'refs/remotes/origin/main'), self.git('rev-parse', 'HEAD'))
        self.assertNotEqual(parent, other)

    def test_provisional_and_active_jobs_are_not_retired(self):
        directory = self.published_blocked_job()
        job = self.job(directory)
        job['provisional'] = True
        worker.write_journal(directory / 'job.json', job)
        worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        job['provisional'] = False
        worker.write_journal(directory / 'job.json', job)
        with (directory / 'worker.lock').open('a+b') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            worker.reconcile_published_jobs(self.repo / '.git')
            self.assertEqual(self.job(directory)['phase'], 'blocked')

    def test_offline_check_preserves_pause_and_worker_recovers_when_published(self):
        directory = self.published_blocked_job()
        original = worker.git
        def offline(*args, **kwargs):
            if args[0] == 'ls-remote':
                raise subprocess.TimeoutExpired(args, 3)
            return original(*args, **kwargs)
        with patch.object(worker, 'git', side_effect=offline):
            worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')

    def test_background_gate_clears_published_job(self):
        directory = self.published_blocked_job()
        worker.wait_for_background('/usr/bin/git', [])
        self.assertEqual(self.job(directory)['phase'], 'done')

    def test_published_job_removed_from_local_branch_stays_blocked(self):
        directory = self.published_blocked_job()
        self.git('checkout', '--orphan', 'replacement')
        self.git('commit', '-qm', 'Replacement history')
        self.git('branch', '-f', 'main', 'HEAD')
        worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'blocked')

    def test_pending_finalization_transaction_prevents_cleanup(self):
        directory = self.published_blocked_job()
        (self.repo / '.git' / worker.TRANSACTION).write_text('{}')
        worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'blocked')

    def test_resume_skips_gitdir_replaced_by_worktree_pointer(self):
        stale = self.root / 'jobs' / 'stale'
        stale.mkdir(parents=True)
        pointer = self.root / 'old.git'
        pointer.write_text('gitdir: /relocated/worktree\n')
        (stale / 'job.json').write_text(json.dumps({'gitdir': str(pointer)}))
        directory = self.queue()
        meta = self.job(directory)['gitdir']
        # Visit the obsolete record first, as in the affected runtime.
        journals = [stale / 'job.json', directory / 'job.json']
        for parallel in (True, False):
            with self.subTest(parallel=parallel), \
                    patch.object(Path, 'glob', return_value=iter(journals)), \
                    patch.object(worker, 'drain_parallel') as drain, \
                    patch.object(worker, 'work') as work:
                worker.resume(parallel=parallel)
                if parallel:
                    drain.assert_called_once_with(meta)
                else:
                    work.assert_called_once_with(directory)

    def test_merged_branch_is_blocked_before_background_push(self):
        directory = self.queue(push=True)
        info = {'branch': 'main', 'number': 61, 'defaultBranch': 'main', 'remote': 'origin'}
        with patch.object(merged_branch, 'require_unmerged', side_effect=merged_branch.MergedBranchPush(info)):
            worker.work(directory)
        job = self.job(directory)
        self.assertEqual(job['phase'], 'blocked')
        self.assertFalse(job['push'])
        self.assertEqual(job['mergedBranch'], info)
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'for-each-ref'), '')

    def test_status_tracks_title_jobs_independently_of_pending_push(self):
        first = self.queue(push=True)
        (self.repo / 'story.txt').write_text('Second change\n')
        self.git('add', 'story.txt')
        second = self.queue(message='')
        command = [sys.executable, worker.__file__, '--status']
        status = json.loads(subprocess.check_output(command, text=True))
        self.assertEqual(status['id'], first.name)
        self.assertEqual(status['titleJobs'], [second.name])
        self.assertTrue(status['pushPending'])
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Apply final title', 'Explanation')):
            worker.work(second)
        status = json.loads(subprocess.check_output(command, text=True))
        self.assertEqual(status['id'], first.name)
        self.assertEqual(status['titleJobs'], [])
        self.assertTrue(status['pushPending'])

    def test_push_title_status_covers_generation_and_clears_when_paused(self):
        directory = self.queue(message='', push=False)
        command = [sys.executable, worker.__file__, '--status']
        status = lambda: json.loads(subprocess.check_output(command, text=True))
        self.assertFalse(status()['pushPending'], 'commit-only naming is not pushing')
        job = self.job(directory)
        job['push'] = True
        for phase, expected in [('generating', True), ('finalizing', True), ('pushing', True),
                                ('blocked', False), ('done', False), ('cancelled', False)]:
            with self.subTest(phase=phase):
                job['phase'] = phase
                if phase == 'blocked':
                    job['error'] = 'Push needs attention'
                worker.write_journal(directory / 'job.json', job)
                self.assertEqual(status()['pushPending'], expected)

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

    def enable_test_gpg_signing(self):
        """Create an ephemeral local GPG identity without touching user keys."""
        import shutil
        gpg = shutil.which('gpg')
        if not gpg:
            self.skipTest('GPG is unavailable')
        home = self.root / 'gnupg'
        home.mkdir(mode=0o700)
        os.environ['GNUPGHOME'] = str(home)
        subprocess.run([gpg, '--batch', '--pinentry-mode', 'loopback',
                        '--passphrase', '', '--quick-generate-key',
                        'Test Author <test@example.invalid>', 'ed25519', 'sign', '0'],
                       check=True, capture_output=True, text=True, timeout=60)
        self.git('config', 'gpg.program', gpg)
        self.git('config', 'user.signingkey', 'test@example.invalid')
        self.git('config', 'commit.gpgsign', 'true')

    def assert_signed(self, revision):
        headers = self.git('cat-file', '-p', revision).partition('\n\n')[0]
        self.assertTrue(any(line.startswith('gpgsig ') for line in headers.splitlines()))
        self.git('verify-commit', revision)

    def test_default_git_gpg_signing_survives_generated_title_and_push(self):
        self.enable_test_gpg_signing()
        directory = self.queue(message='', push=True)
        provisional = self.git('rev-parse', 'HEAD')
        self.assertFalse(self.job(directory)['sign'], 'No explicit sign flag was passed')
        self.assert_signed('HEAD')
        with patch.object(worker.core, 'generate_message',
                          return_value=('🧪 Keep the local GPG signature', '')):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertNotEqual(self.git('rev-parse', 'HEAD'), provisional)
        self.assert_signed('HEAD')
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'),
                                  'rev-parse', 'refs/heads/main'), self.git('rev-parse', 'HEAD'))

    def test_signed_descendants_are_resigned_when_earlier_title_changes(self):
        self.enable_test_gpg_signing()
        first = self.queue(message='')
        (self.repo / 'story.txt').write_text('Second signed snapshot\n')
        self.git('add', 'story.txt')
        second = self.queue(message='🧪 Keep a signed descendant')
        previous_tip = self.git('rev-parse', 'HEAD')
        self.assert_signed('HEAD')
        # Signing follows the captured commits, not a later configuration change.
        self.git('config', 'commit.gpgsign', 'false')
        with patch.object(worker.core, 'generate_message',
                          return_value=('🧪 Finalize the signed ancestor', '')):
            worker.work(first)
        self.assertNotEqual(self.git('rev-parse', 'HEAD'), previous_tip)
        self.assert_signed('HEAD^')
        self.assert_signed('HEAD')
        self.assertEqual(self.git('log', '-1', '--format=%s'), '🧪 Keep a signed descendant')
        worker.work(second)
        self.assertEqual(self.job(second)['phase'], 'done')

    def test_failed_gpg_resigning_keeps_original_commit_and_blocks_push(self):
        self.enable_test_gpg_signing()
        directory = self.queue(message='', push=True)
        original = self.git('rev-parse', 'HEAD')
        self.git('config', 'gpg.program', str(self.root / 'missing-gpg'))
        with patch.object(worker.core, 'generate_message',
                          return_value=('🧪 Do not publish unsigned history', '')):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        self.assertEqual(self.git('rev-parse', 'HEAD'), original)
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'),
                                  'for-each-ref'), '')

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

    def check_divergent_push(self, conflict, dirty=True, descendants=False, crash=None, signed=False):
        lindsey = Path(os.environ.get('LINDSEY_SYNC_REPO', Path(__file__).resolve().parents[2] / 'lindsey-sync'))
        if not (lindsey / 'scripts/sync-local.js').is_file():
            self.skipTest('The local Lindsey Sync checkout is required for this integration check')
        self.env_lindsey = patch.dict(os.environ, {'LINDSEY_SYNC_REPO': str(lindsey)})
        self.env_lindsey.start()
        self.addCleanup(self.env_lindsey.stop)
        (self.repo / 'story.txt').write_bytes(b'base\x00binary\n')
        self.git('add', 'story.txt')
        self.git('commit', '-qm', 'Base')
        self.git('push', '-qu', 'origin', 'main')
        other = self.root / 'other'
        self.git('clone', '-q', '--branch', 'main', str(self.root / 'remote'), str(other))
        self.git('-C', str(other), 'config', 'user.name', 'Other Author')
        self.git('-C', str(other), 'config', 'user.email', 'other@example.invalid')
        path = other / ('story.txt' if conflict else 'remote.txt')
        path.write_bytes(b'remote\x00binary\n')
        self.git('-C', str(other), 'add', path.name)
        self.git('-C', str(other), 'commit', '-qm', 'Remote change')
        self.git('-C', str(other), 'push', '-q', 'origin', 'main')
        if signed:
            self.enable_test_gpg_signing()
        (self.repo / 'story.txt').write_bytes(b'local\x00binary\n')
        self.git('add', 'story.txt')
        directory = self.queue(push=True)
        second = None
        if descendants:
            (self.repo / 'next.txt').write_text('Next queued change\n')
            self.git('add', 'next.txt')
            second = self.queue(push=True)
        sha = self.git('rev-parse', 'HEAD')
        if dirty:
            (self.repo / 'story.txt').write_bytes(b'later staged\x00change\n')
            self.git('add', 'story.txt')
            (self.repo / 'story.txt').write_bytes(b'later unstaged\x00change\n')
        index = self.git('write-tree')
        if crash:
            original_git = worker.git
            def interrupted(*args, **kwargs):
                if args[:2] == ('update-ref', '-m') and (self.repo / '.git' / worker.TRANSACTION).exists():
                    if crash == 'after-ref':
                        original_git(*args, **kwargs)
                    raise OSError('Simulated sync interruption')
                return original_git(*args, **kwargs)
            with patch.object(worker, 'git', side_effect=interrupted):
                worker.work(directory)
            self.assertTrue((self.repo / '.git' / worker.TRANSACTION).exists())
        worker.work(directory)
        job = self.job(directory)
        if not conflict and not dirty:
            self.assertEqual(job['phase'], 'done')
            self.assertNotEqual(self.git('rev-parse', 'HEAD'), sha)
            self.assertEqual(self.git('status', '--porcelain'), '')
            self.assertEqual((self.repo / 'remote.txt').read_bytes(), b'remote\x00binary\n')
            self.assertEqual(self.git('rev-parse', 'HEAD:story.txt'), self.git('rev-parse', sha + ':story.txt'))
            self.assertEqual(self.git('show', 'refs/sweetiebot/recovery/' + directory.name + '/' + sha + ':story.txt'), 'local\x00binary')
            if second:
                worker.work(second)
                self.assertEqual(self.job(second)['phase'], 'done')
            remote = '--git-dir=' + str(self.root / 'remote')
            self.assertEqual(self.git(remote, 'rev-parse', 'refs/heads/main'), self.git('rev-parse', 'HEAD'))
            self.assertFalse((self.repo / '.git' / worker.MARKER).exists())
            if signed:
                self.assert_signed('HEAD')
            return
        self.assertEqual(job['phase'], 'blocked')
        expected = 'merge conflicts' if conflict else 'uncommitted changes'
        self.assertIn(expected, job['error'])
        self.assertIn('Lindsey', job['error'])
        if conflict:
            self.assertEqual(job['conflictPaths'], ['story.txt'])
            status = json.loads(subprocess.check_output([sys.executable, worker.__file__, '--status'], text=True))
            self.assertEqual(status['conflictPaths'], ['story.txt'])
            self.assertEqual(status['branch'], 'refs/heads/main')
        self.assertEqual(self.git('rev-parse', 'HEAD'), sha)
        self.assertEqual(self.git('write-tree'), index)
        if dirty:
            self.assertEqual((self.repo / 'story.txt').read_bytes(), b'later unstaged\x00change\n')
        self.assertFalse((self.repo / '.git' / 'MERGE_HEAD').exists())
        with self.assertRaisesRegex(RuntimeError, expected) as blocked:
            worker.wait_for_background('/usr/bin/git', [])
        self.assertIn('repo (main):', str(blocked.exception))
        with patch.object(worker, 'rejected_push_error', side_effect=AssertionError('Must not retry')):
            worker.work(directory)
        self.assertEqual(self.job(directory), job)

    def test_rejected_push_reports_binary_merge_conflicts(self):
        self.check_divergent_push(conflict=True)

    def test_rejected_push_reports_clean_divergence(self):
        self.check_divergent_push(conflict=False)

    def test_lindsey_rebases_clean_divergence_and_pushes(self):
        self.check_divergent_push(conflict=False, dirty=False)

    def test_lindsey_rebases_all_finalized_queued_descendants(self):
        self.check_divergent_push(conflict=False, dirty=False, descendants=True)

    def test_lindsey_recovers_checkout_before_ref_move(self):
        self.check_divergent_push(conflict=False, dirty=False, crash='before-ref')

    def test_lindsey_recovers_ref_move_before_job_checkpoint(self):
        self.check_divergent_push(conflict=False, dirty=False, crash='after-ref')

    def test_lindsey_preserves_signed_commits(self):
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
            subprocess.run([sys.executable, str(Path(worker.__file__).with_name('ai_commit.py')), 'switch', 'other'], check=True, capture_output=True)
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
            result = subprocess.run([sys.executable, str(Path(worker.__file__).with_name('ai_commit.py')), command], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Commit & Push is still running', result.stderr)
        self.assertEqual(self.job(directory)['phase'], 'committed')

    def test_wrapper_allows_switch_and_checkout_while_push_is_pending(self):
        self.git('commit', '-q', '-m', 'Base')
        self.git('branch', 'other')
        (self.repo / 'story.txt').write_text('Queued main change\n')
        self.git('add', 'story.txt')
        directory = self.queue(push=True)
        script = str(Path(worker.__file__).with_name('ai_commit.py'))
        for args, expected in ((('switch', 'other'), 'other'), (('checkout', 'main'), 'main')):
            result = subprocess.run([sys.executable, script, *args], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.git('branch', '--show-current'), expected)
        result = subprocess.run([sys.executable, script, 'switch', '-c', 'copied'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git('branch', '--show-current'), 'copied')
        self.assertEqual(self.job(directory)['phase'], 'committed')

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
        script = str(Path(worker.__file__).with_name('ai_commit.py'))
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
        self.assertNotIn('placeholder_', self.git('log', '--format=%s', 'isolated'))
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
        self.assertNotIn('placeholder_', self.git('log', '--format=%s'))
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
        script = str(Path(worker.__file__).with_name('ai_commit.py'))
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
        self.git('commit', '--allow-empty', '-q', '-m', 'placeholder_0123456789abcdef')
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
        script = os.environ.get('SWEETIEBOT_TEST_GIT_WRAPPER', str(Path(worker.__file__).with_name('ai_commit.py')))
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
        script = os.environ.get('SWEETIEBOT_TEST_GIT_WRAPPER', str(Path(worker.__file__).with_name('ai_commit.py')))
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

    def test_manual_coauthor_commit_queues_behind_generated_title(self):
        first = self.queue(message='', push=True)
        (self.repo / 'story.txt').write_text('Manual attributed change\n')
        self.git('add', 'story.txt')
        message = '🧪 Preserve manual subject\n\nCo-authored-by: Codex <noreply@openai.com>'
        second = self.queue(message=message, push=True)
        worker.work(second)
        self.assertEqual(self.job(second)['phase'], 'committed')
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'for-each-ref'), '')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Finish earlier title', '')):
            worker.work(first)
        worker.work(second)
        self.assertEqual(self.job(second)['phase'], 'done')
        self.assertEqual(self.git('log', '-1', '--format=%B'), message)
        remote = self.git('--git-dir=' + str(self.root / 'remote'), 'rev-parse', 'refs/heads/main')
        self.assertEqual(remote, self.git('rev-parse', 'HEAD'))
        self.assertNotIn('placeholder_', self.git('log', '--format=%s', remote))

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

    def test_scheduler_runs_six_jobs_before_starting_seventh(self):
        from types import SimpleNamespace
        entries = [{'id': str(i), 'directory': str(self.root / str(i))} for i in range(7)]
        jobs = {entry['id']: dict(entry, phase='committed', provisional=True,
                                branch='refs/heads/main', sha=entry['id']) for entry in entries}
        active, batches = [], []
        def launch(directory):
            child = SimpleNamespace(done=False)
            child.poll = lambda: 0 if child.done else None
            active.append(child)
            return child
        def tick(_seconds):
            running = [child for child in active if not child.done]
            batches.append(len(running))
            for child in running:
                child.done = True
        with patch.object(worker, 'queue_entries', return_value=entries), \
                patch.object(worker, 'read_journal', side_effect=lambda p: jobs[p.parent.name]), \
                patch.object(worker, 'launch_job', side_effect=launch), \
                patch.object(worker.time, 'sleep', side_effect=tick):
            worker.drain_parallel(str(self.repo / '.git'))
        self.assertEqual(batches, [6, 1])

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
        status = json.loads(subprocess.check_output([sys.executable, worker.__file__, '--status'], text=True))
        self.assertTrue(status['recoverable'])
        self.assertEqual(status['phase'], 'recovering')
        self.assertIn(first.name, status['titleJobs'])
        # An unqueued branch move must still surface the real conflict.
        self.git('update-ref', 'refs/heads/main', job['sha'])
        status = json.loads(subprocess.check_output([sys.executable, worker.__file__, '--status'], text=True))
        self.assertFalse(status.get('recoverable', False))
        self.git('update-ref', 'refs/heads/main', self.job(second)['sha'])
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
)
        (self.repo / 'later.txt').write_text('Not included in approval\\n')
        self.git('add', 'later.txt')
        staged_before = self.git('write-tree')
        self.assertNotEqual(approved_tree, staged_before)
        with self.assertRaisesRegex(RuntimeError, 'Staged changes changed'):
            worker.enqueue({
                'message': '🧪 Reject stale inspected tree',
                'expectedTree': approved_tree,
            }, start=False)
        self.assertEqual(self.git('write-tree'), staged_before,
                         'preflight failure must not change the staged contents')
        self.assertEqual(self.git('diff', '--cached', '--name-only'),
                         'later.txt\\nstory.txt')
        self.assertFalse((self.repo / '.git' / worker.MARKER).exists(),
                         'no placeholder should be enqueued after stale approval')
        self.assertEqual(self.git('rev-parse', '--verify', 'HEAD', check=False).returncode, 128)

    def test_durable_commit_accepts_the_matching_staged_tree(self):
        approved_tree = self.git('write-tree')
        directory = self.queue(expectedTree=approved_tree)
        self.assertEqual(self.job(directory)['tree'], approved_tree)
        self.assertNotEqual(self.git('rev-parse', 'HEAD'), '',
                            'the accepted tree must be committed locally')

    def test_durable_commit_rejects_invalid_preflight_tree_id(self):
        with self.assertRaisesRegex(ValueError, 'Invalid approved staged-tree'):
            worker.enqueue({
                'message': '🧪 Invalid preflight',
                'expectedTree': 'not-a-git-object',
            }, start=False)

    def test_status_retires_published_jobs_after_external_merge_without_touching_work(self):
        first = self.queue(push=True)
        self.git('branch', 'side')
        (self.repo / 'story.txt').write_text('Second change\n')
        self.git('add', 'story.txt')
        second = self.queue(push=True)
        self.git('checkout', '-q', 'side')
        self.git('commit', '--allow-empty', '-qm', 'External side change')
        self.git('checkout', '-q', 'main')
        self.git('merge', '--no-ff', '-qm', 'External reconciliation', 'side')
        self.git('push', '-q', 'origin', 'main')
        for directory in (first, second):
            job = self.job(directory)
            job.update(phase='blocked', error='The branch advanced outside the queued commits; background work was paused.')
            worker.write_journal(directory / 'job.json', job)
        (self.repo / 'story.txt').write_text('Staged work\n')
        self.git('add', 'story.txt')
        (self.repo / 'story.txt').write_text('Unstaged work\n')
        before = [self.git('rev-parse', 'HEAD'), self.git('write-tree'), self.git('diff')]
        status = json.loads(subprocess.check_output([sys.executable, worker.__file__, '--status'], text=True))
        self.assertFalse(status.get('id'))
        self.assertEqual([self.job(d)['phase'] for d in (first, second)], ['done', 'done'])
        self.assertEqual(before, [self.git('rev-parse', 'HEAD'), self.git('write-tree'), self.git('diff')])
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.git('ls-remote', 'origin', 'refs/heads/main').split()[0])
        worker.wait_for_background('/usr/bin/git', [])

    def test_stale_tracking_ref_cannot_release_unpublished_job(self):
        directory = self.published_blocked_job()
        parent = self.job(directory)['sha']
        # Tracking says published, but the real destination no longer includes it.
        self.git('checkout', '--orphan', 'unrelated')
        self.git('commit', '-qm', 'Unrelated history')
        other = self.git('rev-parse', 'HEAD')
        self.git('push', '-q', 'origin', 'HEAD:refs/heads/unrelated')
        self.git('checkout', '-q', 'main')
        self.git('--git-dir=' + str(self.root / 'remote'), 'update-ref', 'refs/heads/main', other)
        worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        self.assertEqual(self.git('rev-parse', 'refs/remotes/origin/main'), self.git('rev-parse', 'HEAD'))
        self.assertNotEqual(parent, other)

    def test_provisional_and_active_jobs_are_not_retired(self):
        directory = self.published_blocked_job()
        job = self.job(directory)
        job['provisional'] = True
        worker.write_journal(directory / 'job.json', job)
        worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        job['provisional'] = False
        worker.write_journal(directory / 'job.json', job)
        with (directory / 'worker.lock').open('a+b') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            worker.reconcile_published_jobs(self.repo / '.git')
            self.assertEqual(self.job(directory)['phase'], 'blocked')

    def test_offline_check_preserves_pause_and_worker_recovers_when_published(self):
        directory = self.published_blocked_job()
        original = worker.git
        def offline(*args, **kwargs):
            if args[0] == 'ls-remote':
                raise subprocess.TimeoutExpired(args, 3)
            return original(*args, **kwargs)
        with patch.object(worker, 'git', side_effect=offline):
            worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')

    def test_background_gate_clears_published_job(self):
        directory = self.published_blocked_job()
        worker.wait_for_background('/usr/bin/git', [])
        self.assertEqual(self.job(directory)['phase'], 'done')

    def test_published_job_removed_from_local_branch_stays_blocked(self):
        directory = self.published_blocked_job()
        self.git('checkout', '--orphan', 'replacement')
        self.git('commit', '-qm', 'Replacement history')
        self.git('branch', '-f', 'main', 'HEAD')
        worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'blocked')

    def test_pending_finalization_transaction_prevents_cleanup(self):
        directory = self.published_blocked_job()
        (self.repo / '.git' / worker.TRANSACTION).write_text('{}')
        worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'blocked')

    def test_resume_skips_gitdir_replaced_by_worktree_pointer(self):
        stale = self.root / 'jobs' / 'stale'
        stale.mkdir(parents=True)
        pointer = self.root / 'old.git'
        pointer.write_text('gitdir: /relocated/worktree\n')
        (stale / 'job.json').write_text(json.dumps({'gitdir': str(pointer)}))
        directory = self.queue()
        meta = self.job(directory)['gitdir']
        # Visit the obsolete record first, as in the affected runtime.
        journals = [stale / 'job.json', directory / 'job.json']
        for parallel in (True, False):
            with self.subTest(parallel=parallel), \
                    patch.object(Path, 'glob', return_value=iter(journals)), \
                    patch.object(worker, 'drain_parallel') as drain, \
                    patch.object(worker, 'work') as work:
                worker.resume(parallel=parallel)
                if parallel:
                    drain.assert_called_once_with(meta)
                else:
                    work.assert_called_once_with(directory)

    def test_merged_branch_is_blocked_before_background_push(self):
        directory = self.queue(push=True)
        info = {'branch': 'main', 'number': 61, 'defaultBranch': 'main', 'remote': 'origin'}
        with patch.object(merged_branch, 'require_unmerged', side_effect=merged_branch.MergedBranchPush(info)):
            worker.work(directory)
        job = self.job(directory)
        self.assertEqual(job['phase'], 'blocked')
        self.assertFalse(job['push'])
        self.assertEqual(job['mergedBranch'], info)
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'for-each-ref'), '')

    def test_status_tracks_title_jobs_independently_of_pending_push(self):
        first = self.queue(push=True)
        (self.repo / 'story.txt').write_text('Second change\n')
        self.git('add', 'story.txt')
        second = self.queue(message='')
        command = [sys.executable, worker.__file__, '--status']
        status = json.loads(subprocess.check_output(command, text=True))
        self.assertEqual(status['id'], first.name)
        self.assertEqual(status['titleJobs'], [second.name])
        self.assertTrue(status['pushPending'])
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Apply final title', 'Explanation')):
            worker.work(second)
        status = json.loads(subprocess.check_output(command, text=True))
        self.assertEqual(status['id'], first.name)
        self.assertEqual(status['titleJobs'], [])
        self.assertTrue(status['pushPending'])

    def test_push_title_status_covers_generation_and_clears_when_paused(self):
        directory = self.queue(message='', push=False)
        command = [sys.executable, worker.__file__, '--status']
        status = lambda: json.loads(subprocess.check_output(command, text=True))
        self.assertFalse(status()['pushPending'], 'commit-only naming is not pushing')
        job = self.job(directory)
        job['push'] = True
        for phase, expected in [('generating', True), ('finalizing', True), ('pushing', True),
                                ('blocked', False), ('done', False), ('cancelled', False)]:
            with self.subTest(phase=phase):
                job['phase'] = phase
                if phase == 'blocked':
                    job['error'] = 'Push needs attention'
                worker.write_journal(directory / 'job.json', job)
                self.assertEqual(status()['pushPending'], expected)

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

    def enable_test_gpg_signing(self):
        """Create an ephemeral local GPG identity without touching user keys."""
        import shutil
        gpg = shutil.which('gpg')
        if not gpg:
            self.skipTest('GPG is unavailable')
        home = self.root / 'gnupg'
        home.mkdir(mode=0o700)
        os.environ['GNUPGHOME'] = str(home)
        subprocess.run([gpg, '--batch', '--pinentry-mode', 'loopback',
                        '--passphrase', '', '--quick-generate-key',
                        'Test Author <test@example.invalid>', 'ed25519', 'sign', '0'],
                       check=True, capture_output=True, text=True, timeout=60)
        self.git('config', 'gpg.program', gpg)
        self.git('config', 'user.signingkey', 'test@example.invalid')
        self.git('config', 'commit.gpgsign', 'true')

    def assert_signed(self, revision):
        headers = self.git('cat-file', '-p', revision).partition('\n\n')[0]
        self.assertTrue(any(line.startswith('gpgsig ') for line in headers.splitlines()))
        self.git('verify-commit', revision)

    def test_default_git_gpg_signing_survives_generated_title_and_push(self):
        self.enable_test_gpg_signing()
        directory = self.queue(message='', push=True)
        provisional = self.git('rev-parse', 'HEAD')
        self.assertFalse(self.job(directory)['sign'], 'No explicit sign flag was passed')
        self.assert_signed('HEAD')
        with patch.object(worker.core, 'generate_message',
                          return_value=('🧪 Keep the local GPG signature', '')):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertNotEqual(self.git('rev-parse', 'HEAD'), provisional)
        self.assert_signed('HEAD')
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'),
                                  'rev-parse', 'refs/heads/main'), self.git('rev-parse', 'HEAD'))

    def test_signed_descendants_are_resigned_when_earlier_title_changes(self):
        self.enable_test_gpg_signing()
        first = self.queue(message='')
        (self.repo / 'story.txt').write_text('Second signed snapshot\n')
        self.git('add', 'story.txt')
        second = self.queue(message='🧪 Keep a signed descendant')
        previous_tip = self.git('rev-parse', 'HEAD')
        self.assert_signed('HEAD')
        # Signing follows the captured commits, not a later configuration change.
        self.git('config', 'commit.gpgsign', 'false')
        with patch.object(worker.core, 'generate_message',
                          return_value=('🧪 Finalize the signed ancestor', '')):
            worker.work(first)
        self.assertNotEqual(self.git('rev-parse', 'HEAD'), previous_tip)
        self.assert_signed('HEAD^')
        self.assert_signed('HEAD')
        self.assertEqual(self.git('log', '-1', '--format=%s'), '🧪 Keep a signed descendant')
        worker.work(second)
        self.assertEqual(self.job(second)['phase'], 'done')

    def test_failed_gpg_resigning_keeps_original_commit_and_blocks_push(self):
        self.enable_test_gpg_signing()
        directory = self.queue(message='', push=True)
        original = self.git('rev-parse', 'HEAD')
        self.git('config', 'gpg.program', str(self.root / 'missing-gpg'))
        with patch.object(worker.core, 'generate_message',
                          return_value=('🧪 Do not publish unsigned history', '')):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        self.assertEqual(self.git('rev-parse', 'HEAD'), original)
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'),
                                  'for-each-ref'), '')

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

    def check_divergent_push(self, conflict, dirty=True, descendants=False, crash=None, signed=False):
        lindsey = Path(os.environ.get('LINDSEY_SYNC_REPO', Path(__file__).resolve().parents[2] / 'lindsey-sync'))
        if not (lindsey / 'scripts/sync-local.js').is_file():
            self.skipTest('The local Lindsey Sync checkout is required for this integration check')
        self.env_lindsey = patch.dict(os.environ, {'LINDSEY_SYNC_REPO': str(lindsey)})
        self.env_lindsey.start()
        self.addCleanup(self.env_lindsey.stop)
        (self.repo / 'story.txt').write_bytes(b'base\x00binary\n')
        self.git('add', 'story.txt')
        self.git('commit', '-qm', 'Base')
        self.git('push', '-qu', 'origin', 'main')
        other = self.root / 'other'
        self.git('clone', '-q', '--branch', 'main', str(self.root / 'remote'), str(other))
        self.git('-C', str(other), 'config', 'user.name', 'Other Author')
        self.git('-C', str(other), 'config', 'user.email', 'other@example.invalid')
        path = other / ('story.txt' if conflict else 'remote.txt')
        path.write_bytes(b'remote\x00binary\n')
        self.git('-C', str(other), 'add', path.name)
        self.git('-C', str(other), 'commit', '-qm', 'Remote change')
        self.git('-C', str(other), 'push', '-q', 'origin', 'main')
        if signed:
            self.enable_test_gpg_signing()
        (self.repo / 'story.txt').write_bytes(b'local\x00binary\n')
        self.git('add', 'story.txt')
        directory = self.queue(push=True)
        second = None
        if descendants:
            (self.repo / 'next.txt').write_text('Next queued change\n')
            self.git('add', 'next.txt')
            second = self.queue(push=True)
        sha = self.git('rev-parse', 'HEAD')
        if dirty:
            (self.repo / 'story.txt').write_bytes(b'later staged\x00change\n')
            self.git('add', 'story.txt')
            (self.repo / 'story.txt').write_bytes(b'later unstaged\x00change\n')
        index = self.git('write-tree')
        if crash:
            original_git = worker.git
            def interrupted(*args, **kwargs):
                if args[:2] == ('update-ref', '-m') and (self.repo / '.git' / worker.TRANSACTION).exists():
                    if crash == 'after-ref':
                        original_git(*args, **kwargs)
                    raise OSError('Simulated sync interruption')
                return original_git(*args, **kwargs)
            with patch.object(worker, 'git', side_effect=interrupted):
                worker.work(directory)
            self.assertTrue((self.repo / '.git' / worker.TRANSACTION).exists())
        worker.work(directory)
        job = self.job(directory)
        if not conflict and not dirty:
            self.assertEqual(job['phase'], 'done')
            self.assertNotEqual(self.git('rev-parse', 'HEAD'), sha)
            self.assertEqual(self.git('status', '--porcelain'), '')
            self.assertEqual((self.repo / 'remote.txt').read_bytes(), b'remote\x00binary\n')
            self.assertEqual(self.git('rev-parse', 'HEAD:story.txt'), self.git('rev-parse', sha + ':story.txt'))
            self.assertEqual(self.git('show', 'refs/sweetiebot/recovery/' + directory.name + '/' + sha + ':story.txt'), 'local\x00binary')
            if second:
                worker.work(second)
                self.assertEqual(self.job(second)['phase'], 'done')
            remote = '--git-dir=' + str(self.root / 'remote')
            self.assertEqual(self.git(remote, 'rev-parse', 'refs/heads/main'), self.git('rev-parse', 'HEAD'))
            self.assertFalse((self.repo / '.git' / worker.MARKER).exists())
            if signed:
                self.assert_signed('HEAD')
            return
        self.assertEqual(job['phase'], 'blocked')
        expected = 'merge conflicts' if conflict else 'uncommitted changes'
        self.assertIn(expected, job['error'])
        self.assertIn('Lindsey', job['error'])
        if conflict:
            self.assertEqual(job['conflictPaths'], ['story.txt'])
            status = json.loads(subprocess.check_output([sys.executable, worker.__file__, '--status'], text=True))
            self.assertEqual(status['conflictPaths'], ['story.txt'])
            self.assertEqual(status['branch'], 'refs/heads/main')
        self.assertEqual(self.git('rev-parse', 'HEAD'), sha)
        self.assertEqual(self.git('write-tree'), index)
        if dirty:
            self.assertEqual((self.repo / 'story.txt').read_bytes(), b'later unstaged\x00change\n')
        self.assertFalse((self.repo / '.git' / 'MERGE_HEAD').exists())
        with self.assertRaisesRegex(RuntimeError, expected) as blocked:
            worker.wait_for_background('/usr/bin/git', [])
        self.assertIn('repo (main):', str(blocked.exception))
        with patch.object(worker, 'rejected_push_error', side_effect=AssertionError('Must not retry')):
            worker.work(directory)
        self.assertEqual(self.job(directory), job)

    def test_rejected_push_reports_binary_merge_conflicts(self):
        self.check_divergent_push(conflict=True)

    def test_rejected_push_reports_clean_divergence(self):
        self.check_divergent_push(conflict=False)

    def test_lindsey_rebases_clean_divergence_and_pushes(self):
        self.check_divergent_push(conflict=False, dirty=False)

    def test_lindsey_rebases_all_finalized_queued_descendants(self):
        self.check_divergent_push(conflict=False, dirty=False, descendants=True)

    def test_lindsey_recovers_checkout_before_ref_move(self):
        self.check_divergent_push(conflict=False, dirty=False, crash='before-ref')

    def test_lindsey_recovers_ref_move_before_job_checkpoint(self):
        self.check_divergent_push(conflict=False, dirty=False, crash='after-ref')

    def test_lindsey_preserves_signed_commits(self):
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
            subprocess.run([sys.executable, str(Path(worker.__file__).with_name('ai_commit.py')), 'switch', 'other'], check=True, capture_output=True)
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
            result = subprocess.run([sys.executable, str(Path(worker.__file__).with_name('ai_commit.py')), command], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Commit & Push is still running', result.stderr)
        self.assertEqual(self.job(directory)['phase'], 'committed')

    def test_wrapper_allows_switch_and_checkout_while_push_is_pending(self):
        self.git('commit', '-q', '-m', 'Base')
        self.git('branch', 'other')
        (self.repo / 'story.txt').write_text('Queued main change\n')
        self.git('add', 'story.txt')
        directory = self.queue(push=True)
        script = str(Path(worker.__file__).with_name('ai_commit.py'))
        for args, expected in ((('switch', 'other'), 'other'), (('checkout', 'main'), 'main')):
            result = subprocess.run([sys.executable, script, *args], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.git('branch', '--show-current'), expected)
        result = subprocess.run([sys.executable, script, 'switch', '-c', 'copied'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git('branch', '--show-current'), 'copied')
        self.assertEqual(self.job(directory)['phase'], 'committed')

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
        script = str(Path(worker.__file__).with_name('ai_commit.py'))
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
        self.assertNotIn('placeholder_', self.git('log', '--format=%s', 'isolated'))
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
        self.assertNotIn('placeholder_', self.git('log', '--format=%s'))
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
        script = str(Path(worker.__file__).with_name('ai_commit.py'))
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
        self.git('commit', '--allow-empty', '-q', '-m', 'placeholder_0123456789abcdef')
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
        script = os.environ.get('SWEETIEBOT_TEST_GIT_WRAPPER', str(Path(worker.__file__).with_name('ai_commit.py')))
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
        script = os.environ.get('SWEETIEBOT_TEST_GIT_WRAPPER', str(Path(worker.__file__).with_name('ai_commit.py')))
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

    def test_manual_coauthor_commit_queues_behind_generated_title(self):
        first = self.queue(message='', push=True)
        (self.repo / 'story.txt').write_text('Manual attributed change\n')
        self.git('add', 'story.txt')
        message = '🧪 Preserve manual subject\n\nCo-authored-by: Codex <noreply@openai.com>'
        second = self.queue(message=message, push=True)
        worker.work(second)
        self.assertEqual(self.job(second)['phase'], 'committed')
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'for-each-ref'), '')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Finish earlier title', '')):
            worker.work(first)
        worker.work(second)
        self.assertEqual(self.job(second)['phase'], 'done')
        self.assertEqual(self.git('log', '-1', '--format=%B'), message)
        remote = self.git('--git-dir=' + str(self.root / 'remote'), 'rev-parse', 'refs/heads/main')
        self.assertEqual(remote, self.git('rev-parse', 'HEAD'))
        self.assertNotIn('placeholder_', self.git('log', '--format=%s', remote))

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

    def test_scheduler_runs_six_jobs_before_starting_seventh(self):
        from types import SimpleNamespace
        entries = [{'id': str(i), 'directory': str(self.root / str(i))} for i in range(7)]
        jobs = {entry['id']: dict(entry, phase='committed', provisional=True,
                                branch='refs/heads/main', sha=entry['id']) for entry in entries}
        active, batches = [], []
        def launch(directory):
            child = SimpleNamespace(done=False)
            child.poll = lambda: 0 if child.done else None
            active.append(child)
            return child
        def tick(_seconds):
            running = [child for child in active if not child.done]
            batches.append(len(running))
            for child in running:
                child.done = True
        with patch.object(worker, 'queue_entries', return_value=entries), \
                patch.object(worker, 'read_journal', side_effect=lambda p: jobs[p.parent.name]), \
                patch.object(worker, 'launch_job', side_effect=launch), \
                patch.object(worker.time, 'sleep', side_effect=tick):
            worker.drain_parallel(str(self.repo / '.git'))
        self.assertEqual(batches, [6, 1])

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
        status = json.loads(subprocess.check_output([sys.executable, worker.__file__, '--status'], text=True))
        self.assertTrue(status['recoverable'])
        self.assertEqual(status['phase'], 'recovering')
        self.assertIn(first.name, status['titleJobs'])
        # An unqueued branch move must still surface the real conflict.
        self.git('update-ref', 'refs/heads/main', job['sha'])
        status = json.loads(subprocess.check_output([sys.executable, worker.__file__, '--status'], text=True))
        self.assertFalse(status.get('recoverable', False))
        self.git('update-ref', 'refs/heads/main', self.job(second)['sha'])
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
