# Sweetiebot SCM

A small source-control UI patch for Visual Studio Code. It keeps the built-in Git workflow, but adds a compact branch selector and optional SCM controls around the commit-message box.

Current features:

- resize the current VS Code window to a centered 600 × 600 square with the compact-window titlebar button, matching VS Code's native minimum width for side-mounted panels so resizable vertical columns remain intact without window-level horizontal overflow; restore the previous bounds on the next click (displays smaller than 600 pixels in either dimension are left unchanged)
- open independent local Git clones starting on main, with separately switchable branches, using the title-bar button beside Compact Window (copies live under ~/Library/Application Support/Sweetiebot/Workspaces, with repository-based folder names instead of numeric prefixes; uncommitted changes are not copied)
- show the current branch inside the SCM message box and open VS Code's normal branch picker from it
- switch the branch selector and native Commit button between outlined and accent-filled styles
- show enabled action icons in pure white while hovering SCM or Source Control Graph rows and action buttons, preserving their normal theme colors otherwise
- customize the commit-message placeholder (defaults to `Message`)
- the **Sweetiebot: Commit (Same as Source Control Button)** command starts **unbound**. In Sweetiebot Settings → Message bar, choose **Change** beside **Commit hotkey** to record a shortcut, or **Reset** to remove it. The shortcut invokes the native Source Control Commit action, preserving the current message, AI generation, checks, and push settings. Settings writes only this command's user keybinding and preserves unrelated shortcuts and JSONC comments. VS Code and operating-system shortcuts may take precedence.
- optionally show a commit-and-push checkbox that dispatches the push without holding commit completion
- clean up unchanged local branches after their same-repository PR merges into the default branch
- suppress the GitHub PR extension’s redundant cleanup prompt when the repository deletes merged branches automatically
- open the PR-number link in the GitHub PR view once per click
- optionally show a guarded local-branch cleanup button
- right-click the SCM branch selector to delete an empty topic branch locally and on origin (when published), with confirmation, clean-tree checks, ancestry verification, and an exact-SHA remote lease
- optionally create a branch from each repository's default branch using configurable built-in, imported, and custom name packs, syncing first when there are no uncommitted changes
- optionally show a quick toggle for VS Code inline code completion
- optionally show a commit button that appends a configurable co-author name and email (Codex by default)
- optionally open a pull request for the current branch through a configured MCP server
- recognize built-in pony branch names during PR creation and pass local-only character context to Kafania for a post-publish pony profile
- configure a white confirmation-page X (visible and left-aligned by default) and inspect pony artwork in a stable-size lightbox with tall side navigation targets, no top banner, and click-outside dismissal
- show the matched pony as a small local-only **Pony Info** view in Source Control, beside whatever editor or Integrated Browser content is open
- optionally hide the outgoing commit count from the built-in Sync action, and set separate incoming/outgoing count labels without changing Git operations
- optionally refresh clean/blank Git repositories more aggressively so the first new change appears in SCM quickly
- search the active workspace semantically from a `Workspace Search` view inside Source Control by default, or optionally move it to its own Activity Bar container, backed only by local Ollama
- copy all retained text from the active integrated terminal to the clipboard in one step from its context menu or the Command Palette
- optionally use ⌘-click on an editor tab's close button to keep that tab and close the others in its group
- optionally use ChatGPT as the home page for blank Integrated Browser tabs
- optionally make Source Control Graph **Open File** open the checked-out working-tree file instead of the selected commit snapshot
- optionally generate a commit subject locally when the normal Commit button is used with a blank message
- keep a rotating local diagnostics log of failed commit-title attempts, rejected model outputs, and fallbacks
- preview spelling corrections for manually entered commit subjects before applying them
- optionally show a clipboard button at the right end of the Codex composer, sending pasted text when idle or using native queued follow-ups while Codex is busy (Codex follow-up mode should be set to `queue`)
- replace a compact icon-bearing **Rate Limited** Codex notice with a tiny Twilight Sparkle STOP-sign image (the native message remains if the remote artwork cannot load); leave full usage-limit cards and reset actions unchanged
- optionally show a live, minute-precision countdown in Codex usage-limit banners
- independently hide reset times in Codex menus, dialogs, tooltips, and usage-limit messages
- optionally hide Codex promotional cards such as the Fast mode upsell
- optionally hide the Codex dictation microphone button
- mirror ChatGPT web custom instructions into the global personalization used by the Codex VS Code extension
- optionally require the Codex Web co-author trailer for web/GitHub-tool commits
- import a PGP secret key directly into GnuPG without persisting the private material in toolkit settings
- search repositories through the linked GitHub authentication session instead of maintaining a separate repo allow-list

**Copy Entire Terminal Contents** selects and copies the active integrated terminal's visible output and retained scrollback, then clears the selection. It does not include output already discarded by VS Code's terminal scrollback limit. The command is available by right-clicking inside a terminal or from the Command Palette; it does not clear the terminal or run a shell command.

The patch is intentionally narrow: it does not copy or manage unrelated editor settings.

### Independent workspace trust (first run)

Sweetiebot creates independent clones under `~/Library/Application Support/Sweetiebot/Workspaces` (each new
window gets a separate Git working directory). VS Code's Workspace Trust may
otherwise start these windows in **Restricted Mode**, disabling extensions,
tasks, and other features. On the first Sweetiebot extension startup after
this feature is installed, VS Code's native trust dialog offers to trust
the **parent** directory instead of approving every clone.

The dialog displays the parent path directly. Approve it to trust all existing
and future repositories beneath that folder, or cancel to keep Restricted Mode.
No copying paths or adding folders manually is required. Only approve if every
repository you put there is trusted. VS Code records trust after your approval;
Sweetiebot never disables Workspace Trust or automatically approves the dialog.

To suppress the first-run prompt, set
`scmToolkit.promptForIndependentWorkspaceTrust` to `false` in VS Code Settings.
The first-run prompt appears once per extension installation profile. Each new
untrusted Sweetiebot clone also offers the guide once, even if the first-run
guide was previously dismissed. In Restricted Mode, only the trust guide runs;
Git operations, indexing, and background services start after trust is granted.
Changing this setting does not revoke prior folder trust.
To run the setup again at any time, use the Command Palette action
**Configure Independent Workspace Trust**. If you prefer to trust each cloned
repository separately, simply leave the parent untrusted.

### Independent workspace folder names

The **Open Independent Workspace from Main** button keeps each checkout in a
persistent folder named for the repository, such as
`~/Library/Application Support/Sweetiebot/Workspaces/sweetiebot-SCM-<unique>/sweetiebot-SCM`, rather than
`workspace-<unique>/1-sweetiebot-SCM`. A multi-root workspace uses a
`<first-repository>-group-<unique>` parent, with one named checkout per distinct
Git repository. When multiple roots share the same name, later ones receive a
suffix (for example, `shared` and `shared-2`) to prevent overwrites.
The unique workspace suffix keeps repeated launches independent. Existing
workspaces under the old `~/Sweetiebot Workspaces` directory are not renamed,
migrated, or deleted by this change. The new folder is per-user and lives
under macOS Application Support, not Caches.

### Automatic merged-workspace cleanup

Sweetiebot checks its **own newly created independent clones** at startup and
every ten minutes. `scmToolkit.automaticWorkspaceCleanup` (on by default)
controls this separately from automatic branch cleanup. A checkout is never
deleted merely for being old, or because a remote branch disappeared.

The normal merged-branch cleanup stores evidence of PRs that it verified were
merged into `main` at the exact recorded head commit. Workspace cleanup
revalidates that evidence with authenticated GitHub CLI (`gh`), checks that no
PR for the branch is open, and requires **all** repositories in a multi-root
workspace to pass. Each repository must be on `main`, have no extra local
branches, stash, modified, untracked or ignored files, and no unpublished or
otherwise unrecognized commits in its reflog. A successful fresh fetch must
confirm that local `main` is already reachable from `origin/main`.

Workspace cleanup also requires a Sweetiebot provenance manifest, evidence
that Sweetiebot successfully activated in the workspace, and at least an hour
since its last activity heartbeat. A live extension-host process always
protects the workspace. Missing/ambiguous evidence, network errors, unfamiliar
files, or any unmerged/new work stop deletion. The cleanup process never
manages user-selected folders or older workspaces created without its
manifest. The active-workspace safeguard is conservative but cannot detect
every conceivable editor process outside Sweetiebot; do not treat these clones
as permanent storage after their work has merged.

Successful deletions and errors appear in the **Sweetiebot Workspace Cleanup**
output channel. No automatic migration or cleanup is performed on the old
`~/Sweetiebot Workspaces` directory.


## Requirements

- macOS
- Visual Studio Code using the standard application-bundle layout
- Python 3 (Sweetiebot resolves system, Xcode, Homebrew, or `SWEETIEBOT_PYTHON` interpreters on macOS)
- Git, if you want to configure feature flags through global Git config
- GnuPG, only if you want the configurator to import a PGP signing key
- Ollama is required for local AI commit-title generation and semantic Workspace Search; exact Workspace Search still works if embeddings are unavailable

The installer modifies the installed VS Code workbench files. VS Code updates can replace those files. After installing this version once, the companion extension automatically restores supported patches at startup, after extension changes, and every hour. VS Code may also show an installation-integrity warning after its application files are modified.

## Repository layout

- `scripts/`: Python installers, configuration tools, and their branch-name catalog.
- `assets/workbench/`: JavaScript and CSS injected into the VS Code workbench.
- `assets/codex/`: JavaScript injected into the Codex extension.
- `efs/`: companion VS Code extension code.
- `tests/`: Python and JavaScript tests.

Run Python tests from the repository root with `PYTHONPATH=scripts python3 -m unittest discover -s tests`.

**Diagnostics:** Sweetiebot records commit-title generation problems in `~/Library/Logs/Sweetiebot/sweetiebot.log` (up to 1 MiB each, with three rotated backups). The same general log is available to future Python components. Events include timestamps, component, model, attempt, error category, HTTP status when applicable, and whether generation retried, stopped, or fell back. Prompts, staged changes, model output, chat context, and exception messages are never recorded. Set `SWEETIEBOT_LOG_FILE` to override the location. Logging is best-effort: permission or disk errors never block committing.

