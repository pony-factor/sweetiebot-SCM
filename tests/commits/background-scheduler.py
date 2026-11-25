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


class BackgroundCommitSchedulerTests(BackgroundCommitFixture):
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
        self.assert_no_placeholder_titles(remote)
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
            self.assert_no_placeholder_titles(remote_tip)
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
import importaliases
importaliases.install()
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

    def test_manual_title_between_active_generated_titles_backfills_in_order(self):
        first = self.queue(message='', push=True)
        started, release = self.root / 'first-title-started', self.root / 'release-first-title'
        script = '''
import sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import importaliases
importaliases.install()
import background_commit as worker
calls = 0
def generate(*args, **kwargs):
    global calls
    calls += 1
    if calls == 1:
        Path(sys.argv[2]).touch()
        deadline = time.monotonic() + 20
        while not Path(sys.argv[3]).exists():
            if time.monotonic() > deadline: raise RuntimeError('Test release timed out')
            time.sleep(.02)
        return '🧪 Finish first automatic title', ''
    return '🧪 Finish last automatic title', ''
worker.core.generate_message = generate
worker.resume(parallel=False)
'''
        child = subprocess.Popen([sys.executable, '-c', script,
                                  str(Path(worker.__file__).parent), str(started), str(release)])
        try:
            deadline = time.monotonic() + 10
            while not started.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(started.exists(), 'the first title generator must be active')

            (self.repo / 'story.txt').write_text('Manual middle change\n')
            self.git('add', 'story.txt')
            manual_message = ('🧪 Preserve middle manual title\n\n'
                              'Co-authored-by: Codex <noreply@openai.com>')
            middle = self.queue(message=manual_message, push=True)

            (self.repo / 'story.txt').write_text('Last automatic change\n')
            self.git('add', 'story.txt')
            last = self.queue(message='', push=True)
            original = [self.job(directory) for directory in (first, middle, last)]
            self.assertTrue(original[0]['provisional'])
            self.assertFalse(original[1].get('provisional', False))
            self.assertTrue(original[2]['provisional'])
            self.assertIsNone(child.poll(), 'both later commits must queue during first generation')
            self.assertEqual(self.git('--git-dir=' + str(self.root / 'remote'),
                                      'for-each-ref'), '', 'never publish unfinished titles')

            release.touch()
            self.assertEqual(child.wait(timeout=25), 0)
            expected = ['🧪 Finish first automatic title', '🧪 Preserve middle manual title',
                        '🧪 Finish last automatic title']
            self.assertEqual(self.git('log', '--reverse', '--format=%s'), '\n'.join(expected))
            self.assertEqual(self.git('rev-list', '--count', 'HEAD'), '3')
            directories = (first, middle, last)
            for index, directory in enumerate(directories):
                job = self.job(directory)
                self.assertEqual(job['phase'], 'done')
                self.assertNotEqual(job['sha'], original[index]['sha'])
                self.assertEqual(self.git('show', '-s', '--format=%T', job['sha']),
                                 original[index]['tree'])
                if index:
                    self.assertEqual(self.git('show', '-s', '--format=%P', job['sha']),
                                     self.job(directories[index - 1])['sha'])
            self.assertEqual(self.git('show', '-s', '--format=%B', self.job(middle)['sha']),
                             manual_message, 'backfilling must not replace manual text or trailer')
            remote_tip = self.git('--git-dir=' + str(self.root / 'remote'),
                                  'rev-parse', 'refs/heads/main')
            self.assertEqual(remote_tip, self.git('rev-parse', 'HEAD'))
            self.assert_no_placeholder_titles(remote_tip)
            self.assertFalse((self.repo / '.git' / worker.MARKER).exists())
        finally:
            release.touch()
            child.wait(timeout=25)

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
        self.assert_no_placeholder_titles()
    def test_offline_earlier_push_does_not_block_later_title_or_push(self):
        first = self.queue(message='', push=True)
        (self.repo / 'story.txt').write_text('Second snapshot\n')
        self.git('add', 'story.txt')
        second = self.queue(message='', push=True)
        original_tip = self.git('rev-parse', 'HEAD')
        (self.root / 'remote').rename(self.root / 'offline')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 First final title', '')):
            worker.work(first)
        # Never rewrite a provisional commit while publication cannot be checked.
        # Preserve the generated title so a later retry needs no model request.
        blocked = self.job(first)
        self.assertEqual(blocked['phase'], 'blocked')
        self.assertTrue(blocked['provisional'])
        self.assertIn('Cannot verify whether queued commits are published', blocked['error'])
        self.assertEqual(self.git('rev-parse', 'HEAD'), original_tip)
        (self.root / 'offline').rename(self.root / 'remote')
        with patch.object(worker.core, 'generate_message',
                          side_effect=AssertionError('Ready title must not regenerate')):
            worker.work(first)
        self.assertEqual(self.job(first)['phase'], 'done')
        with patch.object(worker.core, 'generate_message', return_value=('🧪 Second final title', '')):
            worker.work(second)
        self.assertEqual(self.job(second)['phase'], 'done')
        self.assertFalse((self.repo / '.git' / worker.MARKER).exists())
        remote_tip = self.git('--git-dir=' + str(self.root / 'remote'), 'rev-parse', 'refs/heads/main')
        self.assertEqual(remote_tip, self.git('rev-parse', 'HEAD'))
        self.assert_no_placeholder_titles(remote_tip)
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
        self.assert_no_placeholder_titles()
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
            worker.install_agent(Path('/stable/runtime/background-commit.py'))
        agent = self.root / 'Library/LaunchAgents' / (worker.LABEL + '.plist')
        data = plistlib.loads(agent.read_bytes())
        self.assertTrue(data['RunAtLoad'])
        self.assertEqual(data['StartInterval'], 60)
        self.assertEqual(data['ProgramArguments'][1:], ['/stable/runtime/background-commit.py', '--resume'])

if __name__ == "__main__":
    unittest.main()
