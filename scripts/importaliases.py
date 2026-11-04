"""Resolve historical Python underscore imports to hyphenated source filenames."""

import importlib.abc
import importlib.machinery
import importlib.util
import sys
from pathlib import Path


class HyphenAliasFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        module = fullname.rpartition(".")[2]
        if "_" not in module or module == "__init__":
            return None
        filename = module.replace("_", "-") + ".py"
        for folder in path if path is not None else sys.path:
            candidate = Path(folder) / filename
            if candidate.is_file():
                return importlib.util.spec_from_file_location(fullname, candidate)
            # Preserve path precedence when an earlier directory owns the normal
            # spelling, but prefer canonical files over stale siblings on upgrade.
            if importlib.machinery.PathFinder.find_spec(fullname, [folder]) is not None:
                return None
        return None


def install():
    if not any(isinstance(finder, HyphenAliasFinder) for finder in sys.meta_path):
        index = next((i for i, finder in enumerate(sys.meta_path)
                      if finder is importlib.machinery.PathFinder), len(sys.meta_path))
        sys.meta_path.insert(index, HyphenAliasFinder())
