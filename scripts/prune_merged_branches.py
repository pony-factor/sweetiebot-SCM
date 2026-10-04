#!/usr/bin/env python3
"""Prune local branches whose GitHub pull requests have safely merged."""
import argparse
import json
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
    result = run(
        [GH, "repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
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
    return name, default


def pull_requests(repo):
    result = run(
        [
            GH, "pr", "list",
            "--state", "all",
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


def prune_repo(repo, dry_run=False, branch_filter=None):
    metadata = github_repo(repo)
    if not metadata:
        return []
    name_with_owner, default_branch = metadata
    prs = pull_requests(repo)
    if prs is None:
        return []

    open_heads = {
        pr.get("headRefName")
        for pr in prs
        if not pr.get("isCrossRepository") and pr.get("state") == "OPEN"
    }
    candidates = {}
    for pr in prs:
        branch = pr.get("headRefName")
        oid = pr.get("headRefOid")
        if (
            pr.get("isCrossRepository")
            or pr.get("baseRefName") != default_branch
            or not pr.get("mergedAt")
            or not branch
            or not oid
            or branch in open_heads
        ):
            continue
        candidates[(branch, oid)] = pr.get("number")

    branches = local_branches(repo)
    protected = checked_out_branches(repo)
    pruned = []
    for (branch, expected_oid), number in candidates.items():
        if branch_filter is not None and branch != branch_filter:
            continue
        if branch == default_branch or branch in protected:
            continue
        if branches.get(branch) != expected_oid:
            continue
        current = run([GH, "pr", "view", str(number), "--json",
                       "state,headRefName,headRefOid,baseRefName,isCrossRepository,mergedAt"], cwd=repo)
        opened = run([GH, "pr", "list", "--state", "open", "--head", branch,
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
                or verified.get("headRefOid") != expected_oid
                or branch in checked_out_branches(repo)):
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
