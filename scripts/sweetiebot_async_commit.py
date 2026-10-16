"""Durable, local-only commit-message finalization and push barrier.

Git commits a temporary title immediately. A detached Ollama worker replaces the
commit object without touching the index or working tree. All Git operations that
could move or publish the ref must pass through the installed Git wrapper.
"""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time

from sweetiebot_diagnostics import log_event

PLACEHOLDER = "💭 Generate local commit message"
JOURNAL = "sweetiebot-async-commit.json"
LOCK = "sweetiebot-async-commit.lock"
WAIT_SECONDS = 1200
GATED_COMMANDS = {"commit", "push", "pull", "merge", "rebase", "reset", "switch", "checkout", "cherry-pick"}


def command(real_git, global_args, *args, **kwargs):
    return subprocess.run([real_git, *global_args, *args], check=False, **kwargs)


def git_text(real_git, global_args, *args):
    result = command(real_git, global_args, *args, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "Git command failed: " + " ".join(args))
    return result.stdout.strip()


def paths(real_git, global_args):
    result = command(real_git, global_args, "rev-parse", "--absolute-git-dir",
                     capture_output=True, text=True)
    if result.returncode or not isinstance(getattr(result, "stdout", None), str):
        return None
    directory = Path(result.stdout.strip())
    return directory / JOURNAL, directory / LOCK


