#!/usr/bin/env python3
"""One-time migration of lowercase tracked filenames to hyphenated names."""

import ast
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
EXCEPTIONS = {"__init__.py"}


def tracked():
    output = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
    return [Path(item.decode()) for item in output.split(b"\0") if item]


def python_bootstrap(source):
    """Install filename aliases before imports, after docstrings/future imports."""
    if "importaliases.install()" in source:
        return source
    module = ast.parse(source)
    end = 0
    for node in module.body:
        if (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
                and isinstance(node.value.value, str) and end == 0):
            end = node.end_lineno
        elif isinstance(node, ast.ImportFrom) and node.module == "__future__":
            end = node.end_lineno
        else:
            break
    lines = source.splitlines(keepends=True)
    bootstrap = (
        "\nimport sys as _sb_sys\n"
        "from pathlib import Path as _sb_path\n"
        "for _sb_parent in _sb_path(__file__).resolve().parents:\n"
        "    _sb_scripts = _sb_parent / 'scripts'\n"
        "    if (_sb_scripts / 'importaliases.py').is_file():\n"
        "        if str(_sb_scripts) not in _sb_sys.path:\n"
        "            _sb_sys.path.insert(0, str(_sb_scripts))\n"
        "        import importaliases\n"
        "        importaliases.install()\n"
        "        break\n\n"
    )
    if end == 0 and lines and lines[0].startswith("#!"):
        end = 1
    lines.insert(end, bootstrap)
    return "".join(lines)


def main():
    originals = tracked()
    renames = {}
    existing = {str(p) for p in originals}
    for path in originals:
        name = path.name
        if "_" in name and name == name.lower() and name not in EXCEPTIONS:
            new = path.with_name(name.replace("_", "-"))
            if str(new) in existing or new in renames.values():
                raise RuntimeError(f"Filename collision: {path} -> {new}")
            renames[path] = new
    if not renames:
        raise RuntimeError("No lowercase underscore filenames remain to migrate")

    for old, new in renames.items():
        (ROOT / old).rename(ROOT / new)

    names = {old.name: new.name for old, new in renames.items()}
    ordered = sorted(names.items(), key=lambda item: -len(item[0]))
    js_stems = {old.stem: new.stem for old, new in renames.items()
                if old.suffix in {".js", ".css"}}
    quoted_relative = re.compile(r'''(?P<quote>['"\x60])(?P<path>\.{1,2}/[^'"\x60\s]+)(?P=quote)''')

    def fix_relative(match):
        spec = match.group("path")
        parent, slash, stem = spec.rpartition("/")
        target = js_stems.get(stem)
        if target is None:
            return match.group(0)
        return match.group("quote") + parent + slash + target + match.group("quote")

    text_suffixes = {".py", ".js", ".css", ".html", ".json", ".md", ".yml",
                     ".yaml", ".sh", ".toml", ".txt", ".xml", ".svg", ".mjs",
                     ".ts", ".tsx", ".jsx", ".cjs"}
    changed = 0
    for path in originals:
        new = renames.get(path, path)
        on_disk = ROOT / new
        if on_disk.is_symlink() or not on_disk.is_file() or (
                new.suffix not in text_suffixes and
                new.name not in {".gitignore", ".gitattributes"}):
            continue
        raw = on_disk.read_bytes()
        if b"\0" in raw:
            continue
        try:
            body = raw.decode("utf-8")
        except UnicodeError:
            continue
        original = body
        for old_name, new_name in ordered:
            body = body.replace(old_name, new_name)
        body = quoted_relative.sub(fix_relative, body)
        if new.as_posix() == "scripts/ci/ci-test-runner.py":
            body = body.replace(r"[A-Za-z0-9_]+\.(?:py|js)",
                                r"[A-Za-z0-9_-]+\.(?:py|js)")
        if (new.suffix == ".py" and
                new.name not in {"importaliases.py", "sitecustomize.py"} and
                path != Path("tests/__init__.py")):
            body = python_bootstrap(body)
        if body != original:
            on_disk.write_bytes(body.encode("utf-8"))
            changed += 1

    init = ROOT / "tests/__init__.py"
    init.write_text(init.read_text(encoding="utf-8") + "\n"
        "import sys as _sb_sys\n"
        "from pathlib import Path as _sb_path\n"
        "_sb_scripts = _sb_path(__file__).resolve().parents[1] / 'scripts'\n"
        "if str(_sb_scripts) not in _sb_sys.path:\n"
        "    _sb_sys.path.insert(0, str(_sb_scripts))\n"
        "import importaliases\n"
        "importaliases.install()\n", encoding="utf-8")

    print(f"Renamed {len(renames)} lowercase files; rewrote {changed} text files")
    print("Kept __init__.py, which Python requires for the tests package.")


if __name__ == "__main__":
    main()
