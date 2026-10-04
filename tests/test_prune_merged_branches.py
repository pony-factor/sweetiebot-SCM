import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import prune_merged_branches as prune


class BranchCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git('init', '-b', 'main')
        self.git('remote', 'add', 'origin', 'git@github.com:owner/repo.git')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'base')
        self.git('branch', 'topic')
        self.oid = self.git('rev-parse', 'topic')
        self.pr = dict(number=33, state='MERGED', mergedAt='2026-10-03',
                       headRefName='topic', headRefOid=self.oid, baseRefName='main', isCrossRepository=False)
        self.open_prs = []
        self.real_run = prune.run
        self.addCleanup(patch.stopall)
        patch.object(prune, 'GH', 'fake-gh').start()
        patch.object(prune, 'run', side_effect=self.fake_run).start()

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.repo, text=True, capture_output=True, check=True).stdout.strip()

    def fake_run(self, command, **kwargs):
        if command[0] != 'fake-gh':
            return self.real_run(command, **kwargs)
        if command[1] == 'repo':
            data = dict(nameWithOwner='owner/repo', defaultBranchRef=dict(name='main'))
        elif command[2] == 'view':
            data = self.pr
        elif 'open' in command:
            data = self.open_prs
        else:
            data = [self.pr]
        return subprocess.CompletedProcess(command, 0, json.dumps(data), '')

    def exists(self):
        return subprocess.run(['git', 'show-ref', '--verify', '--quiet', 'refs/heads/topic'], cwd=self.repo).returncode == 0

    def test_removes_exact_merged_tip_even_without_ancestry(self):
        self.git('switch', 'topic')
        (self.repo / 'feature.txt').write_text('merged feature\n')
        self.git('add', 'feature.txt')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'feature')
        self.pr['headRefOid'] = self.git('rev-parse', 'HEAD')
        self.git('switch', 'main')
        self.git('merge', '--squash', 'topic')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'squash feature')
        deletion = subprocess.run(['git', 'branch', '-d', 'topic'], cwd=self.repo, text=True, capture_output=True)
        self.assertNotEqual(deletion.returncode, 0)
        self.assertIn('not fully merged', deletion.stderr)
        self.assertEqual(len(prune.prune_repo(self.repo)), 1)
        self.assertFalse(self.exists())

    def test_dry_run_preserves_branch(self):
        self.assertEqual(len(prune.prune_repo(self.repo, True)), 1)
        self.assertTrue(self.exists())

    def test_targeted_cleanup_preserves_other_branches(self):
        self.assertEqual(prune.prune_repo(self.repo, branch_filter='other'), [])
        self.assertTrue(self.exists())
        self.assertEqual(len(prune.prune_repo(self.repo, branch_filter='topic')), 1)
        self.assertFalse(self.exists())

    def test_changed_tip_is_preserved(self):
        self.pr['headRefOid'] = '0' * 40
        self.assertEqual(prune.prune_repo(self.repo), [])
        self.assertTrue(self.exists())

    def test_checked_out_worktree_is_preserved(self):
        self.git('worktree', 'add', str(self.repo / 'other'), 'topic')
        self.assertEqual(prune.prune_repo(self.repo), [])
        self.assertTrue(self.exists())

    def test_current_merged_branch_returns_to_main(self):
        self.git('switch', 'topic')
        self.assertEqual(len(prune.prune_repo(self.repo)), 1)
        self.assertEqual(self.git('branch', '--show-current'), 'main')
        self.assertFalse(self.exists())

    def test_dirty_current_branch_is_preserved(self):
        self.git('switch', 'topic')
        (self.repo / 'draft.txt').write_text('uncommitted work\n')
        self.assertEqual(prune.prune_repo(self.repo), [])
        self.assertEqual(self.git('branch', '--show-current'), 'topic')
        self.assertTrue(self.exists())

    def test_committed_extra_work_on_current_branch_is_preserved(self):
        self.git('switch', 'topic')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'extra work')
        self.assertEqual(prune.prune_repo(self.repo), [])
        self.assertEqual(self.git('branch', '--show-current'), 'topic')
        self.assertTrue(self.exists())

    def test_current_branch_dry_run_does_not_switch(self):
        self.git('switch', 'topic')
        self.assertEqual(len(prune.prune_repo(self.repo, True)), 1)
        self.assertEqual(self.git('branch', '--show-current'), 'topic')
        self.assertTrue(self.exists())

    def test_closed_unmerged_pr_does_nothing(self):
        self.git('switch', 'topic')
        self.pr.update(state='CLOSED', mergedAt=None)
        self.assertEqual(prune.prune_repo(self.repo), [])
        self.assertEqual(self.git('branch', '--show-current'), 'topic')
        self.assertTrue(self.exists())

    def test_older_pr_lookup_is_scoped_to_local_head_and_origin(self):
        previous = self.fake_run
        def scoped(command, **kwargs):
            if command[:3] == ['fake-gh', 'pr', 'list']:
                self.assertIn('--head', command)
                self.assertEqual(command[command.index('--head') + 1], 'topic')
                self.assertEqual(command[command.index('--repo') + 1], 'github.com/owner/repo')
            return previous(command, **kwargs)
        prune.run.side_effect = scoped
        self.assertEqual(len(prune.prune_repo(self.repo)), 1)

    def test_missing_origin_preserves_branches(self):
        self.git('remote', 'remove', 'origin')
        self.assertEqual(prune.prune_repo(self.repo), [])
        self.assertTrue(self.exists())

    def test_switch_failure_preserves_current_branch(self):
        self.git('switch', 'topic')
        self.git('branch', '-D', 'main')
        self.assertEqual(prune.prune_repo(self.repo), [])
        self.assertEqual(self.git('branch', '--show-current'), 'topic')
        self.assertTrue(self.exists())

    def test_in_progress_operation_preserves_current_branch(self):
        self.git('switch', 'topic')
        (self.repo / '.git' / 'MERGE_HEAD').write_text(self.oid + '\n')
        self.assertEqual(prune.prune_repo(self.repo), [])
        self.assertEqual(self.git('branch', '--show-current'), 'topic')
        self.assertTrue(self.exists())

    def test_staged_changes_preserve_current_branch(self):
        self.git('switch', 'topic')
        (self.repo / 'staged.txt').write_text('staged work\n')
        self.git('add', 'staged.txt')
        self.assertEqual(prune.prune_repo(self.repo), [])
        self.assertEqual(self.git('branch', '--show-current'), 'topic')
        self.assertTrue(self.exists())

    def test_changed_remote_verification_preserves_current_branch(self):
        self.git('switch', 'topic')
        previous = self.fake_run
        def changed(command, **kwargs):
            if command[:3] == ['fake-gh', 'pr', 'view']:
                return subprocess.CompletedProcess(command, 0, json.dumps(dict(self.pr, state='CLOSED', mergedAt=None)), '')
            return previous(command, **kwargs)
        prune.run.side_effect = changed
        self.assertEqual(prune.prune_repo(self.repo), [])
        self.assertEqual(self.git('branch', '--show-current'), 'topic')
        self.assertTrue(self.exists())

    def test_fork_nondefault_and_open_pr_are_preserved(self):
        for changes in [dict(isCrossRepository=True), dict(baseRefName='release'), dict(state='OPEN', mergedAt=None)]:
            saved = self.pr.copy()
            self.pr.update(changes)
            self.assertEqual(prune.prune_repo(self.repo), [])
            self.pr = saved
        self.open_prs = [dict(number=34)]
        self.assertEqual(prune.prune_repo(self.repo), [])
        self.assertTrue(self.exists())

    def test_worktree_failure_fails_closed(self):
        previous = self.fake_run
        def failing(command, **kwargs):
            if command[1:3] == ['worktree', 'list']:
                return subprocess.CompletedProcess(command, 1, '', 'failed')
            return previous(command, **kwargs)
        prune.run.side_effect = failing
        with self.assertRaises(RuntimeError):
            prune.prune_repo(self.repo)
        self.assertTrue(self.exists())

    def test_branch_moving_at_deletion_is_preserved(self):
        previous = self.fake_run
        def moving(command, **kwargs):
            if command[1] == 'update-ref':
                new = self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com',
                               'commit-tree', self.git('rev-parse', 'HEAD^{tree}'), '-p', self.oid, '-m', 'new work')
                self.git('update-ref', 'refs/heads/topic', new)
            return previous(command, **kwargs)
        prune.run.side_effect = moving
        self.assertEqual(prune.prune_repo(self.repo), [])
        self.assertTrue(self.exists())
