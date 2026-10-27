import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import merged_branch as feature


class MergedBranchTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.cwd = os.getcwd()
        os.chdir(self.repo)
        self.env = patch.dict(os.environ, {'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'})
        self.env.start()
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')
        (self.repo / 'avatar.js').write_text('before\n')
        self.commit('initial')
        self.git('checkout', '-qb', 'old-topic')
        (self.repo / 'avatar.js').write_text('merged\n')
        self.commit('merged change')
        self.merged_head = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-q', 'main')
        self.git('merge', '--squash', 'old-topic')
        self.git('commit', '-qm', 'squashed PR')
        self.merge_commit = self.git('rev-parse', 'HEAD')
        (self.repo / 'upstream.txt').write_text('new upstream work\n')
        self.commit('advance main')
        self.base = self.git('rev-parse', 'HEAD')
        self.git('clone', '--bare', '-q', '.', str(self.root / 'remote'))
        self.git('remote', 'add', 'origin', str(self.root / 'remote'))
        self.git('checkout', '-q', 'old-topic')
        (self.repo / 'avatar.js').write_text('merged\nfollow-up\n')
        self.commit('placeholder_0123456789abcdef')
        self.tip = self.git('rev-parse', 'HEAD')
        self.info = {'branch': 'old-topic', 'head': self.merged_head, 'number': 61,
                     'defaultBranch': 'main', 'remote': 'origin', 'mergeCommit': self.merge_commit}

    def tearDown(self):
        os.chdir(self.cwd)
        self.env.stop()
        self.directory.cleanup()

    def git(self, *args):
        return subprocess.check_output(['/usr/bin/git', *args], stderr=subprocess.PIPE, text=True).strip()

    def commit(self, title):
        self.git('add', '.')
        self.git('commit', '-qm', title)

    def test_followup_uses_fetched_main_and_only_extra_changes_without_committing_or_staging(self):
        job_dir = self.root / 'job'
        job_dir.mkdir()
        job = {'id': 'pending', 'branch': 'rextension/heads/old-topic', 'push': True, 'phase': 'generating'}
        (job_dir / 'job.json').write_text(json.dumps(job))
        (self.repo / '.git/sweetiebot-background-commit.json').write_text(json.dumps({'directory': str(job_dir)}))
        with patch.object(feature, 'merged_status', return_value=self.info):
            feature.carry_to_new_branch('fresh')
        self.assertEqual(self.git('branch', '--show-current'), 'fresh')
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.base)
        self.assertEqual(self.git('rev-parse', 'old-topic'), self.tip)
        self.assertEqual(self.git('diff', '--name-only'), 'avatar.js')
        self.assertEqual(self.git('diff', '--cached', '--name-only'), '')
        self.assertEqual((self.repo / 'avatar.js').read_text(), 'merged\nfollow-up\n')
        self.assertTrue((self.repo / 'upstream.txt').exists())
        self.assertFalse(json.loads((job_dir / 'job.json').read_text())['push'])

    def test_conflict_leaves_original_branch_files_and_index_untouched(self):
        self.git('checkout', '-q', 'main')
        (self.repo / 'avatar.js').write_text('incompatible upstream\n')
        self.commit('conflicting update')
        self.git('push', '-q', 'origin', 'main')
        self.git('checkout', '-q', 'old-topic')
        with patch.object(feature, 'merged_status', return_value=self.info):
            with self.assertRaises(RuntimeError):
                feature.carry_to_new_branch('fresh')
        self.assertEqual(self.git('branch', '--show-current'), 'old-topic')
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.tip)
        self.assertEqual(self.git('status', '--porcelain'), '')

    def test_staged_and_untracked_work_is_preserved(self):
        (self.repo / 'avatar.js').write_text('draft\n')
        self.git('add', 'avatar.js')
        (self.repo / 'notes.txt').write_text('unsaved idea\n')
        before = self.git('status', '--porcelain')
        with patch.object(feature, 'merged_status', return_value=self.info):
            with self.assertRaisesRegex(RuntimeError, 'staged'):
                feature.carry_to_new_branch('fresh')
        self.assertEqual(self.git('status', '--porcelain'), before)
        self.assertEqual((self.repo / 'notes.txt').read_text(), 'unsaved idea\n')

    def test_push_guard_rejects_merged_branch(self):
        with patch.object(feature, 'merged_status', return_value=self.info):
            with self.assertRaises(feature.MergedBranchPush):
                feature.require_unmerged('old-topic', 'origin')

    def test_unstaged_edits_and_untracked_files_follow_the_new_branch(self):
        (self.repo / 'avatar.js').write_text('merged\nfollow-up\nlocal draft\n')
        (self.repo / 'notes.txt').write_text('untracked draft\n')
        with patch.object(feature, 'merged_status', return_value=self.info):
            feature.carry_to_new_branch('fresh')
        self.assertEqual((self.repo / 'avatar.js').read_text(), 'merged\nfollow-up\nlocal draft\n')
        self.assertEqual((self.repo / 'notes.txt').read_text(), 'untracked draft\n')
        self.assertEqual(self.git('diff', '--cached', '--name-only'), '')

    def test_incoming_path_cannot_overwrite_an_untracked_file(self):
        (self.repo / 'upstream.txt').write_text('local untracked work\n')
        with patch.object(feature, 'merged_status', return_value=self.info):
            with self.assertRaises(RuntimeError):
                feature.carry_to_new_branch('fresh')
        self.assertEqual(self.git('branch', '--show-current'), 'old-topic')
        self.assertEqual((self.repo / 'upstream.txt').read_text(), 'local untracked work\n')


if __name__ == '__main__':
    unittest.main()
