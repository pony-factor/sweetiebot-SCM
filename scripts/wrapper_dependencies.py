"""Resolve and validate all local Python dependencies shipped with the Git wrapper."""
from __future__ import annotations

import ast
import os
from pathlib import Path
import subprocess
import sys

ENTRYPOINTS = (
    "ai_commit", "background_commit", "cloud_repo_sync", "coreml_backend",
    "merged_branch", "post_commit_spellcheck", "sweetiebot_async_commit",
    "sweetiebot_diagnostics",
)
RESOURCE_FILES = {"branch_names": "branch_name_packs.json"}


def runtime_sources(directory):
    """Discover the complete sibling-import closure and its required resources."""
    directory = Path(directory)
    candidates = {path.stem: path for path in directory.glob("*.py") if path.is_file()}
    modules = {}
    pending = list(ENTRYPOINTS)
    while pending:
        name = pending.pop()
        if name in modules:
            continue
        source = candidates.get(name)
        if source is None:
            raise RuntimeError(f"Git wrapper source is missing: {name}.py")
        modules[name] = source
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports = (alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                imports = (node.module or "",)
            else:
                continue
            for imported in imports:
                local = imported.partition(".")[0]
                if local in candidates and local not in modules:
                    pending.append(local)
    sources = {f"{name}.py": source for name, source in modules.items()}
    for module, filename in RESOURCE_FILES.items():
        if module in modules:
            resource = directory / filename
            if not resource.is_file():
                raise RuntimeError(f"Git wrapper resource is missing: {filename}")
            sources[filename] = resource
    return dict(sorted(sources.items()))


def wrapper_files(directory, executable):
    """Return canonical source mapping for every managed installation file."""
    directory, executable = Path(directory), Path(executable)
    files = {executable.with_name(name): source
             for name, source in runtime_sources(directory).items()}
    files[executable] = directory / "ai_commit.py"
    files[executable.with_name(executable.name + "-spellcheck.py")] = (
        directory / "post_commit_spellcheck.py")
    files[executable.with_name("pony_git_publish.js")] = (
        directory.parent / "extension/commits/pony_git_publish.js")
    for source in files.values():
        if not source.is_file():
            raise RuntimeError(f"Git wrapper source is missing: {source.name}")
    return files


def validate_imports(directory):
    """Exercise runtime imports isolated from the checkout, user site and PYTHONPATH."""
    directory = Path(directory).resolve()
    modules = sorted(name[:-3] for name in runtime_sources(directory)
                     if name.endswith(".py"))
    code = """
import importlib
from pathlib import Path
import sys
root = Path(sys.argv[1])
sys.path.insert(0, str(root))
for name in sys.argv[2:]:
    module = importlib.import_module(name)
    if Path(module.__file__).resolve() != root / (name + ".py"):
        raise RuntimeError("Module resolved outside the toolkit: " + name)
"""
    result = subprocess.run(
        [sys.executable, "-I", "-B", "-c", code, str(directory), *modules],
        cwd=directory, env={**os.environ, "PYTHONPATH": ""},
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode:
        failure = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "unknown import failure"
        raise RuntimeError(f"Git wrapper dependencies cannot load: {failure}")
