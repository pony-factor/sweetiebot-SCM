#!/usr/bin/env python3
from __future__ import annotations

import difflib
import importlib.util
from importlib.machinery import SourceFileLoader
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from types import ModuleType

REAL_GIT = os.environ.get("SCM_TOOLKIT_REAL_GIT", "/usr/bin/git")
CORE_PATH = os.path.expanduser(
    os.environ.get(
        "SCM_TOOLKIT_COMMIT_CORE",
        str(Path(__file__).with_name("ai_commit.py")),
    )
)
SPELLCHECK_EXTENSIONS = {".md", ".mdx"}
SPELLCHECK_MAX_RANGE_CHARS = int(os.environ.get("SCM_TOOLKIT_SPELLCHECK_MAX_RANGE_CHARS", "8000"))
SPELLCHECK_NUM_CTX = int(os.environ.get("SCM_TOOLKIT_SPELLCHECK_NUM_CTX", "8192"))
SPELLCHECK_JOB_ENV = "SCM_TOOLKIT_SPELLCHECK_JOB"
POST_COMMIT_ARG = "--post-commit-spellcheck"
HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")
FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")
URL_RE = re.compile(r"https?://[^\s)>]+")
INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
MARKDOWN_PREFIX_RE = re.compile(r"^(\s*(?:(?:#{1,6}|>|[-+*]|\d+[.)])\s+)?)")
SMART_PUNCTUATION = str.maketrans(
    {
        "\u2018": "'",
        "\u2019": "'",
        "\u201b": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u201f": '"',
        "\u2013": "-",
        "\u2014": "-",
        "\u2026": "...",
    }
)


