#!/usr/bin/env python3
"""Prune local branches whose GitHub pull requests have safely merged."""
import argparse
import json
import re
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
    prefix = "branch refs/heads/"
    return {
        line[len(prefix):]
        for line in result.stdout.splitlines()
        if line.startswith(prefix)
    }


def local_branches(repo):
    result = run(
        [GIT, "for-each-ref", "--format=%(refname:short)\t%(objectname)", "refs/heads"],
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
                    and pr.get("headRefOid") == local_oid):
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
                       "state,headRefName,headRefOid,baseRefName,isCrossRepository,mergedAt"], cwd=repo)
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
                or verified.get("headRefOid") != expected_oid):
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
            [GIT, "update-ref", "-d", f"refs/heads/{branch}", expected_oid],
            cwd=repo,
            timeout=10,
        )
        if result.returncode == 0:
            pruned.append((name_with_owner, branch, number))
    return pruned


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", action="append", type=Path, default=[], help="An open local Git repository; may be repeated")
    parser.add_argument("--force", action="store_true", help="Ignore the ten-minute scan interval")
    parser.add_argument("--dry-run", action="store_true", help="Show branches that would be pruned")
    parser.add_argument("--branch", help="Limit cleanup to one local branch")
    args = parser.parse_args()

    if not GIT or not GH or not due(args.force):
        return 0

    found = []
    try:
        for repo in list(dict.fromkeys(path.resolve() for path in args.repo))[:MAX_REPOS]:
            try:
                found.extend(prune_repo(repo, args.dry_run, args.branch))
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                continue
    finally:
        if not args.dry_run:
            mark_run()

    action = "Would prune" if args.dry_run else "Pruned"
    for repo, branch, number in found:
        print(f"{action} merged PR branch {repo}: {branch} (#{number})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
