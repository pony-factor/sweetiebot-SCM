# Sweetiebot scripts

Run commands from the repository root unless a command explicitly says otherwise.
The installer launcher is [`install.command`](install.command), which can be
double-clicked on macOS or run with `bash scripts/install.command`. It builds
`Sweetiebot Installer.app` in the **repository root**, using the canonical source.

## Installation, updates, and configuration

- `install.command`: signed installer app launcher.
- `build_installer_app.py`: build and sign the local macOS installer app.
- `install.py`: direct VS Code/Codex installer and patch validator.
- `repair.py`, `update.py`: automatic repair and source updates.
- `configure.py`, `configurator.py`, `toolkit_settings.py`: settings UI and persistence.
- `local_setup.py`: local workspace/setup helpers.

## Commits, branches, and Git

- `ai_commit.py`, `background_commit.py`, `sweetiebot_async_commit.py`: commit wrappers and durable finalization.
- `local_codex_commit.py`, `post_commit_spellcheck.py`, `commit_hotkey.py`: co-author commits, spellchecking, and shortcuts.
- `commit_diagnostics_dashboard.py`, `sweetiebot_diagnostics.py`: operational diagnostics.
- `branch_names.py`, `branch_name_packs.json`: branch-name selection and character packs.
- `cloud_repo_sync.py`, `merged_branch.py`, `prune_merged_branches.py`: synchronization and branch maintenance.

## Codex and UI integrations

- `codex_colors.py`, `codex_composer.py`, `codex_context.py`, `codex_drafts.py`: Codex appearance, composer, context, and drafts.
- `codex_image_drop.py`, `codex_keep_awake.py`, `codex_label.py`: Codex attachments, wake behavior, and labels.
- `codex_recent_chats.py`, `codex_startup.py`, `codex_usage.py`: recent conversations, startup, and usage indicators.
- `model_picker.py`, `message_bar.py`, `message_bar_configurator.py`: picker and message-bar controls.
- `workspace_search.py`, `ollama_concurrency.py`: local search and Ollama integration.

## Pull requests and CI

- `github_pr.py`, `github_pr_reactions.py`, `browser_pr.py`: GitHub PR integration.
- `ci/ci_test_runner.py`: CI inventory validation and suite execution.
- `ci/ci_test_groups.json`: exclusive test-suite assignments and syntax checks.

The Python modules remain at the root of `scripts/` because the installer,
repair/update payload, VS Code extension, and Python tests currently use
flat module imports and stable paths (`PYTHONPATH=scripts`). The CI-specific
files have no such runtime import contract and are grouped under `ci/`.
When moving additional Python modules, migrate their consumers and packaged
paths together rather than breaking existing installations.

Run inventory verification with:

```sh
python3 scripts/ci/ci_test_runner.py verify
```
