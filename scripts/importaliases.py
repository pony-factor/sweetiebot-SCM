"""Resolve historical Python underscore imports to hyphenated source filenames."""

import importlib.abc
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
        return None


def install():
    if not any(isinstance(finder, HyphenAliasFinder) for finder in sys.meta_path):
        sys.meta_path.append(HyphenAliasFinder())
