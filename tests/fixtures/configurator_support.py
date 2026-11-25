
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

import re
import json
import io
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import configurator
import install
import branch_names
import toolkit_settings
from pathlib import Path


def form_values():
    values = {}
    for pack in branch_names.load_catalog()["packs"]:
        values.setdefault("branchNameKnownPack", []).append(pack["id"])
        values.setdefault("branchNamePack", []).append(pack["id"])

    for setting in configurator.SETTINGS:
        current = install.DEFAULT_SETTINGS[setting.name]
        if setting.kind == "packs":
            continue
        if setting.kind == "bool":
            if current:
                values[setting.name] = ["true"]
        else:
            values[setting.name] = [str(current)]
    return values
