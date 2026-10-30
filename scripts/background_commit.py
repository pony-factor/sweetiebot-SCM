"""Durable staged commits and optional pushes, independent of VS Code."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile
import shutil
import time
from contextlib import contextmanager, nullcontext

import ai_commit as core
from sweetiebot_async_commit import (write_journal as _write_journal, read_journal,
                                    get_placeholder_prefix, alive, related_pending_jobs, new_job_id,
                                    BASE58_ID_PATTERN, PLACEHOLDER_SUBJECT_PATTERN)
from sweetiebot_diagnostics import log_event

MARKER = 'sweetiebot-background-commit.json'
LABEL = 'dev.ponyfactor.sweetiebot-commits'
TRANSACTION = 'sweetiebot-background-finalization.json'
FORKS = 'sweetiebot-background-forks.json'
TITLE_NOTES = 'refs/notes/sweetiebot-published-titles'
PARALLEL_JOBS = 6
COMPLETED_JOB_RETENTION_DAYS = 60


def transient_network_error(error):
    message = str(error).lower()
    return any(fragment in message for fragment in (
        'tls handshake timeout', 'i/o timeout', 'connection timed out',
        'connection reset by peer', 'temporary failure in name resolution',
        'could not resolve host', 'network is unreachable',
    ))


def retry_network_read(operation):
    # Retry only the read-only pre-push guard; never repeat a commit or merge.
    for attempt in range(4):
        try:
            return operation()
        except RuntimeError as error:
            if not transient_network_error(error):
                raise
            if attempt == 3:
                error.network_retries_exhausted = True
                raise
            time.sleep(2 ** attempt)


class SyncConflicts(RuntimeError):
    def __init__(self, paths):
        self.paths = paths
        super().__init__('Lindsey sync found merge conflicts: ' + ', '.join(paths)
                         + '. Your local commit and working files are preserved. '
                         'Stop the background push before resolving these conflicts.')


@contextmanager
def repository_lock(meta):
    with (Path(meta) / (MARKER + '.lock')).open('a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


@contextmanager
def branch_sync_lock(meta, branch):
    name = 'sweetiebot-sync-' + hashlib.sha256(branch.encode()).hexdigest() + '.lock'
    with (Path(meta) / name).open('a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def queue_entries(marker):
    owner = read_journal(marker)
    return owner.get('jobs', [owner]) if owner else []


def save_queue(marker, entries):
    # Keep completed descendants until earlier push retries finish, so the
    # queue still describes the complete local commit chain.
    while entries:
        job = read_journal(Path(entries[0]['directory']) / 'job.json')
        if not job or job['phase'] not in ('done', 'cancelled'):
            break
        entries = entries[1:]
    if entries:
        write_journal(marker, {**entries[0], 'jobs': entries})
    else:
        marker.unlink(missing_ok=True)


def recover_finalization(meta):
    """Replay the ref move and all descendant checkpoints after a crash."""
    file = Path(meta) / TRANSACTION
    transaction = read_journal(file)
    if not transaction:
        # Upgrade the previous single-job checkpoint if its CAS already landed.
        entries = queue_entries(Path(meta) / MARKER)
        if len(entries) == 1:
            journal = Path(entries[0]['directory']) / 'job.json'
            job = read_journal(journal)
            if job and job.get('replacement_sha') and branch_tip(job['branch']) == job['replacement_sha']:
                job.update(sha=job.pop('replacement_sha'), provisional=False, phase='committed')
                write_journal(journal, job)
        return
    moves = transaction.get('refs', [transaction])
    commands = ['start']
    for move in moves:
        actual = branch_tip(move['branch'])
        if actual not in (move['before'], move['after']):
            raise RuntimeError('The branch changed during message finalization; recovery was paused.')
        if transaction.get('checkout') and actual != move['after'] and move['branch'] == transaction['branch']:
            env = os.environ.copy()
            env.pop('GIT_INDEX_FILE', None)
            active = git('symbolic-ref', '--quiet', 'HEAD', check=False, env=env).stdout.strip()
            if active == move['branch']:
                # Two-tree checkout refuses overlapping edits and is replayable
                # if a crash occurs before the compare-and-swap below.
                result = git('read-tree', '-u', '-m', move['before'], move['after'],
                             check=False, env=env)
                if result.returncode:
                    raise RuntimeError('Local edits changed during Lindsey sync; publication was paused.')
        commands.append(f"update {move['branch']} {move['after']} {actual}")
    commands += ['prepare', 'commit']
    git('update-ref', '-m', 'sweetiebot: finalize queued commit messages', '--stdin',
        input='\n'.join(commands) + '\n')
    for update in transaction['updates']:
        journal = Path(update['directory']) / 'job.json'
        job = read_journal(journal)
        job.update(update['values'])
        job.pop('replacement_sha', None)
        write_journal(journal, job)
        if 'tree' in update['values']:
            git('update-ref', 'refs/sweetiebot/jobs/' + job['id'], job['tree'])
    if 'forks' in transaction:
        write_journal(Path(meta) / FORKS, transaction['forks'])
    file.unlink()


def fork_branch(source, name, expected_head, destination=None, expected_tip=None):
    """Capture a pending base and its subscription under the finalizer's lock."""
    meta = Path(git('rev-parse', '--absolute-git-dir'))
    with repository_lock(meta):
        recover_finalization(meta)
        if state()[0] != expected_head:
            raise RuntimeError('The active branch changed while preparing the new branch.')
        if expected_tip and branch_tip(expected_head) != expected_tip:
            raise RuntimeError('The original branch advanced before the recovery fork. Review its commits.')
        if (meta / 'sweetiebot-async-commit.json').exists():
            raise RuntimeError('Wait for the existing commit message to finish before branching.')
        git('check-ref-format', '--branch', name)
        branch = 'refs/heads/' + name
        if branch_tip(branch):
            raise RuntimeError('The new branch already exists.')
        base = git('rev-parse', '--verify', source + '^{commit}')
        # Reject orphaned placeholders: there must be a live job to finish them.
        jobs = [read_journal(Path(entry['directory']) / 'job.json')
                for entry in queue_entries(meta / MARKER)]
        pending = {job['sha'] for job in jobs if job and job.get('provisional')}
        for line in git('log', '--format=%H%x00%s', base).splitlines():
            sha, _, subject = line.partition('\x00')
            if (re.fullmatch(PLACEHOLDER_SUBJECT_PATTERN, subject) and sha not in pending
                    and git('notes', '--ref=' + TITLE_NOTES, 'show', sha,
                            check=False).returncode):
                raise RuntimeError('The branch base contains an unfinished commit without a background job.')
        forks = read_journal(meta / FORKS) or {}
        forks[branch] = base
        # Save before creating the ref: a crash must never leave an untracked fork.
        write_journal(meta / FORKS, forks)
        if destination:
            git('worktree', 'add', '-b', name, '--', destination, base)
        else:
            git('checkout', '-b', name, base)
        return base



def linear_branch_extension(previous, actual):
    """Only accept unchanged queued history with plain single-parent descendants.

    Merges, resets, rewritten commits, and untracked placeholders require manual
    reconciliation. Never rewrite a branch without verifying its ancestry.
    """
    error = 'The branch advanced outside the queued commits; background work was paused.'
    if actual == previous:
        return []
    if not actual or git('merge-base', '--is-ancestor', previous, actual, check=False).returncode:
        raise RuntimeError(error)
    extension = git('rev-list', '--reverse', previous + '..' + actual).splitlines()
    parent = previous
    for sha in extension:
        subject = git('show', '-s', '--format=%s', sha)
        if (git('show', '-s', '--format=%P', sha) != parent
                or re.fullmatch(PLACEHOLDER_SUBJECT_PATTERN, subject)):
            raise RuntimeError(error)
        parent = sha
    if parent != actual:
        raise RuntimeError(error)
    return extension


def remote_contains_commit(job, sha):
    """Check the configured remote before modifying a queued commit's identity.

    A published commit cannot be retitled without rewriting its descendants.
    Fail closed if the remote is configured but its state cannot be verified.
    """
    remote, destination = job.get('remote'), job.get('destination')
    if not remote or not destination or git('remote', 'get-url', remote, check=False).returncode:
        return False
    error = ('Cannot verify whether queued commits are published; '
             'background finalization was paused to preserve shared history.')
    try:
        result = git('ls-remote', '--refs', remote, destination, check=False, timeout=8)
    except subprocess.TimeoutExpired:
        raise RuntimeError(error) from None
    if result.returncode:
        raise RuntimeError(error)
    rows = [line.split() for line in result.stdout.splitlines()]
    if not rows:
        return False
    if len(rows) != 1 or len(rows[0]) != 2 or rows[0][1] != destination:
        raise RuntimeError(error)
    tip = rows[0][0]
    if not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', tip):
        raise RuntimeError(error)
    if git('cat-file', '-e', tip + '^{commit}', check=False).returncode:
        result = git('fetch', '--no-tags', '--no-write-fetch-head', remote, tip,
                     check=False, timeout=8)
        if result.returncode:
            raise RuntimeError(error)
    return git('merge-base', '--is-ancestor', sha, tip, check=False).returncode == 0


def require_unpublished_extension(job, extension):
    """Never reparent already-published external descendants."""
    if extension and remote_contains_commit(job, extension[0]):
        raise RuntimeError('Later commits are already published upstream. SweetieBot cannot '
                           'replace an earlier provisional commit message without rewriting '
                           'that published history; no force-push was attempted.')

