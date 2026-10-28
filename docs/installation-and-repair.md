# Installation, compatibility, and repair

Sweetiebot augments **VS Code on macOS** by installing a companion extension plus guarded workbench/Codex patches. It is not solely a Marketplace extension.

## Requirements and initial check

Install Git and Python 3; optional Ollama supplies local AI commit titles, spellcheck and semantic search. Optional `gh`, Kefania, Lindsey and `gh-stack` are needed only for their workflows. Review App Management permissions before patching VS Code.

```sh
git clone https://github.com/pony-factor/sweetiebot-SCM.git
cd sweetiebot-SCM
python3 scripts/install.py --check
```

Double-click `scripts/install.command` to build/open a locally signed **Sweetiebot Installer.app**. Alternatively use `python3 scripts/install.py`, `--app "/path/to/Visual Studio Code.app"` for a custom app path, or `--configure` for settings. The app build requires a local signing identity in Keychain; see the [root README](../README.md) for setup. Restart/reload VS Code after initial installation.

## Updates

**Initialization → Automatically update and restore app customizations** (extension setting `scmToolkit.automaticAppRepair=true` by default) can restore compatible patches after app/extension updates. Some workbench components replace live; others require a reload. An unsupported anchor must be skipped, not patched by guessing.

Inspect **Output → Sweetie Bot app repair** when UI customizations disappear. Use `python3 scripts/install.py --check` to validate compatibility and app permissions before reinstalling. VS Code may report an installation-integrity warning because its application files changed.

If SCM controls disappear after a VS Code update and the full installer stops on an unsupported Codex patch, restore the SCM workbench independently:

```sh
python3 scripts/install.py --workbench-only --check
python3 scripts/install.py --workbench-only
```

This uses the existing customization settings and guarded workbench transforms, saves the previous workbench files in the printed backup directory, and refreshes the live workbench components. Reload the affected VS Code window afterward. Codex assets, companion extensions, Git configuration, and repository files are untouched. An unsupported or externally modified workbench patch still stops the repair before writing.

## Security and removal

The settings server listens on local authenticated loopback. GitHub App PEMs belong in Keychain or private credential files, never repo files or debug output ([App guide](distinct-github-apps.md)). **Workspace Trust** remains VS Code's decision: trusting the managed parent trusts **all** its children, including future ones. Never trust an uncontrolled parent.

Before uninstalling or manually repairing, inspect live worktrees and pending background commit jobs. Do not delete registered Git worktree metadata or force a pending placeholder commit through. Use the supported version-specific installer/uninstall path, not blind file removal. See [troubleshooting](troubleshooting.md).
