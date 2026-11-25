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


class BackgroundCommitRecoveryTests(BackgroundCommitFixture):
    def test_commit_and_push_without_remotes_commits_locally(self):
        self.git('remote', 'remove', 'origin')
        directory = self.queue(push=True)
        self.assertFalse(self.job(directory)['push'])
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertEqual(self.git('log', '-1', '--format=%s'), '🧪 Record captured change')

    def test_missing_push_remote_still_blocks_when_another_remote_exists(self):
        self.git('remote', 'rename', 'origin', 'upstream')
        with self.assertRaisesRegex(RuntimeError, 'Configure the push remote'):
            self.queue(push=True)

    def test_pony_job_is_durable_and_preserves_unrelated_staging(self):
        profile = self.repo / 'ponies' / 'g4-mares' / 'stardom.json'
        profile.parent.mkdir(parents=True)
        profile.write_text(json.dumps({
            'packId': 'g4-mares', 'slug': 'stardom', 'profile': 'Research'
        }))
        request = {'pony': {'packId': 'g4-mares', 'slug': 'stardom'},
                   'path': 'g4-mares/stardom.json'}
        staged = self.git('diff', '--cached', '--name-only')
        with patch.object(worker.shutil, 'which', return_value='/usr/bin/node'):
            first = worker.enqueue_pony(request, start=False)
            again = worker.enqueue_pony(request, start=False)
        self.assertTrue(first['queued'])
        self.assertEqual(first['id'], again['id'])
        record = self.job(self.root / 'jobs' / first['id'])
        self.assertEqual(record['kind'], 'pony-profile')
        self.assertEqual(record['phase'], 'queued')
        self.assertEqual(record['path'], request['path'])
        self.assertEqual(self.git('diff', '--cached', '--name-only'), staged)
        with self.assertRaisesRegex(ValueError, 'Unexpected pony profile path'):
            worker.enqueue_pony({**request, 'path': '../unsafe.json'}, start=False)

    def test_pony_enqueue_starts_own_worker_without_waiting_for_title_drain(self):
        profile = self.repo / 'ponies' / 'g4-mares' / 'stardom.json'
        profile.parent.mkdir(parents=True)
        profile.write_text(json.dumps({
            'packId': 'g4-mares', 'slug': 'stardom', 'profile': 'Research'
        }))
        durable_script = self.root / 'durable-background-commit.py'
        with patch.object(worker.shutil, 'which', return_value='/usr/bin/node'), \
                patch.object(worker, 'runtime', return_value=durable_script), \
                patch.object(worker, 'install_agent') as agent, \
                patch.object(worker, 'launch_job') as launch:
            accepted = worker.enqueue_pony({
                'pony': {'packId': 'g4-mares', 'slug': 'stardom'},
                'path': 'g4-mares/stardom.json'}, start=True)
        directory = self.root / 'jobs' / accepted['id']
        agent.assert_called_once_with(durable_script)
        launch.assert_called_once_with(directory, script=durable_script)
        self.assertEqual(self.job(directory)['phase'], 'queued')

    def test_pony_resume_launches_before_unfinished_commit_drain(self):
        profile = self.repo / 'ponies' / 'g4-mares' / 'stardom.json'
        profile.parent.mkdir(parents=True)
        profile.write_text(json.dumps({
            'packId': 'g4-mares', 'slug': 'stardom', 'profile': 'Research'
        }))
        with patch.object(worker.shutil, 'which', return_value='/usr/bin/node'):
            accepted = worker.enqueue_pony({
                'pony': {'packId': 'g4-mares', 'slug': 'stardom'},
                'path': 'g4-mares/stardom.json'}, start=False)
        self.queue(push=True)
        launches = []
        with patch.object(worker, 'launch_job', side_effect=lambda directory:
                          launches.append(('pony', directory))), \
                patch.object(worker, 'drain_parallel', side_effect=lambda meta:
                             launches.append(('commit', meta))), \
                patch.object(worker, 'prune_completed_jobs'):
            worker.resume()
        self.assertEqual(launches, [
            ('pony', self.root / 'jobs' / accepted['id']),
            ('commit', str((self.repo / '.git').resolve())),
        ], 'Independent pony work must start before lengthy title generation')

    def test_pony_worker_waits_behind_background_commits(self):
        profile = self.repo / 'ponies' / 'g4-mares' / 'stardom.json'
        profile.parent.mkdir(parents=True)
        profile.write_text(json.dumps({
            'packId': 'g4-mares', 'slug': 'stardom', 'profile': 'Research'
        }))
        with patch.object(worker.shutil, 'which', return_value='/usr/bin/node'):
            accepted = worker.enqueue_pony({
                'pony': {'packId': 'g4-mares', 'slug': 'stardom'},
                'path': 'g4-mares/stardom.json'}, start=False)
        pending = self.root / 'jobs' / accepted['id']
        self.queue(push=True)
        worker.work_pony(pending)
        job = self.job(pending)
        self.assertEqual(job['phase'], 'waiting')
        self.assertIn('background commit', job['error'])
        self.assertGreater(job['nextAttemptAt'], time.time())

    def test_inspection_snapshot_reuses_blob_sizes_without_second_cat_file(self):
        snapshot = self.approved_snapshot()
        with patch.object(worker.core, 'staged_blob_sizes', side_effect=AssertionError(
                'blob metadata must come from the approved snapshot')):
            directory = self.queue(expectedTree=snapshot['tree'], validatedSnapshot=snapshot,
                                   message='')
        self.assertEqual(self.job(directory)['tree'], snapshot['tree'])
        self.assertEqual(self.git('rev-parse', 'HEAD^{tree}'), snapshot['tree'])

    def test_inspection_snapshot_requires_matching_content_and_parent(self):
        snapshot = self.approved_snapshot()
        for corrupted in (
            {**snapshot, 'tree': 'f' * 40},
            {**snapshot, 'parent': 'f' * 40},
            {**snapshot, 'files': []},
            {**snapshot, 'files': [{'path': 'story.txt', 'size': -1}]},
            {**snapshot, 'diff': {**snapshot['diff'], 'totalBytes': -1}},
        ):
            with self.subTest(corrupted=corrupted):
                with self.assertRaises((RuntimeError, ValueError)):
                    worker.enqueue({
                        'message': '🧪 Reject stale snapshot', 'expectedTree': snapshot['tree'],
                        'validatedSnapshot': corrupted,
                    }, start=False)
        self.assertFalse((self.repo / '.git' / worker.MARKER).exists())

    def test_preflight_normalizes_before_approval_without_repeating_work(self):
        (self.repo / 'story.txt').write_text('Needs normalized newline')
        self.git('add', 'story.txt')
        original = self.git('write-tree')
        prepared = worker.prepare_staged_preflight()['stagedTree']
        self.assertNotEqual(original, prepared)
        self.assertEqual(self.git('write-tree'), prepared)
        snapshot = self.approved_snapshot()
        self.assertEqual(snapshot['tree'], prepared)
        with patch.object(worker.core, 'normalize_staged_final_newlines',
                          side_effect=AssertionError('Normalization must not repeat')):
            directory = self.queue(expectedTree=prepared, normalizedTree=prepared,
                                   validatedSnapshot=snapshot)
        self.assertEqual(self.job(directory)['tree'], prepared)
        self.assertEqual(self.git('rev-parse', 'HEAD^{tree}'), prepared)

    def test_normalized_stage_approval_rejects_concurrent_changes(self):
        prepared = worker.prepare_staged_preflight()['stagedTree']
        snapshot = self.approved_snapshot()
        (self.repo / 'late.txt').write_text('Later staged change\n')
        self.git('add', 'late.txt')
        with self.assertRaisesRegex(RuntimeError, 'Staged changes changed'):
            worker.enqueue({
                'message': '🧪 Reject changed selection',
                'expectedTree': prepared,
                'normalizedTree': prepared,
                'validatedSnapshot': snapshot,
            }, start=False)
        self.assertFalse((self.repo / '.git' / worker.MARKER).exists())

    def test_unverified_normalization_cannot_bypass_the_normalizer(self):
        snapshot = self.approved_snapshot()
        for bad_request in (
            {'normalizedTree': snapshot['tree']},
            {'expectedTree': snapshot['tree'], 'normalizedTree': 'f' * 40,
             'validatedSnapshot': snapshot},
        ):
            with self.assertRaises(ValueError):
                worker.enqueue({'message': '🧪 Require verified normalization',
                                **bad_request}, start=False)
        self.assertFalse((self.repo / '.git' / worker.MARKER).exists())

    def test_normalization_invalidates_old_inspection_and_requires_reapproval(self):
        (self.repo / 'story.txt').write_text('Missing final newline')
        self.git('add', 'story.txt')
        snapshot = self.approved_snapshot()
        with self.assertRaisesRegex(RuntimeError, 'Staged changes changed'):
            worker.enqueue({
                'message': '🧪 Normalize staged file', 'expectedTree': snapshot['tree'],
                'validatedSnapshot': snapshot
            }, start=False)
        self.assertNotEqual(self.git('write-tree'), snapshot['tree'])
        self.assertFalse((self.repo / '.git' / worker.MARKER).exists())
        refreshed = self.approved_snapshot()
        directory = self.queue(expectedTree=refreshed['tree'], validatedSnapshot=refreshed)
        self.assertEqual(self.job(directory)['tree'], refreshed['tree'])

    def test_durable_commit_rejects_changed_stage_after_approved_preflight(self):
        """A cheap tree comparison guards the one staged-size inspection."""
        approved_tree = self.git('write-tree')
        (self.repo / 'later.txt').write_text('Not included in approval\n')
        self.git('add', 'later.txt')
        staged_before = self.git('write-tree')
        self.assertNotEqual(approved_tree, staged_before)
        with self.assertRaisesRegex(RuntimeError, 'Staged changes changed'):
            worker.enqueue({
                'message': '🧪 Reject stale inspected tree',
                'expectedTree': approved_tree,
            }, start=False)
        self.assertEqual(self.git('write-tree'), staged_before)
        self.assertEqual(self.git('diff', '--cached', '--name-only'),
                         'later.txt\nstory.txt')
        self.assertFalse((self.repo / '.git' / worker.MARKER).exists())

    def test_durable_commit_accepts_matching_staged_tree(self):
        approved_tree = self.git('write-tree')
        directory = self.queue(expectedTree=approved_tree)
        self.assertEqual(self.job(directory)['tree'], approved_tree)
        self.assertEqual(self.git('rev-parse', 'HEAD^{tree}'), approved_tree)

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

    def test_deleted_local_and_remote_branch_retires_push_and_preserves_recovery_commit(self):
        directory = self.deleted_branch_job()
        queued = self.job(directory)['sha']
        (self.repo / 'story.txt').write_text('Staged afterward\n')
        self.git('add', 'story.txt')
        (self.repo / 'story.txt').write_text('Unstaged afterward\n')
        before = [self.git('rev-parse', 'HEAD'), self.git('write-tree'), self.git('diff')]
        status = json.loads(subprocess.check_output([sys.executable, worker.__file__, '--status'], text=True))
        self.assertFalse(status.get('id'))
        job = self.job(directory)
        self.assertEqual(job['phase'], 'cancelled', 'A deleted branch is not falsely reported as published')
        self.assertFalse(job['push'])
        self.assertNotIn('error', job)
        self.assertEqual(self.git('rev-parse', 'refs/sweetiebot/recovery/' + job['id'] + '/deleted-branch'), queued)
        self.assertEqual(before, [self.git('rev-parse', 'HEAD'), self.git('write-tree'), self.git('diff')])
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'for-each-ref'), '')
        self.assertNotIn('refs/heads/main', self.git('for-each-ref', '--format=%(refname)'))

    def test_deleted_local_branch_with_verified_published_commit_finishes(self):
        directory = self.deleted_branch_job(publish=True)
        worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'done')

    def test_deleted_branch_is_not_retired_when_remote_check_fails(self):
        directory = self.deleted_branch_job()
        original = worker.git
        def offline(*args, **kwargs):
            if args[0] == 'ls-remote':
                return subprocess.CompletedProcess(args, 128, stdout='', stderr='offline')
            return original(*args, **kwargs)
        with patch.object(worker, 'git', side_effect=offline):
            worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'blocked')

    def test_deleted_branch_with_pending_message_is_not_retired(self):
        directory = self.deleted_branch_job()
        job = self.job(directory)
        job['provisional'] = True
        worker.write_journal(directory / 'job.json', job)
        worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'blocked')

    def test_finalized_job_pushes_after_external_merge_without_rewriting_or_staging(self):
        directory = self.external_merge_after_queue()
        queued = self.job(directory)['sha']
        (self.repo / 'story.txt').write_text('Staged afterward\n')
        self.git('add', 'story.txt')
        (self.repo / 'story.txt').write_text('Unstaged afterward\n')
        before = [self.git('rev-parse', 'HEAD'), self.git('write-tree'), self.git('diff')]
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertEqual(self.job(directory)['sha'], queued)
        self.assertEqual(before, [self.git('rev-parse', 'HEAD'), self.git('write-tree'), self.git('diff')])
        self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/main').split()[0], queued,
                         'Publish only the requested queued commit, not unrelated external commits')

    def test_finalized_branch_advance_reports_recovering_and_resumes_without_retry(self):
        directory = self.external_merge_after_queue()
        job = self.job(directory)
        job.update(phase='blocked', error='The branch advanced outside the queued commits; background work was paused.')
        worker.write_journal(directory / 'job.json', job)
        status = json.loads(subprocess.check_output([sys.executable, worker.__file__, '--status'], text=True))
        self.assertEqual(status['phase'], 'recovering')
        self.assertTrue(status['recoverable'])
        self.assertTrue(status['pushPending'])
        self.assertEqual(status['titleJobs'], [])
        self.assertEqual(worker.request_push({'remote': 'origin'}, start=False), {'queued': True})
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertNotIn('error', self.job(directory))

    def test_finalized_advance_with_untracked_placeholder_stays_blocked(self):
        directory = self.queue(push=True)
        self.git('commit', '--allow-empty', '-qm', 'placeholder_0123456789abcdef')
        before = self.git('rev-parse', 'HEAD')
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        self.assertIn('unfinished commit messages', self.job(directory)['error'])
        self.assertEqual(self.git('rev-parse', 'HEAD'), before)
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'for-each-ref'), '')

    def test_finalized_advance_with_untracked_configured_placeholder_stays_blocked(self):
        directory = self.queue(push=True)
        self.git('commit', '--allow-empty', '-qm', worker.get_placeholder_prefix() + '123456789AB')
        before = self.git('rev-parse', 'HEAD')
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        self.assertIn('unfinished commit messages', self.job(directory)['error'])
        self.assertEqual(self.git('rev-parse', 'HEAD'), before)
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'for-each-ref'), '')

    def test_finalized_job_cannot_recover_after_reset_removes_queued_commit(self):
        directory = self.queue(push=True)
        alternate = self.git('commit-tree', 'HEAD^{tree}', input='Unrelated root\n')
        self.git('update-ref', 'refs/heads/main', alternate)
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        status = json.loads(subprocess.check_output([sys.executable, worker.__file__, '--status'], text=True))
        self.assertFalse(status.get('recoverable', False))
        self.assertEqual(self.git('rev-parse', 'HEAD'), alternate)
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'for-each-ref'), '')

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

    def test_superseded_job_is_archived_without_touching_history_or_work(self):
        directory = self.superseded_blocked_job()
        old = self.job(directory)['sha']
        head = self.git('rev-parse', 'HEAD')
        (self.repo / 'story.txt').write_text('Staged work\n')
        self.git('add', 'story.txt')
        (self.repo / 'story.txt').write_text('Unstaged work\n')
        (self.repo / 'untracked.txt').write_text('Untracked work\n')
        index = (self.repo / '.git/index').read_bytes()
        status = self.git('status', '--porcelain')
        worker.reconcile_published_jobs(self.repo / '.git')
        job = self.job(directory)
        self.assertEqual(job['phase'], 'cancelled')
        self.assertFalse(job['push'])
        self.assertIn('synchronized', job['retired_reason'])
        self.assertEqual(self.git('rev-parse', job['recovery_ref']), old)
        self.assertEqual(self.git('rev-parse', 'HEAD'), head)
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'rev-parse', 'main'), head)
        self.assertEqual((self.repo / '.git/index').read_bytes(), index)
        self.assertEqual(self.git('status', '--porcelain'), status)
        self.assertEqual((self.repo / 'story.txt').read_text(), 'Unstaged work\n')
        self.assertEqual((self.repo / 'untracked.txt').read_text(), 'Untracked work\n')
        self.assertFalse(worker.queue_entries(self.repo / '.git' / worker.MARKER))
        worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory), job)

    def test_superseded_job_stays_blocked_when_local_and_remote_differ(self):
        directory = self.superseded_blocked_job()
        self.git('commit', '--allow-empty', '-qm', 'Unpublished follow-up')
        worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'blocked')

    def test_superseded_job_requires_live_remote_and_recovery_ref(self):
        directory = self.superseded_blocked_job()
        original = worker.git
        for fail_command in ('ls-remote', 'update-ref'):
            def fail(*args, **kwargs):
                if args[0] == fail_command:
                    raise RuntimeError('Unavailable')
                return original(*args, **kwargs)
            with patch.object(worker, 'git', side_effect=fail):
                worker.reconcile_published_jobs(self.repo / '.git')
            self.assertEqual(self.job(directory)['phase'], 'blocked')

    def test_superseded_job_keeps_unfinished_active_and_uncertain_cases_paused(self):
        directory = self.superseded_blocked_job()
        original_job = self.job(directory)
        for changes in ({'provisional': True}, {'replacement_sha': original_job['sha']},
                        {'error': 'Authentication failed.'}):
            worker.write_journal(directory / 'job.json', {**original_job, **changes})
            worker.reconcile_published_jobs(self.repo / '.git')
            self.assertEqual(self.job(directory)['phase'], 'blocked')
        worker.write_journal(directory / 'job.json', original_job)
        with (directory / 'worker.lock').open('a+b') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        original = worker.git
        def uncertain(*args, **kwargs):
            if args[0] == 'merge-base':
                return subprocess.CompletedProcess(args, 128, '', 'Cannot determine ancestry')
            return original(*args, **kwargs)
        with patch.object(worker, 'git', side_effect=uncertain):
            worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'blocked')

    def test_superseded_job_rechecks_branch_under_lock(self):
        directory = self.superseded_blocked_job()
        original = worker.repository_lock
        def changed(meta):
            self.git('commit', '--allow-empty', '-qm', 'Concurrent branch change')
            return original(meta)
        with patch.object(worker, 'repository_lock', side_effect=changed):
            worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'blocked')

    def test_published_job_removed_from_local_branch_stays_blocked(self):
        directory = self.published_blocked_job()
        self.git('checkout', '--orphan', 'replacement')
        self.git('commit', '-qm', 'Replacement history')
        self.git('branch', '-f', 'main', 'HEAD')
        worker.reconcile_published_jobs(self.repo / '.git')
        self.assertEqual(self.job(directory)['phase'], 'blocked')

    def test_tls_guard_retries_three_times_before_blocking_or_continuing(self):
        error = 'Post "https://api.github.com/graphql": net/http: TLS handshake timeout'
        directory = self.queue(push=True)
        with patch.object(merged_branch, 'require_unmerged', side_effect=[RuntimeError(error), RuntimeError(error), RuntimeError(error), None]) as guard, patch.object(worker.time, 'sleep') as sleep:
            worker.work(directory)
            self.assertEqual(guard.call_count, 4)
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2, 4])
            self.assertEqual(self.job(directory)['phase'], 'done')
        (self.repo / 'story.txt').write_text('Another captured change.\n')
        self.git('add', 'story.txt')
        failed = self.queue(push=True)
        with patch.object(merged_branch, 'require_unmerged', side_effect=RuntimeError(error)) as guard, patch.object(worker.time, 'sleep') as sleep:
            worker.work(failed)
            self.assertEqual(guard.call_count, 4)
            self.assertEqual(self.job(failed)['phase'], 'blocked')
            self.assertTrue(self.job(failed)['network_retries_exhausted'])
            worker.work(failed)
            self.assertEqual(guard.call_count, 4, 'Exhausted jobs stay paused until a manual retry')

    def test_non_network_guard_failure_is_not_retried(self):
        with patch.object(worker.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, 'Authentication failed'):
                worker.retry_network_read(lambda: (_ for _ in ()).throw(RuntimeError('Authentication failed')))
            sleep.assert_not_called()

if __name__ == "__main__":
    unittest.main()
