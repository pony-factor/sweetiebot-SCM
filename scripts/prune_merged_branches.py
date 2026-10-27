#!/usr/bin/env python3
"""Prune local branches whose GitHub pull requests have safely merged."""
import argparse
import json
import os
import re
import sys
import shutil
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE_DIR = Path.home() / "Library/Caches/Sweetiebot"
STAMP = CACHE_DIR / "last-merged-pr-prune"
PRUNE_INTERVAL = 10 * 60
MAX_PRS = 500
MAX_REPOS = 30


def tool(name):
    candidates = [
        shutil.which(name),
        f"/opt/homebrew/bin/{name}",
        f"/usr/local/bin/{name}",
        f"/usr/bin/{name}",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    return None


GIT = tool("git")
GH = tool("gh")


def run(command, cwd=None, timeout=30):
    return subprocess.run(
        command,
        cwd=cwd,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
        env={**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GH_PROMPT_DISABLED': '1'},
    )


def due(force):
    if force:
        return True
    try:
        return time.time() - STAMP.stat().st_mtime >= PRUNE_INTERVAL
    except OSError:
        return True


def mark_run():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    STAMP.touch()


def checked_out_branches(repo):
    result = run([GIT, "worktree", "list", "--porcelain"], cwd=repo, timeout=10)
    if result.returncode:
        raise RuntimeError("Cannot verify checked-out branches")
    prefix = "branch rextension/heads/"
    return {
        line[len(prefix):]
        for line in result.stdout.splitlines()
        if line.startswith(prefix)
    }


def local_branches(repo):
    result = run(
        [GIT, "for-each-ref", "--format=%(refname:short)\t%(objectname)", "rextension/heads"],
        cwd=repo,
        timeout=10,
    )
    if result.returncode:
        return {}
    branches = {}
    for line in result.stdout.splitlines():
        if "\t" not in line:
            continue
        name, oid = line.split("\t", 1)
        branches[name] = oid
    return branches


def github_repo(repo):
    origin = run([GIT, "remote", "get-url", "origin"], cwd=repo, timeout=10)
    if origin.returncode:
        return None
    match = re.fullmatch(
        r"(?:https?://|ssh://git@|git@)([^/:]+)[:/]([^/]+)/([^/]+?)(?:\.git)?/?",
        origin.stdout.strip(),
    )
    if not match:
        return None
    host, owner, name = match.groups()
    result = run(
        [GH, "repo", "view", f"{host}/{owner}/{name}", "--json", "nameWithOwner,defaultBranchRef"],
        cwd=repo,
    )
    if result.returncode:
        return None
    try:
        data = json.loads(result.stdout)
        default = (data.get("defaultBranchRef") or {}).get("name")
        name = data.get("nameWithOwner")
    except (json.JSONDecodeError, AttributeError):
        return None
    if not name or not default:
        return None
    return f"{host}/{name}", default


def pull_requests(repo, repository, branch):
    result = run(
        [
            GH, "pr", "list",
            "--repo", repository,
            "--head", branch,
            "--state", "merged",
            "--limit", str(MAX_PRS),
            "--json",
            "number,state,headRefName,headRefOid,baseRefName,isCrossRepository,mergedAt",
        ],
        cwd=repo,
    )
    if result.returncode:
        return None
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, list) else None


def origin_tracking_refs(repo):
    result = run([GIT, "for-each-ref", "--format=%(refname:short)", "rextension/remotes/origin"],
                 cwd=repo, timeout=10)
    if result.returncode:
        raise RuntimeError("Cannot inspect origin tracking refs")
    return {ref for ref in result.stdout.splitlines() if ref and ref != "origin/HEAD"}


def prune_origin_tracking(repo):
    """Reconcile deleted upstream branches without touching local branch refs."""
    before = origin_tracking_refs(repo)
    result = run([GIT, "fetch", "--prune", "--no-tags", "origin"], cwd=repo, timeout=60)
    if result.returncode:
        raise RuntimeError("Cannot fetch/prune origin: " + (result.stderr.strip() or "Git failed"))
    return sorted(before - origin_tracking_refs(repo))


def merged_pr_head_matches(pr, expected_oid):
    """A deleted PR head ref can have null headRefOid; use its recorded final commit."""
    oid = pr.get("headRefOid")
    if oid is not None:
        return oid == expected_oid
    commits = pr.get("commits")
    return bool(isinstance(commits, list) and commits
                and isinstance(commits[-1], dict)
                and commits[-1].get("oid") == expected_oid)


def current_branch(repo):
    result = run([GIT, "symbolic-ref", "--quiet", "--short", "HEAD"], cwd=repo, timeout=10)
    return result.stdout.strip() if result.returncode == 0 else None


def return_to_default(repo, branch, default_branch, expected_oid, dry_run=False):
    """Switch only a clean, unchanged branch in this worktree."""
    if current_branch(repo) != branch or local_branches(repo).get(branch) != expected_oid:
        return False
    status = run([GIT, "status", "--porcelain", "--untracked-files=all"], cwd=repo, timeout=10)
    if status.returncode or status.stdout:
        return False
    for marker in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_START"):
        location = run([GIT, "rev-parse", "--git-path", marker], cwd=repo, timeout=10)
        if location.returncode or (Path(repo) / location.stdout.strip()).exists():
            return False
    if default_branch not in local_branches(repo):
        return False
    if dry_run:
        return True
    result = run([GIT, "switch", "--no-guess", default_branch], cwd=repo, timeout=10)
    return result.returncode == 0 and current_branch(repo) == default_branch


def prune_repo(repo, dry_run=False, branch_filter=None):
    metadata = github_repo(repo)
    if not metadata:
        return []
    name_with_owner, default_branch = metadata
    branches = local_branches(repo)
    protected = checked_out_branches(repo)
    candidates = {}
    for branch, local_oid in branches.items():
        if branch == default_branch or (branch_filter is not None and branch != branch_filter):
            continue
        if branch in protected and current_branch(repo) != branch:
            continue
        # Query each outstanding local head, rather than only recent repository PRs.
        for pr in pull_requests(repo, name_with_owner, branch) or []:
            if (pr.get("state") == "MERGED" and pr.get("mergedAt")
                    and not pr.get("isCrossRepository")
                    and pr.get("baseRefName") == default_branch
                    and pr.get("headRefName") == branch
                    and pr.get("headRefOid") in (None, local_oid)):
                candidates[(branch, local_oid)] = pr.get("number")

    pruned = []
    for (branch, expected_oid), number in candidates.items():
        if branch_filter is not None and branch != branch_filter:
            continue
        if branch == default_branch:
            continue
        if branches.get(branch) != expected_oid:
            continue
        current = run([GH, "pr", "view", str(number), "--repo", name_with_owner, "--json",
                       "state,headRefName,headRefOid,baseRefName,isCrossRepository,mergedAt,commits"], cwd=repo)
        opened = run([GH, "pr", "list", "--repo", name_with_owner, "--state", "open", "--head", branch,
                      "--limit", "1", "--json", "number"], cwd=repo)
        try:
            verified = json.loads(current.stdout)
            open_prs = json.loads(opened.stdout)
        except (ValueError, TypeError):
            continue
        if (current.returncode or opened.returncode or open_prs != []
                or not isinstance(verified, dict) or verified.get("state") != "MERGED"
                or not verified.get("mergedAt") or verified.get("isCrossRepository")
                or verified.get("baseRefName") != default_branch
                or verified.get("headRefName") != branch
                or not merged_pr_head_matches(verified, expected_oid)):
            continue
        if branch in checked_out_branches(repo):
            if not return_to_default(repo, branch, default_branch, expected_oid, dry_run):
                continue
        if not dry_run and branch in checked_out_branches(repo):
            continue
        if dry_run:
            pruned.append((name_with_owner, branch, number))
            continue
        result = run(
            [GIT, "update-ref", "-d", f"rextension/heads/{branch}", expected_oid],
            cwd=repo,
            timeout=10,
        )
        if result.returncode == 0:
            pruned.append((name_with_owner, branch, number))
            record_managed_workspace_merge(repo, name_with_owner, branch,
                                           expected_oid, number, default_branch)
    return pruned


def record_managed_workspace_merge(repo, repository, branch, oid, number, default_branch):
    """Retain verified PR evidence outside an independent clone's working tree.

    A later workspace scan must revalidate the PR with GitHub before deletion.
    This is bookkeeping, not evidence that deleting a workspace is safe.
    """
    if default_branch != "main":
        return
    root = Path(repo).resolve()
    group = root.parent
    base = (Path.home() / "Library/Application Support/Sweetiebot/Workspaces").resolve()
    if ((group.parent != base and group.parent.parent != base)
            or group.parent.is_symlink() or group.is_symlink() or root.is_symlink()):
        return
    try:
        manifest = json.loads((group / ".sweetiebot-workspace.json").read_text())
        if (manifest.get("version") != 1
                or manifest.get("kind") != "independent-clone"
                or root.name not in manifest.get("repositories", [])):
            return
        evidence_dir = group / ".sweetiebot-merged"
        if evidence_dir.is_symlink():
            return
        evidence_dir.mkdir(mode=0o700, exist_ok=True)
        target = evidence_dir / (root.name + ".json")
        if target.is_symlink():
            return
        data = json.loads(target.read_text()) if target.exists() else {"merges": []}
        merges = data.get("merges", [])
        if not isinstance(merges, list) or len(merges) >= 100:
            return
        record = dict(repository=repository, branch=branch, oid=oid,
                      number=number, base=default_branch)
        if record not in merges:
            merges.append(record)
        # Same-directory temporary file plus replacement avoids partial JSON
        # if the extension host is interrupted mid-write.
        import tempfile
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8",
                                              dir=evidence_dir, prefix=".proof-",
                                              delete=False) as stream:
                temporary = Path(stream.name)
                os.chmod(stream.name, 0o600)
                json.dump({"merges": merges}, stream)
                stream.write("\n")
            os.replace(temporary, target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    except (OSError, ValueError, TypeError, AttributeError) as error:
        print(f"Could not record merged workspace PR for {repo}: {error}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", action="append", type=Path, default=[], help="An open local Git repository; may be repeated")
    parser.add_argument("--force", action="store_true", help="Ignore the ten-minute scan interval")
    parser.add_argument("--dry-run", action="store_true", help="Show branches that would be pruned")
    parser.add_argument("--branch", help="Limit cleanup to one local branch")
    args = parser.parse_args()

    if not GIT or not due(args.force):
        return 0

    found = []
    try:
        for repo in list(dict.fromkeys(path.resolve() for path in args.repo))[:MAX_REPOS]:
            if not args.branch and not args.dry_run:
                try:
                    for ref in prune_origin_tracking(repo):
                        print(f"Pruned deleted origin tracking branch {repo}: {ref}")
                except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                    print(f"Could not prune origin refs in {repo}: {error}", file=sys.stderr)
            if not GH:
                print(f"Skipping merged local-branch cleanup in {repo}: install/authenticate GitHub CLI (gh)", file=sys.stderr)
                continue
            try:
                found.extend(prune_repo(repo, args.dry_run, args.branch))
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                print(f"Could not check merged local branches in {repo}: {error}", file=sys.stderr)
    finally:
        if not args.dry_run:
            mark_run()

    action = "Would prune" if args.dry_run else "Pruned"
    for repo, branch, number in found:
        print(f"{action} merged PR branch {repo}: {branch} (#{number})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