def captured_chain(marker, branch, *, allow_extension=False, allow_finalized_advance=False):
    entries = [entry for entry in queue_entries(marker)
               if read_journal(Path(entry['directory']) / 'job.json')['branch'] == branch]
    jobs = [read_journal(Path(entry['directory']) / 'job.json') for entry in entries]
    actual = branch_tip(branch)
    if not jobs or any(not job or not job.get('sha') or job['branch'] != branch for job in jobs):
        raise RuntimeError('A queued local commit is incomplete or its branch changed.')
    previous = jobs[0]['parent']
    for job in jobs:
        if (job['parent'] != previous
                or git('show', '-s', '--format=%P', job['sha']) != previous
                or git('show', '-s', '--format=%T', job['sha']) != job['tree']):
            raise RuntimeError('The queued commit chain changed; background work was paused.')
        previous = job['sha']
    if actual != previous:
        if not allow_extension:
            raise RuntimeError('The branch advanced outside the queued commits; background work was paused.')
        if (allow_finalized_advance and all(not job.get('provisional')
                and not job.get('replacement_sha') for job in jobs)):
            # Publication does not rename or reparent commits. A completed queued
            # chain may be followed by ordinary external commits or merges.
            if (not actual or git('merge-base', '--is-ancestor', previous, actual,
                                  check=False).returncode):
                raise RuntimeError('The branch advanced outside the queued commits; background work was paused.')
            subjects = git('log', '--format=%s', previous + '..' + actual).splitlines()
            if any(re.fullmatch(PLACEHOLDER_SUBJECT_PATTERN, subject)
                   for subject in subjects):
                raise RuntimeError('The branch contains unfinished commit messages; background work was paused.')
        else:
            linear_branch_extension(previous, actual)
    return entries, jobs


def write_journal(path, value):
    _write_journal(path, value)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def jobs_home():
    return Path(os.environ.get('SWEETIEBOT_COMMIT_JOBS',
        '~/Library/Application Support/Sweetiebot/commit-jobs')).expanduser()


def git(*args, check=True, **kwargs):
    result = subprocess.run([core.REAL_GIT, *args], capture_output=True, text=True, **kwargs)
    if check and result.returncode:
        # Raw Git output can contain private diffs, URLs, or hook output.
        raise RuntimeError('Git operation failed; inspect the repository before retrying.')
    return result.stdout.strip() if check else result


def branch_tip(branch):
    return git('rev-parse', '--verify', branch, check=False).stdout.strip()


def state():
    return (git('symbolic-ref', '--quiet', 'HEAD'),
            git('rev-parse', '--verify', 'HEAD', check=False).stdout.strip())


def runtime():
    target = jobs_home() / 'runtime'
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ('background_commit.py', 'ai_commit.py', 'sweetiebot_async_commit.py',
                 'sweetiebot_diagnostics.py', 'post_commit_spellcheck.py', 'merged_branch.py'):
        source = Path(__file__).with_name(name)
        if source.resolve() == (target / name).resolve():
            continue
        fd, temporary = tempfile.mkstemp(dir=target)
        try:
            with os.fdopen(fd, 'wb') as output:
                output.write(source.read_bytes())
            os.replace(temporary, target / name)
        finally:
            Path(temporary).unlink(missing_ok=True)
    pony_source = Path(__file__).with_name('pony_git_publish.js')
    if not pony_source.exists():
        pony_source = Path(__file__).resolve().parent.parent / 'extension' / 'commits' / 'pony_git_publish.js'
    if pony_source.resolve() != (target / pony_source.name).resolve():
        fd, temporary = tempfile.mkstemp(dir=target)
        try:
            with os.fdopen(fd, 'wb') as output:
                output.write(pony_source.read_bytes())
            os.replace(temporary, target / pony_source.name)
        finally:
            Path(temporary).unlink(missing_ok=True)
    return target / 'background_commit.py'

def enqueue_pony(request, start=True):
    """Durably accept one new profile without capturing or staging the user index."""
    pony = request.get('pony') or {}
    pack = str(pony.get('packId', '')).strip().lower()
    slug = str(pony.get('canonicalSlug') or pony.get('slug', '')).strip().lower()
    if pack == 'g4-stallions' and slug == 'hoofar':
        slug = 'hoo-far'
    if not all(re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,127}', value) for value in (pack, slug)):
        raise ValueError('Invalid pony identity.')
    stored = f'{pack}/{slug}.json'
    if request.get('path') != stored:
        raise ValueError('Unexpected pony profile path.')
    root = str(Path(git('rev-parse', '--show-toplevel')).resolve())
    meta = Path(git('rev-parse', '--absolute-git-dir'))
    relative = 'ponies/' + stored
    profile = Path(root) / relative
    if not profile.is_file() or profile.is_symlink():
        raise ValueError('The pony profile must be a regular file.')
    # This path is exclusively a validated pony record, never an arbitrary file.
    record = json.loads(profile.read_text())
    if (record.get('packId') != pack or record.get('slug') != slug
            or not isinstance(record.get('profile'), str) or not record['profile'].strip()):
        raise ValueError('Pony profile identity does not match its path.')
    with repository_lock(meta):
        status = git('status', '--porcelain=1', '--untracked-files=all', '--', relative)
        receipt = meta / 'sweetiebot-pony-publish' / f'{pack}--{slug}.json'
        if status not in (f'?? {relative}', f'A  {relative}') and not receipt.exists():
            return {'queued': False, 'reason': 'existing-profile-preserved'}
        job_id = 'pony-' + hashlib.sha256((root + '\0' + stored).encode()).hexdigest()[:24]
        directory = jobs_home() / job_id
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        job = read_journal(directory / 'job.json')
        if not job or job.get('phase') == 'done':
            node = shutil.which('node') or next((str(candidate) for candidate in
                (Path('/opt/homebrew/bin/node'), Path('/usr/local/bin/node')) if candidate.is_file()), None)
            if not node:
                raise RuntimeError('Node is unavailable for pony publication.')
            job = dict(id=job_id, kind='pony-profile', root=root, gitdir=str(meta),
                       branch='refs/heads/main', pony=dict(packId=pack, slug=slug), path=stored,
                       node=node, phase='queued', attempts=0, nextAttemptAt=0)
            write_journal(directory / 'job.json', job)
    if start:
        script = runtime()
        install_agent(script)
        # The shared scheduler resumes earlier title/push jobs before pony jobs.
        subprocess.Popen([sys.executable, str(script), '--resume'], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True, close_fds=True)
    return {'queued': True, 'id': job_id}


def work_pony(directory):
    """Use the existing scheduler and repository lock for scoped pony publication."""
    with (directory / 'worker.lock').open('a+b') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        file = directory / 'job.json'
        job = read_journal(file)
        if not job or job['phase'] in ('done', 'cancelled') or job.get('nextAttemptAt', 0) > time.time():
            return
        previous_cwd = os.getcwd()
        try:
            os.chdir(job['root'])
            if git('rev-parse', '--absolute-git-dir') != job['gitdir']:
                raise RuntimeError('Repository metadata changed.')
            with repository_lock(job['gitdir']):
                if queue_entries(Path(job['gitdir']) / MARKER) or (Path(job['gitdir']) / 'sweetiebot-async-commit.json').exists():
                    job.update(phase='waiting', error='Waiting for the existing background commit and push.',
                               nextAttemptAt=time.time() + 60)
                    write_journal(file, job)
                    return
                helper = Path(__file__).with_name('pony_git_publish.js')
                if not helper.exists():
                    helper = Path(__file__).resolve().parent.parent / 'extension' / 'commits' / 'pony_git_publish.js'
                env = os.environ.copy()
                env.pop('GIT_INDEX_FILE', None)
                env['GIT_TERMINAL_PROMPT'] = '0'
                env['SCM_TOOLKIT_REAL_GIT'] = core.REAL_GIT
                result = subprocess.run([job['node'], str(helper)],
                    input=json.dumps(dict(directory=job['root'], pony=job['pony'], path=job['path'])),
                    capture_output=True, text=True, env=env, timeout=300)
                if result.returncode:
                    # The helper emits only its controlled error messages, not raw Git output.
                    raise RuntimeError(result.stderr.strip() or 'Pony publication will retry.')
                publication = json.loads(result.stdout)
                job.update(phase='done', publication=publication, nextAttemptAt=0)
                job.pop('error', None)
                write_journal(file, job)
        except Exception as error:
            attempts = job.get('attempts', 0) + 1
            job.update(phase='retrying', error=str(error), attempts=attempts,
                       nextAttemptAt=time.time() + min(60 * 2 ** min(attempts - 1, 3), 300))
            write_journal(file, job)
        finally:
            os.chdir(previous_cwd)


def install_agent(script):
    if sys.platform != 'darwin':
        return
    agent = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    if agent.is_symlink():
        raise RuntimeError('Refusing a symlinked commit worker agent.')
    definition = {'Label': LABEL, 'ProgramArguments': [sys.executable, str(script), '--resume'],
                  'RunAtLoad': True, 'StartInterval': 60,
                  'StandardOutPath': '/dev/null', 'StandardErrorPath': '/dev/null'}
    agent.parent.mkdir(parents=True, exist_ok=True)
    agent.write_bytes(plistlib.dumps(definition))
    agent.chmod(0o600)
    service = f'gui/{os.getuid()}/{LABEL}'
    if subprocess.run(['/bin/launchctl', 'print', service], capture_output=True).returncode:
        subprocess.run(['/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', str(agent)],
                       check=True, capture_output=True)


def prepare_staged_preflight():
    """Normalize the staged index under the queue lock before size inspection."""
    meta = Path(git('rev-parse', '--absolute-git-dir'))
    with repository_lock(meta):
        if core.staged_whitespace_enabled():
            core.normalize_staged_final_newlines()
        return {'stagedTree': git('write-tree')}