**Background commit generation uses this same log.** It preserves the regular Ollama request-failure and rejected-output events (including attempt counts), and records asynchronous worker-start failures, crashed-worker recovery, fallback selection, blocked Git operations, and commit-finalization errors under the existing `commit_title` component. These events contain operational categories only; no prompts, diffs, generated messages, exception strings, or repository paths are added to diagnostics.

## Install

On macOS, double-click **Install Sweetie Bot.command** in a repository checkout to build a fresh, locally signed **Sweetiebot Installer.app** from the current source files and launch it. The app bundle is generated locally and ignored by Git, rather than keeping signed binaries and duplicate source files in the repository. You can move the generated app to Applications for future use. To rebuild that app with later changes, update your checkout and run the launcher again. Close and reopen your VS Code windows afterward. Once installed, Sweetie Bot automatically restores supported customizations after VS Code and extension updates.

You can also install directly from source with `python3 scripts/install.py` without building an app, but this runs under your terminal's macOS permissions rather than the signed installer app's permissions.

On the first run, macOS may require you to allow **Sweetiebot Installer** in **System Settings → Privacy & Security → App Management**. The app offers an **Open Settings** button when access is blocked; grant access and double-click the app again.

**Install Sweetie Bot.command** runs the following builder automatically before opening the app; the equivalent manual command is:

```sh
python3 scripts/build_installer_app.py
open "Sweetiebot Installer.app"
```

The builder reuses the **Sweetiebot Installer Local Signing** certificate in your login Keychain. On another Mac, create a self-signed **Code Signing** certificate with that name using Keychain Access → Certificate Assistant → Create a Certificate, or select an existing signing identity with `--signing-identity` (also available as `SWEETIEBOT_SIGNING_IDENTITY`). Keep the same certificate and bundle identifier across rebuilds so macOS can recognize the app and retain its permission. The builder stops if the identity is missing or ambiguous instead of using ad hoc signing. Switching an existing app to this certificate may require granting App Management once more. Signing keys stay in Keychain and are never bundled with the installer.

Clone the repository and enter it:

```sh
git clone https://github.com/pony-factor/sweetiebot-SCM.git
cd sweetiebot-SCM
```

Automatic repair checks the project's `main` branch for Sweetie Bot updates at startup and every hour, with a shared per-user check timestamp so opening other repository windows within the same hour does not repeat the download. A failed remote check uses a shorter five-minute shared backoff; local repair still runs on each window startup. It downloads the canonical source files into an isolated cache, regenerates the installed companion-extension and tool payloads, and restores customizations using your saved settings. It does not require, download, rebuild, or re-sign the generated installer app for background updates. If the update check or installation fails, it repairs from the installed sources. It targets the running local macOS VS Code application (including custom install locations) and the selected Codex extension. No repository checkout or retained installer app is needed. A successful update or repair automatically reloads a stale window after the updates settle. Background windows wait until you focus them. Windows already running the current version do not reload. To prevent reload loops, the same workspace will not automatically reload twice for the same revision within ten minutes, and automatic reloads pause after two distinct revisions in that interval; a warning in **Output → Sweetie Bot app repair** explains the pause. Manual **Developer: Reload Window** still works. Before that reload, Sweetie Bot invalidates VS Code's disposable user-extension manifest scan cache when installed files change, so the first reload reads the updated companion extension instead of presenting a second **Extensions have been modified on disk** prompt. It does not alter the installed extensions registry or suppress warnings for unrelated extension changes. Turn it off with **Automatically update and restore app customizations** in Sweetie Bot's Startup settings, or `scmToolkit.automaticAppRepair` in VS Code Settings.

Updates and repairs are serialized across windows. The Python settings server suppresses bytecode generation, and any existing `__pycache__` / `.pyc` files are ignored when checking whether installed extension sources match, preventing unnecessary reinstalls and reload loops. Routine repair skips companion-extension installation; a new toolkit revision updates it too. Unsupported builds fail guarded validation before patch writes. See **Output → Sweetie Bot app repair** for errors; macOS may require App Management permission for VS Code/Python. Remote sessions are skipped. New upstream layouts may still require a compatible Sweetie Bot release, which is fetched automatically once published to `main`.

The locally built and signed installer app includes the update bootstrap for first-time installation. Existing installations with this bootstrap update themselves; you do not need to retain or rerun the installer. Older installations need the bootstrap installed once, using **Install Sweetie Bot.command** or the direct Python installer.

Validate that the currently installed VS Code build matches the guarded patch anchors without changing anything:

```sh
python3 scripts/install.py --check
```

Install the patch:

```sh
python3 scripts/install.py
```

To review the settings in a local browser before installing, run:

```sh
python3 scripts/install.py --configure
```

Then reload or restart Visual Studio Code.

The default application path is:

```text
/Applications/Visual Studio Code.app
```

To target another app bundle, pass `--app`:

```sh
python3 scripts/install.py --app "/path/to/Visual Studio Code.app"
```

If macOS blocks the write, allow the terminal or Python process you are using under **System Settings → Privacy & Security → App Management**, then run the installer again.


### Automatic spellcheck commit notification

When the opt-in post-commit Markdown spellcheck produces edits and you keep them, Sweetiebot leaves the edits **unstaged**, shows a small VS Code notification, and fills an **empty** Source Control commit box with a `🤖 Spellcheck …` message. An existing draft is never overwritten: the notification offers **Use spellcheck message** instead. No follow-up commit or push happens automatically.

Enable automatic post-commit spellcheck with `git config --global scm-toolkit.post-commit-spellcheck true` if it is not already enabled.

The prepared message includes the model that actually generated the corrections:

```text
Co-authored-by: Ollama (Model Name) <326443430+codex-pony[bot]@users.noreply.github.com>
```

The model name comes from the completed spellcheck job, including when the low-memory model is selected. To override the bot email, set `scm-toolkit.spellcheck-coauthor-email` to another account-associated GitHub noreply address. This feature preserves the keep/discard review step and uses a one-time notification file under the repository's Git metadata, including for linked worktrees.

## Configuration

Toolkit settings live in your global Git config under the `scm-toolkit` section. This keeps feature settings in the normal `~/.gitconfig` file and leaves room for new options later.

### Local web configurator

Run the configurator without installing anything:

```sh
python3 scripts/configure.py
```

It opens an app-like settings page in the default browser, prefilled with the current Git configuration. The page includes every toolkit switch plus the Ollama model choices and low-memory threshold. Changes save automatically to global Git config after you edit a setting, with an inline status showing whether the latest values were saved. A dedicated **Startup** section exposes **Open Sweetie Bot on startup**; when opened through VS Code, that checkbox also updates the real `scmToolkit.openPanelOnStartup` global user setting. The **Branch names** section lets you toggle individual packs, add custom names, and paste third-party packs as JSON. If Ollama is running on `127.0.0.1:11434`, locally installed models appear as suggestions; model tags can still be entered manually when it is offline. PGP secret-key import remains tied to the final action instead of autosaving private key material while it is being entered.

The **Updates** section controls VS Code's native app update mode, extension update checks, and automatic extension updates. When opened through the extension, it reads your current VS Code preferences and saves changes back to those same global preferences. VS Code's normal update and startup notices continue to work; release-note preferences are preserved.

After installation, the gear at the right end of the Source Control message row opens the same local settings page directly. The companion extension starts the loopback configurator and opens it in VS Code’s native Integrated Browser in the current window. Clicking the gear again focuses the existing settings tab. This requires a VS Code version with the Integrated Browser; older versions show an update message. The repository checkout and manual URL entry are not required.

Every toolkit setting and companion-extension preference is available on this gear page. **Automatically publish new branches** controls the saved publishing preference; **Auto-publish toggle** controls whether the cloud icon appears. Publishing works even when the icon is hidden. The page loads the current VS Code preferences and saves publishing, startup, keep-awake, inline suggestions, post-commit actions, and search options to global user settings immediately. **Automatically pull clean branches** is also available independently of blank-state refresh.

With **Automatically pull clean branches** enabled, each repository's default branch fetches its tracked upstream once a minute through the extension host, even when the commit input row is hidden. It pulls only with a fast-forward and preserves nonconflicting staged and unstaged edits. Sweetiebot pauses these ref-moving pulls for the full lifetime of a VS Code commit so background syncing cannot advance `HEAD` between Git reading and updating the branch ref. Git refuses to pull when incoming files would overwrite local work; merge conflicts, divergent commits, changed branch tips or upstreams also pause pulling.

The configurator uses only the Python standard library, binds to a random loopback port, requires a one-time URL token, and sends no settings off the computer. Its UI is cross-platform; the workbench installer remains macOS-specific because it currently targets the Visual Studio Code application-bundle layout.

**Keep awake while Codex works** is enabled by default on macOS. It prevents idle system sleep while any Codex task in the window is active and releases the assertion when all tasks finish, fail, or are interrupted. The display can still turn off. Set `scmToolkit.codexKeepAwake` to `false` in VS Code Settings to disable it immediately, or change the default in the toolkit configurator (`scm-toolkit.codex-keep-awake`). Reload the window after first installing the feature. It has no effect on other operating systems.

Set options with `git config --global`:

