"""Detect merged GitHub heads and carry follow-up changes to a fresh branch."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def run(*args, input=None, env=None, check=True):
    result = subprocess.run(args, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=env, timeout=60)
    if check and result.returncode:
        raise RuntimeError(result.stderr.decode().strip() or 'Git operation failed.')
    return result


def git(*args, **kwargs):
    return run('/usr/bin/git', *args, **kwargs)


def value(*args):
    return git(*args).stdout.decode().strip()


def merged_status(branch=None, remote='origin'):
    branch = branch or value('symbolic-ref', '--quiet', '--short', 'HEAD')
    branch = branch.removeprefix('refs/heads/')
    url = git('remote', 'get-url', remote, check=False)
    if url.returncode:
        return None
    match = re.fullmatch(r'(?:https://github.com/|git@github.com:)([^/]+/[^/]+?)(?:\.git)?',
                         url.stdout.decode().strip())
    if not match:
        return None
    gh = shutil.which('gh') or '/opt/homebrew/bin/gh'
    metadata = json.loads(run(gh, 'repo', 'view', match[1], '--json', 'defaultBranchRef').stdout)
    default = (metadata.get('defaultBranchRef') or {}).get('name')
    if branch == default:
        return None
    prs = json.loads(run(gh, 'pr', 'list', '--repo', match[1], '--head', branch,
                         '--state', 'merged', '--limit', '30', '--json',
                         'number,headRefName,headRefOid,baseRefName,isCrossRepository,mergeCommit,mergedAt').stdout)
    for pr in prs:
        if (pr.get('isCrossRepository') or pr.get('headRefName') != branch
                or pr.get('baseRefName') != default or not pr.get('mergedAt')):
            continue
        head = pr.get('headRefOid')
        if not head:
            detail = json.loads(run(gh, 'pr', 'view', str(pr['number']), '--repo', match[1],
                                    '--json', 'commits').stdout)
            commits = detail.get('commits') or []
            head = commits[-1].get('oid') if commits else None
        if not head or git('merge-base', '--is-ancestor', head, branch, check=False).returncode:
            continue
        return {'branch': branch, 'head': head, 'number': pr['number'],
                'defaultBranch': pr['baseRefName'], 'remote': remote,
                'mergeCommit': (pr.get('mergeCommit') or {}).get('oid')}
    return None


class MergedBranchPush(RuntimeError):
    def __init__(self, info):
        self.info = info
        super().__init__(f'Branch "{info["branch"]}" was merged in PR #{info["number"]}. '
                         'Push stopped. Use New Branch to carry follow-up changes onto updated '
                         + info['defaultBranch'] + '.')


def require_unmerged(branch=None, remote='origin'):
    info = merged_status(branch, remote)
    if info:
        raise MergedBranchPush(info)


def guard_push_arguments(args, global_args=()):
    # The native Git extension uses a single remote and branch refspec. Leave
    # tag-only publication alone; inspect the current branch for a plain push.
    if '--tags' in args or '--delete' in args:
        return
    positional = [arg for arg in args if not arg.startswith('-')]
    remote = positional[0] if positional else 'origin'
    refspec = positional[1] if len(positional) > 1 else ''
    if refspec.startswith('refs/tags/') or ':refs/tags/' in refspec:
        return
    branch = refspec.split(':')[-1].lstrip('+') if refspec else None
    if branch == 'HEAD':
        branch = None
    root = run('/usr/bin/git', *global_args, 'rev-parse', '--show-toplevel').stdout.decode().strip()
    previous = os.getcwd()
    try:
        os.chdir(root)
        require_unmerged(branch, remote)
    finally:
        os.chdir(previous)


def carry_to_new_branch(name, remote='origin'):
    import background_commit as bg
    meta = Path(value('rev-parse', '--absolute-git-dir'))
    with bg.repository_lock(meta):
        info = merged_status(remote=remote)
        if not info:
            raise RuntimeError('The active branch is no longer a verified merged PR branch.')
        old_branch = info['branch']
        old_head = value('rev-parse', 'HEAD')
        if git('diff', '--cached', '--quiet', check=False).returncode:
            raise RuntimeError('Keep the staged changes on this branch: unstage them before carrying follow-up work to a new branch.')
        for marker in ('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply'):
            if Path(value('rev-parse', '--git-path', marker)).exists():
                raise RuntimeError('Finish the current Git operation before creating a branch.')
        git('check-ref-format', '--branch', name)
        if not git('show-ref', '--verify', '--quiet', 'refs/heads/' + name, check=False).returncode:
            raise RuntimeError('The new branch name is already in use.')
        git('fetch', '--no-tags', remote, '+refs/heads/' + info['defaultBranch']
            + ':refs/remotes/' + remote + '/' + info['defaultBranch'])
        base = value('rev-parse', 'refs/remotes/' + remote + '/' + info['defaultBranch'])
        merged = info.get('mergeCommit')
        if not merged or git('merge-base', '--is-ancestor', merged, base, check=False).returncode:
            raise RuntimeError('The merged PR is not present on the fetched base branch. Nothing was moved.')
        patch = git('diff', '--binary', info['head']).stdout
        index_before = value('write-tree')
        with tempfile.TemporaryDirectory(dir=meta) as directory:
            env = {**os.environ, 'GIT_INDEX_FILE': str(Path(directory) / 'index')}
            git('read-tree', old_head, env=env)
            git('add', '--update', env=env)
            working_tree = value_with_env(env, 'write-tree')
            git('read-tree', base, env=env)
            if patch:
                git('apply', '--cached', '--3way', input=patch, env=env)
            tree = value_with_env(env, 'write-tree')
        if value('symbolic-ref', '--short', 'HEAD') != old_branch or value('rev-parse', 'HEAD') != old_head:
            raise RuntimeError('The active branch changed while preparing its follow-up work.')
        if value('write-tree') != index_before or git('diff', '--binary', info['head']).stdout != patch:
            raise RuntimeError('The local edits changed while preparing the new branch. Nothing was moved.')
        # Jobs can finish their messages on the original branch, but must never
        # recreate its deleted remote head after this transition.
        for entry in bg.queue_entries(meta / bg.MARKER):
            file = Path(entry['directory']) / 'job.json'
            job = bg.read_journal(file)
            if job.get('branch') == 'refs/heads/' + old_branch:
                if job.get('phase') == 'pushing':
                    raise RuntimeError('A push is already running. Wait for it before changing branches.')
                job['push'] = False
                bg.write_journal(file, job)
        # Two-tree checkout refuses to overwrite untracked files. The original
        # branch and its commits remain intact; no commit or stash is created.
        checkout_tree(working_tree, tree, meta)
        created = False
        try:
            git('update-ref', 'refs/heads/' + name, base, '')
            created = True
            git('symbolic-ref', 'HEAD', 'refs/heads/' + name)
            git('read-tree', base)
        except Exception:
            git('symbolic-ref', 'HEAD', 'refs/heads/' + old_branch)
            checkout_tree(tree, working_tree, meta)
            if created:
                git('update-ref', '-d', 'refs/heads/' + name, base, check=False)
            raise
        return {'branch': name, 'base': base, 'previousBranch': old_branch}


def value_with_env(env, *args):
    return git(*args, env=env).stdout.decode().strip()


def checkout_tree(before, after, meta):
    # Use a temporary index for checkout so local edits never become staged.
    with tempfile.TemporaryDirectory(dir=meta) as directory:
        env = {**os.environ, 'GIT_INDEX_FILE': str(Path(directory) / 'index')}
        git('read-tree', before, env=env)
        git('update-index', '--refresh', env=env)
        git('read-tree', '-u', '-m', before, after, env=env)


def names():
    from branch_names import resolve_runtime_settings
    from toolkit_settings import load_settings
    settings = resolve_runtime_settings(load_settings())
    disabled = set(settings.get('branchNameDisabledPacks', []))
    return list(dict.fromkeys([name for pack in settings['branchNamePacks']
                              if pack['id'] not in disabled for name in pack['names']]
                             + settings.get('branchCustomNames', [])))


if __name__ == '__main__':
    try:
        action, *args = sys.argv[1:]
        if action == '--status':
            print(json.dumps(merged_status(args[0] or None, args[1])))
        elif action == '--new-branch':
            print(json.dumps(carry_to_new_branch(*args)))
        elif action == '--names':
            print(json.dumps(names()))
        elif action == '--completed-base':
            import background_commit as bg
            print(json.dumps(bg.completed_branch_base('/usr/bin/git', [], args[0])))
        else:
            raise RuntimeError('Unknown merged-branch action.')
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