def validated_preflight_files(snapshot, tree, parent):
    """Consume an approved VS Code snapshot only for its exact tree and HEAD.

    A verified source snapshot avoids another Git blob-size walk during
    oversized-commit splitting. Its shape is checked before any local commit.
    """
    if not isinstance(snapshot, dict) or snapshot.get('version') != 1:
        raise ValueError('Invalid staged-inspection snapshot.')
    if snapshot.get('tree') != tree or snapshot.get('parent') != parent:
        raise RuntimeError('Staged changes changed after the commit-size check. Review and retry.')
    entries = snapshot.get('files')
    diff = snapshot.get('diff')
    warnings = snapshot.get('approvedWarnings')
    if (not isinstance(entries, list) or len(entries) > 100_000
            or not isinstance(diff, dict) or not isinstance(warnings, list)
            or len(warnings) > 20 or any(not isinstance(w, str) or len(w) > 500 for w in warnings)):
        raise ValueError('Invalid staged-inspection snapshot.')
    if (any(not isinstance(diff.get(key), int) or isinstance(diff[key], bool) or diff[key] < 0
            for key in ('totalBytes', 'totalLines'))
            or not isinstance(diff.get('sections'), list)
            or len(diff['sections']) > 100_000
            or any(not isinstance(section, dict)
                   or any(not isinstance(section.get(key), int)
                          or isinstance(section[key], bool) or section[key] < 0
                          for key in ('bytes', 'lines'))
                   for section in diff['sections'])):
        raise ValueError('Invalid staged-inspection diff metrics.')
    files = []
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {'path', 'size'}:
            raise ValueError('Invalid staged-inspection file metadata.')
        path, size = entry['path'], entry['size']
        if (not isinstance(path, str) or not path or '\x00' in path
                or not isinstance(size, int) or isinstance(size, bool) or size < 0
                or path in seen):
            raise ValueError('Invalid staged-inspection file metadata.')
        seen.add(path)
        files.append((path, size))
    # Names are inexpensive to verify and prevent a malformed snapshot from
    # omitting a file, while the expensive blob-size query is never repeated.
    current = [name for name in git('diff', '--cached', '--name-only', '-z').split('\x00') if name]
    if current != [path for path, _ in files]:
        raise RuntimeError('Staged changes changed after the commit-size check. Review and retry.')
    if diff['totalLines'] > diff['totalBytes'] + 1:
        raise ValueError('Invalid staged-inspection diff metrics.')
    if sum(part['bytes'] for part in diff['sections']) > diff['totalBytes']:
        raise ValueError('Invalid staged-inspection diff metrics.')
    return files


