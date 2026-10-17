"""Durable staged commits and optional pushes, independent of VS Code."""
from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import secrets
from contextlib import contextmanager

import ai_commit as core
from sweetiebot_async_commit import write_journal as _write_journal, read_journal, PLACEHOLDER, alive
from sweetiebot_diagnostics import log_event

MARKER = 'sweetiebot-background-commit.json'
LABEL = 'dev.ponyfactor.sweetiebot-commits'
TRANSACTION = 'sweetiebot-background-finalization.json'


@contextmanager
def repository_lock(meta):
    with (Path(meta) / (MARKER + '.lock')).open('a+b') as lock:
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
            if job and job.get('replacement_sha') and state() == (job['branch'], job['replacement_sha']):
                job.update(sha=job.pop('replacement_sha'), provisional=False, phase='committed')
                write_journal(journal, job)
        return
    branch, actual = state()
    if branch != transaction['branch'] or actual not in (transaction['before'], transaction['after']):
        raise RuntimeError('The branch changed during message finalization; recovery was paused.')
    if actual != transaction['after']:
        git('update-ref', '-m', 'sweetiebot: finalize queued commit messages',
            branch, transaction['after'], transaction['before'])
    for update in transaction['updates']:
        journal = Path(update['directory']) / 'job.json'
        job = read_journal(journal)
        job.update(update['values'])
        job.pop('replacement_sha', None)
        write_journal(journal, job)
    file.unlink()


def captured_chain(marker):
    entries = queue_entries(marker)
    jobs = [read_journal(Path(entry['directory']) / 'job.json') for entry in entries]
    branch, actual = state()
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
        raise RuntimeError('The branch advanced outside the queued commits; background work was paused.')
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


def state():
    return (git('symbolic-ref', '--quiet', 'HEAD'),
            git('rev-parse', '--verify', 'HEAD', check=False).stdout.strip())


def runtime():
    target = jobs_home() / 'runtime'
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ('background_commit.py', 'ai_commit.py', 'sweetiebot_async_commit.py',
                 'sweetiebot_diagnostics.py', 'post_commit_spellcheck.py'):
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
    return target / 'background_commit.py'


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


