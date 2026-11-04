#!/usr/bin/env python3
"""Open the local Sweetiebot SCM configuration interface."""

import sys as _sb_sys
from pathlib import Path as _sb_path
for _sb_parent in _sb_path(__file__).resolve().parents:
    _sb_scripts = _sb_parent / 'scripts'
    if (_sb_scripts / 'importaliases.py').is_file():
        if str(_sb_scripts) not in _sb_sys.path:
            _sb_sys.path.insert(0, str(_sb_scripts))
        import importaliases
        importaliases.install()
        break


from configurator import run_configurator
from toolkit_settings import load_settings


if __name__ == "__main__":
    if run_configurator(load_settings()):
        print("Saved Sweetiebot SCM settings. Run python3 scripts/install.py to apply them.")