@contextmanager
def exclusive(lock_file):
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_file, "a+b") as stream:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def read_journal(journal):
    try:
        return json.loads(journal.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def write_journal(journal, data):
    fd, name = tempfile.mkstemp(prefix=".sweetiebot-async-", dir=journal.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, journal)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def head(real_git, global_args):
    return git_text(real_git, global_args, "rev-parse", "--verify", "HEAD")


def current_branch(real_git, global_args):
    return git_text(real_git, global_args, "symbolic-ref", "--quiet", "--short", "HEAD")


def alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def reconcile(real_git, global_args, journal, job):
    """Finish an interrupted CAS update, never move a changed branch."""
    replacement = job.get("replacement_sha")
    if not replacement:
        return False
    try:
        branch = current_branch(real_git, global_args)
        actual = head(real_git, global_args)
    except RuntimeError:
        return False
    if branch != job["branch"]:
        return False
    if actual == replacement:
        journal.unlink(missing_ok=True)
        return True
    if actual != job["sha"]:
        return False
    result = command(real_git, global_args, "update-ref",
                     "refs/heads/" + branch, replacement, job["sha"],
                     capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "Could not finalize local commit")
    journal.unlink(missing_ok=True)
    return True


def commit_metadata(real_git, global_args, sha):
    """Reject signed/extended commits rather than silently dropping headers."""
    raw = git_text(real_git, global_args, "cat-file", "-p", sha)
    headers, _, body = raw.partition("\n\n")
    parsed = {}
    for line in headers.splitlines():
        key, _, value = line.partition(" ")
        if key not in {"tree", "parent", "author", "committer"} or not value:
            raise RuntimeError("Cannot rewrite a signed or extended-header commit")
        if key in parsed:
            raise RuntimeError("Cannot rewrite a multi-parent commit asynchronously")
        parsed[key] = value
    if not all(key in parsed for key in ("tree", "author", "committer")):
        raise RuntimeError("The placeholder commit is missing required Git metadata")
    return parsed, body


def identity(value):
    match = re.fullmatch(r"(.+) <([^<>]+)> (\d+) ([+-]\d{4})", value)
    if not match:
        raise RuntimeError("Unsupported commit identity; keeping the placeholder private")
    return match.groups()


def finalize(real_git, global_args, job_id, title, description):
    pair = paths(real_git, global_args)
    if pair is None:
        raise RuntimeError("Repository metadata is unavailable")
    journal, lock = pair
    with exclusive(lock):
        job = read_journal(journal)
        if not job or job["id"] != job_id:
            return False  # Already finalized or replaced by recovery.
        if reconcile(real_git, global_args, journal, job):
            return True
        if not job.get("sha"):
            raise RuntimeError("The provisional Git commit has not completed")
        if current_branch(real_git, global_args) != job["branch"] or head(real_git, global_args) != job["sha"]:
            raise RuntimeError("Branch advanced while a commit was pending; push remains blocked")
        headers, previous_message = commit_metadata(real_git, global_args, job["sha"])
        if not previous_message.splitlines()[0].startswith(PLACEHOLDER + " [" + job_id + "]"):
            raise RuntimeError("The pending commit does not match its durable journal")
        message = title.strip()
        if description.strip():
            message += "\n\n" + description.strip()
        # Keep trailers inserted by Git commit hooks or --signoff.
        suffix = previous_message.partition("\n")[2].strip()
        if suffix:
            message += "\n\n" + suffix
        if not message or "\x00" in message:
            raise RuntimeError("Refusing an invalid generated commit message")
        author = identity(headers["author"])
        committer = identity(headers["committer"])
        env = os.environ.copy()
        for prefix, identity_parts in (("AUTHOR", author), ("COMMITTER", committer)):
            env["GIT_" + prefix + "_NAME"] = identity_parts[0]
            env["GIT_" + prefix + "_EMAIL"] = identity_parts[1]
            env["GIT_" + prefix + "_DATE"] = identity_parts[2] + " " + identity_parts[3]
        args = ["commit-tree", headers["tree"]]
        if "parent" in headers:
            args += ["-p", headers["parent"]]
        created = command(real_git, global_args, *args, input=message,
                          text=True, capture_output=True, env=env)
        if created.returncode:
            raise RuntimeError(created.stderr.strip() or "Could not create finalized commit")
        replacement = created.stdout.strip()
        if not re.fullmatch("[0-9a-f]{40,64}", replacement) or replacement == job["sha"]:
            raise RuntimeError("Git did not produce a distinct finalized commit")
        job["replacement_sha"] = replacement
        write_journal(journal, job)  # Crash recovery can complete the update-ref.
        return reconcile(real_git, global_args, journal, job)


def fallback(job):
    import ai_commit
    return ai_commit.fallback_message(
        job["files"], job["include_description"], job.get("file_context", ""))


def recover(real_git, global_args, job):
    try:
        title, description = fallback(job)
        finalize(real_git, global_args, job["id"], title, description)
    except Exception as exc:
        log_event("commit_title", "async_recovery_failed", reason="worker_stopped",
                  error_type=type(exc).__name__, outcome="blocked")
        raise
    log_event("commit_title", "async_fallback", reason="worker_stopped",
              outcome="fallback")


def wait_for_completion(real_git, global_args, timeout=WAIT_SECONDS):
    """Fail closed: never allow a placeholder to be pushed or moved."""
    pair = paths(real_git, global_args)
    if pair is None:
        return
    journal, lock = pair
    start = time.monotonic()
    while True:
        with exclusive(lock):
            job = read_journal(journal)
            if not job:
                return
            if reconcile(real_git, global_args, journal, job):
                return
            if job.get("error"):
                raise RuntimeError(job["error"] + "; placeholder remains local")
            crashed = job.get("sha") and not alive(job.get("pid"))
            awaiting_spawn = not job.get("sha") and time.monotonic() - start < 5
            if not job.get("sha") and not awaiting_spawn:
                # A failed commit must not leave its journal blocking forever.
                previous = job.get("previous_head", "")
                try:
                    actual = head(real_git, global_args)
                except RuntimeError:
                    actual = ""
                if actual == previous:
                    journal.unlink(missing_ok=True)
                    return
                log_event("commit_title", "async_operation_blocked",
                          reason="interrupted_provisional_commit", outcome="blocked")
                raise RuntimeError("Interrupted provisional commit; inspect local Git history")
        if crashed:
            log_event("commit_title", "async_worker_crashed",
                      reason="worker_stopped", outcome="fallback")
            recover(real_git, global_args, job)
            continue
        if time.monotonic() - start >= timeout:
            log_event("commit_title", "async_operation_blocked",
                      reason="finalization_timeout", outcome="blocked")
            raise RuntimeError("Local commit-message finalization is still pending; push was not attempted")
        time.sleep(0.25)


def begin(real_git, global_args, commit_args, stat, diff, files,
          include_description, file_context, worker_script, spawn=None):
    """Commit first, then return while Ollama runs independently."""
    pair = paths(real_git, global_args)
    if pair is None:
        raise RuntimeError("Asynchronous generation needs a local Git repository")
    journal, lock = pair
    wait_for_completion(real_git, global_args)
    with exclusive(lock):
        if read_journal(journal):
            raise RuntimeError("A previous commit is still pending")
        branch = current_branch(real_git, global_args)
        try:
            previous_head = head(real_git, global_args)
        except RuntimeError:
            previous_head = ""  # Initial root commit.
        job = {
            "id": secrets.token_hex(12), "sha": "", "previous_head": previous_head,
            "branch": branch, "stat": stat, "diff": diff, "files": files,
            "file_context": file_context, "include_description": include_description,
            "global_args": global_args, "pid": 0, "created_at": time.time(),
        }
        write_journal(journal, job)
        placeholder = PLACEHOLDER + " [" + job["id"] + "]"
        try:
            result = command(real_git, global_args, "commit", *commit_args,
                             "-m", placeholder)
            if result.returncode:
                journal.unlink(missing_ok=True)
                log_event("commit_title", "async_placeholder_commit_failed",
                          reason="git_commit_rejected", outcome="blocked")
                return result.returncode
            new_head = head(real_git, global_args)
            if new_head == previous_head or current_branch(real_git, global_args) != branch:
                log_event("commit_title", "async_finalization_failed",
                          reason="commit_hook_changed_branch", outcome="blocked")
                job["error"] = "Commit hook changed the branch during provisional commit"
                write_journal(journal, job)
                raise RuntimeError(job["error"])
            job["sha"] = new_head
            write_journal(journal, job)
            try:
                worker = (spawn or subprocess.Popen)(
                    [sys.executable, worker_script, "--sweetiebot-finalize", job["id"], str(journal)],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True,
                    cwd=git_text(real_git, global_args, "rev-parse", "--show-toplevel"),
                )
                job["pid"] = worker.pid
                write_journal(journal, job)
            except OSError as exc:
                # Preserve the reason in the same local diagnostics log as Ollama.
                log_event("commit_title", "async_worker_start_failed",
                          reason="spawn_failed", error_type=type(exc).__name__,
                          outcome="fallback")
                # The commit exists: fall back locally, never accidentally push it.
                title, description = fallback(job)
                # Release the lock before acquiring it in finalize below.
                worker = None
        except BaseException:
            if not job.get("sha"):
                journal.unlink(missing_ok=True)
            raise
    if worker is None:
        try:
            finalize(real_git, global_args, job["id"], title, description)
        except Exception as exc:
            log_event("commit_title", "async_finalization_failed",
                      reason="spawn_fallback_finalization_failed",
                      error_type=type(exc).__name__, outcome="blocked")
            raise
        log_event("commit_title", "async_fallback", reason="spawn_failed",
                  outcome="fallback")
    return 0


def run_worker(real_git, job_id, journal_path):
    journal = Path(journal_path)
    job = read_journal(journal)
    if not job or job.get("id") != job_id:
        return
    verified = paths(real_git, list(job["global_args"]))
    if verified is None or verified[0].resolve() != journal.resolve():
        log_event("commit_title", "async_worker_verification_failed",
                  reason="journal_mismatch", outcome="blocked")
        raise RuntimeError("The pending journal does not belong to the selected Git repository")
    import ai_commit
    ai_commit.GIT_GLOBAL_ARGS = list(job["global_args"])
    try:
        # Snapshot was captured before committing; later user edits are irrelevant.
        title, description = ai_commit.generate_message(
            job["stat"], job["diff"], job["files"],
            include_description=job["include_description"],
            file_context_override=job.get("file_context", ""),
        )
    except Exception as exc:
        log_event("commit_title", "async_fallback", reason="generation_failed",
                  error_type=type(exc).__name__, outcome="fallback")
        title, description = fallback(job)
    try:
        finalize(real_git, list(job["global_args"]), job_id, title, description)
    except Exception as exc:
        try:
            with exclusive(paths(real_git, list(job["global_args"]))[1]):
                current = read_journal(journal)
                if current and current.get("id") == job_id:
                    current["error"] = str(exc)
                    write_journal(journal, current)
        finally:
            log_event("commit_title", "async_finalization_failed",
                      reason="commit_rewrite_failed",
                      error_type=type(exc).__name__, outcome="blocked")
