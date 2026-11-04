#!/usr/bin/env python3
"""Repair references and standalone import resolution after filename migration."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def gitlines(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT).decode().splitlines()


def modify(name, old, new):
    path = ROOT / name
    source = path.read_text(encoding="utf-8")
    if old not in source:
        raise RuntimeError(f"Missing expected source in {name}: {old!r}")
    path.write_text(source.replace(old, new), encoding="utf-8")


def main():
    old_paths = gitlines("ls-tree", "-r", "--name-only", "origin/main")
    original_names = {Path(p).name for p in old_paths if "_" in Path(p).name
                      and Path(p).name.islower() and Path(p).name != "__init__.py"}
    renames = sorted(((name, name.replace("_", "-")) for name in original_names),
                     key=lambda item: -len(item[0]))
    tracked = gitlines("ls-files")
    for name in tracked:
        path = ROOT / name
        if not path.is_file() or path.is_symlink() or name.startswith(".github/workflows/"):
            continue
        raw = path.read_bytes()
        if b"\0" in raw:
            continue
        try:
            source = raw.decode("utf-8")
        except UnicodeError:
            continue
        updated = source
        for old, new in renames:
            updated = updated.replace(old, new)
        if updated != source:
            path.write_bytes(updated.encode("utf-8"))

    old = """for _sb_parent in _sb_path(__file__).resolve().parents:
    _sb_scripts = _sb_parent / 'scripts'"""
    new = """for _sb_parent in _sb_path(__file__).resolve().parents:
    _sb_scripts = (_sb_parent if (_sb_parent / 'importaliases.py').is_file()
                   else _sb_parent / 'scripts')"""
    replacements = 0
    for name in tracked:
        if not name.endswith(".py") or name.startswith(".github/"):
            continue
        path = ROOT / name
        source = path.read_text(encoding="utf-8")
        if old in source:
            path.write_text(source.replace(old, new), encoding="utf-8")
            replacements += 1
    if replacements < 50:
        raise RuntimeError(f"Only updated {replacements} standalone bootstraps")

    path = "scripts/wrapper-dependencies.py"
    modify(path, 'candidates = {path.stem: path for path in directory.glob("*.py")',
           'candidates = {path.stem.replace("-", "_"): path for path in directory.glob("*.py")')
    modify(path, 'sources = {f"{name}.py": source for name, source in modules.items()}',
           'sources = {source.name: source for source in modules.values()}')
    modify(path, 'modules = sorted(name[:-3] for name in runtime_sources(directory)',
           'modules = sorted(name[:-3].replace("-", "_") for name in runtime_sources(directory)')
    modify(path, 'root = Path(sys.argv[1])\nsys.path.insert(0, str(root))\nfor name',
           'root = Path(sys.argv[1])\nsys.path.insert(0, str(root))\nimport importaliases\nimportaliases.install()\nfor name')
    modify(path, 'root / (name + ".py")', 'root / (name.replace("_", "-") + ".py")')
    modify("scripts/workspace-search.py", '    files[Path("configurator.py")] = here / "configurator.py"',
           '    files[Path("configurator.py")] = here / "configurator.py"\n'
           '    files[Path("importaliases.py")] = here / "importaliases.py"')
    modify("tests/workbench-live-runtime.js", r"codex_file_drag\.js", r"codex-file-drag\.js")
    modify("tests/parallel-merge-batch.js", "'/merge/parallel_merge_batch'", "'/merge/parallel-merge-batch'")
    modify("tests/parallel-pr-session.js", "'/github/pr_session'", "'/github/pr-session'")
    print(f"Applied {replacements} Python bootstrap repairs, wrapper closure and standalone packaging fixes")


if __name__ == "__main__":
    main()
