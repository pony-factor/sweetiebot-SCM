#!/usr/bin/env python3
"""Run independent CI test groups and enforce exclusive test-file ownership."""

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


import argparse
import errno
import json
import os
from pathlib import Path
import py_compile
import re
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
CONFIG = Path(__file__).resolve().with_name("ci-test-groups.json")
EXECUTION_UNAVAILABLE = 125  # Distinguish a failed spawn from a failed test.


def inventory(verbose=False):
    data = json.loads(CONFIG.read_text(encoding="utf-8"))
    groups = data["groups"]
    owners = {}
    problems = []
    actual = {path.relative_to(ROOT / "tests").as_posix()
              for suffix in ("py", "js")
              for path in (ROOT / "tests").rglob(f"*.{suffix}")
              if path.name != "__init__.py" and "fixtures" not in path.relative_to(ROOT / "tests").parts}
    redundant_prefixes = {"branches": "branch-", "codex": "codex-", "commits": "commit-", "github": "github-", "kefania": "kefania-", "lindsey": "lindsey-", "merge": "merge-", "pr": "pr-", "spellcheck": "spellcheck-"}
    for name in actual:
        category, filename = name.split("/", 1)
        prefix = redundant_prefixes.get(category)
        if prefix and filename.startswith(prefix):
            problems.append(f"Redundant test filename prefix: {name}")
    for group, spec in groups.items():
        if not spec.get("tests"):
            problems.append(f"{group} has no tests")
        for name in spec["tests"]:
            if not re.fullmatch(r"(?:[a-z][a-z0-9_-]*/)+[A-Za-z0-9_-]+\.(?:py|js)", name):
                problems.append(f"Invalid test name: {name}")
            if name in owners:
                problems.append(f"{name} assigned to {owners[name]} and {group}")
            owners[name] = group
        for path in spec.get("syntax", []):
            if not path.startswith(("assets/", "extension/", "scripts/")) or Path(path).is_absolute():
                problems.append(f"Invalid syntax path: {path}")
            elif not (ROOT / path).is_file():
                problems.append(f"Missing source for syntax check: {path}")
    for name in data.get("specialized_browser_tests", []):
        if name in owners:
            problems.append(f"Specialized browser test also assigned: {name}")
        owners[name] = "Codex webview browser simulation (path-triggered)"
    missing = sorted(actual - owners.keys())
    obsolete = sorted(owners.keys() - actual)
    if missing:
        problems.append("Unassigned test files: " + ", ".join(missing))
    if obsolete:
        problems.append("Missing test files: " + ", ".join(obsolete))
    if problems:
        for problem in problems:
            print(f"::error::{problem}", file=sys.stderr)
        raise SystemExit(1)
    if verbose:
        print(f"Verified {len(actual)} test files with unique owners in "
              f"{len(groups)} grouped jobs and the existing browser integration workflow.")
    return data


PLAYWRIGHT_JS_IMPORT = re.compile(
    r"""(?:\brequire\s*\(\s*['"]playwright['"]\s*\)"""
    r"""|\bimport\s*\(\s*['"]playwright['"]\s*\)"""
    r"""|\bfrom\s+['"]playwright['"]"""
    r"""|\bimport\s+['"]playwright['"])"""
)


def browser_needed(spec):
    # Require a full browser for all supported Playwright import forms, not
    # just CommonJS. A false positive only costs browser setup; a false negative
    # silently makes genuine browser tests run without Chromium installed.
    return any(
        PLAYWRIGHT_JS_IMPORT.search(
            (ROOT / "tests" / name).read_text(encoding="utf-8"))
        for name in spec["tests"] if name.endswith(".js")
    )


def resolve_command(command, env):
    """Find Node when a macOS GUI-launched extension has a minimal PATH."""
    if not command or command[0] != "node":
        return command
    executable = shutil.which("node", path=env.get("PATH", ""))
    if not executable and sys.platform == "darwin":
        home = Path.home()
        candidates = [Path("/opt/homebrew/bin/node"), Path("/usr/local/bin/node"),
                      home / ".volta/bin/node", home / ".asdf/shims/node",
                      home / ".local/share/mise/shims/node"]
        candidates.extend(sorted((home / ".nvm/versions/node").glob("*/bin/node"), reverse=True))
        executable = next((str(candidate) for candidate in candidates
                           if candidate.is_file() and os.access(candidate, os.X_OK)), None)
    return [executable, *command[1:]] if executable else command


