#!/usr/bin/env python3
"""Run independent CI test groups and enforce exclusive test-file ownership."""

import argparse
import json
import os
from pathlib import Path
import py_compile
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
CONFIG = Path(__file__).resolve().with_name("ci_test_groups.json")


def inventory(verbose=False):
    data = json.loads(CONFIG.read_text(encoding="utf-8"))
    groups = data["groups"]
    owners = {}
    problems = []
    actual = {path.name for suffix in ("py", "js")
              for path in (ROOT / "tests").glob(f"test_*.{suffix}")}
    for group, spec in groups.items():
        if not spec.get("tests"):
            problems.append(f"{group} has no tests")
        for name in spec["tests"]:
            if not re.fullmatch(r"test_[A-Za-z0-9_]+\.(?:py|js)", name):
                problems.append(f"Invalid test name: {name}")
            if name in owners:
                problems.append(f"{name} assigned to {owners[name]} and {group}")
            owners[name] = group
        for path in spec.get("syntax", []):
            if not path.startswith(("assets/", "efs/", "scripts/")) or Path(path).is_absolute():
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


def browser_needed(spec):
    # Only Node-based suites run via the group runner use Playwright.
    return any(
        re.search(r"""require\s*\(\s*['"]playwright['"]\s*\)""",
                  (ROOT / "tests" / name).read_text(encoding="utf-8"))
        for name in spec["tests"] if name.endswith(".js")
    )


def execute(command, env=None):
    print("+", " ".join(map(str, command)), flush=True)
    return subprocess.run(command, cwd=ROOT, env=env, check=False).returncode


def run_group(name, spec):
    print(f"Running {spec['label']} ({len(spec['tests'])} test files)", flush=True)
    failures = 0
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
        if execute(["node", "--check", file]):
            print(f"::error file={file}::JavaScript syntax check failed", file=sys.stderr)
            failures += 1
    if python_tests:
        env = os.environ.copy()
        env["PYTHONPATH"] = os.pathsep.join(
            [str(ROOT / "scripts"), str(ROOT / "tests"), env.get("PYTHONPATH", "")]
        )
        modules = [Path(item).stem for item in python_tests]
        if execute([sys.executable, "-m", "unittest", "-v", *modules], env):
            print(f"::error::{name} Python regressions failed", file=sys.stderr)
            failures += 1
    for file in javascript_tests:
        if execute(["node", f"tests/{file}"]):
            print(f"::error file=tests/{file}::JavaScript regression test failed",
                  file=sys.stderr)
            failures += 1
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
