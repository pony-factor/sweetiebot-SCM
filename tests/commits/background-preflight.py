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


class BackgroundCommitPreflightTests(BackgroundCommitFixture):
    def test_fast_placeholder_captures_once_before_diff_or_spellcheck(self):
        calls = []
        real_git = worker.git
        def recording_git(*args, **kwargs):
            calls.append(args)
            return real_git(*args, **kwargs)
        with patch.object(worker, 'git', side_effect=recording_git), \
                patch.object(worker, 'captured_diff_warnings') as inspect, \
                patch.object(worker, 'start_spellcheck') as spellcheck, \
                patch.object(worker.core, 'generate_message') as generate:
            directory = self.queue(message='', deferDiffInspection=True)
            self.assertTrue(self.job(directory)['provisional'])
            self.assertEqual(calls.count(('write-tree',)), 1)
            inspect.assert_not_called()
            spellcheck.assert_not_called()
            generate.assert_not_called()
        with patch.object(worker, 'captured_diff_warnings', return_value=['large patch']) as inspect, \
                patch.object(worker.core, 'generate_message') as generate:
            worker.work(directory)
            inspect.assert_called_once()
            generate.assert_not_called()
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        self.assertEqual(self.job(directory)['diffWarnings'], ['large patch'])
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.job(directory)['sha'])
        with self.assertRaisesRegex(RuntimeError, 'Explicitly approve'):
            worker.control('retry')
        worker.control('approve-diff', directory.name)
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Final title', '')):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertEqual(self.git('log', '-1', '--format=%s'), '🧪 Final title')

    def test_fast_placeholder_large_file_uses_existing_preflight(self):
        with patch.object(worker, 'snapshot_file_sizes', return_value=[('story.txt', 51 * 1024**2)]):
            result = worker.enqueue({'message': '', 'deferDiffInspection': True}, start=False)
        self.assertEqual(result, {'queued': False, 'requireFullPreflight': True})
        self.assertEqual(self.git('diff', '--cached', '--name-only'), 'story.txt')

    def test_spellcheck_starts_before_title_generation_and_is_not_repeated(self):
        import post_commit_spellcheck
        (self.repo / 'note.md').write_text('A speling mistake.\n')
        self.git('add', 'note.md')
        self.git('config', 'sweetiebot.post-commit-spellcheck', 'true')
        original_config = worker.core.git_config_bool
        with patch.object(worker.core, 'git_config_bool', side_effect=lambda key, default: True if key == 'sweetiebot.post-commit-spellcheck' else original_config(key, default)), patch.object(post_commit_spellcheck, 'spawn_post_commit') as spellcheck, patch.object(worker.core, 'generate_message', return_value=('📝 Record note', '')) as generate:
            directory = self.queue(message='')
            generate.assert_not_called()
            spellcheck.assert_called_once()
            self.assertEqual(spellcheck.call_args.args[1], ['note.md'])
            self.assertTrue(self.job(directory)['spellcheck_started'])
            worker.work(directory)
            spellcheck.assert_called_once()

    def test_reviewed_spellcheck_queues_while_titles_pending_and_preserves_other_staging(self):
        directory = self.queue(message='')
        (self.repo / 'note.md').write_text('Reviewed spelling.\n')
        (self.repo / 'story.txt').write_text('Unrelated staged work.\n')
        self.git('add', 'note.md', 'story.txt')
        with patch.object(worker.core, 'generate_message') as generate:
            reviewed = self.queue(message='', paths=['note.md'], skipSpellcheck=True, description='My reviewed note')
            generate.assert_not_called()
        sha = self.job(reviewed)['sha']
        self.assertEqual(self.git('show', '--format=', '--name-only', sha), 'note.md')
        self.assertEqual(self.git('diff', '--cached', '--name-only'), 'story.txt')
        self.assertIn('My reviewed note', self.git('show', '-s', '--format=%B', sha))
        self.assertTrue(self.job(reviewed)['skip_spellcheck'])

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

    def test_retention_prunes_only_settled_jobs_older_than_60_days(self):
        now = time.time()
        expired_done = self.saved_retention_job('11111111112', 'done', 61, now)
        expired_cancelled = self.saved_retention_job('11111111113', 'cancelled', 61, now)
        recent = self.saved_retention_job('11111111114', 'done', 59, now)
        boundary = self.saved_retention_job('11111111115', 'done', 59.9, now)
        blocked = self.saved_retention_job('11111111116', 'blocked', 90, now)
        generating = self.saved_retention_job('11111111117', 'generating', 90, now)
        provisional = self.saved_retention_job('11111111118', 'done', 90, now, provisional=True)
        unknown = self.saved_retention_job('not-a-job-id', 'done', 90, now)
        worker.prune_completed_jobs(now=now)
        self.assertFalse(expired_done.exists())
        self.assertFalse(expired_cancelled.exists())
        for directory in (recent, boundary, blocked, generating, provisional, unknown):
            self.assertTrue(directory.exists(), directory.name)

    def test_retention_protects_queued_jobs_transactions_and_active_workers(self):
        now = time.time()
        queued = self.saved_retention_job('11111111119', 'done', 90, now)
        busy = self.saved_retention_job('1111111111A', 'done', 90, now)
        meta = self.repo / '.git'
        worker.write_journal(meta / worker.MARKER, {'id': queued.name, 'directory': str(queued)})
        with (busy / 'worker.lock').open('a+b') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            worker.prune_completed_jobs(now=now)
            self.assertTrue(queued.exists())
            self.assertTrue(busy.exists())
        (meta / worker.MARKER).unlink()
        (meta / worker.TRANSACTION).write_text('{}')
        worker.prune_completed_jobs(now=now)
        self.assertTrue(queued.exists())
        self.assertTrue(busy.exists())
        (meta / worker.TRANSACTION).unlink()
        worker.prune_completed_jobs(now=now)
        self.assertFalse(queued.exists())
        self.assertFalse(busy.exists())

    def test_resume_prunes_expired_completed_jobs(self):
        now = time.time()
        expired = self.saved_retention_job('1111111111B', 'done', 61, now)
        with patch.object(worker.time, 'time', return_value=now):
            worker.resume()
        self.assertFalse(expired.exists())

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

    def test_recovery_forks_old_local_tip_without_syncing_main(self):
        directory = self.queue(push=True)
        info = {'branch': 'main', 'number': 61, 'defaultBranch': 'main', 'remote': 'origin'}
        with patch.object(merged_branch, 'require_unmerged', side_effect=merged_branch.MergedBranchPush(info)):
            worker.work(directory)
        original_tip = self.git('rev-parse', 'HEAD')
        with self.assertRaisesRegex(RuntimeError, 'advanced'):
            worker.fork_branch('refs/heads/main', 'stale-followup', 'refs/heads/main',
                               expected_tip='f' * 40)
        self.assertEqual(self.git('branch', '--show-current'), 'main')
        worker.fork_branch('refs/heads/main', 'new-followup', 'refs/heads/main',
                           expected_tip=original_tip)
        self.assertEqual(self.git('branch', '--show-current'), 'new-followup')
        self.assertEqual(self.git('rev-parse', 'new-followup'), original_tip)
        self.assertEqual(self.git('rev-parse', 'main'), original_tip)
        self.assertFalse(self.job(directory)['push'])
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'for-each-ref'), '')

    def test_user_can_retire_merged_push_without_changing_local_history(self):
        directory = self.queue(push=True)
        info = {'branch': 'main', 'number': 61, 'defaultBranch': 'main', 'remote': 'origin'}
        with patch.object(merged_branch, 'require_unmerged', side_effect=merged_branch.MergedBranchPush(info)):
            worker.work(directory)
        paused = self.job(directory)
        local_sha = paused['sha']
        with self.assertRaisesRegex(ValueError, 'identifier'):
            worker.dismiss_merged_push('wrong-job')
        with self.assertRaisesRegex(RuntimeError, 'job changed'):
            worker.dismiss_merged_push('z' * 11)
        self.assertEqual(self.git('rev-parse', 'HEAD'), local_sha)
        self.assertTrue(worker.dismiss_merged_push(paused['id']))
        retired = self.job(directory)
        self.assertFalse(retired['push'])
        self.assertEqual(retired['phase'], 'committed')
        self.assertNotIn('mergedBranch', retired)
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertEqual(self.git('rev-parse', 'HEAD'), local_sha)
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
        with patch.object(worker, 'get_placeholder_prefix', return_value='pony_'):
            with patch.object(worker.core, 'generate_message', side_effect=AssertionError('Must run later')):
                directory = self.queue(message='', push=True, signoff=True)
        provisional = self.git('rev-parse', 'HEAD')
        self.assertRegex(directory.name, r'^[1-9A-HJ-NP-Za-km-z]{11}$')
        self.assertEqual(self.git('log', '-1', '--format=%s'), 'pony_' + directory.name)
        self.assertEqual(self.job(directory)['placeholder_prefix'], 'pony_')
        identity = self.git('show', '-s', '--format=%an|%ae|%aI|%cn|%ce|%cI')
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

if __name__ == "__main__":
    unittest.main()