```sh
git config --global scm-toolkit.branch-picker true
git config --global scm-toolkit.pony-branch true
git config --global scm-toolkit.message-placeholder "Message"
git config --global scm-toolkit.commit-button-label "Send"
git config --global scm-toolkit.commit-and-send-button-label "Send"
git config --global scm-toolkit.source-control-label "Sweetie Bot"
git config --global scm-toolkit.open-panel-on-startup true
git config --global scm-toolkit.workspace-search-activity-bar false
git config --global scm-toolkit.workspace-search-label EFS
git config --global scm-toolkit.filled-buttons false
git config --global scm-toolkit.commit-and-push true
git config --global scm-toolkit.branch-cleanup true
git config --global scm-toolkit.autocomplete-toggle true
git config --global scm-toolkit.codex-coauthor true
git config --global scm-toolkit.codex-coauthor-name "Codex"
git config --global scm-toolkit.codex-coauthor-email "noreply@openai.com"
git config --global scm-toolkit.hide-outgoing-sync-count true
git config --global scm-toolkit.incoming-sync-label "Incoming"
git config --global scm-toolkit.outgoing-sync-label "Outgoing"
git config --global scm-toolkit.blank-state-refresh true
git config --global scm-toolkit.auto-pull-clean true
git config --global scm-toolkit.cmd-click-close-others false
git config --global scm-toolkit.browser-chatgpt-home true
git config --global scm-toolkit.graph-open-working-file true
git config --global scm-toolkit.ai-commit true
git config --global scm-toolkit.ai-commit-async false
git config --global scm-toolkit.ai-default-branch-description true
git config --global scm-toolkit.ai-commit-model qwen2.5-coder:7b
git config --global scm-toolkit.ai-commit-low-memory-model qwen2.5-coder:3b
git config --global scm-toolkit.ai-low-memory-gib 4
git config --global scm-toolkit.ai-model-picker true
git config --global scm-toolkit.mcp-pull-request true
git config --global scm-toolkit.mcp-pr-server codex-drafter
git config --global scm-toolkit.mcp-pr-tool github_create_pull_request
git config --global scm-toolkit.codex-usage-reset-countdown true
git config --global scm-toolkit.codex-hide-promotions true
git config --global scm-toolkit.chatgpt-custom-instructions ""
git config --global scm-toolkit.chatgpt-web-codex-coauthor true
git config --global scm-toolkit.codex-hide-chat-timestamps true
git config --global scm-toolkit.codex-hide-dictation true
git config --global scm-toolkit.codex-short-model-labels true
git config --global scm-toolkit.default-branch main
git config --global scm-toolkit.remote origin
git config --global scm-toolkit.branch-name-disabled-packs "pony-life,idw-comics"
git config --global scm-toolkit.branch-custom-names ""
git config --global scm-toolkit.branch-name-imports '[]'
```

The equivalent `~/.gitconfig` block is:

```gitconfig
[scm-toolkit]
    branch-picker = true
    pony-branch = true
    message-placeholder = Message
    commit-button-label = Send
    commit-and-send-button-label = Send
    source-control-label = Sweetie Bot
    open-panel-on-startup = true
    workspace-search-activity-bar = false
    workspace-search-label = EFS
    filled-buttons = false
    commit-and-push = true
    branch-cleanup = true
    autocomplete-toggle = true
    codex-coauthor = true
    codex-coauthor-name = Codex
    codex-coauthor-email = noreply@openai.com
    hide-outgoing-sync-count = true
    incoming-sync-label = Incoming
    outgoing-sync-label = Outgoing
    blank-state-refresh = true
    auto-pull-clean = true
    cmd-click-close-others = false
    browser-chatgpt-home = true
    graph-open-working-file = true
    ai-commit = true
    ai-commit-custom-instructions = false
    ai-default-branch-description = true
    ai-commit-model = qwen2.5-coder:7b
    ai-commit-low-memory-model = qwen2.5-coder:3b
    ai-low-memory-gib = 4
    ai-model-picker = true
    mcp-pull-request = true
    mcp-pr-server = codex-drafter
    mcp-pr-tool = github_create_pull_request
    codex-usage-reset-countdown = true
    codex-hide-promotions = true
    chatgpt-custom-instructions =
    chatgpt-web-codex-coauthor = true
    codex-hide-chat-timestamps = true
    codex-hide-dictation = true
    default-branch = main
    remote = origin
    branch-name-disabled-packs = pony-life,idw-comics
    branch-custom-names =
    branch-name-imports = []
```

<<<<<<< HEAD
The filled-button style, standalone Workspace Search Activity Bar, Cmd-click close-others gesture, Codex usage-reset countdown, Codex promotion hiding, Codex chat timestamp hiding, Codex dictation hiding, and ChatGPT browser homepage default to `false`; the other boolean SCM feature switches default to `true`. The Source Control app-bar label defaults to `Sweetiebot`, and the optional standalone Workspace Search container label defaults to `EFS`. With filled buttons disabled, the branch selector and native Commit button use a transparent background and a theme-aware border instead of VS Code's accent fill. The default AI models are `qwen2.5-coder:7b` for normal operation and `qwen2.5-coder:3b` for low-memory operation. The low-memory threshold defaults to 4 GiB of estimated available memory. The default protected branch is `main`, and the default remote is `origin`.
=======
The filled-button style, standalone Workspace Search Activity Bar, Cmd-click close-others gesture, Codex usage-reset countdown, Codex promotion hiding, Codex chat timestamp hiding, and ChatGPT browser homepage default to `false`; the other boolean SCM feature switches default to `true`. The Source Control app-bar label defaults to `Sweetie Bot`, and the optional standalone Workspace Search container label defaults to `EFS`. With filled buttons disabled, the branch selector and native Commit button use a transparent background and a theme-aware border instead of VS Code's accent fill. The default AI models are `qwen2.5-coder:7b` for normal operation and `qwen2.5-coder:3b` for low-memory operation. The low-memory threshold defaults to 4 GiB of estimated available memory. The default protected branch is `main`, and the default remote is `origin`.
>>>>>>> origin/main

After changing toolkit Git config, rerun:

```sh
python3 scripts/install.py
```

Then reload Visual Studio Code. The installer resolves the Git-config values and embeds that configuration into the installed patch.

### Branch-name packs

Random branch names are data-driven. Built-in packs live in `scripts/branch_name_packs.json`, and every pack uses the same small schema: The G4 roster has separate packs for mares, stallions, fillies, colts, and major non-pony creatures. An opt-in **G4 pets** pack holds only named pets and animal companions, distinct from the **G4 creatures** pack. The dedicated **G4 caricatures** pack containing the six Equestrian founders, six Power Ponies, Humdrum, Smash Fortune, and Grogar; Wind Rider and Coiffed Waiter Pony remain in G4 stallions, Forward-Thinking Friendship Student is in G4 mares, and Tirek and Scorpan are in G4 creatures. The two finale-era pony labels come from the Gameloft game rather than dialogue in the show.

```json
{
  "id": "friends",
  "label": "Friends",
  "description": "Optional human-readable description.",
  "names": ["name-one", "name-two"]
}
```

Pack IDs and names are lowercase branch-safe slugs containing letters, numbers, and hyphens. Built-in packs keep each branch-name slug unique across packs; shared characters use one canonical slug rather than duplicate entries. The G4 catalog also strips import-only role and episode descriptors (for example, `Knowledgeable ShopperRainbowshine` becomes `rainbowshine`) while retaining genuine multiword names such as `fleur-de-lis`. Built-in pony source links now live in Kefania's versioned `ponies/sources.json`, keyed by pack and canonical slug. The branch-name catalog no longer duplicates those reference URLs; custom imported packs may still provide their own optional `sources` field. This keeps contributed lists as data instead of picker logic.

