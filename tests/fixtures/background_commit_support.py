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


class BackgroundCommitFixture(unittest.TestCase):
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

    def assert_no_placeholder_titles(self, *revisions):
        subjects = self.git('log', '--format=%s', *revisions).splitlines()
        for subject in subjects:
            self.assertIsNone(worker.re.fullmatch(worker.PLACEHOLDER_SUBJECT_PATTERN, subject), subject)

    def queue(self, **request):
        result = worker.enqueue({'message': '🧪 Record captured change', **request}, start=False)
        directory = self.root / 'jobs' / result['id']
        return directory

    def job(self, directory):
        return json.loads((directory / 'job.json').read_text())

    def approved_snapshot(self):
        """Model the validated metrics emitted by the VS Code preflight."""
        raw = subprocess.check_output(['/usr/bin/git', 'diff', '--cached', '--no-ext-diff', '--no-color'])
        names = [name for name in self.git('diff', '--cached', '--name-only', '-z').split('\x00') if name]
        files = [{'path': name, 'size': int(self.git('cat-file', '-s', ':' + name))}
                 for name in names]
        parent = subprocess.run(['/usr/bin/git', 'rev-parse', '--verify', 'HEAD'],
                                capture_output=True, text=True).stdout.strip()
        lines = raw.count(b'\n') + int(bool(raw) and not raw.endswith(b'\n'))
        return {
            'version': 1, 'tree': self.git('write-tree'), 'parent': parent,
            'files': files,
            'diff': {'totalBytes': len(raw), 'totalLines': lines,
                     'sections': [{'bytes': len(raw), 'lines': lines}] if raw else []},
            'approvedWarnings': [],
        }

    def published_blocked_job(self):
        directory = self.queue(push=True)
        self.git('commit', '--allow-empty', '-qm', 'External follow-up')
        self.git('push', '-q', 'origin', 'main')
        job = self.job(directory)
        job.update(phase='blocked', error='The branch advanced outside the queued commits; background work was paused.')
        worker.write_journal(directory / 'job.json', job)
        return directory

    def deleted_branch_job(self, publish=False):
        directory = self.queue(push=True)
        job = self.job(directory)
        if publish:
            self.git('push', '-q', 'origin', 'main')
        replacement = self.git('commit-tree', 'HEAD^{tree}', input='Independent branch\n')
        self.git('checkout', '-qb', 'replacement', replacement)
        self.git('branch', '-D', 'main')
        job.update(phase='blocked', error='The branch advanced outside the queued commits; background work was paused.')
        worker.write_journal(directory / 'job.json', job)
        return directory

    def external_merge_after_queue(self):
        directory = self.queue(push=True)
        self.git('branch', 'side')
        self.git('commit', '--allow-empty', '-qm', 'External main follow-up')
        self.git('checkout', '-q', 'side')
        self.git('commit', '--allow-empty', '-qm', 'External side follow-up')
        self.git('checkout', '-q', 'main')
        self.git('merge', '--no-ff', '-qm', 'External reconciliation', 'side')
        return directory

    def superseded_blocked_job(self):
        self.git('commit', '-qm', 'Base')
        self.git('push', '-q', '-u', 'origin', 'main')
        base = self.git('rev-parse', 'HEAD')
        (self.repo / 'story.txt').write_text('Old queued change\n')
        self.git('add', 'story.txt')
        directory = self.queue(push=True)
        job = self.job(directory)
        job.update(phase='blocked', error='The branch advanced outside the queued commits; background work was paused.')
        worker.write_journal(directory / 'job.json', job)
        self.git('reset', '--hard', base)
        return directory

    def saved_retention_job(self, name, phase, age_days, now, **extra):
        directory = self.root / 'jobs' / name
        directory.mkdir(parents=True)
        worker.write_journal(directory / 'job.json', dict(
            id=name, gitdir=str(self.repo / '.git'), phase=phase, **extra))
        timestamp = now - age_days * 86400
        os.utime(directory / 'job.json', (timestamp, timestamp))
        return directory

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

    def assert_published_title_archived(self, directory, original_sha, title):
        job = self.job(directory)
        self.assertEqual(job['phase'], 'done')
        self.assertFalse(job['provisional'])
        self.assertTrue(job['published_title_unapplied'])
        self.assertEqual(job['sha'], original_sha)
        self.assertEqual(job['suggested_message'], title)
        self.assertIn('not changed', job['title_warning'])
        self.assertEqual(self.git('notes', '--ref=' + worker.TITLE_NOTES,
                                  'show', original_sha), title)
        self.assertRegex(self.git('show', '-s', '--format=%s', original_sha),
                         worker.PLACEHOLDER_SUBJECT_PATTERN)

    def reject_initial_commit(self):
        hook = self.repo / '.git' / 'hooks' / 'pre-commit'
        hook.write_text('#!/bin/sh\necho "husky - pre-commit hook failed" >&2\nexit 1\n')
        hook.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, 'Git commit failed'):
            self.queue(message='')
        entry = worker.queue_entries(self.repo / '.git' / worker.MARKER)[0]
        return hook, Path(entry['directory'])

    def check_divergent_push(self, conflict, dirty=True, descendants=False, crash=None, signed=False):
        lindsey = Path(os.environ.get('LINDSEY_SYNC_REPO', Path(__file__).resolve().parents[3] / 'lindsey-sync'))
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
import importaliases
importaliases.install()
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