def enqueue(request, start=True):
    root = git('rev-parse', '--show-toplevel')
    meta = Path(git('rev-parse', '--absolute-git-dir'))
    marker = meta / MARKER
    with (meta / (MARKER + '.lock')).open('a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (meta / 'sweetiebot-async-commit.json').exists():
            raise RuntimeError('Wait for the existing commit message to finish before queuing another commit.')
        recover_finalization(meta)
        entries = queue_entries(marker)
        if entries:
            captured_chain(marker)
        branch, parent = state()
        if any((meta / name).exists() for name in
               ('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply')):
            raise RuntimeError('Finish the current Git operation before queuing a commit.')
        message = request.get('message', '')
        context = request.get('context', '')
        trailer = request.get('trailer', '')
        if not all(isinstance(value, str) and '\x00' not in value
                   for value in (message, context, trailer)):
            raise ValueError('Invalid background commit request.')
        if trailer and ('\n' in trailer or not trailer.startswith('Co-authored-by: ')):
            raise ValueError('Invalid co-author trailer.')
        if not message.strip():
            if not core.feature_enabled():
                raise RuntimeError('Enter a commit message; automatic commit titles are disabled.')
            files = [name for name in core.git_output('diff', '--cached', '--name-only', '-z').split('\x00') if name]
            if not trailer and len(core.github_split_groups(files)) > 1:
                return {'queued': False}  # Preserve the existing oversized-commit splitter.
        if core.staged_whitespace_enabled():
            core.normalize_staged_final_newlines()
        tree = git('write-tree')
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
        directory = jobs_home() / secrets.token_hex(8)
        directory.mkdir(mode=0o700)
        job = dict(id=directory.name, root=root, gitdir=str(meta), branch=branch, parent=parent,
                   tree=tree, message=message, context=context[-6000:], trailer=trailer,
                   push=push, remote=remote, destination=destination, tracking=tracking,
                   sign=request.get('sign') is True, signoff=request.get('signoff') is True,
                   no_verify=request.get('noVerify') is True,
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


def rewritten_commit(job, parent, message):
    fields = git('show', '-s', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', job['sha']).split('\x00')
    env = os.environ.copy()
    for prefix, values in (('AUTHOR', fields[:3]), ('COMMITTER', fields[3:])):
        for key, value in zip(('NAME', 'EMAIL', 'DATE'), values):
            env['GIT_' + prefix + '_' + key] = value
    args = ['commit-tree', job['tree']]
    if parent:
        args += ['-p', parent]
    if job['sign']:
        args.append('-S')
    return git(*args, input=message + '\n', env=env)


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
        entries, jobs = captured_chain(marker)
        position = next(i for i, item in enumerate(jobs) if item['id'] == job['id'])
        if any(item.get('provisional') for item in jobs[:position]):
            raise RuntimeError('An earlier queued commit message must finish first.')
        before = jobs[-1]['sha']
        parent = current['parent']
        updates = []
        for entry, item in zip(entries[position:], jobs[position:]):
            message = current['message'] if item['id'] == job['id'] else git('show', '-s', '--format=%B', item['sha'])
            sha = rewritten_commit(item, parent, message)
            values = {'sha': sha, 'parent': parent}
            if item['id'] == job['id']:
                values.update(provisional=False, phase='committed')
            updates.append({'directory': entry['directory'], 'values': values})
            parent = sha
        write_journal(meta / TRANSACTION, dict(branch=current['branch'], before=before,
                                             after=parent, updates=updates))
        recover_finalization(meta)
        job.update(read_journal(directory / 'job.json'))


def captured_diff(job):
    base = job['parent'] or git('hash-object', '-w', '-t', 'tree', '--stdin', input='')
    args = ['diff', '--no-ext-diff', '--no-color']
    stat = git(*args, '--stat', base, job['tree'])
    diff = git(*args, '--unified=2', base, job['tree'])
    files = git(*args, '--name-only', '-z', base, job['tree']).split('\x00')
    return stat, diff, [name for name in files if name]


def work(directory, commit_only=False):
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
            if job['phase'] == 'blocked':
                # An already-running older worker can finish generation after
                # another placeholder was queued. Recover only a verified chain.
                if not job.get('provisional') or 'branch advanced' not in job.get('error', '').lower():
                    return
                with repository_lock(job['gitdir']):
                    captured_chain(marker)
                    generated = not job['message'].startswith((PLACEHOLDER, '💭 Generate local commit message ['))
                    job['phase'] = 'finalizing' if generated else 'committed'
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
            branch, actual = state()
            if branch != job['branch']:
                raise RuntimeError('The branch changed; background work was paused.')
            if job['phase'] == 'committing' and matches_commit(job, actual):
                job.update(sha=actual, phase='committed')
                write_journal(file, job)
            if job['phase'] in ('queued', 'generating', 'committing') and not job.get('sha'):
                if actual != job['parent']:
                    raise RuntimeError('The branch advanced; background commit was paused.')
                if not job['message'].strip():
                    job['provisional'] = True
                    job['message'] = PLACEHOLDER + job['id']
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
            if commit_only:
                return
            with repository_lock(job['gitdir']):
                recover_finalization(job['gitdir'])
                _, pending = captured_chain(marker)
                job = read_journal(file)
                position = next(i for i, item in enumerate(pending) if item['id'] == job['id'])
                if any(item.get('provisional') for item in pending[:position]):
                    return
            if job.get('provisional'):
                if not job.get('replacement_sha') and job['phase'] != 'finalizing':
                    job['phase'] = 'generating'
                    write_journal(file, job)
                    stat, diff, files = captured_diff(job)
                    title, description = core.generate_message(stat, diff, files,
                        include_description=core.should_add_default_branch_description(),
                        conversation_context=job['context'])
                    suffix = git('show', '-s', '--format=%B', job['sha']).partition('\n')[2].strip()
                    job['message'] = title + ('\n\n' + description if description else '')
                    if suffix:
                        job['message'] += '\n\n' + suffix
                job['phase'] = 'finalizing'
                write_journal(file, job)
                finalize_message(directory, job)
            with repository_lock(job['gitdir']):
                captured_chain(marker)
            if job['push']:
                job['phase'] = 'pushing'
                write_journal(file, job)
                env = os.environ.copy()
                env.setdefault('GIT_SSH_COMMAND', 'ssh -oBatchMode=yes')
                result = git('-c', 'credential.interactive=false', 'push', job['remote'],
                             job['sha'] + ':' + job['destination'], check=False, timeout=120, env=env)
                if result.returncode:
                    # A later finalized job may already have published this one.
                    published = git('ls-remote', job['remote'], job['destination'], check=False, timeout=30)
                    tip = published.stdout.split()[0] if published.returncode == 0 and published.stdout.strip() else ''
                    included = tip and git('merge-base', '--is-ancestor', job['sha'], tip, check=False).returncode == 0
                    if not included:
                        log_event('background_commit', 'push_pending', outcome='retry')
                        return
                if not job.get('tracking'):
                    short = job['branch'][len('refs/heads/'):]
                    with repository_lock(job['gitdir']):
                        git('config', 'branch.' + short + '.remote', job['remote'])
                        git('config', 'branch.' + short + '.merge', job['destination'])
            job.update(phase='done', context='')
            write_journal(file, job)
            with repository_lock(job['gitdir']):
                save_queue(marker, queue_entries(marker))
            git('update-ref', '-d', 'refs/sweetiebot/jobs/' + job['id'], job['tree'], check=False)
            log_event('background_commit', 'completed', outcome='success')
            # Existing spellcheck guards refuse edits when users have moved on.
            if core.git_config_bool('scm-toolkit.post-commit-spellcheck', False):
                import post_commit_spellcheck as spellcheck
                paths = git('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', job['sha']).splitlines()
                paths = [name for name in paths if name.lower().endswith(('.md', '.mdx'))]
                os.environ.pop('GIT_INDEX_FILE', None)
                spellcheck.spawn_post_commit([], paths, job['sha'], str(Path(__file__).with_name('ai_commit.py')), job['parent'])
        except (OSError, subprocess.TimeoutExpired):
            log_event('background_commit', 'interrupted', outcome='retry')
        except Exception as exc:
            if job['phase'] == 'generating':
                log_event('background_commit', 'generation_pending', error_type=type(exc).__name__, outcome='retry')
                return
            job.update(phase='blocked', error=str(exc), context='')
            write_journal(file, job)
            log_event('background_commit', 'blocked', error_type=type(exc).__name__, outcome='blocked')
        finally:
            os.chdir(previous_cwd)
            os.environ.clear()
            os.environ.update(previous_env)


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
            write_journal(directory / 'job.json', job)


def resume():
    repositories = set()
    for file in jobs_home().glob('*/job.json'):
        job = read_journal(file)
        meta = job['gitdir']
        if meta in repositories:
            continue
        repositories.add(meta)
        for entry in queue_entries(Path(meta) / MARKER):
            work(Path(entry['directory']))


def wait_for_background(real_git, global_args):
    result = subprocess.run([real_git, *global_args, 'rev-parse', '--absolute-git-dir'],
                            capture_output=True, text=True)
    if result.returncode:
        return
    marker = Path(result.stdout.strip()) / MARKER
    entries = queue_entries(marker)
    if entries and not any(os.environ.get('SWEETIEBOT_BACKGROUND_JOB') == entry['id'] for entry in entries):
        raise RuntimeError('A background Commit & Push is pending. Let it finish before changing the branch or committing again.')


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--enqueue']:
            print(json.dumps(enqueue(json.load(sys.stdin))))
        elif sys.argv[1:] == ['--resume']:
            resume()
        elif sys.argv[1:] in (['--retry'], ['--cancel']):
            control(sys.argv[1][2:])
            if sys.argv[1] == '--retry':
                resume()
        elif sys.argv[1:] == ['--status']:
            marker = Path(git('rev-parse', '--absolute-git-dir')) / MARKER
            pending = read_journal(marker)
            job = read_journal(Path(pending['directory']) / 'job.json') if pending else None
            print(json.dumps({key: job[key] for key in ('id', 'phase', 'error') if key in job} if job else {}))
        else:
            raise ValueError('Unknown background commit action.')
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