Built-in community packs also include a dedicated **Convention mascots** set and a **4chan /mlp/** set; the latter intentionally includes Anonfilly but excludes generic `anon`, `anonpony`, and Aryanne. Most packs, including **G4 caricatures**, are enabled by default; **Pony Life**, **IDW comics**, **G5 remaining**, and **G4 pets** are opt-in and start disabled. Disabling a pack stores its ID in `scm-toolkit.branch-name-disabled-packs`. Saved references to the former `g4-founders-power-ponies` or `g4-characters` pack IDs are recognized as `g4-caricatures`. Custom names are stored in `scm-toolkit.branch-custom-names`. Third-party packs can be pasted into **Imported packs** as one pack object, an array of packs, or a `{"packs":[...]}` object and are stored in `scm-toolkit.branch-name-imports`.

### Workspace Search

The normal installer also installs a small companion VS Code extension into `~/.vscode/extensions`. By default, after reloading VS Code, Source Control contains a **Workspace Search** section with an in-sidebar query box, Hybrid/Semantic/Exact modes, ranked snippets, click-to-open results, and an optional **Ask Ollama** action. It does not open Open WebUI or a separate browser window.

Set `scm-toolkit.workspace-search-activity-bar` to `true` to move the same Workspace Search view into its own Activity Bar container. The panel title and container label use `scm-toolkit.workspace-search-label` and default to **EFS**. Rerun `python3 scripts/install.py` and reload VS Code after changing either setting.

Customize the search-box hint separately from the panel title with `scm-toolkit.workspace-search-placeholder` (or **Search box placeholder** under Sweetiebot Settings → Workspace Search). For example, `git config --global scm-toolkit.workspace-search-placeholder SATS` shows **SATS** in the empty search box. The default remains **Search your workspace…**; blank restores that hint. VS Code Settings also exposes `scmToolkit.workspaceSearch.placeholder`. Changes to that setting update the open EFS view without clearing a search.

The EFS Activity Bar icon is adapted from Fallout: Equestria Game imagery credited to The Overmare Studios. The source and attribution are recorded in `efs/THIRD_PARTY_NOTICES.md`.

Install the default local embedding model once:

```sh
ollama pull qwen3-embedding:0.6b
```

Workspace Search indexes text and code directly, uses macOS `textutil` for Word/RTF/ODT files, tries `pdftotext` for PDFs when available, and falls back to Spotlight text metadata for PDFs and iWork documents. The index lives in VS Code extension storage and changed files are re-indexed incrementally. Git metadata, dependency folders, build output, virtual environments, and coverage output are excluded by default.

Hybrid search combines semantic similarity with exact term/path matching. If Ollama or the embedding model is unavailable, Hybrid falls back to exact ranking instead of failing.

The default **Ask Ollama** model is automatic: it first reuses a currently loaded non-embedding Ollama model, preferring the largest loaded model, then falls back to `scm-toolkit.ai-commit-model`. Set `scmToolkit.workspaceSearch.chatModel` in VS Code settings only when you want to force a different model. The embedding model is separately configurable as `scmToolkit.workspaceSearch.embeddingModel`.

The companion extension only accepts loopback Ollama URLs (`127.0.0.1`, `localhost`, or `::1`). You can also install or remove just this companion extension with `python3 scripts/workspace_search.py` or `python3 scripts/workspace_search.py --uninstall`.


#### Historical work index

The active workspace is only the first corpus this search needs to cover. A more substantive persistent index should eventually span prior research, comment letters, examination responses, drafts, and other related repositories or files so earlier work can be referenced quickly even when the exact wording is forgotten.

A concrete example is the September 2026 lookup for earlier discussion of transitioning away from custodial retirement holdings, the Spain and India direct-holding examples, and the related SEC examination response. Finding those passages required crossing separate stores and took roughly three minutes. That retrieval should instead be a near-immediate semantic lookup that returns the relevant passage together with durable provenance such as repository, file, commit, page, and line.

That broader corpus implies future work beyond active-workspace embeddings: configurable indexed roots or collections, durable cross-workspace metadata, incremental refresh across those sources, and stable source references suitable for citing prior work directly.

### AI commit titles

The installer places a Git wrapper at `~/.local/bin/scm-toolkit-git`. To make VS Code use it, set these User Settings and reload VS Code:

```json
{
    "git.path": "/absolute/path/to/.local/bin/scm-toolkit-git",
    "git.useEditorAsCommitInput": true
}
```

Use the absolute path shown by `python3 scripts/install.py`; do not rely on `~` expansion in the setting.

When `ai-commit` is enabled, clicking VS Code's normal Commit button with a blank message summarizes the staged diff through the configured local Ollama model. On the configured `default-branch` (normally `main`), `ai-default-branch-description = true` asks the model for a subject plus one or two substantive sentences describing what changed and, when clear from the diff, its purpose or effect. Other branches keep the subject-only format. A manually entered message is never replaced by generated commit content or silently spellchecked. Use the explicit spelling-preview control when you want a correction reviewed first. Ordinary staged commits with manually supplied `-m` or `--message` text receive the same final-newline and added-line trailing-whitespace normalization before Git commits, even when AI message generation is disabled; their message text is forwarded unchanged. This cleanup is controlled by the **Normalize staged whitespace** toggle in Sweetie Bot settings → **Source control** (on by default). Turning it off skips cleanup for both manual and automatically generated commits, without changing how their messages are created. To disable it from the terminal, run `git config --global scm-toolkit.normalize-staged-whitespace false`. Amend/fixup/squash/reuse-message mode, path-limited commits, or `--all` keep their existing behavior.

Sweetiebot treats GitHub's 100 MiB regular-repository file ceiling as the large-commit split target. When a blank automatic commit contains multiple staged files whose final Git blobs total more than 100 MiB, Sweetiebot splits them at file boundaries into smaller commits through temporary indexes, leaving the real staged index intact while the split runs. If one staged file itself exceeds 100 MiB, Sweetiebot does **not** change it automatically: VS Code shows a modal confirmation with **Split file**, **Git LFS docs**, and **Cancel**. Only after **Split file** is chosen does Sweetiebot replace the oversized working-tree file with numbered `.part001`, `.part002`, … files of at most 95 MiB and stage that replacement. It refuses the automatic file split when the file has unstaged changes or when a target part already exists, and restores the original if splitting or staging fails. GitHub's softer diff-view ceilings (20,000 lines or 1 MB total raw diff, 20,000 lines or 500 KB for one file, 300 files, and 25 renderable files) produce a VS Code warning with a clickable **Commit anyway** bypass instead of forcing a split. Files over 50 MiB also receive GitHub's large-file warning with the same bypass. Existing legacy `~/.local/bin/git-auto-title` installations are migrated to symlinks pointing at the canonical `scm-toolkit-git` wrapper (and its spellcheck helper). The normal installer manages that legacy path even when it passes the canonical destination explicitly, so an older VS Code `git.path` cannot remain on a stale independent copy.

**Ollama is required for this feature.** Run a local Ollama server and install the models you select before relying on AI-generated subjects. The wrapper talks only to Ollama on `127.0.0.1:11434`, bypasses proxy settings for that local request, and checks the local model inventory before generation. If the selected model or Ollama is unavailable, it uses a deterministic fallback subject.

Both normal and Codex-context generation read commit-writing preferences from `~/.config/sweetiebot/commit-instructions.md` on each request. Edit that file through the Sweetiebot settings page, or set `SCM_TOOLKIT_COMMIT_INSTRUCTIONS` to select another file. Instructions may shape commit wording and style, but staged changes remain authoritative and the generator refuses instruction-driven trailers, metadata, or output-format changes.

`assets/commit-instructions.md` is the shared starter kit: a professional emoji, a brief imperative title, and a fuller description for commits directly to `main`. Personal preferences can be kept in the ignored `assets/commit-instructions.local.md`; copy that file to the default local path or select it with `SCM_TOOLKIT_COMMIT_INSTRUCTIONS` to use it. The installer bundles only the shared starter kit.

Without a dedicated title preference, titles default to one professional emoji followed by a concise imperative title; fallback subjects also include an emoji. Recent repository subjects supply style examples only. Sync titles are excluded from those examples and rejected from generated output, regardless of diff size or file count. Only the dedicated Sync button supplies the branch-sync message.

When blank-message commits use local AI, Source Control displays **Generating commit message** immediately on pressing Commit—even while preflight checks run. The notice stays visible during generation and closes on cancellation or failure. Background commits use the same sparkle notice with **Generating commit message asynchronously**, which closes quietly after one second while generation continues in the background. Local saves and completed commits produce no success notification; optional pushes still run independently.

**Durable background Commit and Push:** Ordinary staged Commit actions and the
Codex co-author button immediately commit the staged tree locally. Blank-message
commits use a temporary `placeholder_<16 hex digits>` subject, so committed
changes leave Staged before title generation starts. You can close the workspace
or quit VS Code after the saved notification. The worker replaces that local
placeholder with the generated message while preserving its tree, author,
committer, timestamps, and trailers; later editing and staging remain separate.
Explicit messages are committed immediately as supplied. The Push checkbox is
captured with the job, and only the finalized commit is published.
When nothing is staged, the background path stages the working changes first,
respecting Git's tracked-only smart commit setting. Existing staged selections
stay separate from unstaged work unless you explicitly choose Commit All.
You can keep committing while earlier titles generate. Each click creates its
own local placeholder; up to four titles generate in parallel, then the worker
applies them in commit order and updates
the queued descendants' parent links without changing their contents. Pushes
publish only commits whose messages and ancestors are finalized.

On macOS, the first queued job installs a per-user login agent that retries every
minute. Interrupted generation and offline pushes resume after login, even if VS
Code stays closed. The computer must be awake and the user logged in; signing or
remote authentication must be available without a prompt. Conflicts, branch
changes, and hook/signing failures pause safely and are reported when the
repository is open. Push rejection preserves the local commit and retries; it
never force-pushes or automatically merges remote changes. Jobs and their private
index snapshots live outside the working tree under
`~/Library/Application Support/Sweetiebot/commit-jobs`; their repository marker
allows more Sweetiebot commits while blocking direct pushes and branch changes.
Terminal commits through the Git wrapper wait until the queue finishes. Special commit
modes such as amend and oversized automatic commit splitting keep the normal Git flow. On other systems a detached worker
continues after VS Code closes, but automatic recovery requires launching the
worker again. Install the updated toolkit and reload the workspace to use this
flow. Older terminal-only asynchronous finalization remains available below.

**Asynchronous local commit finalization (opt-in):** Turn on **Finalize commit messages in background** in Sweetiebot settings → Ollama, or set `git config --global scm-toolkit.ai-commit-async true`. An ordinary blank-message commit first records its staged tree locally with a temporary `placeholder_<16 hex digits>` subject. The Git command returns immediately and a detached local worker prepares the final title and optional default-branch description using the *captured* diff. The worker replaces the provisional commit object with the final message, preserving the exact tree and Git author/committer identity and timestamps, without staging any further work. An optional auto-push starts as usual in the background but the installed Git wrapper blocks **every push** until finalization completes. It also queues additional commits and ref-changing Git commands until the pending message is finalized; file editing and staging remain available.

If Ollama cannot produce a valid message after three attempts, the background job uses Sweetiebot's existing deterministic, factual fallback title and description. Pending job data and its crash-recovery journal live only under the repository's Git directory. The next wrapped push/commit can finish a stopped worker using that fallback. When the branch has changed unexpectedly or the worker cannot safely rewrite an unusual commit, push fails closed and the temporary commit stays local for manual recovery. This protection applies to Git commands run through the configured Sweetiebot Git wrapper; invoking an unrelated Git executable bypasses it. To avoid changing signed commits or the post-commit Markdown spellcheck flow, commits requesting Git signatures and repositories with automatic post-commit spellcheck enabled continue using synchronous generation. Install/reinstall the toolkit after updating so the Git wrapper has its companion async worker.


### Concurrent PDF OCR and commit generation

On macOS, install a dedicated local commit worker so long PDF OCR jobs on port 11434 do not occupy the commit worker's queue:

```sh
python3 scripts/ollama_concurrency.py
```

This starts a login LaunchAgent on `127.0.0.1:11435`, shares the existing models in `~/.ollama/models`, and sets `scm-toolkit.ai-ollama-url` after the worker is ready. It leaves the existing Ollama service and active OCR jobs running. The dedicated commit worker allows four simultaneous Ollama requests. Titles that finish early are saved until earlier commits are finalized. The commit worker uses a 4096-token default context and quantized context cache to limit memory use. The API setting `SCM_TOOLKIT_AI_OLLAMA_URL` overrides the Git endpoint setting; only local HTTP endpoints are accepted.

Remove the dedicated worker and restore the default commit endpoint with `python3 scripts/ollama_concurrency.py --uninstall`. Installing the normal VS Code toolkit alone does not change Ollama services.

The wrapper supports two independently configurable models:

- `ai-commit-model` is the normal/default model
- `ai-commit-low-memory-model` is used when macOS reports less available memory than `ai-low-memory-gib`

The low-memory path never escalates to the larger primary model when the fallback is missing. During normal-memory operation, the smaller model may be used if the primary model is not installed.

### Manual commit spellcheck preview

The Source Control message controls can include a checkmark action for **Preview spelling correction**.
The feature is off by default; enable **Manual commit spellcheck preview** in Sweetiebot settings to
show the action. It sends only the current subject line to the configured local Ollama model and never
changes the message until you approve the suggestion. If the suggestion differs, Sweetiebot shows the
original and corrected subjects in a modal with **Apply correction** and **Keep original**.

Spellcheck uses its own `scm-toolkit.spellcheck-model` setting, defaulting to `qwen2.5:3b`, instead
of sharing either commit-writing model. The model must return a structured `{"subject":"..."}`
response. Sweetiebot rejects malformed output, added or removed words, changed punctuation/emoji
structure, and unrelated rewrites before the preview is shown. Commit bodies are left byte-for-byte
in place. Codex-attributed messages are excluded from the manual spellcheck path, and blank-message
AI generation never enters it.

The preview opt-in is stored as `scm-toolkit.spellcheck-preview`. The former
`scm-toolkit.spellcheck-manual-commit` automatic rewrite setting remains unused, so an older global
Git value cannot silently reactivate spellchecking or mutate a manually entered commit subject.

### AI model picker

When `ai-model-picker` is enabled, the installer adds a small native macOS picker:

```sh
~/.local/bin/scm-toolkit-models
```

The picker shows the current selections, locally installed Ollama models, and common Qwen2.5-Coder sizes, then writes the chosen normal and low-memory models to the `[scm-toolkit]` section of `~/.gitconfig`. It does not modify unrelated Git or VS Code settings.

The recommendations are heuristics based on total system memory:

| System memory | Suggested normal model | Suggested low-memory model |
| --- | --- | --- |
| under 12 GiB | `qwen2.5-coder:3b` | `qwen2.5-coder:1.5b` |
| 12–23 GiB | `qwen2.5-coder:7b` | `qwen2.5-coder:3b` |
| 24–47 GiB | `qwen2.5-coder:14b` | `qwen2.5-coder:7b` |
| 48 GiB or more | `qwen2.5-coder:32b` | `qwen2.5-coder:14b` |

These are starting points rather than memory guarantees. Ollama publishes Qwen2.5-Coder variants at 0.5B, 1.5B, 3B, 7B, 14B, and 32B: https://ollama.com/library/qwen2.5-coder

Disable generation without removing the wrapper:

```sh
git config --global scm-toolkit.ai-commit false
```

Keep AI subjects but disable the extra default-branch description:

```sh
git config --global scm-toolkit.ai-default-branch-description false
```

Disable and remove the installed picker on the next installer run:

```sh
git config --global scm-toolkit.ai-model-picker false
python3 scripts/install.py
```

The environment variables `SCM_TOOLKIT_AI_MODEL`, `SCM_TOOLKIT_AI_LOW_MEMORY_MODEL`, and `SCM_TOOLKIT_AI_LOW_MEMORY_GIB` can temporarily override the corresponding Git-config values.

### Custom Codex window label

In Sweetie Bot's **Codex** settings, change **Codex window label** to any
single-line name, such as **CelestAI**. This replaces the displayed Codex
sidebar/container title and the home-view heading in the Codex webview:
**CelestAI: Codex** becomes **CelestAI**, rather than showing the custom name
as a prefix. The Activity Bar and secondary sidebar use the same setting,
including builds with a different Codex chat view ID. The replacement also
handles heading action buttons without touching them, and does not change
commands, provider IDs, conversation text, or chat behavior.
The original **Codex** label is used by default.

You can also configure it from a terminal:

```sh
git config --global scm-toolkit.codex-window-label "CelestAI"
python3 scripts/install.py --codex-only
```

Reload VS Code after applying the change. Restore the original label by
setting the value back to `Codex` and rerunning the installer, or by
uninstalling Sweetie Bot. Installed Codex extension updates may reset its
manifest; automatic app repair reapplies the selected label.

### Codex composer appearance

The bottom of the configurator's **Codex → Customization** group includes
**New chat input text** and **Follow-up input text**, replacing **Do anything**
and **Ask for follow-up changes**. Blank values restore the original text.
These use `scm-toolkit.codex-new-chat-placeholder` and
`scm-toolkit.codex-follow-up-placeholder`. App repair applies the saved text;
reload VS Code afterward, or run `python3 scripts/install.py` to apply it immediately.

Enable **Hide access label** in the configurator's **Codex** section to show only
the permission icon instead of text such as **Full access**. It defaults to off
and preserves the access menu and the current mode for screen readers. The Git
setting is `scm-toolkit.codex-hide-access-label`.

The send button, New Chat unread dot, and composer labels have separate color
controls in the local configurator's **Codex → Customization** section. Set
`scm-toolkit.codex-send-background` for the Send button background,
`scm-toolkit.codex-new-chat-dot-color` for the notification dot on New Chat,
`scm-toolkit.codex-send-foreground` for the Send icon, and
`scm-toolkit.codex-composer-label-color` for **Full access**, **Work locally**,
and the **+** add-context control. Use a hexadecimal color such as Studio green
`#43AF49`. All four settings default to blank. The New Chat dot follows the
Send button background when its own color is blank; when both are blank, it uses
the existing VS Code theme fallback. Other blank values restore the theme.

Run `python3 scripts/install.py` after changing them and reopen the VS Code window.
These overrides apply only to the selected Codex controls, independently of
VS Code's general foreground color. Codex extension updates can replace the
stylesheet; automatic app repair restores supported customizations after updates.

If Codex stopped loading after the retired inline composer patch from PR #93,
repair the installed OpenAI extension directly from a current checkout:

```sh
python3 scripts/codex_composer.py
```

The recovery command scans installed `openai.chatgpt-*` extensions, validates the
old Sweetie Bot restoration metadata, removes only that retired payload, and
restores any source text it replaced. Before reloading Visual Studio Code, rebuild
and run **Sweetiebot Installer.app** using **Install Sweetie Bot.command** from this checkout. The companion Workspace
Search extension bundles its own Codex installer and runs it at startup; an older
installed copy can reintroduce the retired composer patch on every reload.
Rebuilding the app alone does not update that companion extension: run the rebuilt
app to install the current payload. The rebuilt app retains its persistent signing
identity. Use `--extension "/path/to/openai.chatgpt-version"` to target
one extension directory explicitly.

The current installer also migrates the recent-chat preview patch's older raw
JSON restoration metadata into a JavaScript comment. The old metadata could be
interpreted as a function call when another customization followed it, causing
the webview to show **ChatGPT hit a snag** even after the composer repair.

### Compact Codex rate-limit notices

Repeated transcript notices without a usable reset time are shortened to
**Rate limited**, rather than duplicating the upgrade/credit warning already
shown in Codex's main limit card. Messages with an actual reset time retain it.

A right-aligned **Use credits** shortcut appears on the main limit card
when Codex itself renders an available banked-reset control (for example,
**1 reset available** or **Full reset**). The shortcut activates Codex's
native usage/reset confirmation flow; Sweetie Bot never redeems a reset
automatically or treats purchased usage credits as banked resets. If the
native eligibility control is not present, no shortcut is shown.

### Hide Codex reset times

The independent **Hide Codex reset times** toggle suppresses absolute reset dates,
clock times, and relative durations (including countdowns) in Codex usage menus,
dialogs, limit messages, and tooltips without hiding usage indicators.
It takes precedence over the countdown display without changing that preference.
It is off by default. Enable it in Sweetie Bot settings or run:

```sh
git config --global scm-toolkit.codex-hide-usage-reset-times true
python3 scripts/install.py --codex-only
```

### Codex usage-reset countdown

When `codex-usage-reset-countdown` is enabled, usage-limit banners in the installed
Codex extension show the time remaining as a live countdown such as `4h 23m`. The
display rounds to the nearest minute and refreshes as the countdown changes.
The local composer label beside the location icon shows the smaller remaining
percentage of the five-hour and weekly usage limits. Until usage data is available,
it shows **Work locally**. The usage submenu shows centered reset countdowns;
weekly resets display the number of days left instead of a calendar date.

To install or refresh only this optional Codex patch without touching the SCM
workbench patch, run:

```sh
python3 scripts/install.py --codex-only
```

Codex extension updates can replace the patched webview bundle. Automatic app repair restores supported customizations; reload when prompted.

### Codex promotion hiding

When `codex-hide-promotions` is enabled, the Codex webview suppresses targeted
promotional cards such as the `Enable Fast mode` / `Enable now` upsell and the
`You're out of Codex messages` upgrade card. The
filter matches both the promotion title and its action before hiding the nearest
card, so ordinary Codex warnings, errors, and usage-limit messages are left
alone.

This option can be installed or refreshed with the same `--codex-only` command
used by the usage-reset countdown.

### Codex VS Code personalization

The local configurator includes a Codex section for the personalization used by the
Codex VS Code extension. It can keep a local copy of the custom instructions you
use on ChatGPT web and mirror that text into a managed block in `~/.codex/AGENTS.md`
without overwriting unrelated global Codex instructions.

The "Import from ChatGPT" button is clipboard-assisted: copy the Custom Instructions
text from ChatGPT Personalization, then import it into the Codex section.
The toolkit does not scrape ChatGPT session cookies or call a private custom-instructions
endpoint.

When `chatgpt-web-codex-coauthor` is enabled, the managed Codex instructions require
web or GitHub-tool commits to append:

```text
Co-authored-by: Codex Web <noreply@openai.com>
```

The Codex section also accepts an optional ASCII-armored PGP secret key. The key
is piped to GnuPG over stdin, imported into the local keyring, and discarded from
the form. Only the resulting public fingerprint is saved to Git configuration;
`commit.gpgsign` is enabled and the private key is never echoed into generated
configuration or command output.

The companion extension exposes `Sweetiebot SCM: Search Linked GitHub Repositories`.
It authenticates through VS Code's GitHub provider and searches the repositories
visible to that linked account, so the toolkit does not maintain a second repository
access list or a separate personal access token.

### Codex chat timestamp hiding

When `codex-hide-chat-timestamps` is enabled, the Codex webview hides standalone
conversation date/time separators such as `Today 6:44 PM`. It also replaces
elapsed-time labels like `Worked for 1m 48s` with `Activity` on collapsible Codex
activity controls, preserving their expand behavior. Exact time labels such as
`9:18 PM` are also hidden when split into several text nodes. A persistent
stylesheet and mutation handling keep them hidden when React changes their
attributes or styles. Message content, unrelated buttons, links, and inputs
remain untouched.

This option uses the same `--codex-only` install/refresh path as the other Codex
customizations.

### Commit and push

The Source Control message placeholder and commit actions have independent text overrides. Set `scm-toolkit.message-placeholder` to replace the commit-message placeholder (default **Message**); leave it blank to restore VS Code's native placeholder. Set `scm-toolkit.commit-button-label` for ordinary commits and `scm-toolkit.commit-and-send-button-label` for the primary action while `git.postCommitCommand` is `push`. Both action labels default to **Send**. Changes made through the Sweetiebot settings page are mirrored into VS Code configuration and update the running Source Control UI without a window reload.

When `commit-and-push` is enabled, the checkbox mirrors VS Code's `git.postCommitCommand` setting. Checking it sets the value to `push`; unchecking it sets the value to `none`.

For push mode, the toolkit suppresses VS Code's awaited post-commit push, completes the commit first, then dispatches `repository.push()` without awaiting it. This releases the commit UI immediately instead of waiting for remote confirmation or performing a separate origin-verification step. If Git rejects that push because the remote branch advanced (`PushRejected`), the toolkit automatically runs `repository.pull()` and retries the push once without asking for confirmation or requiring the Sync button. Any pull conflict or second push failure is surfaced asynchronously as a notification.

Disabling the toolkit feature hides the checkbox. It does not silently rewrite an existing `git.postCommitCommand` value.

### Inline code completion

When `autocomplete-toggle` is enabled, the sparkle button appears after the other
SCM controls. It toggles VS Code's `editor.inlineSuggest.enabled` setting. A slash
through the sparkle means inline code completion is off.

### Source Control label

The toolkit can replace VS Code's built-in **Source Control** view-container label
with a custom app-bar name. It defaults to **Sweetie Bot**.

Set another label and reinstall:

```sh
git config --global scm-toolkit.source-control-label "My SCM"
python3 scripts/install.py
```

Set it back to `Source Control` to preserve VS Code's stock label while keeping
the rest of the toolkit enabled.

### Source Control Graph working-file open

When `graph-open-working-file` is enabled, the Source Control Graph's **Open File**
action keeps the selected history item's path but opens it as a normal `file:` URI.
That means the editor shows the file from the branch currently checked out in the
working tree instead of the read-only `git:` snapshot for the selected commit.

If that path does not exist in the checked-out branch, VS Code reports the missing
working-tree file rather than silently falling back to the historical snapshot.

Restore VS Code's stock historical-file behavior with:

```sh
git config --global scm-toolkit.graph-open-working-file false
python3 scripts/install.py
```

### Blank-state refresh

When `blank-state-refresh` is enabled, the toolkit asks VS Code's built-in Git
extension to refresh a repository more aggressively while SCM has zero changed
resources. It performs an initial refresh after about 300 ms, then falls back to
roughly 750 ms refreshes while VS Code is visible. The polling stops as soon
as SCM reports a change and automatically resumes after the repository becomes
clean again. Hidden windows back off instead of polling at the foreground rate.

This uses VS Code's existing `git.refresh` command; the toolkit does not run its
own Git status implementation. The SCM progress bar stays hidden, including during
background Git fetches, so updates do not flash a distracting animation.

When `auto-pull-clean` is enabled, the toolkit checks the current branch against its
tracked upstream in the background, even when `blank-state-refresh` is
disabled. Disabling blank-state refresh skips the extra `git.refresh` calls while
automatic pulling continues. Network fetches never hold up the next local SCM
refresh, and only one automatic pull check runs at a time. The toolkit pulls only when the working tree is
still clean and the local HEAD is an ancestor of the upstream HEAD. That means a
behind-only branch can fast-forward automatically, while branches with unpushed or
diverged commits are left untouched. The pull uses VS Code's existing `git.pull`
command and does not ask for confirmation in that safe case.

### Cmd-click close others

When `cmd-click-close-others` is enabled, holding ⌘ while clicking an editor tab's X
uses VS Code's built-in **Close Others** action for that tab. The clicked tab stays
open while VS Code closes the other editors in that group using its normal behavior
for selected editors, sticky/pinned tabs, and dirty-close prompts.

The installer extends the modifier state VS Code already uses for its native
close-others tab action. Normal clicks and normal ⌘-click tab selection are otherwise
left to VS Code.

### Moving Integrated Browser tabs between VS Code windows

Sweetiebot applies a reversible, guarded workaround when moving an **Integrated Browser** tab to another VS Code workspace window. VS Code can deserialize a transferred browser tab with an ID still owned by the source window. The destination then fails to resolve the editor with `Browser view … closed during creation`. When the destination has no registered view for that ID, Sweetiebot opens a new view using the transferred tab's saved URL and title rather than attaching to a view owned by a different window. Moving within one workspace, including floating auxiliary windows, retains the original view identity.

This is **reopening, not live Electron view migration**. Unsent form input, in-memory page state, navigation history, DevTools state, and other transient data may not transfer. Copy important unsent text first. The workaround does not address screenshot-capture failures or unrelated browser crashes, and it applies only to supported VS Code builds. Rerun Sweetiebot's repair after an update and reload the windows.

### Integrated Browser ChatGPT home

When `browser-chatgpt-home` is enabled, a blank Integrated Browser tab starts at
`https://chatgpt.com/`. Explicit URLs, including PR action prompts and restored
tabs, continue to win. Opening a new tab no longer clears a different tab's
unsent message.

With both `browser-globe-new-tab` and `browser-chatgpt-home` enabled,
the title-bar globe opens a new tab at the configured homepage directly,
without leaving the address-bar picker focused over the website. With the
homepage toggle off, the globe still opens a normal blank tab with the URL
picker. Other New Tab actions retain their native focus behavior.

On startup, Sweetiebot prefers VS Code's native
`workbench.browser.dataStorage: "workspace"` setting when there is no explicit
user/workspace override. The native browser patch routes both `workspace` and
`global` storage to one persistent profile at
`~/Library/Application Support/Sweetiebot/browserStorage` for all repository
and New PR windows. Signing into ChatGPT in that profile carries across GitHub
folders, independent clones, saved workspaces, and application restarts.
Cookies and site storage, including ChatGPT drafts, are shared across those
windows. Each PR keeps its own workspace and tabs.

Fully quit and reopen VS Code after first installing this native patch; reloading
a window does not restart the main process that selects browser sessions.
Sign in once in the shared profile if needed. Previous workspace and global
profiles remain stored separately; their logins are not migrated automatically.
Temporary and agent browser sessions remain isolated. To use temporary browser
storage, explicitly set `workbench.browser.dataStorage` to `ephemeral` in VS Code
Settings. The ChatGPT home toggle is still applied by the installer: rerun
`python3 scripts/install.py` and reload VS Code after changing it.

### Codex starting-draft isolation

Codex's VS Code sidebar is separate from the Integrated Browser's ChatGPT login.
Codex historically saves the unsent `new-conversation` composer draft in a
user-global persisted atom, which can reappear in unrelated repository windows.
Sweetiebot now stores **only that starting draft** under a stable key derived
from the VS Code workspace folder URI(s). Reopening the same checkout restores
its draft without exposing another checkout's text. Independent clones have
their own drafts; separate windows for the same checkout share one draft key.
Existing local conversation drafts (`local:...`), Codex account authentication,
selected projects, prompt history, and all other persisted state stay native.

The Codex webview patch also masks any old global starting draft during startup
without deleting the original stored value, so older shared drafts are not
silently assigned to an arbitrary repository. Fully reload VS Code after
installing; live Codex extension updates can change the guarded patch anchors.

### Codex co-author commit

Enable `scm-toolkit.codex-commit-context` to generate blank co-author commit
messages from the current Codex conversation in the same VS Code window and the
staged diff, using only local Ollama. The option defaults to `false`. The captured
text stays in memory, is limited to the latest 6,000 characters of the loaded
transcript, and supplies intent; the staged diff determines what the commit
actually describes. Generation does not submit a Codex prompt, steer its task,
stop it, or change focus. It also reads a retained conversation when Source
Control hides the Codex pane, and shows progress while Ollama generates the
message. Manually entered messages retain the usual behavior.

Stage the intended changes first. An unavailable chat or local model stops the
commit; a changed branch, index, repository, or message also stops it. Run the
installer after enabling the setting and reopen the VS Code window once to load
the snapshot bridge. Subsequent button presses leave Codex running.

When `codex-coauthor` is enabled, an account button appears in the SCM message row.
The **Message bar** settings let you change the **Commit co-author name** and
**Commit co-author email** independently. The button appends the configured
`Co-authored-by` trailer to the current message, then commits to the selected
repository. With the default name and email, it appends:

```text
Co-authored-by: Codex <noreply@openai.com>
```

To use a different co-author, set `scm-toolkit.codex-coauthor-name` and
`scm-toolkit.codex-coauthor-email` in Sweetie Bot's Message bar settings or
with `git config --global`. The email should belong to the intended GitHub
account for linked attribution; changing these fields does not change the Git
commit's primary author. The trailer is added after a blank line and is not
duplicated if it is already present. Invalid names or emails stop the attributed
commit rather than allowing injected commit-message lines. This applies to both
manual messages and locally generated blank-message commits.

### ChatGPT project context for GitHub PR actions

In Sweetie Bot settings → **GitHub**, set **ChatGPT project for PR actions** to a project address such as `https://chatgpt.com/g/g-p-6ac73804b6b081918ef8d1f0c88d4ba0/project`. You can also use VS Code's `scmToolkit.chatgptProjectUrl` setting (including a workspace override), or `git config --global scm-toolkit.chatgpt-project-url "https://chatgpt.com/g/g-p-.../project"` followed by syncing settings through the configurator. An empty value retains normal ChatGPT chats. This affects **PR drafting** and **Squash Selected Pull Requests with ChatGPT**; the direct GitHub CLI quick-merge button does not open a chat and is unchanged.

Sweetie Bot appends the prepared prompt as the URL's `q` parameter within the chosen project. ChatGPT's project-scoped `q` behavior is not a documented API, so verify the draft appears in the project composer before submitting; if it does not, paste the prepared prompt manually. The project must already be accessible to the signed-in ChatGPT account. Project instructions and files are supplied by ChatGPT, not by Sweetie Bot.


**First-run setup:** With no project configured, the next ChatGPT-backed PR drafting or batch merge action offers to set up a project. Choose **Set up project** to open ChatGPT in your web browser, create (or select) a personal **unshared** project, and paste its project URL into Sweetie Bot. The URL is saved in your VS Code user settings so later actions open inside that project. Choose **Use regular chats** to explicitly retain the original behavior without repeat prompts, or cancel to launch no chat. A project URL configured in Settings takes precedence over that choice. Sweetie Bot cannot create a ChatGPT project through a supported external API, verify its privacy, or move old chats; use ChatGPT's own project controls and do not share the project if it must remain private.\n\n### Pull requests through Kafania

The pull-request button immediately left of the new-branch button opens a dedicated **Pull Request** workspace in a new VS Code window. That workspace starts in Sweetiebot's centered 600 × 600 compact-square layout (on displays large enough to support it). The title-bar **Compact window** button restores its previous size; the originating repository window keeps its own dimensions. The PR workspace owns the confirmation window, drafting and pony chats, and local callback server, so closing the original repository window does not stop the PR session. It uses the same repository checkout and preserves the selected branch, base, conversation context, and PR settings. Keep the Pull Request workspace open until the session finishes. When a PR workspace contains one repository, the Explorer shows that repository's files directly rather than an extra root-folder row. This is an Explorer-only change: the named `.code-workspace` file, isolated PR window and extension host, callback ownership, and shared ChatGPT browser profile remain unchanged. Normal workspaces and multi-root PR workspaces retain native Explorer behavior. Sweetiebot reads `PULL_REQUEST.md` from a sibling `kefania` checkout and includes those canonical rules in the request.

Before opening the chat, Sweetiebot reads the published branch comparison through local Kefania using the saved GitHub App credentials. It sends bounded evidence to ChatGPT, withholds secret-bearing patches, and retains the verified head SHA locally.

The request asks ChatGPT to research relevant earlier PRs, commits, and primary sources, then present its finished title and description with a **Publish with codex-pony bot** link. Clicking the one-time link returns the description to local Kefania, which verifies the unchanged branch head and publishes as the bot without another Codex drafting run. The link expires after one hour. If the Integrated Browser is unavailable before launch, the button uses the local Codex fallback; an uncertain or unfinished browser launch never starts a second drafter.

When the Integrated Browser is already showing a private ChatGPT conversation, Sweetiebot records its `/c/<uuid>` URL as the source. Otherwise it asks the patched Codex extension for the active local conversation UUID and a read-only context snapshot. The Codex UUID is linked through a Sweetiebot VS Code deep link so the author can reopen the local session even though it is not public.

That source metadata is passed to Kafania. Kafania formats it as a separate pull-request comment and can include a short conversation-intent summary, which is intentionally distinct from the diff-based PR description. Source UUIDs are never invented when neither ChatGPT nor Codex exposes one.

Sweetiebot first looks for a sibling `kefania` checkout. It also discovers a shared `pony-factor/kefania` checkout under the same repository collection, beside the Sweetiebot source, or at `~/GitHub/pony-factor/kefania`. The eligibility check, drafting rules, and local publisher use this discovery, so repositories grouped under different owners can share one Kefania checkout. Failed eligibility checks retry after 15 seconds, allowing repaired setup to enable New PR without a branch-head change or window reload. Opening the drafting chat does not stage, commit, or push local changes. When a branch matches a pony, Sweetiebot asks that local Kefania checkout for any saved biography and source-reference pages. The URLs from `ponies/sources.json` are sent only to the independent pony research page—even when no biography is cached—and never enter PR descriptions or GitHub metadata. Update Kefania together with Sweetiebot to use the migrated source index. URLs are references, not stored copies of artwork.\n\nWhen independent pony research creates a new profile in Kafania's `ponies/<pack>/<slug>.json`, Sweetiebot automatically commits **only that new JSON file** and pushes `main` to `origin/main` using the deterministic subject `🦄 Add pony profile: <pack>/<slug>`. Other staged files and existing profiles are never included or overwritten. Automatic publishing requires an up-to-date local Kafania `main` tracking `origin/main`; it never pulls, force-pushes, or pushes previously unpushed local commits. A failed publish keeps the new file locally and shows a warning. Pony content remains separate from the target project's PR.

#### Connect a local Kefania server

Kefania can run on your computer; it does not need a dedicated website or domain. Register `kefania/src/index.js` as a Node stdio MCP server named `codex-drafter` in VS Code. Use **MCP: List Servers** to start it. Its GitHub CLI login must have access to the repository.

VS Code's local connection and ChatGPT's connection are separate. The PR button does not require a ChatGPT MCP connection or tunnel: browser research and drafting return to the local bot publisher through the one-time link. Other ChatGPT MCP workflows can use the [official Secure MCP Tunnel setup](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). Keep credentials in the supported local credential store or process environment, never in repository files.

Sweetiebot's availability check verifies the VS Code server and GitHub login. It cannot verify the signed-in ChatGPT account's tunnel/plugin connection. The drafting prompt reports missing tools if that separate connection has not been completed.

### Pony branch

When `pony-branch` is enabled, a branch-create button appears at the far right of
the SCM message row. With a clean worktree, it syncs the configured
`default-branch` (normally `main`) in a temporary worktree when needed, pushes
any outgoing commits, and creates a branch from the synchronized HEAD.
With staged or unstaged changes, it skips syncing and creates the branch from
local HEAD, carrying the changes and their staging into the new branch. These operations
use the built-in Git extension's API through the toolkit companion extension.
Syncing requires the default branch to track the configured remote. Checkout
or sync failures stop branch creation and display the error; unresolved merge
conflicts also stop branch creation.

The branch name is chosen randomly from a built-in, branch-safe pool. Its canon
portion covers the named G4 pony roster (excluding explicitly unnamed placeholders
and non-pony kirin), with major canon G4 non-pony creatures and the main G5 cast
added separately alongside Tamers12345 continuity names, fanmade characters featured
Fallout: Equestria characters and major side-story variants. Existing local
and configured-remote branch names are excluded before selection. The picker
uses Node.js cryptographically secure `crypto.randomInt()` rather than
`Math.random()`, with equal odds for every eligible name. It remembers drawn
names in `.git/sweetiebot-branch-name-history.json` (the common Git directory
for linked worktrees), avoiding reuse even after branch deletion until every
currently available name has been drawn. It then starts another cycle and
avoids repeating the most recent name when multiple choices remain. The local
history survives VS Code restarts but is not committed or shared between
separate clones; deleting the history file resets the rotation.

Disable the button without changing the rest of the toolkit:

```sh
git config --global scm-toolkit.pony-branch false
```

### Branch cleanup

When `branch-cleanup` is enabled, the trash control appears for local branches other than the configured `default-branch`.

For a branch already absent from the remote, the trash control first attempts its guarded merged-branch cleanup: fetch and prune, verify the remote, update and check out the configured default branch, then delete locally without forcing. GitHub PR verification remains required for automatic cleanup of squash-merged local branches. If the branch tip cannot be verified as a merged PR, a **Delete Local Branch Anyway** modal warns that unmerged commits could become unreachable. Cancel keeps the local branch (with the default branch checked out); confirming force-deletes only the local branch after rechecking its exact tip, clean worktree, absence from the remote, and Git worktree protections. This override never deletes a remote ref.

If the branch still exists on `origin` (or the configured remote), clicking trash instead opens a **modal confirmation**. Cancel leaves both copies untouched. **Delete Local and Remote** removes the exact confirmed remote ref using Git CLI with an SHA lease, then removes the local branch. This can close the associated GitHub PR and discard unmerged branch commits, so confirmation is required. Deletion requires a clean worktree and a matching local/remote tip; changes on the remote before or during deletion abort it. The default branch remains protected. If the remote delete fails, the local branch is preserved (even if checkout has already returned to the default branch).

The separate right-click **Delete empty branch** action retains its stricter ancestry checks for empty topics.

## Uninstall

Before uninstalling, clear VS Code's `git.path` setting if it points to the toolkit wrapper.

Remove the patch and the installed wrapper:

```sh
python3 scripts/install.py --uninstall
```

Then reload or restart Visual Studio Code.

You can also use `--check` with `--uninstall` to validate the removal without writing:

```sh
python3 scripts/install.py --uninstall --check
```

## Automatic merged-branch cleanup

Sweetiebot checks open local repositories when VS Code starts and every ten minutes. Each automatic scan first fetches `origin` with `--prune`, removing locally cached remote-tracking refs whose upstream branches have been deleted, without deleting local branches on that evidence alone. It then looks up merged PRs for each outstanding local branch on `origin`, including older PRs outside the repository's recent history. A deleted PR head ref is validated against the final commit recorded for that PR when GitHub no longer reports a head-ref OID. It uses authenticated `gh` to verify that a same-repository PR merged into the default branch. A local branch is removed only if its tip still equals the recorded PR head and no PR for that branch is open. If the merged branch is active, Sweetiebot switches to the local default branch (normally `main`) before removing it, provided there are no uncommitted changes or Git operations in progress. Branches checked out in other worktrees are preserved. Git removes the reference with the expected SHA, preserving a branch that moves during cleanup. Closing a PR without merging leaves its local branch alone. Remote branches are left to GitHub’s repository setting.

Preview one repository without deleting branches:

```sh
python3 scripts/prune_merged_branches.py --repo /path/to/repository --force --dry-run
```

Automatic scans report successful pruning and skipped operations in the VS Code **Sweetiebot Branch Cleanup** output channel. A dry run does not fetch or remove remote-tracking refs. A GitHub CLI authentication failure never authorizes deletion of local branches.

The installer also applies reversible fixes to supported GitHub Pull Requests extension builds. It suppresses the automatic cleanup prompt when the repository already deletes branches on merge, while retaining the manual Delete Branch action and explicitly configured native automatic deletion. The PR-number link keeps its existing click handler as its sole opening path. Rerun the installer after updating that extension; unsupported assets are skipped with a warning.



Sweetiebot moves both single-PR drafting chats and batch pull-request merge chats to a native floating editor window, without changing the global Integrated Browser tab-placement setting. On macOS, it also attempts to resize the newly focused ChatGPT window to 680 × 720 pixels. That size adjustment requires macOS Accessibility permission and is best-effort; if it is unavailable, the floating window remains resizable manually. If VS Code cannot float the browser tab, the chat remains open in its original tab rather than accidentally starting a second PR run. In the floating window title bar, **Set Compact Mode** can hide the extra window chrome.

The batch ChatGPT merge picker includes ready-for-review PRs targeting any branch and displays complete selected stacks in ancestor-first order. Complete stacks rooted at `main` do not trigger the generic non-`main` warning: the generated chat requests GitHub's native atomic stack squash operation where supported (`gh stack merge <PR> --yes --squash` or the asynchronous REST endpoint), preserving one squash commit per PR. A head/base branch-name chain does not prove native GitHub stack membership, so the merging workflow rechecks it and never adds unselected ancestors. Incomplete stacks and unrelated non-`main` targets still require confirmation and retain their bases. The picker only launches a merge-request chat; it does not itself merge or rebase PRs. Its instructions require each completed squash commit to end its title with that PR's number (for example, `(#269)`), retain verified original human authors/committers and existing co-authors through explicit `Co-authored-by` trailers when necessary, order co-authors as primary original human authors, other human contributors, regular Codex, Codex Web, codex-pony, Copilot, Ollama, other bots, then other AI collaborators; retain the required Codex Web entry at its priority position (not necessarily last); and verify the resulting commit. Ollama uses `hello@ollama.com`, and Copilot uses the verified GitHub noreply identity recorded for the contributor. When a native stacked merge cannot customize each layer's commit metadata, the workflow stops the affected stack rather than silently losing contributor credit. The individual **Squash and Merge Pull Request** button still merges only into the PR's current base. The GitHub Pull Requests list refreshes when visible and focused if the configured interval has elapsed, then every 120 seconds by default. The gear page offers **Pull-request refresh interval (seconds)** (30–3600 seconds); manual refresh remains available. After an API or secondary rate limit, Sweetiebot pauses its own automatic refreshes for at least 15 minutes, increasing the cooldown to at most 60 minutes for repeated limits. Other GitHub API consumers may still exhaust the shared quota. Hover over a PR to use **Squash and Merge Pull Request** without opening its description. The button uses the authenticated GitHub CLI to call GitHub's asynchronous REST merge endpoint (`merge-async`) for an ordinary, individual squash merge, with the selected PR's exact head SHA, `merge_method=squash`, and `merge_action=direct_merge` (with GitHub branch protections still enforced). It rechecks the PR's head and base before submission, polls the returned request ID for up to twelve seconds, distinguishes accepted/pending and merge-queued requests from completed merges, and confirms the PR's merged state and original target before cleanup. A pending merge does not close the PR tab or remove branches. Retrying a matching existing request polls its status and shows that GitHub is still processing; a different head, method, queue policy, or rules-bypass setting is rejected. Since GitHub does not return custom commit metadata with an existing request, Sweetiebot verifies the completed squash commit title and contributor attribution before reporting success or cleaning up branches. The single-PR action also checks native GitHub stack membership and declines stacked PRs, because requesting one stack layer would implicitly include unselected downstack PRs; use the bulk merge workflow for those. The merge button verifies the PR is open and ready for review. PRs targeting a branch other than `main` require an explicit modal confirmation showing the destination and a re-check of the target and head before merging. Merges always use the PR's base branch and the freshly fetched head commit. GitHub branch protections remain in effect. After a completed merge into `main`, guarded cleanup returns an eligible clean local PR branch to the default branch and removes it; non-`main` merges skip that local cleanup; dirty worktrees and changed local heads are preserved. Queued merges skip cleanup until a later operation confirms completion. Direct quick merges show status-bar progress instead of a persistent notification, then one brief toast with a 🎉 icon on confirmation or an ⏳ icon if still queued. Errors and cleanup warnings remain visible. Both features can be toggled in the gear page using `pull-request-auto-refresh` and `pull-request-quick-merge`.


Automatic staged commits remove trailing spaces and tabs from added or changed text lines and normalize the final newline. Existing untouched lines, LF/CRLF style, file modes, cached attribute exclusions, and unstaged edits are preserved. Explicit-message commits keep their existing behavior.

### Post-commit Markdown spellcheck

Enable **Post-commit Markdown spellcheck** in SweetieBot settings under Ollama, or run:

```sh
git config --global scm-toolkit.post-commit-spellcheck true
```

This toggle is off by default. After a successful automatic staged commit, the local Ollama model reviews changed Markdown prose and proposes conservative spelling, grammar, and ASCII punctuation corrections. When **Commit and push** is checked, the active branch finishes pushing (including any retry) before spellchecking starts. Failed pushes and branch changes skip the spellcheck job without dirtying the working tree. Fenced code, inline code, URLs, Markdown prefixes, and line endings are protected. **Preserve intentional line breaks** (Sweetie Bot settings → Ollama) is **off by default**. With it off, the model prefers to join unnecessary soft line breaks—particularly adjacent Markdown links that belong next to one another—while leaving paragraph separations, headings, lists, tables, code and hard line breaks intact. It does not flatten everything into a single line or insert new lines. To require every original line break to stay put, enable the switch or run `git config --global scm-toolkit.spellcheck-preserve-line-breaks true`; this restores the strict, same-line-count check. Unavailable models and unchanged text produce no dialog.

Proposals open in the **Spellchecks Performed** review popup as unstaged edits. Use **Undo** beside an individual highlighted correction to restore just that change (including when several typos occur on one line); click a file heading to collapse or expand its diff while reviewing other files. Collapsed sections stay collapsed as corrections are refreshed. You can also edit corrections and the proposed message before choosing **Accept** to commit only the reviewed files, **Revert** to discard their unstaged corrections, or **Close** to leave the edits in place. **Accept** also pushes the active branch when Source Control's **Commit and push** checkbox is checked; otherwise it commits locally. If that push fails, the commit stays local and an error is shown without reopening a stale preview. The original commit and unrelated staged work remain unchanged. The job skips repositories with local work or new staged changes, a changed HEAD, and corrections to files edited while it runs. Explicit-message commits retain their existing behavior.

### Lindsey-backed bulk merges

When a local `lindsey-sync` checkout includes `scripts/bulk-merge.js`, Sweetiebot's existing Merge All picker calls Lindsey directly rather than launching a ChatGPT merge chat. The **Merge All Pull Requests** button appears beside the bulk merge button in the GitHub Pull Requests toolbar and submits all ready-for-review PRs directly. The bulk merge picker retains its selective checkboxes; Lindsey executes exact-SHA squash operations and reports individually merged, queued, blocked and unverified results in the **Lindsey Bulk Merge** output channel.

Place the Lindsey repository beside the active repository, add it to the VS Code workspace, or set `LINDSEY_SYNC_REPO`. Install the GitHub `gh` CLI. The existing VS Code GitHub session is passed only to the local Lindsey child process, and selection snapshots are written as private temporary JSON that is removed afterward. When the Lindsey CLI is absent, Sweetiebot retains the existing ChatGPT flow.

**Important:** Selecting PRs for Lindsey authorizes actual GitHub merges, not just creation of a ChatGPT prompt. Lindsey refuses linked/native stack merges until it can preserve independently attributed commits, and continues with unrelated safe PRs. It does not force-push or merge unselected PRs.


### Direct versus durable commit mode

By default, **Durable background Commit and Push** is now **off**. Ordinary staged Commit and Codex-attributed commits use the earlier direct Git/Ollama workflow, generating a message immediately within the normal commit action and then committing. For Codex context, the direct path reads the existing conversation snapshot and uses `local_codex_commit.py`; manually provided text is committed with the configured trailer. The custom commit instructions (`~/.config/sweetiebot/commit-instructions.md`), priority emoji enforcement, normal/low-memory models, co-author, Git signing and normal push checkbox keep their existing behavior. Generated descriptions on `main` remain enabled according to **Default-branch descriptions**.

Turn on **Durable background Commit and Push** in Settings → Source control for ordinary Commit, native Git commits and the Codex co-author button. It creates a local placeholder commit at click time, clears the committed changes from Staged, and applies the generated message afterward, with retry and recovery even after VS Code closes. Disabling the setting does not discard existing jobs; the worker continues to recover them. The separate **Legacy provisional commit finalization** toggle remains off by default and is only for the older Git-wrapper mode. **Detailed AI commit descriptions on all branches** is a second, independent opt-in style control, adding explanatory bodies on topic branches without changing user instructions or the ordered emoji rules. Settings applied through the gear page update global Git configuration; changes to native Git interception may require the toolkit to update and reload.


### Eight-hour GitHub main mirror (opt-in)

Enable **Mirror GitHub main every 8 hours** in Sweetiebot Settings → GitHub. The setting installs a per-user macOS LaunchAgent (`StartInterval=28800`) which can run after VS Code closes while the Mac is awake and the user is logged in. GitHub CLI authentication and noninteractive HTTPS Git credentials are required for private repositories. The mirror discovers accessible repositories and clones those with a literal `main` default branch into `~/Library/Application Support/Sweetiebot/Cloud Repositories/<owner>/<repo>`. It never accesses user workspaces. On later runs it fetches only `main` and fast-forwards only when the managed checkout is clean, on `main`, nondivergent, and without a pending Sweetiebot commit. Dirty, untracked, switched, divergent, symlinked and unmanaged checkouts are skipped; no reset, push or force-pull occurs. Logs are at `~/Library/Logs/Sweetiebot/cloud-repository-sync*.log`. Disabling unloads the agent without deleting mirrors. This is separate from automatic pull for open workspaces.