def execute(command, env=None):
    print("+", " ".join(map(str, command)), flush=True)
    # Integrated-tree checks also run locally. Personal App identities and
    # formatting preferences must not change fixtures or trigger live auth.
    test_env = dict(os.environ if env is None else env)
    test_env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
    # Python regressions and JavaScript helpers also spawn `node` by name.
    # Propagate the GUI-path fallback to every descendant, not just direct
    # Node commands launched by this runner.
    node = resolve_command(["node"], test_env)[0]
    if os.path.isabs(node):
        entries = test_env.get("PATH", "").split(os.pathsep)
        directory = str(Path(node).parent)
        if directory not in entries:
            test_env["PATH"] = os.pathsep.join([directory, *entries])
    resolved = resolve_command(command, test_env)
    # Concurrent Lindsey integrations can briefly exhaust macOS process slots
    # or open descriptors. Retry only transient OS launch failures, never
    # failing checks or a genuinely missing executable.
    transient = {errno.EAGAIN, errno.EMFILE, errno.ENFILE, errno.ENOMEM}
    for attempt in range(4):
        try:
            return subprocess.run(resolved, cwd=ROOT, env=test_env, check=False).returncode
        except OSError as error:
            if error.errno in transient and attempt < 3:
                time.sleep(0.25 * (2 ** attempt))
                continue
            if error.errno == errno.ENOENT and command[0] == "node":
                detail = "Node.js executable not found; install Node or add it to PATH."
            else:
                detail = f"Could not launch {command[0]}: {error}."
            print(f"::error::{detail}", file=sys.stderr)
            return EXECUTION_UNAVAILABLE


def run_group(name, spec):
    print(f"Running {spec['label']} ({len(spec['tests'])} test files)", flush=True)
    failures = 0

    def checked_execute(command, failure_message, env=None):
        result = execute(command, env) if env is not None else execute(command)
        if result == EXECUTION_UNAVAILABLE:
            print(f"::error::{name}: Test execution unavailable; aborting without claiming a regression failure.",
                  file=sys.stderr)
            raise SystemExit(EXECUTION_UNAVAILABLE)
        if result:
            print(failure_message, file=sys.stderr)
        return bool(result)
    python_tests = [item for item in spec["tests"] if item.endswith(".py")]
    javascript_tests = [item for item in spec["tests"] if item.endswith(".js")]
    python_syntax = [item for item in spec.get("syntax", []) if item.endswith(".py")]
    js_syntax = [item for item in spec.get("syntax", []) if item.endswith(".js")]
    for file in [*(f"tests/{item}" for item in python_tests), *python_syntax]:
        try:
            py_compile.compile(str(ROOT / file), doraise=True)
        except py_compile.PyCompileError as error:
            print(f"::error file={file}::{error}", file=sys.stderr)
            failures += 1
    for file in [*(f"tests/{item}" for item in javascript_tests), *js_syntax]:
        failures += checked_execute(["node", "--check", file],
                                    f"::error file={file}::JavaScript syntax check failed")
    if python_tests:
        env = os.environ.copy()
        env["PYTHONPATH"] = os.pathsep.join(
            [str(ROOT / "scripts"), str(ROOT / "tests"), env.get("PYTHONPATH", "")]
        )
        modules = [f"tests.{Path(item).with_suffix('').as_posix().replace('/', '.')}" for item in python_tests]
        failures += checked_execute([sys.executable, "-m", "unittest", "-v", *modules],
                                    f"::error::{name} Python regressions failed", env)
    for file in javascript_tests:
        failures += checked_execute(["node", f"tests/{file}"],
                                    f"::error file=tests/{file}::JavaScript regression test failed")
    if failures:
        print(f"::error::{name}: {failures} test or syntax failures", file=sys.stderr)
        raise SystemExit(1)
    print(f"{spec['label']} checks passed.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["verify", "browser-needed", "run"])
    parser.add_argument("group", nargs="?")
    args = parser.parse_args()
    data = inventory(verbose=args.action == "verify")
    if args.action == "verify":
        return
    if not args.group or args.group not in data["groups"]:
        parser.error("A known group is required for browser-needed and run")
    spec = data["groups"][args.group]
    if args.action == "browser-needed":
        print("required=" + str(browser_needed(spec)).lower())
    else:
        run_group(args.group, spec)


if __name__ == "__main__":
    main()