def load_core() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "scm_toolkit_commit_core", CORE_PATH,
        loader=SourceFileLoader("scm_toolkit_commit_core", CORE_PATH),
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load commit core at {CORE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git_run(global_args: list[str], *args: str, text: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(
        [REAL_GIT, *global_args, *args],
        check=False,
        capture_output=True,
        text=text,
    )


def has_unstaged_changes(global_args: list[str]) -> bool:
    tracked = git_run(global_args, "diff", "--quiet", "--no-ext-diff", "--")
    if tracked.returncode != 0:
        return True
    untracked = git_run(global_args, "ls-files", "--others", "--exclude-standard", "-z", "--")
    return untracked.returncode != 0 or bool(untracked.stdout)


def staged_markdown_paths(global_args: list[str]) -> list[str]:
    result = git_run(
        global_args,
        "diff",
        "--cached",
        "--name-only",
        "--diff-filter=ACMR",
        "-z",
        "--",
    )
    if result.returncode != 0:
        return []
    paths = [os.fsdecode(raw) for raw in result.stdout.split(b"\0") if raw]
    return [path for path in paths if Path(path).suffix.lower() in SPELLCHECK_EXTENSIONS]


def head_sha(global_args: list[str]) -> str:
    result = git_run(global_args, "rev-parse", "HEAD", text=True)
    return result.stdout.strip() if result.returncode == 0 else ""


def changed_line_ranges(global_args: list[str], path: str) -> list[tuple[int, int]]:
    result = git_run(
        global_args,
        "show",
        "--format=",
        "--unified=0",
        "--no-ext-diff",
        "--no-color",
        "HEAD",
        "--",
        path,
        text=True,
    )
    if result.returncode != 0:
        return []
    ranges: list[tuple[int, int]] = []
    for line in result.stdout.splitlines():
        match = HUNK_RE.match(line)
        if not match:
            continue
        start = int(match.group(1))
        count = int(match.group(2) or "1")
        if count:
            ranges.append((start, start + count - 1))
    return ranges


def split_line(line: str) -> tuple[str, str]:
    if line.endswith("\r\n"):
        return line[:-2], "\r\n"
    if line.endswith("\n") or line.endswith("\r"):
        return line[:-1], line[-1:]
    return line, ""


def fenced_lines(lines: list[str]) -> set[int]:
    fenced: set[int] = set()
    active_marker = ""
    active_length = 0
    for number, line in enumerate(lines, start=1):
        body, _ = split_line(line)
        match = FENCE_RE.match(body)
        if active_marker:
            fenced.add(number)
            if match and match.group(1)[0] == active_marker and len(match.group(1)) >= active_length:
                active_marker = ""
                active_length = 0
            continue
        if match:
            token = match.group(1)
            active_marker = token[0]
            active_length = len(token)
            fenced.add(number)
    return fenced


def prose_ranges(lines: list[str], ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    excluded = fenced_lines(lines)
    output: list[tuple[int, int]] = []
    for start, end in ranges:
        current_start: int | None = None
        for number in range(max(1, start), min(len(lines), end) + 1):
            if number in excluded:
                if current_start is not None:
                    output.append((current_start, number - 1))
                    current_start = None
            elif current_start is None:
                current_start = number
        if current_start is not None:
            output.append((current_start, min(len(lines), end)))
    return output


def chunk_range(lines: list[str], start: int, end: int) -> list[tuple[int, int]]:
    chunks: list[tuple[int, int]] = []
    cursor = start
    while cursor <= end:
        chunk_start = cursor
        size = 0
        while cursor <= end:
            body, _ = split_line(lines[cursor - 1])
            addition = len(body) + (1 if cursor > chunk_start else 0)
            if cursor > chunk_start and size + addition > SPELLCHECK_MAX_RANGE_CHARS:
                break
            size += addition
            cursor += 1
        chunks.append((chunk_start, cursor - 1))
    return chunks


def protected_tokens(text: str) -> list[str]:
    return URL_RE.findall(text) + INLINE_CODE_RE.findall(text)


def markdown_prefix(line: str) -> str:
    match = MARKDOWN_PREFIX_RE.match(line)
    return match.group(1) if match else ""


def normalize_smart_punctuation(text: str) -> str:
    return text.translate(SMART_PUNCTUATION)


def safe_correction(original: str, corrected: str) -> bool:
    original_lines = original.split("\n")
    corrected_lines = corrected.split("\n")
    if len(original_lines) != len(corrected_lines):
        return False
    if protected_tokens(original) != protected_tokens(corrected):
        return False
    for before, after in zip(original_lines, corrected_lines):
        if markdown_prefix(before) != markdown_prefix(after):
            return False
    if original == corrected:
        return True
    return difflib.SequenceMatcher(None, original, corrected).ratio() >= 0.72


def spellcheck_prompt(path: str, target: str, before: str, after: str) -> str:
    line_count = len(target.split("\n"))
    return f"""You are a spellcheck-only editor. Correct only the TARGET Markdown text.

Allowed changes:
- spelling and obvious typographical errors
- accidental duplicated or missing small words
- clear punctuation or grammar mistakes
- replace smart punctuation with plain ASCII punctuation, for example Alpine’s -> Alpine's

Do not rewrite, restyle, summarize, change meaning, alter facts, or make editorial improvements.
Preserve Markdown syntax, URLs, inline code, citations, capitalization choices, and line breaks.
Use plain ASCII punctuation in prose; do not introduce curly quotes, smart apostrophes, en/em dashes, or ellipsis characters.
Return exactly {line_count} target line(s), with no added or removed lines.
The BEFORE and AFTER text is context only and must not be returned or changed.
Return JSON only in this exact shape: {{"text":"corrected target text"}}.

File: {path}

BEFORE:
{before or "[none]"}

TARGET:
{target}

AFTER:
{after or "[none]"}
"""


def request_correction(core: ModuleType, model: str, path: str, target: str, before: str, after: str) -> str | None:
    try:
        response = core.ollama_json(
            "/api/generate",
            {
                "model": model,
                "prompt": spellcheck_prompt(path, target, before, after),
                "stream": False,
                "format": "json",
                "options": {
                    "num_ctx": SPELLCHECK_NUM_CTX,
                    "temperature": 0,
                    "num_predict": 4096,
                },
            },
        )
        payload = json.loads(str(response.get("response", "")))
        corrected = payload.get("text")
        if not isinstance(corrected, str):
            return None
        corrected = normalize_smart_punctuation(corrected)
        if not safe_correction(target, corrected):
            return None
        return corrected
    except Exception:
        return None


def spellcheck_file(core: ModuleType, model: str, global_args: list[str], path: str) -> tuple[bytes, bytes] | None:
    root_result = git_run(global_args, "rev-parse", "--show-toplevel")
    if root_result.returncode != 0:
        return None
    root = Path(os.fsdecode(root_result.stdout.rstrip(b"\n")))
    file_path = root / path
    if file_path.is_symlink() or not file_path.resolve().is_relative_to(root.resolve()):
        return None
    try:
        original_bytes = file_path.read_bytes()
        text = original_bytes.decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return None

    lines = text.splitlines(keepends=True)
    if not lines:
        return None
    ranges = prose_ranges(lines, changed_line_ranges(global_args, path))
    if not ranges:
        return None

    updated = list(lines)
    changed = False
    for start, end in ranges:
        for chunk_start, chunk_end in chunk_range(lines, start, end):
            original_bodies = [split_line(lines[number - 1])[0] for number in range(chunk_start, chunk_end + 1)]
            target = "\n".join(original_bodies)
            if not target.strip():
                continue
            context_before = "\n".join(
                split_line(lines[number - 1])[0]
                for number in range(max(1, chunk_start - 2), chunk_start)
            )
            context_after = "\n".join(
                split_line(lines[number - 1])[0]
                for number in range(chunk_end + 1, min(len(lines), chunk_end + 2) + 1)
            )
            corrected = request_correction(core, model, path, target, context_before, context_after)
            if corrected is None or corrected == target:
                continue
            corrected_lines = corrected.split("\n")
            for offset, corrected_body in enumerate(corrected_lines):
                index = chunk_start - 1 + offset
                _, ending = split_line(lines[index])
                updated[index] = corrected_body + ending
            changed = True

    if not changed:
        return None
    updated_bytes = "".join(updated).encode("utf-8")
    return original_bytes, updated_bytes


def index_is_clean(global_args: list[str]) -> bool:
    return git_run(global_args, "diff", "--cached", "--quiet", "--no-ext-diff", "--").returncode == 0


def apply_spellcheck(core: ModuleType, global_args: list[str], paths: list[str], expected_head: str) -> dict[str, tuple[bytes, bytes]]:
    model, _ = core.selected_model(core.installed_local_model_names())
    if model is None:
        return {}
    proposals = {}
    for path in paths:
        proposal = spellcheck_file(core, model, global_args, path)
        if proposal is not None:
            proposals[path] = proposal
    if (
        not proposals
        or head_sha(global_args) != expected_head
        or has_unstaged_changes(global_args)
        or not index_is_clean(global_args)
        or not core.git_config_bool("scm-toolkit.post-commit-spellcheck", False)
    ):
        return {}
    root_result = git_run(global_args, "rev-parse", "--show-toplevel")
    if root_result.returncode != 0:
        return {}
    root = Path(os.fsdecode(root_result.stdout.rstrip(b"\n")))
    for path, (original, _) in proposals.items():
        try:
            if (root / path).is_symlink() or (root / path).read_bytes() != original:
                return {}
        except OSError:
            return {}
    for path, (_, proposed) in proposals.items():
        (root / path).write_bytes(proposed)
    return proposals


def dialog_choice(file_count: int) -> str:
    message = (
        f"Spellcheck proposed changes in {file_count} Markdown file"
        f"{'s' if file_count != 1 else ''}.\n\n"
        "Review the unstaged diff in Source Control.\n\n"
        "Keep edits: leave the changes unstaged for review.\n"
        "Discard: remove the generated changes."
    )
    script = """on run argv
set resultDialog to display dialog (item 1 of argv) with title "Spellcheck" buttons {"Discard", "Keep edits"} default button "Keep edits"
return button returned of resultDialog
end run"""
    result = subprocess.run(
        ["/usr/bin/osascript", "-e", script, message],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def proposal_is_untouched(global_args: list[str], proposals: dict[str, tuple[bytes, bytes]]) -> bool:
    root_result = git_run(global_args, "rev-parse", "--show-toplevel")
    if root_result.returncode != 0:
        return False
    root = Path(os.fsdecode(root_result.stdout.rstrip(b"\n")))
    for path, (_, proposed) in proposals.items():
        try:
            if (root / path).read_bytes() != proposed:
                return False
        except OSError:
            return False
    return True


def discard_proposals(global_args: list[str], proposals: dict[str, tuple[bytes, bytes]]) -> None:
    if not proposal_is_untouched(global_args, proposals):
        return
    git_run(global_args, "--literal-pathspecs", "restore", "--worktree", "--", *proposals.keys())


def run_post_commit_job() -> int:
    raw = os.environ.get(SPELLCHECK_JOB_ENV, "")
    try:
        job = json.loads(raw)
        global_args = list(job["global_args"])
        paths = list(job["paths"])
        expected_head = str(job["head"])
    except (KeyError, TypeError, ValueError):
        return 0

    if not paths or head_sha(global_args) != expected_head or has_unstaged_changes(global_args) or not index_is_clean(global_args):
        return 0

    try:
        core = load_core()
        core.GIT_GLOBAL_ARGS = global_args
        if not core.git_config_bool("scm-toolkit.post-commit-spellcheck", False):
            return 0
        proposals = apply_spellcheck(core, global_args, paths, expected_head)
    except Exception:
        return 0
    if not proposals:
        return 0

    choice = dialog_choice(len(proposals))
    if choice == "Discard" and head_sha(global_args) == expected_head and index_is_clean(global_args):
        discard_proposals(global_args, proposals)
    return 0


def spawn_post_commit(global_args: list[str], paths: list[str], committed_head: str, core_path: str) -> None:
    if not paths or not committed_head:
        return
    env = os.environ.copy()
    env["SCM_TOOLKIT_COMMIT_CORE"] = core_path
    env[SPELLCHECK_JOB_ENV] = json.dumps(
        {"global_args": global_args, "paths": paths, "head": committed_head},
        separators=(",", ":"),
    )
    subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), POST_COMMIT_ARG],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


if __name__ == "__main__":
    if sys.argv[1:] == [POST_COMMIT_ARG]:
        raise SystemExit(run_post_commit_job())
