"""Durable staged commits and optional pushes, independent of VS Code."""
from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import uuid

import ai_commit as core
from sweetiebot_async_commit import write_journal as _write_journal, read_journal
from sweetiebot_diagnostics import log_event

MARKER = 'sweetiebot-background-commit.json'
LABEL = 'dev.ponyfactor.sweetiebot-commits'


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
        if marker.exists():
            raise RuntimeError('A background commit is already queued for this repository.')
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
            if len(core.github_split_groups(files)) > 1:
                return {'queued': False}  # Preserve the existing oversized-commit splitter.
        if core.staged_whitespace_enabled():
            core.normalize_staged_final_newlines()
        tree = git('write-tree')
        baseline = git('rev-parse', 'HEAD^{tree}', check=False).stdout.strip()
        if tree == baseline or not git('diff', '--cached', '--name-only'):
            raise RuntimeError('Stage the intended changes before queuing a commit.')
        upstream = git('for-each-ref', '--format=%(upstream:remotename)|%(upstream:remoteref)', branch)
        remote, _, destination = upstream.partition('|')
        remote = remote or request.get('remote', 'origin')
        destination = destination or branch
        push = request.get('push') is True
        if push and (not isinstance(remote, str) or remote.startswith('-')
                     or not git('remote', 'get-url', remote, check=False).returncode == 0):
            raise RuntimeError('Configure the push remote before queuing Commit & Push.')
        script = runtime()
        if start:
            install_agent(script)
        directory = jobs_home() / uuid.uuid4().hex
        directory.mkdir(mode=0o700)
        job = dict(id=directory.name, root=root, gitdir=str(meta), branch=branch, parent=parent,
                   tree=tree, message=message, context=context[-6000:], trailer=trailer,
                   push=push, remote=remote, destination=destination,
                   sign=request.get('sign') is True, signoff=request.get('signoff') is True,
                   phase='preparing')
        write_journal(directory / 'job.json', job)
        git('update-ref', 'refs/sweetiebot/jobs/' + job['id'], job['tree'])
        write_journal(marker, {'id': job['id'], 'directory': str(directory)})
        job['phase'] = 'queued'
        write_journal(directory / 'job.json', job)
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


def work(directory):
    with (directory / 'worker.lock').open('a+b') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        file = directory / 'job.json'
        job = read_journal(file)
        if not job or job['phase'] in ('blocked', 'cancelled'):
            return
        if job['phase'] == 'done':
            marker = Path(job['gitdir']) / MARKER
            owner = read_journal(marker)
            if owner and owner['id'] == job['id']:
                marker.unlink(missing_ok=True)
            return
        previous_cwd = os.getcwd()
        previous_env = os.environ.copy()
        try:
            os.chdir(job['root'])
            marker = Path(job['gitdir']) / MARKER
            if git('rev-parse', '--absolute-git-dir') != job['gitdir']:
                raise RuntimeError('Repository metadata changed.')
            owner = read_journal(marker)
            if not owner and job['phase'] == 'preparing':
                return
            if not owner or owner['id'] != job['id']:
                raise RuntimeError('The background commit no longer owns this repository.')
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
            if job['phase'] in ('queued', 'generating', 'committing'):
                if actual != job['parent']:
                    raise RuntimeError('The branch advanced; background commit was paused.')
                if not job['message'].strip():
                    job['phase'] = 'generating'
                    write_journal(file, job)
                    stat, diff, files = core.staged_diff()
                    title, description = core.generate_message(stat, diff, files,
                        include_description=core.should_add_default_branch_description(),
                        conversation_context=job['context'])
                    job['message'] = title + ('\n\n' + description if description else '')
                if job['trailer'] and job['trailer'] not in job['message'].splitlines():
                    job['message'] += '\n\n' + job['trailer']
                if state() != (job['branch'], job['parent']):
                    raise RuntimeError('The branch advanced during generation; commit was paused.')
                job['phase'] = 'committing'
                write_journal(file, job)
                args = ['-c', 'credential.interactive=false', 'commit', '-m', job['message']]
                if job['sign']: args.append('-S')
                if job['signoff']: args.append('--signoff')
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
            if state() != (job['branch'], job['sha']):
                raise RuntimeError('The branch changed after committing; push was paused.')
            if job['push']:
                job['phase'] = 'pushing'
                write_journal(file, job)
                env = os.environ.copy()
                env.setdefault('GIT_SSH_COMMAND', 'ssh -oBatchMode=yes')
                result = git('-c', 'credential.interactive=false', 'push', job['remote'],
                             job['sha'] + ':' + job['destination'], check=False, timeout=120, env=env)
                if result.returncode:
                    # Network/auth failures remain durable and retry next minute/login.
                    log_event('background_commit', 'push_pending', outcome='retry')
                    return
            job.update(phase='done', context='')
            write_journal(file, job)
            marker.unlink(missing_ok=True)
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
    owner = read_journal(marker)
    if not owner:
        return
    directory = Path(owner['directory'])
    with (directory / 'worker.lock').open('a+b') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('The background worker is active; try again after it finishes.')
        job = read_journal(directory / 'job.json')
        if action == 'cancel':
            job.update(phase='cancelled', context='')
            write_journal(directory / 'job.json', job)
            marker.unlink(missing_ok=True)
            git('update-ref', '-d', 'refs/sweetiebot/jobs/' + job['id'], job['tree'], check=False)
        elif job['phase'] == 'blocked':
            job['phase'] = 'committed' if job.get('sha') else 'committing' if job['message'] else 'queued'
            job.pop('error', None)
            write_journal(directory / 'job.json', job)


def resume():
    for file in jobs_home().glob('*/job.json'):
        work(file.parent)


def wait_for_background(real_git, global_args):
    result = subprocess.run([real_git, *global_args, 'rev-parse', '--absolute-git-dir'],
                            capture_output=True, text=True)
    if result.returncode:
        return
    marker = Path(result.stdout.strip()) / MARKER
    job = read_journal(marker)
    if job and os.environ.get('SWEETIEBOT_BACKGROUND_JOB') != job['id']:
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
