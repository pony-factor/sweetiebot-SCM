#!/usr/bin/env python3
"""Open the local Sweetiebot SCM configuration interface."""

from configurator import run_configurator
from toolkit_settings import load_settings


if __name__ == "__main__":
    if run_configurator(load_settings()):
        print("Saved Sweetiebot SCM settings. Run python3 scripts/install.py to apply them.")