def enqueue(request, start=True):
    root = git('rev-parse', '--show-toplevel')
    meta = Path(git('rev-parse', '--absolute-git-dir'))
    marker = meta / MARKER
    with (meta / (MARKER + '.lock')).open('a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        branch, parent = state()
        dependencies = related_pending_jobs(core.REAL_GIT, [])
        # A branch explicitly forked under the background finalizer may queue
        # descendants of its inherited provisional commit. This is not an
        # unrelated branch: the recorded fork tip pins the allowed ancestry.
        fork_base = (read_journal(meta / FORKS) or {}).get(branch)
        def owns_pending_ancestor(record):
            job = record['job']
            if job.get('branch') == branch:
                return True
            return bool(fork_base and job.get('sha') and
                        git('merge-base', '--is-ancestor', job['sha'], fork_base,
                            check=False).returncode == 0)
        if any(record['kind'] == 'legacy' or record['directory'] != meta
               or not owns_pending_ancestor(record) for record in dependencies):
            raise RuntimeError('Wait for the existing commit message to finish before queuing another commit.')
        recover_finalization(meta)
        entries = queue_entries(marker)
        if any(read_journal(Path(entry['directory']) / 'job.json')['branch'] == branch
               for entry in entries):
            captured_chain(marker, branch)
        if any((meta / name).exists() for name in
               ('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply')):
            raise RuntimeError('Finish the current Git operation before queuing a commit.')
        message = request.get('message', '')
        context = request.get('context', '')
        trailer = request.get('trailer', '')
        description = request.get('description', '')
        if not all(isinstance(value, str) and '\x00' not in value
                   for value in (message, context, trailer, description)):
            raise ValueError('Invalid background commit request.')
        if trailer and ('\n' in trailer or not trailer.startswith('Co-authored-by: ')):
            raise ValueError('Invalid co-author trailer.')
        if not message.strip() and not core.feature_enabled():
            raise RuntimeError('Enter a commit message; automatic commit titles are disabled.')
        # The VS Code command inspected the exact staged tree once. Reject
        # later staged edits without rescanning its diff or blob sizes; this
        # also protects the time spent capturing optional Codex context.
        expected_tree = request.get('expectedTree')
        if expected_tree is not None:
            if (not isinstance(expected_tree, str)
                    or not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', expected_tree)):
                raise ValueError('Invalid approved staged-tree identifier.')
            if git('write-tree') != expected_tree:
                raise RuntimeError(
                    'Staged changes changed after the commit-size check. '
                    'Review the staged selection and retry the commit.'
                )
        normalized_tree = request.get('normalizedTree')
        if normalized_tree is not None:
            # Only the exact approved index can skip a second normalization.
            # Legacy and direct callers continue normalizing inside enqueue.
            if (not isinstance(normalized_tree, str)
                    or normalized_tree != expected_tree
                    or request.get('validatedSnapshot') is None):
                raise ValueError('Invalid pre-normalized staged-tree identifier.')
        elif core.staged_whitespace_enabled():
            core.normalize_staged_final_newlines()
        tree = git('write-tree')
        # Legacy normalization can modify the tree; never reuse its old
        # approval without another staged-tree verification.
        if expected_tree is not None and tree != expected_tree:
            raise RuntimeError(
                'Staged changes changed after the commit-size check. '
                'Review the staged selection and retry the commit.'
            )
        snapshot = request.get('validatedSnapshot')
        blob_sizes = None
        if snapshot is not None:
            if expected_tree is None:
                raise ValueError('A staged-inspection snapshot requires an approved tree.')
            blob_sizes = validated_preflight_files(snapshot, tree, parent)
        if not message.strip():
            if blob_sizes is None:
                files = [name for name in core.git_output(
                    'diff', '--cached', '--name-only', '-z').split('\x00') if name]
            else:
                files = [name for name, _ in blob_sizes]
            if not trailer and len(core.github_split_groups(files, blob_sizes)) > 1:
                return {'queued': False}  # Preserve the existing oversized-commit splitter.
        selected = request.get('paths')
        if selected is not None:
            if (not isinstance(selected, list) or not selected or len(selected) > 100
                    or any(not isinstance(name, str) or not name or Path(name).is_absolute()
                           or '..' in Path(name).parts or '\x00' in name or '\n' in name
                           or Path(name).suffix.lower() not in ('.md', '.mdx') for name in selected)):
                raise ValueError('Invalid reviewed spellcheck file selection.')
            entries_for_paths = git('--literal-pathspecs', 'ls-files', '--stage', '-z', '--', *selected)
            entries_list = [entry for entry in entries_for_paths.split('\x00') if entry]
            if {entry.partition('\t')[2] for entry in entries_list} != set(selected) or any(' 0\t' not in entry for entry in entries_list):
                raise RuntimeError('The reviewed spellcheck index entries changed.')
            with tempfile.TemporaryDirectory(prefix='sweetiebot-reviewed-index-') as temporary:
                env = os.environ.copy()
                env['GIT_INDEX_FILE'] = str(Path(temporary) / 'index')
                git('read-tree', parent, env=env)
                git('update-index', '-z', '--index-info', input=entries_for_paths + ('\x00' if not entries_for_paths.endswith('\x00') else ''), env=env)
                tree = git('write-tree', env=env)
        baseline = git('rev-parse', 'HEAD^{tree}', check=False).stdout.strip()
        if tree == baseline or not git('diff', '--cached', '--name-only'):
            raise RuntimeError('Stage the intended changes before queuing a commit.')
        upstream = git('for-each-ref', '--format=%(upstream:remotename)|%(upstream:remoteref)', branch)
        remote, _, destination = upstream.partition('|')
        tracking = bool(remote and destination)
        remote = remote or request.get('remote', 'origin')
        destination = destination or branch
        push = request.get('push') is True
        if push and (not isinstance(remote, str) or remote.startswith('-')
                     or git('remote', 'get-url', remote, check=False).returncode != 0):
            raise RuntimeError('Configure the push remote before queuing Commit & Push.')
        script = runtime()
        if start:
            install_agent(script)
        directory = jobs_home() / new_job_id()
        directory.mkdir(mode=0o700)
        job = dict(id=directory.name, root=root, gitdir=str(meta), branch=branch, parent=parent,
                   tree=tree, message=message, context=context[-6000:], trailer=trailer, description=description[:6000],
                   push=push, remote=remote, destination=destination, tracking=tracking,
                   sign=request.get('sign') is True, signoff=request.get('signoff') is True,
                   no_verify=request.get('noVerify') is True,
                   skip_spellcheck=request.get('skipSpellcheck') is True,
                   include_description=core.should_add_default_branch_description(),
                   phase='preparing', enqueue_pid=os.getpid())
        write_journal(directory / 'job.json', job)
        git('update-ref', 'refs/sweetiebot/jobs/' + job['id'], job['tree'])
        entries.append({'id': job['id'], 'directory': str(directory)})
        save_queue(marker, entries)
        # Finish Git's local commit before acknowledging the click. Only message
        # generation and publication belong in the detached worker.
        work(directory, commit_only=True)
        job = read_journal(directory / 'job.json')
        if job['phase'] == 'blocked' or not job.get('sha'):
            raise RuntimeError(job.get('error', 'Could not create the local commit.'))
    if start:
        try:
            subprocess.Popen([sys.executable, str(script), '--resume'], stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True, close_fds=True)
        except OSError:
            # The registered agent will pick up the already accepted job.
            log_event('background_commit', 'worker_start_pending', outcome='retry')
    return {'queued': True, 'id': job['id']}


def matches_commit(job, sha):
    if not sha:
        return False
    return (git('show', '-s', '--format=%T', sha) == job['tree']
            and git('show', '-s', '--format=%P', sha) == job['parent']
            and (git('show', '-s', '--format=%B', sha).strip() == job['message'].strip()
                 or git('reflog', '-1', '--format=%gs').startswith('sweetiebot-background:' + job['id'] + ':')))


def commit_has_signature(sha):
    """Inspect the existing commit, not just explicit VS Code signing flags.

    Git's commit-tree does not inherit commit.gpgsign like git commit does.
    An unsigned rewrite must never replace a locally signed provisional commit,
    or a signed descendant that needs a different parent.
    """
    headers = git('cat-file', '-p', sha).partition('\n\n')[0]
    return any(line.startswith(('gpgsig ', 'gpgsig-sha256 '))
               for line in headers.splitlines())


def rewritten_commit(job, parent, message):
    fields = git('show', '-s', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', job['sha']).split('\x00')
    env = os.environ.copy()
    for prefix, values in (('AUTHOR', fields[:3]), ('COMMITTER', fields[3:])):
        for key, value in zip(('NAME', 'EMAIL', 'DATE'), values):
            env['GIT_' + prefix + '_' + key] = value
    args = ['commit-tree', job['tree']]
    if parent:
        args += ['-p', parent]
    # The initial git commit honors commit.gpgsign and can be signed even when
    # the VS Code request did not include an explicit sign flag. Re-sign the
    # replacement (and every rewritten descendant) using local Git settings.
    signed = job['sign'] or commit_has_signature(job['sha'])
    if signed:
        args.append('-S')
    replacement = git(*args, input=message + '\n', env=env)
    if signed and not commit_has_signature(replacement):
        raise RuntimeError('Git returned an unsigned replacement for a signed commit.')
    return replacement


def finalize_message(directory, job):
    """Finalize one message and reparent its queued descendants atomically."""
    meta = Path(job['gitdir'])
    with repository_lock(meta):
        recover_finalization(meta)
        current = read_journal(directory / 'job.json')
        if not current.get('provisional'):
            job.update(current)
            return
        marker = meta / MARKER
        entries, jobs = captured_chain(marker, job['branch'], allow_extension=True)
        position = next(i for i, item in enumerate(jobs) if item['id'] == job['id'])
        if any(item.get('provisional') for item in jobs[:position]):
            raise RuntimeError('An earlier queued commit message must finish first.')
        before = branch_tip(current['branch'])
        extension = linear_branch_extension(jobs[-1]['sha'], before)
        if remote_contains_commit(current, current['sha']):
            # The provisional commit (not just the later web commits) is already
            # public. Preserve the exact shared SHA, tree, and descendants.
            # A local Git note makes the generated title recoverable without
            # changing the repository history or pushing a new commit.
            proposed = current['message']
            note = git('notes', '--ref=' + TITLE_NOTES, 'show', current['sha'],
                       check=False)
            if not note.returncode and note.stdout.strip() != proposed.strip():
                raise RuntimeError('A different saved title exists for this published commit.')
            if note.returncode:
                git('notes', '--ref=' + TITLE_NOTES, 'add', '-m', proposed,
                    current['sha'])
            original = git('show', '-s', '--format=%B', current['sha'])
            current.update(message=original, suggested_message=proposed,
                           published_title_unapplied=True, provisional=False,
                           phase='committed',
                           title_warning=('Generated title saved in local Git notes; '
                                          'the published commit message was not changed.'))
            write_journal(directory / 'job.json', current)
            job.update(current)
            log_event('background_commit', 'published_title_preserved',
                      outcome='warning')
            return
        require_unpublished_extension(current, extension)
        parent = current['parent']
        updates = []
        replacements = {}
        for entry, item in zip(entries[position:], jobs[position:]):
            message = current['message'] if item['id'] == job['id'] else git('show', '-s', '--format=%B', item['sha'])
            sha = rewritten_commit(item, parent, message)
            replacements[item['sha']] = sha
            values = {'sha': sha, 'parent': parent}
            if item['id'] == job['id']:
                values.update(provisional=False, phase='committed')
            updates.append({'directory': entry['directory'], 'values': values})
            parent = sha
        for sha in extension:
            item = dict(sha=sha, tree=git('show', '-s', '--format=%T', sha), sign=False)
            rewritten = rewritten_commit(item, parent, git('show', '-s', '--format=%B', sha))
            replacements[sha] = rewritten
            parent = rewritten
        if extension:
            # Preserve the old tip for recovery; the ref transaction uses CAS.
            git('update-ref', 'refs/sweetiebot/recovery/' + current['id'] + '/' + before, before)
        moves = [dict(branch=current['branch'], before=before, after=parent)]
        forks = read_journal(meta / FORKS) or {}
        remaining = dict(forks)
        while remaining:
            advanced = False
            for branch, base in list(remaining.items()):
                if base not in replacements:
                    continue
                tip = branch_tip(branch)
                if not tip or git('merge-base', '--is-ancestor', base, tip, check=False).returncode == 1:
                    forks.pop(branch, None)  # Deleted or deliberately reset fork.
                    del remaining[branch]
                    continue
                for sha in git('rev-list', '--reverse', base + '..' + tip).splitlines():
                    if sha in replacements:
                        continue
                    parents = git('show', '-s', '--format=%P', sha).split()
                    if len(parents) != 1 or parents[0] not in replacements:
                        raise RuntimeError('A fork contains merged or changed history; message finalization was paused.')
                    item = dict(sha=sha, tree=git('show', '-s', '--format=%T', sha), sign=False)
                    replacements[sha] = rewritten_commit(item, replacements[parents[0]],
                                                          git('show', '-s', '--format=%B', sha))
                moves.append(dict(branch=branch, before=tip, after=replacements[tip]))
                forks[branch] = replacements[base]
                del remaining[branch]
                advanced = True
            if not advanced:
                break
        updated = {entry['directory'] for entry in updates}
        for entry in queue_entries(marker):
            if entry['directory'] in updated:
                continue
            item = read_journal(Path(entry['directory']) / 'job.json')
            if item.get('sha') in replacements:
                updates.append(dict(directory=entry['directory'], values=dict(
                    sha=replacements[item['sha']], parent=replacements.get(item['parent'], item['parent']))))
        write_journal(meta / TRANSACTION, dict(branch=current['branch'], before=before,
                                             after=parent, updates=updates, refs=moves, forks=forks))
        recover_finalization(meta)
        job.update(read_journal(directory / 'job.json'))


def captured_diff(job):
    base = job['parent'] or git('hash-object', '-w', '-t', 'tree', '--stdin', input='')
    args = ['diff', '--no-ext-diff', '--no-color']
    stat = git(*args, '--stat', base, job['tree'])
    diff = git(*args, '--unified=2', base, job['tree'])
    files = git(*args, '--name-only', '-z', base, job['tree']).split('\x00')
    return stat, diff, [name for name in files if name]


def branch_recovery_candidate(job):
    error = job.get('error', '').lower()
    return bool(job.get('sha') and ('branch changed' in error
                or 'branch advanced' in error
                or (job.get('provisional') and (
                    'published upstream' in error
                    or 'cannot verify whether queued commits are published' in error))))


def permanent_push_error(job, result):
    """Stop retrying remote branch namespace collisions; never expose raw Git output."""
    output = '\n'.join((result.stderr or '', result.stdout or ''))
    if not re.search(
            r"cannot lock ref 'refs/heads/[^']+': 'refs/heads/[^']+' exists; cannot create 'refs/heads/[^']+'",
            output, re.IGNORECASE):
        return None
    destination = job['destination'].removeprefix('refs/heads/')
    return (f"Push blocked: {job['remote']}/{destination} conflicts with an existing remote branch name. "
            "Git cannot use both a branch and a nested branch with the same prefix. "
            "This rejection will not succeed on retry. Stop background push, then publish "
            "to a nonconflicting remote branch name. Your local commits and uncommitted "
            "changes are preserved.")


def rejected_push_error(job, result, remote_tip):
    """Diagnose history rejection without exposing Git output or touching the index."""
    rejected = any(line.startswith('!\t') and line.endswith(
        ('(fetch first)', '(non-fast-forward)')) for line in result.stdout.splitlines())
    if not rejected:
        return None  # Network failures retain the durable automatic retry.
    message = ('Push rejected: the remote branch has newer commits. '
               'Cancel the background job, sync the branch, then push again. '
               'Your local commit and uncommitted changes are preserved.')
    if not remote_tip or not re.fullmatch(r'[0-9a-f]{40,64}', remote_tip):
        return message
    if git('cat-file', '-e', remote_tip + '^{commit}', check=False).returncode:
        fetched = git('fetch', '--no-tags', '--no-write-fetch-head', job['remote'],
                      remote_tip, check=False, timeout=120)
        if fetched.returncode:
            return message
    # merge-tree creates only temporary Git objects: no merge, commit, or checkout.
    preview = git('merge-tree', '--write-tree', '--name-only', job['sha'], remote_tip,
                  check=False, timeout=30)
    if preview.returncode == 1:
        return ('Push rejected: local and remote changes have merge conflicts. '
                'Cancel the background job, sync the branch and resolve the conflicts, '
                'then push again. Your local commit and uncommitted changes are preserved.')
    return message


def adopt_published_fast_forward(job, remote_tip):
    """Fast-forward a clean local branch to published web work, never rewrite it.

    A queued job can already be published while its checkout is behind the
    destination. Other pending titles, dirty worktrees, or divergent history
    must remain untouched; later jobs can perform their normal safe sync.
    """
    meta = Path(job['gitdir'])
    with branch_sync_lock(meta, job['branch']):
        with repository_lock(meta):
            recover_finalization(meta)
            before = branch_tip(job['branch'])
            if before == remote_tip:
                return True
            if (not before or git('merge-base', '--is-ancestor', before, remote_tip,
                                  check=False).returncode):
                return False
            _, jobs = captured_chain(meta / MARKER, job['branch'],
                                     allow_extension=True, allow_finalized_advance=True)
            if any(item.get('provisional') or item.get('replacement_sha') for item in jobs):
                return False
            env = os.environ.copy()
            env.pop('GIT_INDEX_FILE', None)
            for worktree in git('worktree', 'list', '--porcelain').split('\n\n'):
                if ('\nbranch ' + job['branch'] in worktree
                        and not worktree.startswith('worktree ' + job['root'] + '\n')):
                    return False
            active = git('symbolic-ref', '--quiet', 'HEAD', check=False,
                         env=env).stdout.strip()
            if active == job['branch'] and git('status', '--porcelain', env=env):
                return False
            # No queued commit SHA or tree changes. Reuse the crash-safe ref and
            # checkout transaction already used by Lindsey, with an exact CAS.
            git('update-ref', 'refs/sweetiebot/recovery/' + job['id'] + '/' + before,
                before)
            write_journal(meta / TRANSACTION, dict(
                branch=job['branch'], before=before, after=remote_tip,
                updates=[], checkout=True))
            recover_finalization(meta)
            return True


def sync_with_lindsey(job, remote_tip):
    """Replay unpublished history through Lindsey, then atomically adopt its plan."""
    meta = Path(job['gitdir'])
    with branch_sync_lock(meta, job['branch']):
        with repository_lock(meta):
            recover_finalization(meta)
            entries, jobs = captured_chain(meta / MARKER, job['branch'], allow_extension=True)
            if any(item.get('provisional') for item in jobs):
                return False  # Let all queued titles finish before rebasing the chain.
            before = branch_tip(job['branch'])
        # Network and replay planning must not hold the shared queue lock.
        configured = os.environ.get('LINDSEY_SYNC_REPO')
        candidates = ([Path(configured)] if configured else []) + [
            Path(job['root']).parent / 'lindsey-sync',
            Path.home() / 'GitHub/pony-factor/lindsey-sync']
        script = next((root / 'scripts/sync-local.js' for root in candidates
                       if (root / 'scripts/sync-local.js').is_file()), None)
        node = shutil.which('node') or next((str(path) for path in (
            Path('/opt/homebrew/bin/node'), Path('/usr/local/bin/node')) if path.is_file()), None)
        if not script or not node:
            raise RuntimeError('Push needs sync, but Lindsey local sync is unavailable. Install Lindsey Sync and Node, then retry.')
        if not re.fullmatch(r'[0-9a-f]{40,64}', remote_tip or ''):
            raise RuntimeError('Lindsey could not verify the remote branch; retry when it is reachable.')
        if git('cat-file', '-e', remote_tip + '^{commit}', check=False).returncode:
            if git('fetch', '--no-tags', '--no-write-fetch-head', job['remote'], remote_tip,
                   check=False, timeout=120).returncode:
                raise RuntimeError('Lindsey could not fetch the remote branch; retry when it is reachable.')
        env = os.environ.copy()
        env.pop('GIT_INDEX_FILE', None)
        # Do not update a branch checked out in another linked worktree.
        def check_worktrees():
            worktrees = git('worktree', 'list', '--porcelain').split('\n\n')
            for worktree in worktrees:
                if '\nbranch ' + job['branch'] in worktree and not worktree.startswith('worktree ' + job['root'] + '\n'):
                    raise RuntimeError('Lindsey sync paused because the branch is open in another worktree.')
        check_worktrees()
        result = subprocess.run([node, str(script), job['root'], before, remote_tip, core.REAL_GIT],
                                capture_output=True, text=True, timeout=180, env=env)
        if result.returncode:
            raise RuntimeError('Lindsey could not prepare the sync; your local commits and files are preserved.')
        plan = json.loads(result.stdout)
        if plan.get('status') == 'conflicts':
            paths = plan.get('paths', [])
            raise SyncConflicts(paths)
        if (plan.get('version') != 1 or plan.get('status') != 'ready'
                or plan.get('before') != before or plan.get('onto') != remote_tip):
            raise RuntimeError('Lindsey could not safely replay this history; manual sync is required.')
        replacements = {item['before']: item for item in plan['commits']}
        after = plan['after']
        if git('merge-base', '--is-ancestor', remote_tip, after, check=False).returncode:
            raise RuntimeError('Lindsey returned a sync that does not contain the remote changes.')
        with repository_lock(meta):
            recover_finalization(meta)
            if branch_tip(job['branch']) != before:
                raise RuntimeError('The branch changed while Lindsey prepared the sync; publication was paused.')
            check_worktrees()
            active = git('symbolic-ref', '--quiet', 'HEAD', check=False, env=env).stdout.strip()
            entries, jobs = captured_chain(meta / MARKER, job['branch'], allow_extension=True)
            updates = []
            for entry, item in zip(entries, jobs):
                replacement = replacements.get(item['sha'])
                if replacement:
                    updates.append({'directory': entry['directory'], 'values': dict(
                        sha=replacement['after'], parent=replacement['parent'], tree=replacement['tree'])})
            # Retain the exact old history before adopting any replacement refs.
            git('update-ref', 'refs/sweetiebot/recovery/' + job['id'] + '/' + before, before)
            if active == job['branch'] and git('status', '--porcelain', env=env):
                raise RuntimeError('Lindsey sync is waiting for your uncommitted changes. Commit or stash them before retrying; your files are preserved.')
            write_journal(meta / TRANSACTION, dict(branch=job['branch'], before=before,
                          after=after, updates=updates, checkout=True))
            recover_finalization(meta)
            job.update(read_journal(Path(next(entry['directory'] for entry in entries
                                             if entry['id'] == job['id'])) / 'job.json'))
        return True


def reconcile_published_jobs(meta):
    """Retire finalized blocked jobs already published or belonging to deleted branches."""
    meta = Path(meta).resolve()
    marker = meta / MARKER
    published = {}
    for entry in queue_entries(marker):
        directory = Path(entry['directory'])
        file = directory / 'job.json'
        job = read_journal(file)
        if (not job or job.get('phase') != 'blocked' or job.get('provisional')
                or job.get('replacement_sha') or not job.get('sha') or not job.get('push')):
            continue
        try:
            with (directory / 'worker.lock').open('a+b') as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    continue
                env = os.environ.copy()
                env.pop('GIT_INDEX_FILE', None)
                env['GIT_TERMINAL_PROMPT'] = '0'
                env.setdefault('GIT_SSH_COMMAND', 'ssh -oBatchMode=yes')
                def query(*args, **kwargs):
                    return git(*args, cwd=job['root'], env=env, **kwargs)
                if query('rev-parse', '--absolute-git-dir') != str(meta):
                    continue
                if (query('show', '-s', '--format=%T', job['sha']) != job['tree']
                        or query('show', '-s', '--format=%P', job['sha']) != job['parent']):
                    continue
                local = query('show-ref', '--verify', '--quiet', job['branch'], check=False)
                if local.returncode not in (0, 1):
                    continue
                deleted = local.returncode == 1
                if not deleted and query('merge-base', '--is-ancestor', job['sha'], job['branch'], check=False).returncode:
                    continue
                remote, destination = job.get('remote'), job.get('destination')
                if not remote or remote.startswith('-') or not destination or not destination.startswith('refs/heads/'):
                    continue
                key = (job['root'], remote, destination)
                if key not in published:
                    result = query('ls-remote', '--refs', remote, destination, check=False, timeout=3)
                    rows = [line.split() for line in result.stdout.splitlines()]
                    tip = (rows[0][0] if result.returncode == 0 and len(rows) == 1
                           and len(rows[0]) == 2 and rows[0][1] == destination
                           and re.fullmatch(r'[0-9a-f]{40,64}', rows[0][0]) else '')
                    if tip and query('cat-file', '-e', tip + '^{commit}', check=False).returncode:
                        if query('fetch', '--no-tags', '--no-write-fetch-head', remote, tip,
                                 check=False, timeout=3).returncode:
                            tip = ''
                    published[key] = (tip, result.returncode == 0 and not rows)
                tip, remote_deleted = published[key]
                obsolete = deleted and remote_deleted
                if not obsolete and (not tip or query('merge-base', '--is-ancestor', job['sha'], tip, check=False).returncode):
                    continue
                with repository_lock(meta):
                    current = read_journal(file)
                    if (current != job or (meta / TRANSACTION).exists()
                            or not any(item['id'] == job['id'] for item in queue_entries(marker))
                            or query('show-ref', '--verify', '--quiet', job['branch'], check=False).returncode != local.returncode
                            or (not deleted and query('merge-base', '--is-ancestor', job['sha'], job['branch'], check=False).returncode)):
                        continue
                    if obsolete:
                        # Never recreate a deleted branch to finish an old push.
                        # Retain the actual commit, rather than only its tree.
                        recovery = 'refs/sweetiebot/recovery/' + job['id'] + '/deleted-branch'
                        if query('update-ref', recovery, job['sha'], '', check=False).returncode:
                            if query('rev-parse', '--verify', recovery) != job['sha']:
                                continue
                        job.update(phase='cancelled', push=False, context='',
                                   retired_reason='Local and remote branches were deleted; queued commit retained for recovery.')
                    else:
                        job.update(phase='done', context='')
                    job.pop('error', None)
                    job.pop('conflictPaths', None)
                    write_journal(file, job)
                    save_queue(marker, queue_entries(marker))
                    query('update-ref', '-d', 'refs/sweetiebot/jobs/' + job['id'], job['tree'], check=False)
        except (OSError, RuntimeError, subprocess.TimeoutExpired):
            # Uncertain histories and offline checks retain their existing pause.
            continue


def start_spellcheck(job, journal):
    if job.get('spellcheck_started') or job.get('skip_spellcheck') or not job.get('sha'):
        return
    if state() != (job['branch'], job['sha']):
        return
    if not core.git_config_bool('scm-toolkit.post-commit-spellcheck', False):
        return
    import post_commit_spellcheck as spellcheck
    if spellcheck.repository_spellcheck_disabled([]):
        return
    paths = git('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', job['sha']).splitlines()
    paths = [name for name in paths if name.lower().endswith(('.md', '.mdx'))]
    if not paths:
        return
    index = os.environ.pop('GIT_INDEX_FILE', None)
    try:
        spellcheck.spawn_post_commit([], paths, job['sha'], str(Path(__file__).with_name('ai_commit.py')), job['parent'])
        job['spellcheck_started'] = True
        write_journal(journal, job)
    finally:
        if index is not None:
            os.environ['GIT_INDEX_FILE'] = index


def work(directory, commit_only=False):
    if (read_journal(directory / 'job.json') or {}).get('kind') == 'pony-profile':
        return work_pony(directory)
    saved = read_journal(directory / 'job.json')
    if saved and saved.get('phase') == 'blocked':
        reconcile_published_jobs(saved['gitdir'])
    with (directory / 'worker.lock').open('a+b') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        file = directory / 'job.json'
        job = read_journal(file)
        if not job or job['phase'] == 'cancelled':
            return
        if job['phase'] == 'preparing' and not commit_only and alive(job.get('enqueue_pid')):
            return  # The click handler owns the initial local commit.
        if job['phase'] == 'done':
            marker = Path(job['gitdir']) / MARKER
            with repository_lock(job['gitdir']):
                save_queue(marker, queue_entries(marker))
            return
        previous_cwd = os.getcwd()
        previous_env = os.environ.copy()
        try:
            os.chdir(job['root'])
            marker = Path(job['gitdir']) / MARKER
            if git('rev-parse', '--absolute-git-dir') != job['gitdir']:
                raise RuntimeError('Repository metadata changed.')
            entries = queue_entries(marker)
            if not entries and job['phase'] in ('preparing', 'queued'):
                return
            if not any(entry['id'] == job['id'] for entry in entries):
                raise RuntimeError('The background commit no longer owns this repository.')
            if (job['phase'] == 'blocked' and job.get('push') and job.get('sha')
                    and transient_network_error(job.get('error', ''))
                    and not job.get('network_retries_exhausted')):
                # Repair jobs paused by the older immediate-notification path.
                job['phase'] = 'committed'
                job.pop('error', None)
                write_journal(file, job)
            if job['phase'] == 'blocked':
                # An already-running older worker can finish generation after
                # another placeholder was queued. Recover only a verified chain.
                if not branch_recovery_candidate(job):
                    return
                with repository_lock(job['gitdir']):
                    captured_chain(marker, job['branch'], allow_extension=True, allow_finalized_advance=True)
                    job = read_journal(file)
                    generated = not re.fullmatch(
                        PLACEHOLDER_SUBJECT_PATTERN, job['message'].partition('\n')[0])
                    job['phase'] = 'finalizing' if job.get('provisional') and generated else 'committed'
                    job.pop('error', None)
                    write_journal(file, job)
            if job['phase'] == 'preparing':
                job['phase'] = 'queued'
                write_journal(file, job)
            os.environ['SWEETIEBOT_BACKGROUND_JOB'] = job['id']
            os.environ['GIT_TERMINAL_PROMPT'] = '0'
            # A private index preserves the click-time tree while users keep staging.
            os.environ['GIT_INDEX_FILE'] = str(directory / 'index')
            git('read-tree', job['tree'])
            actual = branch_tip(job['branch'])
            if job['phase'] == 'committing' and matches_commit(job, actual):
                job.update(sha=actual, phase='committed')
                write_journal(file, job)
            if job['phase'] in ('queued', 'generating', 'committing') and not job.get('sha'):
                if state()[0] != job['branch']:
                    raise RuntimeError('The branch changed before the local commit; background work was paused.')
                if actual != job['parent']:
                    raise RuntimeError('The branch advanced; background commit was paused.')
                if not job['message'].strip():
                    job['provisional'] = True
                    job['placeholder_prefix'] = get_placeholder_prefix()
                    job['message'] = job['placeholder_prefix'] + job['id']
                    if job.get('description'):
                        job['message'] += '\n\n' + job['description']
                if job['trailer'] and job['trailer'] not in job['message'].splitlines():
                    job['message'] += '\n\n' + job['trailer']
                if state() != (job['branch'], job['parent']):
                    raise RuntimeError('The branch advanced during generation; commit was paused.')
                job['phase'] = 'committing'
                write_journal(file, job)
                args = ['-c', 'credential.interactive=false', 'commit', '-m', job['message']]
                if job['sign']: args.append('-S')
                if job['signoff']: args.append('--signoff')
                if job.get('no_verify'): args.append('--no-verify')
                os.environ['GIT_REFLOG_ACTION'] = 'sweetiebot-background:' + job['id']
                result = git(*args, check=False)
                if result.returncode:
                    raise RuntimeError('Background Git commit failed; inspect Git hooks or signing.')
                sha = git('rev-parse', 'HEAD')
                # Capture the actual message too (hooks/signoff may add trailers).
                if state()[0] != job['branch'] or not matches_commit(job, sha):
                    raise RuntimeError('A hook changed the captured tree; push was paused.')
                job.update(sha=sha, phase='committed')
                write_journal(file, job)
            try:
                start_spellcheck(job, file)
            except (OSError, RuntimeError) as error:
                log_event('background_commit', 'spellcheck_start_pending', error_type=type(error).__name__, outcome='retry')
            if commit_only:
                return
            with repository_lock(job['gitdir']):
                recover_finalization(job['gitdir'])
                _, pending = captured_chain(marker, job['branch'], allow_extension=True, allow_finalized_advance=True)
                job = read_journal(file)
            if job.get('provisional'):
                if not job.get('replacement_sha') and job['phase'] not in ('ready', 'finalizing'):
                    with repository_lock(job['gitdir']):
                        recover_finalization(job['gitdir'])
                        job = read_journal(file)
                        job['phase'] = 'generating'
                        write_journal(file, job)
                    stat, diff, files = captured_diff(job)
                    title, description = core.generate_message(stat, diff, files,
                        include_description=job.get('include_description', False),
                        conversation_context=job['context'])
                    with repository_lock(job['gitdir']):
                        recover_finalization(job['gitdir'])
                        # Earlier titles can reparent this commit while Ollama
                        # works. Save only the generated message onto fresh state.
                        job = read_journal(file)
                        suffix = git('show', '-s', '--format=%B', job['sha']).partition('\n')[2].strip()
                        job['message'] = title + ('\n\n' + description if description else '')
                        if suffix:
                            job['message'] += '\n\n' + suffix
                        job['phase'] = 'ready'
                        write_journal(file, job)
            with repository_lock(job['gitdir']):
                recover_finalization(job['gitdir'])
                _, pending = captured_chain(marker, job['branch'], allow_extension=True, allow_finalized_advance=True)
                job = read_journal(file)
                position = next(i for i, item in enumerate(pending) if item['id'] == job['id'])
                if any(item.get('provisional') for item in pending[:position]):
                    return
                # A fork may have its own ready title while its inherited base
                # is still provisional. Never finalize or publish it first.
                for entry in queue_entries(marker):
                    ancestor = read_journal(Path(entry['directory']) / 'job.json')
                    if (ancestor and ancestor.get('provisional') and ancestor['id'] != job['id']
                            and ancestor['branch'] != job['branch']
                            and git('merge-base', '--is-ancestor', ancestor['sha'], job['sha'], check=False).returncode == 0):
                        return
            if job.get('provisional'):
                job['phase'] = 'finalizing'
                write_journal(file, job)
                finalize_message(directory, job)
            with repository_lock(job['gitdir']):
                captured_chain(marker, job['branch'], allow_extension=True, allow_finalized_advance=True)
                job = read_journal(file)
            pushed = job['push']
            if pushed:
                from merged_branch import require_unmerged
                retry_network_read(lambda: require_unmerged(job['branch'], job['remote']))
                job['phase'] = 'pushing'
                write_journal(file, job)
                env = os.environ.copy()
                env.setdefault('GIT_SSH_COMMAND', 'ssh -oBatchMode=yes')
                result = git('-c', 'credential.interactive=false', 'push', '--porcelain', job['remote'],
                             job['sha'] + ':' + job['destination'], check=False, timeout=120, env=env)
                if result.returncode:
                    permanent = permanent_push_error(job, result)
                    if permanent:
                        raise RuntimeError(permanent)
                    # A later finalized job may already have published this one.
                    published = git('ls-remote', job['remote'], job['destination'], check=False, timeout=30)
                    tip = published.stdout.split()[0] if published.returncode == 0 and published.stdout.strip() else ''
                    included = tip and git('merge-base', '--is-ancestor', job['sha'], tip, check=False).returncode == 0
                    if included and job.get('published_title_unapplied'):
                        adopt_published_fast_forward(job, tip)
                    if not included:
                        error = rejected_push_error(job, result, tip)
                        if error:
                            if not sync_with_lindsey(job, tip):
                                return
                            # One recovery attempt per push; never force-push.
                            result = git('-c', 'credential.interactive=false', 'push', '--porcelain',
                                         job['remote'], job['sha'] + ':' + job['destination'],
                                         check=False, timeout=120, env=env)
                            if result.returncode:
                                permanent = permanent_push_error(job, result)
                                if permanent:
                                    raise RuntimeError(permanent)
                                error = rejected_push_error(job, result, '')
                                if error:
                                    raise RuntimeError('The remote advanced again after Lindsey sync. Retry the background job.')
                                log_event('background_commit', 'push_pending', outcome='retry')
                                return
                        else:
                            log_event('background_commit', 'push_pending', outcome='retry')
                            return
                if not job.get('tracking'):
                    short = job['branch'][len('refs/heads/'):]
                    with repository_lock(job['gitdir']):
                        git('config', 'branch.' + short + '.remote', job['remote'])
                        git('config', 'branch.' + short + '.merge', job['destination'])
            with repository_lock(job['gitdir']):
                current = read_journal(file)
                if current['push'] and not pushed:
                    return  # A manual push arrived while this worker was finishing.
                job.update(current)
                job.update(phase='done', context='')
                write_journal(file, job)
                save_queue(marker, queue_entries(marker))
            git('update-ref', '-d', 'refs/sweetiebot/jobs/' + job['id'], job['tree'], check=False)
            log_event('background_commit', 'completed', outcome='success')
            # Optional post-commit spellcheck is scheduled once by start_spellcheck.
        except (OSError, subprocess.TimeoutExpired):
            log_event('background_commit', 'interrupted', outcome='retry')
        except Exception as exc:
            if job['phase'] == 'generating':
                log_event('background_commit', 'generation_pending', error_type=type(exc).__name__, outcome='retry')
                return
            with nullcontext() if commit_only else repository_lock(job['gitdir']):
                current = read_journal(file)
                current.update(phase='blocked', error=str(exc), context='')
                if getattr(exc, 'network_retries_exhausted', False):
                    current['network_retries_exhausted'] = True
                current.pop('conflictPaths', None)
                if isinstance(exc, SyncConflicts):
                    current['conflictPaths'] = exc.paths
                if getattr(exc, 'info', None):
                    current['mergedBranch'] = exc.info
                    current['push'] = False
                write_journal(file, current)
            log_event('background_commit', 'blocked', error_type=type(exc).__name__, outcome='blocked')
        finally:
            os.chdir(previous_cwd)
            os.environ.clear()
            os.environ.update(previous_env)


def dismiss_merged_push(job_id):
    """Release a confirmed blocked old-branch push without losing local commits."""
    if not re.fullmatch(BASE58_ID_PATTERN, job_id):
        raise ValueError('Invalid merged push job identifier.')
    meta = Path(git('rev-parse', '--absolute-git-dir'))
    marker = meta / MARKER
    with repository_lock(meta):
        entries = queue_entries(marker)
        if not entries or entries[0]['id'] != job_id:
            raise RuntimeError('The paused merged-branch job changed. Review the queue again.')
        paused = read_journal(Path(entries[0]['directory']) / 'job.json')
        if not paused or paused.get('phase') != 'blocked' or not paused.get('mergedBranch'):
            raise RuntimeError('The selected job is no longer paused for a merged branch.')
        if paused.get('provisional') or not paused.get('sha'):
            raise RuntimeError('The local commit must finish before releasing its push.')
        for entry in entries:
            file = Path(entry['directory']) / 'job.json'
            job = read_journal(file)
            if not job or job['branch'] != paused['branch']:
                continue
            job['push'] = False
            if job['id'] == job_id:
                job['phase'] = 'committed'
                job.pop('error', None)
                job.pop('mergedBranch', None)
            write_journal(file, job)
    return True


def control(action):
    marker = Path(git('rev-parse', '--absolute-git-dir')) / MARKER
    entries = queue_entries(marker)
    if not entries:
        return
    directory = Path(entries[0]['directory'])
    with (directory / 'worker.lock').open('a+b') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('The background worker is active; try again after it finishes.')
        job = read_journal(directory / 'job.json')
        if action == 'cancel':
            if job.get('provisional'):
                # Removing an unresolved ancestor would release placeholders to
                # push. Give it a local fallback message before cancelling push.
                _, _, files = captured_diff(job)
                title, description = core.fallback_message(files, False)
                job['message'] = title + ('\n\n' + description if description else '')
                suffix = git('show', '-s', '--format=%B', job['sha']).partition('\n')[2].strip()
                if suffix:
                    job['message'] += '\n\n' + suffix
                job['phase'] = 'finalizing'
                write_journal(directory / 'job.json', job)
                finalize_message(directory, job)
            job.update(phase='cancelled', context='')
            write_journal(directory / 'job.json', job)
            with repository_lock(job['gitdir']):
                save_queue(marker, queue_entries(marker))
            git('update-ref', '-d', 'refs/sweetiebot/jobs/' + job['id'], job['tree'], check=False)
        elif job['phase'] == 'blocked':
            job['phase'] = ('finalizing' if job.get('replacement_sha') else
                            'committed' if job.get('sha') else 'committing' if job['message'] else 'queued')
            job.pop('error', None)
            job.pop('network_retries_exhausted', None)
            write_journal(directory / 'job.json', job)


def launch_job(directory):
    return subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--work', str(directory)],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)


def drain_parallel(meta):
    """Separate processes isolate each job's cwd/index while Ollama runs."""
    with (Path(meta) / (MARKER + '.scheduler.lock')).open('a+b') as scheduler:
        try:
            fcntl.flock(scheduler, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        active, generated, applied = {}, set(), set()
        while True:
            for job_id, child in list(active.items()):
                if child.poll() is not None:
                    del active[job_id]
            launched = False
            earlier_pending = set()
            for entry in queue_entries(Path(meta) / MARKER):
                job = read_journal(Path(entry['directory']) / 'job.json')
                if not job:
                    continue
                predecessor_pending = job['branch'] in earlier_pending
                if job.get('provisional'):
                    earlier_pending.add(job['branch'])
                if job['id'] in active or job['phase'] in ('done', 'cancelled'):
                    continue
                if not job.get('sha') and alive(job.get('enqueue_pid')):
                    continue
                needs_generation = job.get('provisional') and job['phase'] not in ('ready', 'finalizing')
                key = (job['id'], job.get('sha'))
                if needs_generation:
                    if job['id'] in generated:
                        continue
                elif predecessor_pending or key in applied:
                    continue
                if len(active) >= PARALLEL_JOBS:
                    break
                if needs_generation:
                    generated.add(job['id'])
                else:
                    applied.add(key)
                try:
                    active[job['id']] = launch_job(Path(entry['directory']))
                    launched = True
                except OSError:
                    log_event('background_commit', 'worker_start_pending', outcome='retry')
            if not active and not launched:
                return
            time.sleep(.1)


def resume(parallel=True):
    repositories = set()
    pony_jobs = []
    for file in jobs_home().glob('*/job.json'):
        job = read_journal(file)
        if not job:
            continue
        if job.get('kind') == 'pony-profile':
            if job.get('phase') not in ('done', 'cancelled'):
                pony_jobs.append(file.parent)
            continue
        meta = job['gitdir']
        # Archived jobs can outlive a checkout or its conversion to a linked
        # worktree, where the old .git directory is now a pointer file.
        # Never let that stale location prevent other repositories resuming.
        if not Path(meta).is_dir():
            continue
        if meta in repositories:
            continue
        repositories.add(meta)
        if parallel:
            if queue_entries(Path(meta) / MARKER):
                drain_parallel(meta)
            continue
        visited = set()
        while True:
            entry = next((item for item in queue_entries(Path(meta) / MARKER)
                          if item['id'] not in visited), None)
            if not entry:
                break
            visited.add(entry['id'])
            work(Path(entry['directory']))
    for directory in pony_jobs:
        if parallel:
            launch_job(directory)
        else:
            work_pony(directory)
    prune_completed_jobs()


def prune_completed_jobs(now=None):
    """Delete settled background commit snapshots after 60 days, not recovery state."""
    cutoff = (time.time() if now is None else now) - COMPLETED_JOB_RETENTION_DAYS * 86400
    for journal in jobs_home().glob('*/job.json'):
        directory = journal.parent
        # Only enqueue-created directories fall under this policy.
        if (not re.fullmatch(BASE58_ID_PATTERN, directory.name)
                or directory.is_symlink() or journal.is_symlink()
                or (directory / 'worker.lock').is_symlink()):
            continue
        try:
            if journal.stat().st_mtime >= cutoff:
                continue
            with (directory / 'worker.lock').open('a+b') as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    continue
                # Recheck after locking: a worker may have completed recently.
                if journal.is_symlink() or journal.stat().st_mtime >= cutoff:
                    continue
                job = read_journal(journal)
                if (not isinstance(job, dict) or job.get('id') != directory.name
                        or job.get('phase') not in ('done', 'cancelled')
                        or job.get('provisional') or job.get('replacement_sha')):
                    continue
                gitdir = job.get('gitdir')
                if not isinstance(gitdir, str) or not gitdir:
                    continue
                meta = Path(gitdir)
                if meta.is_dir():
                    # A done descendant may still be queued behind a retry,
                    # and a pending finalization transaction can need old journals.
                    if (meta / TRANSACTION).exists() or any(
                            item.get('id') == job['id']
                            or item.get('directory') == str(directory)
                            for item in queue_entries(meta / MARKER)):
                        continue
                shutil.rmtree(directory)
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            log_event('background_commit', 'prune_failed',
                      error_type=type(exc).__name__, outcome='retry')


def request_push(request, start=True):
    """Persist a manual push behind pending titles; never publish placeholders."""
    meta = Path(git('rev-parse', '--absolute-git-dir'))
    with repository_lock(meta):
        marker = meta / MARKER
        if not queue_entries(marker):
            return {'queued': False}
        recover_finalization(meta)
        requested_branch = request.get('branch')
        branch = (git('symbolic-ref', '--quiet', 'HEAD')
                  if not requested_branch or requested_branch == 'HEAD'
                  else requested_branch if requested_branch.startswith('refs/heads/')
                  else 'refs/heads/' + requested_branch)
        if not any(read_journal(Path(entry['directory']) / 'job.json')['branch'] == branch
                   for entry in queue_entries(marker)):
            return {'queued': False}
        entries, jobs = captured_chain(marker, branch, allow_extension=True, allow_finalized_advance=True)
        remote = request.get('remote')
        if remote and any(job['remote'] != remote for job in jobs):
            raise RuntimeError('Pending commit messages use a different push remote.')
        for entry, job in zip(entries, jobs):
            if job['phase'] in ('done', 'cancelled'):
                continue
            job['push'] = True
            write_journal(Path(entry['directory']) / 'job.json', job)
    if start:
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--resume'],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
    return {'queued': True}


def queue_plain_push(args, global_args=()):
    # Only defer the ordinary push supported by the durable queue. Preserve
    # specialized pushes (tags, deletes, force, alternate refspecs) as guarded.
    positional = [arg for arg in args if arg not in ('-u', '--set-upstream')]
    if any(arg.startswith('-') for arg in positional) or len(positional) > 2:
        return False
    if len(positional) < 2:
        # Custom default refspecs/destinations must reach the source-aware gate,
        # rather than silently turning into a push of the current queued branch.
        configured = subprocess.run([core.REAL_GIT, *global_args, 'config', '--get-regexp',
                                     r'^(remote\..*\.push|remote\.pushDefault|branch\..*\.pushRemote)$'],
                                    capture_output=True, text=True)
        mode = subprocess.run([core.REAL_GIT, *global_args, 'config', '--get', 'push.default'],
                              capture_output=True, text=True)
        if configured.returncode == 0 or (mode.returncode == 0 and mode.stdout.strip() not in ('simple', 'upstream')):
            return False
    if not global_args:
        return request_push(dict(zip(('remote', 'branch'), positional)))['queued']
    result = subprocess.run([core.REAL_GIT, *global_args, 'rev-parse', '--show-toplevel'],
                            capture_output=True, text=True)
    if result.returncode:
        return False
    previous = os.getcwd()
    try:
        os.chdir(result.stdout.strip())
        return request_push(dict(zip(('remote', 'branch'), positional)))['queued']
    finally:
        os.chdir(previous)


def completed_branch_base(real_git, global_args, ref):
    """Resolve a fixed commit without copying unfinished message ancestry."""
    def query(*args):
        result = subprocess.run([real_git, *global_args, *args], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError('Could not resolve a completed branch base.')
        return result.stdout.strip()

    meta = Path(query('rev-parse', '--absolute-git-dir'))
    with repository_lock(meta):
        jobs = [read_journal(Path(entry['directory']) / 'job.json')
                for entry in queue_entries(meta / MARKER)]
        if any(not job for job in jobs):
            raise RuntimeError('A pending commit checkpoint is unavailable.')
        pending = {job['sha']: job for job in jobs if job.get('provisional') and job.get('sha')}
        candidate = query('rev-parse', '--verify', ref + '^{commit}')
        # A copied workspace can have later commits on top of an orphaned
        # placeholder. Inspect ancestry too, even without a matching job record.
        unfinished = set(pending)
        history = query('log', '--format=%H%x00%s', candidate)
        ordered = []
        for line in history.splitlines():
            sha, _, subject = line.partition('\x00')
            if sha in pending or re.fullmatch(
                    PLACEHOLDER_SUBJECT_PATTERN, subject):
                unfinished.add(sha)
                ordered.append(sha)
        for sha in ordered:
            contained = subprocess.run([real_git, *global_args, 'merge-base', '--is-ancestor', sha, candidate],
                                       capture_output=True)
            if contained.returncode == 1:
                continue
            if contained.returncode:
                raise RuntimeError('Could not verify completed branch ancestry.')
            parents = query('show', '-s', '--format=%P', sha).split()
            if len(parents) != 1:
                raise RuntimeError('There is no completed commit to branch from yet.')
            candidate = parents[0]
        for sha in unfinished:
            result = subprocess.run([real_git, *global_args, 'merge-base', '--is-ancestor', sha, candidate],
                                    capture_output=True)
            if result.returncode != 1:
                raise RuntimeError('The selected branch base contains an unfinished commit message.')
        return candidate


def wait_for_background(real_git, global_args, branch_base=None, refs=('HEAD',)):
    result = subprocess.run([real_git, *global_args, 'rev-parse', '--absolute-git-dir'],
                            capture_output=True, text=True)
    if result.returncode:
        return
    marker = Path(result.stdout.strip()) / MARKER
    reconcile_published_jobs(marker.parent)
    entries = queue_entries(marker)
    own_job = os.environ.get('SWEETIEBOT_BACKGROUND_JOB')
    if own_job and any(own_job == entry.get('id') for entry in entries):
        return
    dependencies = related_pending_jobs(real_git, global_args, (branch_base,) if branch_base else refs)
    dependencies = [record for record in dependencies
                    if record['kind'] == 'background' or record['directory'] != marker.parent]
    # Pin named bases even when the jobs we found belong to unrelated branches.
    # A later enqueue or ref move must not change the history being copied.
    if branch_base:
        resolved = subprocess.run([real_git, *global_args, 'rev-parse', '--verify', branch_base + '^{commit}'],
                                  capture_output=True, text=True)
        current = subprocess.run([real_git, *global_args, 'symbolic-ref', '--quiet', 'HEAD'],
                                 capture_output=True, text=True)
        jobs = [record['job'] for record in dependencies]
        current_pending = any(not job or job.get('branch') == current.stdout.strip() for job in jobs)
        if (resolved.returncode == 0 and (branch_base != 'HEAD' or not current_pending)
                and completed_branch_base(real_git, global_args, resolved.stdout.strip()) == resolved.stdout.strip()):
            return resolved.stdout.strip()
        if not dependencies and resolved.returncode == 0:
            raise RuntimeError('The selected branch base contains unfinished commit history.')
    if dependencies:
        job = dependencies[0]['job']
        name = Path(job['root']).name if job and job.get('root') else marker.parent.parent.name
        branch = job.get('branch', '').removeprefix('refs/heads/') if job else ''
        label = name + (' (' + branch + ')' if branch else '')
        if job and job.get('phase') == 'blocked' and job.get('error'):
            reason = 'Push blocked by merge conflicts.' if 'merge conflict' in job['error'].lower() else 'Commit & Push paused.'
            raise RuntimeError('Sweetiebot: ' + reason + ' ' + label + ': ' + job['error'])
        raise RuntimeError('Sweetiebot: Commit & Push is still running. Let it finish before modifying pending history or committing again.')


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--branch-base':
            print(completed_branch_base(core.REAL_GIT, [], sys.argv[2]))
        elif len(sys.argv) == 5 and sys.argv[1] == '--fork-branch':
            print(fork_branch(*sys.argv[2:]))
        elif len(sys.argv) == 6 and sys.argv[1] == '--fork-verified':
            print(fork_branch(*sys.argv[2:5], expected_tip=sys.argv[5]))
        elif len(sys.argv) == 6 and sys.argv[1] == '--fork-worktree':
            print(fork_branch(*sys.argv[2:]))
        elif sys.argv[1:] == ['--prepare-stage']:
            print(json.dumps(prepare_staged_preflight()))
        elif sys.argv[1:] == ['--enqueue']:
            print(json.dumps(enqueue(json.load(sys.stdin))))
        elif sys.argv[1:] == ['--enqueue-pony']:
            print(json.dumps(enqueue_pony(json.load(sys.stdin))))
        elif sys.argv[1:] == ['--request-push']:
            print(json.dumps(request_push(json.load(sys.stdin))))
        elif len(sys.argv) >= 2 and sys.argv[1] in ('--pending', '--pending-legacy'):
            print(json.dumps(bool(related_pending_jobs(core.REAL_GIT, [], sys.argv[2:] or ['HEAD'],
                                                      background=sys.argv[1] == '--pending'))))
        elif sys.argv[1:] == ['--resume']:
            resume()
        elif len(sys.argv) == 3 and sys.argv[1] == '--work':
            work(Path(sys.argv[2]))
        elif len(sys.argv) == 3 and sys.argv[1] == '--dismiss-merged':
            dismiss_merged_push(sys.argv[2])
            resume()
        elif sys.argv[1:] in (['--retry'], ['--cancel']):
            control(sys.argv[1][2:])
            if sys.argv[1] == '--retry':
                resume()
        elif sys.argv[1:] == ['--status']:
            marker = Path(git('rev-parse', '--absolute-git-dir')) / MARKER
            reconcile_published_jobs(marker.parent)
            pending = read_journal(marker)
            job = read_journal(Path(pending['directory']) / 'job.json') if pending else None
            status = {key: job[key] for key in ('id', 'phase', 'error', 'branch', 'conflictPaths', 'mergedBranch') if key in job} if job else {}
            recoverable = False
            if job and job['phase'] == 'blocked' and branch_recovery_candidate(job):
                try:
                    with repository_lock(marker.parent):
                        captured_chain(marker, job['branch'], allow_extension=True, allow_finalized_advance=True)
                    recoverable = True
                except RuntimeError:
                    pass
            if recoverable:
                status['phase'] = 'recovering'
                status['recoverable'] = True
            status['titleJobs'] = []
            status['ponyJobs'] = []
            for file in jobs_home().glob('pony-*/job.json'):
                item = read_journal(file)
                if (item and item.get('kind') == 'pony-profile' and item.get('gitdir') == str(marker.parent)
                        and item['phase'] not in ('done', 'cancelled')):
                    status['ponyJobs'].append({key: item[key] for key in
                        ('id', 'phase', 'path', 'error', 'nextAttemptAt') if key in item})
            status['pushPending'] = False
            for entry in queue_entries(marker):
                item = read_journal(Path(entry['directory']) / 'job.json')
                if (item and item.get('push')
                        and (item['phase'] not in ('blocked', 'done', 'cancelled')
                             or (recoverable and item['id'] == job['id']))):
                    status['pushPending'] = True
                if (item and item.get('provisional')
                        and (item['phase'] not in ('blocked', 'done', 'cancelled')
                             or (recoverable and item['id'] == job['id']))):
                    status['titleJobs'].append(item['id'])
            print(json.dumps(status))
        else:
            raise ValueError('Unknown background commit action.')
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
