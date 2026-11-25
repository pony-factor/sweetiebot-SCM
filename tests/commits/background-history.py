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


class BackgroundCommitHistoryTests(BackgroundCommitFixture):
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

    def test_linear_external_commit_survives_pending_title_and_push(self):
        directory = self.queue(message='', push=True)
        placeholder = self.git('rev-parse', 'HEAD')
        self.git('commit', '-q', '--allow-empty', '-m', 'Later external commit')
        original_tip = self.git('rev-parse', 'HEAD')
        original_tree = self.git('rev-parse', 'HEAD^{tree}')
        (self.repo / 'story.txt').write_text('Staged afterward\n')
        self.git('add', 'story.txt')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Final queued title', '')):
            worker.work(directory)
        job = self.job(directory)
        self.assertEqual(job['phase'], 'done')
        self.assertNotEqual(self.git('rev-parse', 'HEAD'), original_tip)
        self.assertNotEqual(job['sha'], placeholder)
        self.assertEqual(self.git('rev-parse', 'HEAD^'), job['sha'])
        self.assertEqual(self.git('log', '-1', '--format=%s'), 'Later external commit')
        self.assertEqual(self.git('log', '-1', '--format=%s', 'HEAD^'), '🧪 Final queued title')
        self.assertEqual(self.git('rev-parse', 'HEAD^{tree}'), original_tree)
        self.assertEqual(self.git('show', ':story.txt'), 'Staged afterward')
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'),
                                  'rev-parse', 'refs/heads/main'), job['sha'])
        self.assertEqual(self.git('rev-parse', 'refs/sweetiebot/recovery/' + job['id'] + '/' + original_tip),
                         original_tip)

    def test_published_external_commit_blocks_placeholder_replacement(self):
        directory = self.queue(message='', push=True)
        provisional = self.job(directory)['sha']
        self.git('commit', '-q', '--allow-empty', '-m', 'Already published through web')
        self.git('push', '-q', 'origin', 'main')
        original_tip = self.git('rev-parse', 'HEAD')
        with patch.object(worker.core, 'generate_message',
                          return_value=('🧪 Safe suggested local title', '')):
            worker.work(directory)
        self.assert_published_title_archived(directory, provisional,
                                             '🧪 Safe suggested local title')
        self.assertEqual(self.git('rev-parse', 'HEAD'), original_tip)
        self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/main').split()[0], original_tip)
        self.assertEqual(self.git('log', '-1', '--format=%s'), 'Already published through web')

    def test_web_commit_published_during_generation_cannot_replace_history(self):
        directory = self.queue(message='', push=True)
        provisional = self.job(directory)['sha']
        self.git('commit', '-q', '--allow-empty', '-m', 'Web follow-up')
        original_tip = self.git('rev-parse', 'HEAD')
        def publish_during_generation(*args, **kwargs):
            self.git('push', '-q', 'origin', 'main')
            return '🧪 Generated but not yet applied', ''
        with patch.object(worker.core, 'generate_message', side_effect=publish_during_generation):
            worker.work(directory)
        self.assert_published_title_archived(directory, provisional,
                                             '🧪 Generated but not yet applied')
        self.assertEqual(self.git('rev-parse', 'HEAD'), original_tip)
        self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/main').split()[0], original_tip)

    def test_published_followup_after_title_is_ready_blocks_replacement(self):
        directory = self.queue(message='', push=True)
        job = self.job(directory)
        provisional = job['sha']
        job.update(phase='ready', message='🧪 Title generated before web publication')
        worker.write_journal(directory / 'job.json', job)
        self.git('commit', '-q', '--allow-empty', '-m', 'Later web commit')
        original_tip = self.git('rev-parse', 'HEAD')
        self.git('push', '-q', 'origin', 'main')
        with patch.object(worker.core, 'generate_message',
                          side_effect=AssertionError('Ready title must not regenerate')):
            worker.work(directory)
        self.assert_published_title_archived(directory, provisional,
                                             '🧪 Title generated before web publication')
        self.assertEqual(self.git('rev-parse', 'HEAD'), original_tip)
        self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/main').split()[0], original_tip)

    def test_published_web_followup_blocks_multiple_pending_local_titles(self):
        first = self.queue(message='', push=True)
        (self.repo / 'story.txt').write_text('Second local commit\n')
        self.git('add', 'story.txt')
        second = self.queue(message='', push=True)
        first_sha = self.job(first)['sha']
        second_sha = self.job(second)['sha']
        self.git('commit', '-q', '--allow-empty', '-m', 'Later published web commit')
        original_tip = self.git('rev-parse', 'HEAD')
        original_tree = self.git('rev-parse', 'HEAD^{tree}')
        self.git('push', '-q', 'origin', 'main')
        with patch.object(worker.core, 'generate_message',
                          side_effect=[('🧪 First queued title', ''),
                                       ('🧪 Second queued title', '')]):
            worker.work(first)
            worker.work(second)
        self.assert_published_title_archived(first, first_sha, '🧪 First queued title')
        self.assert_published_title_archived(second, second_sha, '🧪 Second queued title')
        self.assertEqual(self.git('rev-parse', 'HEAD'), original_tip)
        self.assertEqual(self.git('rev-parse', 'HEAD^{tree}'), original_tree)
        self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/main').split()[0], original_tip)

    def test_published_provisional_without_followup_keeps_existing_sha(self):
        directory = self.queue(message='', push=True)
        original = self.git('rev-parse', 'HEAD')
        self.git('push', '-q', 'origin', 'main')
        with patch.object(worker.core, 'generate_message',
                          return_value=('🧪 Preserve published identity', '')):
            worker.work(directory)
        self.assert_published_title_archived(directory, original,
                                             '🧪 Preserve published identity')
        self.assertEqual(self.git('rev-parse', 'HEAD'), original)
        self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/main').split()[0], original)

    def test_published_ancestor_allows_unpublished_local_title_finalization(self):
        first = self.queue(message='', push=True)
        first_sha = self.job(first)['sha']
        self.git('push', '-q', 'origin', 'main')
        (self.repo / 'story.txt').write_text('Unpublished local second change\n')
        self.git('add', 'story.txt')
        second = self.queue(message='', push=True)
        with patch.object(worker.core, 'generate_message',
                          side_effect=[('🧪 Published ancestor suggestion', ''),
                                       ('🧪 Final unpublished second title', '')]):
            worker.work(first)
            worker.work(second)
        self.assert_published_title_archived(first, first_sha,
                                             '🧪 Published ancestor suggestion')
        self.assertEqual(self.job(second)['phase'], 'done')
        self.assertFalse(self.job(second).get('published_title_unapplied'))
        self.assertEqual(self.git('log', '-1', '--format=%s'),
                         '🧪 Final unpublished second title')
        self.assertEqual(self.git('rev-parse', 'HEAD^'), first_sha)
        self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/main').split()[0],
                         self.git('rev-parse', 'HEAD'))

    def test_previously_blocked_published_job_can_resume_without_rewrite(self):
        directory = self.queue(message='', push=True)
        original = self.job(directory)['sha']
        self.git('commit', '-q', '--allow-empty', '-m', 'Existing web follow-up')
        self.git('push', '-q', 'origin', 'main')
        tip = self.git('rev-parse', 'HEAD')
        job = self.job(directory)
        job.update(phase='blocked', error=('Later commits are already published upstream. '
                   'SweetieBot cannot replace an earlier provisional commit message.'))
        worker.write_journal(directory / 'job.json', job)
        with patch.object(worker.core, 'generate_message',
                          return_value=('🧪 Recovered published suggestion', '')):
            worker.work(directory)
        self.assert_published_title_archived(directory, original,
                                             '🧪 Recovered published suggestion')
        self.assertEqual(self.git('rev-parse', 'HEAD'), tip)
        self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/main').split()[0], tip)


    def test_published_title_fast_forwards_clean_branch_to_web_commits(self):
        directory = self.queue(message='', push=True)
        provisional = self.job(directory)['sha']
        self.git('push', '-q', 'origin', 'main')
        web = self.root / 'web-checkout'
        self.git('clone', '-q', '-b', 'main', str(self.root / 'remote'), str(web))
        self.git('-C', str(web), 'config', 'user.name', 'Web Author')
        self.git('-C', str(web), 'config', 'user.email', 'web@example.invalid')
        (web / 'web.txt').write_text('Web-only changes\n')
        self.git('-C', str(web), 'add', 'web.txt')
        self.git('-C', str(web), 'commit', '-qm', 'Published web follow-up')
        self.git('-C', str(web), 'push', '-q', 'origin', 'main')
        web_tip = self.git('-C', str(web), 'rev-parse', 'HEAD')
        self.assertEqual(self.git('rev-parse', 'HEAD'), provisional)
        with patch.object(worker.core, 'generate_message',
                          return_value=('🧪 Archived local title', '')):
            worker.work(directory)
        self.assert_published_title_archived(directory, provisional,
                                             '🧪 Archived local title')
        self.assertEqual(self.git('rev-parse', 'HEAD'), web_tip)
        self.assertEqual(self.git('show', 'HEAD:web.txt'), 'Web-only changes')
        self.assertEqual(self.git('rev-parse', 'HEAD^'), provisional)
        self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/main').split()[0], web_tip)

    def test_published_title_does_not_fast_forward_dirty_checkout(self):
        directory = self.queue(message='', push=True)
        provisional = self.job(directory)['sha']
        self.git('push', '-q', 'origin', 'main')
        web = self.root / 'web-checkout'
        self.git('clone', '-q', '-b', 'main', str(self.root / 'remote'), str(web))
        self.git('-C', str(web), 'config', 'user.name', 'Web Author')
        self.git('-C', str(web), 'config', 'user.email', 'web@example.invalid')
        (web / 'web.txt').write_text('Web change\n')
        self.git('-C', str(web), 'add', 'web.txt')
        self.git('-C', str(web), 'commit', '-qm', 'Newer published web change')
        self.git('-C', str(web), 'push', '-q', 'origin', 'main')
        web_tip = self.git('-C', str(web), 'rev-parse', 'HEAD')
        (self.repo / 'untracked.txt').write_text('Keep my local untracked file\n')
        with patch.object(worker.core, 'generate_message',
                          return_value=('🧪 Preserve untracked local edits', '')):
            worker.work(directory)
        self.assert_published_title_archived(directory, provisional,
                                             '🧪 Preserve untracked local edits')
        self.assertEqual(self.git('rev-parse', 'HEAD'), provisional)
        self.assertEqual((self.repo / 'untracked.txt').read_text(),
                         'Keep my local untracked file\n')
        self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/main').split()[0], web_tip)

    def test_external_merge_blocks_placeholder_replacement(self):
        directory = self.queue(message='', push=True)
        self.git('branch', 'side')
        self.git('commit', '-q', '--allow-empty', '-m', 'Main follow-up')
        self.git('switch', '-q', 'side')
        self.git('commit', '-q', '--allow-empty', '-m', 'Side follow-up')
        self.git('switch', '-q', 'main')
        self.git('merge', '--no-ff', '-q', '-m', 'External merge', 'side')
        sha = self.git('rev-parse', 'HEAD')
        with patch.object(worker.core, 'generate_message', side_effect=AssertionError('Merge must block')):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        self.assertEqual(self.git('rev-parse', 'HEAD'), sha)
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'), 'for-each-ref'), '')

    def test_reset_branch_blocks_placeholder_replacement(self):
        directory = self.queue(message='', push=True)
        alternate = self.git('commit-tree', 'HEAD^{tree}', input='Unrelated root\n')
        self.git('update-ref', 'refs/heads/main', alternate)
        with patch.object(worker.core, 'generate_message', side_effect=AssertionError('Reset must block')):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'blocked')
        self.assertEqual(self.git('rev-parse', 'main'), alternate)

    def test_finalized_commit_allows_linear_followup_without_rewriting_it(self):
        directory = self.queue(push=True)
        original = self.job(directory)['sha']
        self.git('commit', '-q', '--allow-empty', '-m', 'Later finalized commit')
        tip = self.git('rev-parse', 'HEAD')
        worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertEqual(self.git('rev-parse', 'HEAD'), tip)
        self.assertEqual(self.job(directory)['sha'], original)
        self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'),
                                  'rev-parse', 'refs/heads/main'), original)

    def test_signed_external_commit_replays_with_valid_signature(self):
        self.enable_test_gpg_signing()
        directory = self.queue(message='')
        self.git('commit', '-q', '--allow-empty', '-m', 'Signed follow-up')
        external = self.git('rev-parse', 'HEAD')
        self.git('config', 'commit.gpgsign', 'false')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Signed ancestor title', '')):
            worker.work(directory)
        self.assertEqual(self.job(directory)['phase'], 'done')
        self.assertNotEqual(self.git('rev-parse', 'HEAD'), external)
        self.assert_signed('HEAD')
        self.assert_signed('HEAD^')

if __name__ == "__main__":
    unittest.main()
