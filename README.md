# Sweetiebot SCM

Sweetiebot extends **Visual Studio Code on macOS** with Source Control controls, managed Git worktrees, local Ollama features, semantic workspace search, and GitHub pull-request workflows. It builds around the installed VS Code Git extension rather than replacing Git.

**Start with the Sweetiebot Settings gear beside the Source Control message field.** Settings are organized by feature and save automatically. The old list of dozens of `git config --global` commands is no longer the recommended configuration path.

> [!IMPORTANT]
> Sweetiebot patches installed VS Code workbench files and certain supported extensions. VS Code updates may replace patches, unsupported versions may be refused, and VS Code can show an installation-integrity warning. Review changes before installing, and only trust repositories and workspace roots you control.

## Documentation

Browse the [documentation index](docs/index.md) for installation, settings, commits, worktrees, PR workflows, Workspace Search, Codex/UI, troubleshooting, and development. The [functionality audit](docs/functionality-audit.md) links implemented behavior to source and tests and distinguishes code inspection from live macOS verification.

## Installation

### Requirements

- macOS with a supported Visual Studio Code application bundle.
- Python 3 and Git.
- macOS permission to modify VS Code's application files.
- Optional: [Ollama](https://ollama.com/) for local commit titles, spellchecking, and semantic workspace search. Exact search can work without embeddings.
- Optional: authenticated GitHub CLI and local [Kefania](https://github.com/pony-factor/kefania) for bot-published PRs, [gh-stack](https://github.com/github/gh-stack) for native stacked PRs, and GnuPG for signing-key import.

Clone this repository, then double-click **`scripts/install.command`**:

```sh
git clone https://github.com/pony-factor/sweetiebot-SCM.git
cd sweetiebot-SCM
```

The launcher builds and opens a locally signed **Sweetiebot Installer.app** from the checkout. The generated app is ignored by Git. Restart or reload VS Code after initial installation.

The direct Python path is also available:

```sh
# Validate compatibility without applying patches:
python3 scripts/install.py --check

# Install from source:
python3 scripts/install.py

# Inspect settings before installing:
python3 scripts/install.py --configure
```

To target a different app bundle, use `--app "/path/to/Visual Studio Code.app"`. Running directly from a terminal uses that process's macOS permissions instead of the signed installer app's permissions. If the write is blocked, check **System Settings → Privacy & Security → App Management**.

The locally built installer expects the **Sweetiebot Installer Local Signing** Keychain certificate. On another Mac, create the corresponding Code Signing certificate or specify an existing identity with the build script's `--signing-identity` option. Signing keys remain in Keychain, not in the generated app.

### Updates and repair

After the initial bootstrap is installed, the companion extension can restore compatible patches after VS Code or extension updates without rebuilding the installer app. **Initialization → Automatically update and restore app customizations** controls automatic repair and update checks. Some live workbench components update without a window reload; other patches and first-time installation still require a reload.

Look in **Output → Sweetie Bot app repair** for skipped patches, update failures, and reload details. Unsupported upstream versions are guarded rather than patched indiscriminately. A currently installed version that predates automatic repair may need the installer once.

## Settings

In VS Code, open Source Control and click the **gear at the right end of the commit-message row**. The local Sweetiebot Settings page opens in the Integrated Browser. Repeated clicks focus the same tab. Changes are saved as you make them; the page displays their status.

You can also open that local configurator from a checkout without installing the patch:

```sh
python3 scripts/configure.py
```

The settings server listens on a local authenticated loopback address; it does not transmit your settings to an external configuration service.

| Settings section | What you can configure |
| --- | --- |
| **Message bar** | Branch selector, message-bar layout, commit and co-author hotkeys, labels, publish and push controls |
| **Source control** | Button style, sync counts and arrows, branch cleanup, auto-pull, working-file opening, whitespace normalization |
| **Branch names** | Enable/disable built-in name packs, custom names, imported JSON packs |
| **Ollama** | AI commits, model choice, generation budgets, direct or durable background commit behavior |
| **Spellcheck Changes** | Draft-title corrections, Markdown spellcheck, spelling model, protected vocabulary, line breaks |
| **Search** | Workspace Search appearance, modes, Ollama models, limits, exclusions |
| **Pull requests**, **Kefania**, **Lindsey**, **GitHub** | PR drafting, merge dashboard, review and refresh preferences |
| **Codex**, **Browser**, **Window**, **Initialization** | Codex adjustments, Integrated Browser, title-bar controls, startup, updates |

Git-backed preferences are stored under `[scm-toolkit]` in the user's `~/.gitconfig`; VS Code-specific preferences are saved to VS Code User Settings. The configuration page handles both.

Individual command-line overrides remain supported for scripting:

```sh
git config --global scm-toolkit.horizontal-branch-selector true
git config --global scm-toolkit.ai-commit-model qwen2.5-coder:7b
```

Use the live Settings page for the complete option list, defaults, and descriptions rather than relying on hardcoded examples in this README. Manual changes affecting the installed workbench may require another `python3 scripts/install.py` and a VS Code reload.

## Source Control and committing

Sweetiebot retains VS Code's native commit and Git actions while adding optional controls beside the commit message: a branch selector, branch creation and cleanup, a push checkbox, inline-completion toggle, configurable labels and button appearance, and a Codex co-author action.

**Commit hotkeys are initially unbound.** Under **Message bar**, use **Change** or **Reset** for each independent shortcut:

- **Sweetiebot: Commit (Same as Source Control Button)** runs the regular Source Control commit action, including when a message has already been entered.
- **Sweetiebot: Commit with Codex Co-author** runs the same action as the attributed commit button.

The two hotkeys must be distinct. VS Code and macOS can reserve shortcuts before Sweetiebot receives them.

### AI messages and commit safety

With **AI commit titles** enabled, a blank commit message can be generated by a model hosted by local Ollama from the staged diff. An entered message is not replaced by the commit operation itself. The optional draft-title spellchecker runs separately. You can choose normal and low-memory models and adjust attempts and timeouts in **Ollama**.

The Git wrapper is installed as `~/.local/bin/scm-toolkit-git`. If setting `git.path` manually, use its absolute path from the installer output; VS Code does not expand `~` in the setting. Reload VS Code after changing the Git executable.

Commit instructions are read from `~/.config/sweetiebot/commit-instructions.md`; the shared starter lives at `assets/commit-instructions.md`. They guide the title style without changing what was actually staged. The model can generate descriptions on the default branch; detailed descriptions on other branches are a separate opt-in setting.

**Durable background Commit and Push is opt-in and off by default.** Direct mode commits normally. In durable mode, Sweetiebot saves the staged tree as a local temporary-title commit, finalizes the title in order, and pushes only after finalization. A macOS login agent can recover unfinished work while VS Code is closed if the Mac is awake and the user remains logged in. Do not amend, reset, or push a branch with unresolved placeholder jobs; use the recorded recovery information. The older **Legacy provisional commit finalization** setting is a different option.

Git hooks, GPG signing, staged/unstaged selection, and remote branch rules still apply. A preflight checks GitHub size limits for automatically generated commits. An oversized individual file requires explicit action; GitHub's diff-view limits are warnings rather than evidence that a commit is safe to split. **Normalize staged whitespace** controls eligible added-line trailing whitespace and final newlines independently of title generation.

The optional Codex co-author action adds the configured `Co-authored-by` trailer after a blank line without changing the primary author. **Local commit messages from Codex text** can use a read-only current-conversation snapshot alongside the staged diff to inform a blank attributed message. Codex is not prompted or interrupted by that operation.

### Spellchecking

Spellcheck features have independent controls:

- **Draft commit-title correction** can suggest conservative spelling/grammar changes after an idle delay, with a preview or automatic handling.
- **Sweetiebot: Spellcheck Filenames** previews name corrections from the Command Palette or a file context menu; it does not stage or commit a rename automatically.
- **Post-commit Markdown spellcheck** is **off by default**. When enabled, it proposes changed Markdown prose as unstaged edits for review in **Spellchecks Performed**. Keep or discard reviewed changes before a follow-up commit.
- **Spellcheck Only** is a separate manual action. The native ChatGPT browser session follows `scmToolkit.chatgptReviewProjectUrl` if configured, otherwise it inherits `scmToolkit.chatgptProjectUrl` (or uses regular chats when neither is set). An inaccessible Project fails rather than silently submitting outside it.

**Sweetiebot: Suggest Commit Title with ChatGPT Project** is an optional, explicitly initiated command. After your confirmation, it sends a bounded staged diff to the signed-in ChatGPT browser and previews a suggested title. It only fills the Source Control message box after your approval, without committing. It uses the dedicated optional `scmToolkit.chatgptReviewProjectUrl` if present, or the shared `scmToolkit.chatgptProjectUrl` otherwise. **Automatic** commit-title generation and the post-commit Markdown spellchecker continue using local Ollama, including unattended jobs; configuring a ChatGPT Project does not change their model provider.

To keep post-commit Markdown spellcheck enabled globally while disabling it in one repository, add to that repository's `.vscode/settings.json`:

```json
{
  "scmToolkit.postCommitSpellcheck": false
}
```

This repository-level override does not turn off the manual Spellcheck Only action, filename spelling suggestions, or draft-title correction. Protected code, URLs, formatting, and model mistakes still warrant human review.

## Branches and managed workspaces

The branch box can open a horizontal popup or the native VS Code branch picker. **Branch names** manages the built-in pony and other name packs, disabled packs, imported packs, and custom names without editing a JSON catalog by hand.

Sweetiebot uses **linked Git worktrees** for topic branches, not a separate clone for every topic. Managed workspace metadata and worktrees are kept under:

```text
~/Library/Application Support/Sweetiebot/Workspaces/
```

Creating a topic branch can open it in a separate managed worktree while keeping the same saved VS Code workspace identity. The original checkout and shared main worktree use one Git history; a terminal command still works on the terminal's current checkout. Staged and unstaged changes are not silently discarded during workspace handoffs.

The title-bar **new workspace window** control opens another saved window for the repository. **Compact window** toggles a centered square layout and restores previous bounds if supported by the screen and VS Code's minimum dimensions.

### Workspace Trust

VS Code can initially open managed workspaces in **Restricted Mode**. Sweetiebot offers a native prompt to trust a parent directory; this would also trust repositories subsequently placed below that parent. Approve it only when all children are trusted. Sweetiebot does not override VS Code Workspace Trust. **Configure Independent Workspace Trust** can reopen the guide; `scmToolkit.promptForIndependentWorkspaceTrust` controls the first-run prompt.

### Sync and cleanup

**Automatically pull clean branches** uses guarded fast-forward behavior when possible, without silently merging divergent history. **Sync recent repositories every 15 minutes** is a separate opt-in macOS background job for eligible clean main checkouts; it skips unpublished edits and divergent branches.

Automatic merged-branch and managed-workspace cleanup are independent settings. Cleanup requires an eligible clean worktree and verified merge evidence; dirty workspaces, unknown files, or other active references prevent deletion. It does not scan arbitrary user directories for removal. Inspect **Output → Sweetiebot Workspace Cleanup** for the recorded result. Do not manually delete registered Git worktrees without using Git's worktree commands.

### Native branch stacks

The layers action creates a stacked branch from the current topic branch, whereas the ordinary new-branch action starts from the configured default branch when possible. Native stack operations use GitHub's `gh-stack` extension. Creating a branch does not itself publish a PR; a child PR should retain its actual parent branch as the intended base. Publish the parent first if it does not exist and verify the native stack membership before attempting a stack merge.

## GitHub pull requests

### Draft and publish with Kefania

Sweetiebot's New PR button starts a dedicated **Pull Request workspace** and a ChatGPT research/drafting session. Local **Kefania** supplies the published branch diff, verified head/base information, and the bot publication flow. Review the proposed title and body; the confirmation link hands them back to Kefania for publication as **codex-pony** after rechecking the head. Opening the chat alone does not publish a PR.

The GitHub App, GitHub CLI, local Kefania service, VS Code, and ChatGPT account can have distinct permissions and sessions. A local service can be registered as `codex-drafter`; no public Kefania domain is required for that workflow. See [separate GitHub App identities](docs/distinct-github-apps.md) for setup and keep secrets in an appropriate credential store, never in repository files.

A **ChatGPT project for PR and pony research** is optional. When a branch name identifies a pony, local pony info or independent research can open separately without inserting character notes into the PR description. Keep the dedicated PR workspace open until the session completes.

Newly researched Kafania pony profiles are published as isolated, one-file commits on its tracked `main` branch. The shared detached Sweetiebot worker journals pending publication and retries after failures, including after VS Code restarts while the Mac user session is active. Existing profiles are not rewritten; unrelated staged files and unpushed commits remain untouched. Rejected pushes and divergent histories require manual recovery, never a force-push.

### Review, conflict resolution, and merge with Lindsey

Sweetiebot's **Lindsey** integration provides individual and bulk PR review/merge surfaces, a progress dashboard, and an activity timeline. **Settings → Pull requests → Squash co-author separator** selects the default ten-underscore divider (`__________`), the conventional nine-hyphen divider (`---------`), or **None** (a standard blank line before Git trailers). The GitHub Pull Requests view can show a quick squash-merge control; **Merge All** and selected bulk operations launch a dedicated ChatGPT workspace. Selecting PRs or submitting merge requests is not itself a completed merge.

A safe merge must recheck the **actual PR head SHA, intended base branch, checks, protection rules, attribution, and stack relationships**. Compatible conflicts can be resolved on the PR branch. If a design decision cannot be resolved without the maintainer, leave that PR open and continue only with independent eligible work. Never assume that every PR targets `main` or that a head/base chain is registered as a native stack. Check the dashboard and GitHub for a verified result before cleanup.

Refresh intervals, rate-limit cooldowns, review summary behavior, and timeline display are configurable in **GitHub** and **Lindsey** settings.

## Workspace Search

Sweetiebot also provides **Workspace Search**. It normally appears inside Source Control; **Search → Standalone Activity Bar** moves it to its own container. The search label, placeholder, ranking mode, indexed-file limits, exclusions, and local models are configurable.

**Hybrid**, **Semantic**, and **Exact** are separate ranking modes. Semantic matching uses a locally available Ollama embedding model; exact term/path matching can work without it. Install the documented default embedding model if needed:

```sh
ollama pull qwen3-embedding:0.6b
```

**Ask Ollama** is optional and uses a separate local chat model. Workspace Search indexes eligible local text/code and supported document text, skips common generated and Git metadata paths, and incrementally refreshes changed content. The search scope can include other local repositories under `~/GitHub` as well as the active workspace. Search results can open matching passages and copy repository-relative Markdown links.

Workspace Search is a **local file index**, not a complete historical archive of every ChatGPT conversation, PDF, commit, or external source. It does not upload your workspace to GitHub for search. See [Workspace Search details](docs/workspace-search.md) and [EFS attribution](efs/THIRD_PARTY_NOTICES.md).

## Codex, browser, and window controls

### Flawless-GPT cannon in Codex

**Codex → Time → Show cannon** (off by default) enables Flawless-GPT’s cannon and minute counter beside active **Working for** and completed **Worked for** durations in the Codex sidebar. Precise elapsed times remain available, and the cannon takes priority over the Hide chat timestamps activity-label substitution.

```sh
git config --global scm-toolkit.codex-show-cannon true
python3 scripts/install.py --codex-only
```

The installer pins and validates the original Flawless-GPT [duration JavaScript](https://github.com/pony-factor/flawless-GPT/blob/bb98089c648709ea18ceae6b6c6dad843bd93a57/js/chat/worked-duration.js), [stylesheet](https://github.com/pony-factor/flawless-GPT/blob/bb98089c648709ea18ceae6b6c6dad843bd93a57/css/worked-duration.css), and [cannon image](https://github.com/pony-factor/flawless-GPT/blob/bb98089c648709ea18ceae6b6c6dad843bd93a57/artwork/searching-complete.png). Resources are cached under `~/.cache/sweetiebot/flawless-cannon/` for offline repair. A pinned local checkout may be set with `SCM_TOOLKIT_FLAWLESS_SOURCE_DIR`. If unavailable, installation skips only the optional cannon.


Sweetiebot also has settings for supported Codex composer controls, usage-limit displays, promotion cards, dictation visibility, sidebar labels, and **Keep awake while Codex works**. **Codex → Customization → Pegasus wing Send icon** replaces the Send arrow with a white-outline SVG wing by default. Its color follows the VS Code theme or the existing **Send button icon** override; Queue and Stop keep their native appearance. Disable it to restore the arrow. Other controls affect Integrated Browser blank-tab URLs, browser tab handling, window labels, notifications, and title-bar buttons. Availability depends on the installed VS Code/Codex build and whether the corresponding patch anchors are supported.

Prefer the live settings page for the current option names and defaults rather than old release-specific instructions.

## Troubleshooting

| Symptom | First checks |
| --- | --- |
| Customizations disappeared after an update | **Output → Sweetie Bot app repair**; app version, supported patch anchors, permissions; `python3 scripts/install.py --check` |
| Commit title/model failure | Ollama running locally, selected model installed, available memory; `~/Library/Logs/Sweetiebot/sweetiebot.log` |
| Pending background commit or push | Read the queued job's status; avoid amending, resetting, or forcing a push while title finalization is pending |
| New PR button cannot publish | Published branch and unchanged head SHA, local Kefania service, GitHub App/CLI access, active PR workspace |
| Merge action is unavailable | Live head/base, merge conflicts, status checks, rulesets, attribution requirements, and stacked dependencies |
| Workspace Search is incomplete | Selected search scope, indexing exclusions/limits, local embedding model, and Search settings |

Most model inference stays on local Ollama. Operational diagnostics are designed to avoid logging raw staged diffs, prompts, and model responses. If you need to remove the toolkit, use the supported installer/uninstall workflow for the version you installed; do not blindly delete linked worktrees or their Git metadata.

## Development

| Path | Purpose |
| --- | --- |
| [`scripts/`](scripts/README.md) | Installer, configurator, branch names, local Git/AI helpers, CI tooling |
| [`extension/`](extension/README.md) | Complete Sweetiebot VS Code extension, including commits, GitHub, branches, UI, and search |
| `assets/workbench/` | Injected workbench JavaScript and CSS |
| `assets/codex/` | Supported Codex patch components |
| `assets/imgs/` | Bundled images and attribution |
| `tests/` | Python and JavaScript tests |
| `scripts/ci/` | Test runner and test-file ownership inventory |

Useful repository checks:

```sh
python3 scripts/ci/ci_test_runner.py verify
PYTHONPATH=scripts python3 -m unittest discover -s tests -t . -p '*.py'
python3 scripts/install.py --check
```

The installer compatibility check needs a suitable macOS VS Code installation; it is not a portable CI test on Linux. Refer to [the scripts guide](scripts/README.md) and current workflows for further test commands.

The settings definitions live in `scripts/configurator.py` with persisted Git settings in `scripts/toolkit_settings.py`. Keep this README focused on installation, navigation, and everyday behavior. Git history retains the old, release-by-release implementation details without presenting them as current user instructions.
