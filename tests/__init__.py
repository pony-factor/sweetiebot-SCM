"""Sweetiebot regression tests, separated from production module imports."""

import sys as _sb_sys
from pathlib import Path as _sb_path
_sb_scripts = _sb_path(__file__).resolve().parents[1] / 'scripts'
if str(_sb_scripts) not in _sb_sys.path:
    _sb_sys.path.insert(0, str(_sb_scripts))
import importaliases
importaliases.install()
