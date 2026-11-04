# Sweetiebot scripts

Run commands from the repository root unless a command explicitly says otherwise.
The installer launcher is [`install.command`](install.command), which can be
double-clicked on macOS or run with `bash scripts/install.command`. It builds
`Sweetiebot Installer.app` in the **repository root**, using the canonical source.

## Installation, updates, and configuration

- `install.command`: signed installer app launcher.
- `build-installer-app.py`: build and sign the local macOS installer app.
- `install.py`: direct VS Code/Codex installer and patch validator.
- `repair.py`, `update.py`: automatic repair and source updates.
- `configure.py`, `configurator.py`, `toolkit-settings.py`: settings UI and persistence.
- `local-setup.py`: local workspace/setup helpers.

## Commits, branches, and Git

- `ai-commit.py`, `background-commit.py`, `sweetiebot-async-commit.py`: commit wrappers and durable finalization.
- `local-codex-commit.py`, `post-commit-spellcheck.py`, `commit-hotkey.py`: co-author commits, spellchecking, and shortcuts.
- `commit-diagnostics-dashboard.py`, `sweetiebot-diagnostics.py`: operational diagnostics.
- `branch-names.py`, `branch-name-packs.json`: branch-name selection and character packs.
- `cloud-repo-sync.py`, `merged-branch.py`, `prune-merged-branches.py`: synchronization and branch maintenance.

## Codex and UI integrations

- `codex-colors.py`, `codex-composer.py`, `codex-context.py`, `codex-drafts.py`: Codex appearance, composer, context, and drafts.
- `codex-image-drop.py`, `codex-keep-awake.py`, `codex-label.py`: Codex attachments, wake behavior, and labels.
- `codex-recent-chats.py`, `codex-startup.py`, `codex-usage.py`: recent conversations, startup, and usage indicators.
- `model-picker.py`, `message-bar.py`, `message-bar-configurator.py`: picker and message-bar controls.
- `workspace-search.py`, `ollama-concurrency.py`: local search and Ollama integration.

## Pull requests and CI

- `github-pr.py`, `github-pr-reactions.py`, `browser-pr.py`: GitHub PR integration.
- `ci/ci-test-runner.py`: CI inventory validation and suite execution.
- `ci/ci-test-groups.json`: exclusive test-suite assignments and syntax checks.

The Python modules remain at the root of `scripts/` because the installer,
repair/update payload, VS Code extension, and Python tests currently use
flat module imports and stable paths (`PYTHONPATH=scripts`). The CI-specific
files have no such runtime import contract and are grouped under `ci/`.
When moving additional Python modules, migrate their consumers and packaged
paths together rather than breaking existing installations.

Run inventory verification with:

```sh
python3 scripts/ci/ci-test-runner.py verify
```
