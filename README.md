# Sweetiebot SCM

A small source-control UI patch for Visual Studio Code. It keeps the built-in Git workflow, but adds a compact branch selector and optional SCM controls around the commit-message box.

Current features:

- show the current branch inside the SCM message box and open VS Code's normal branch picker from it
- switch the branch selector and native Commit button between outlined and accent-filled styles
- show enabled action icons in pure white while hovering SCM or Source Control Graph rows and action buttons, preserving their normal theme colors otherwise
- customize the commit-message placeholder (defaults to `Message`)
- optionally show a commit-and-push checkbox that dispatches the push without holding commit completion
- clean up unchanged local branches after their same-repository PR merges into the default branch
- suppress the GitHub PR extension’s redundant cleanup prompt when the repository deletes merged branches automatically
- open the PR-number link in the GitHub PR view once per click
- optionally show a guarded local-branch cleanup button
- optionally create a branch from `main` using configurable built-in, imported, and custom name packs, syncing first when there are no uncommitted changes
- optionally show a quick toggle for VS Code inline code completion
- optionally show a commit button that appends the Codex co-author trailer
- optionally open a pull request for the current branch through a configured MCP server
- recognize built-in pony branch names during PR creation and pass local-only character context to Kafania for a post-publish pony profile
- show the matched pony as a small local-only **Pony Info** view in Source Control, beside whatever editor or Integrated Browser content is open
- optionally hide the outgoing commit count from the built-in Sync action
- optionally refresh clean/blank Git repositories more aggressively so the first new change appears in SCM quickly
- search the active workspace semantically from a `Workspace Search` view inside Source Control by default, or optionally move it to its own Activity Bar container, backed only by local Ollama
- optionally use ⌘-click on an editor tab's close button to keep that tab and close the others in its group
- optionally use ChatGPT as the home page for blank Integrated Browser tabs
- optionally make Source Control Graph **Open File** open the checked-out working-tree file instead of the selected commit snapshot
- optionally generate a commit subject locally when the normal Commit button is used with a blank message
- preview spelling corrections for manually entered commit subjects before applying them
- optionally show a live, minute-precision countdown in Codex usage-limit banners
- optionally hide Codex promotional cards such as the Fast mode upsell
- optionally hide the Codex dictation microphone button
- mirror ChatGPT web custom instructions into the global personalization used by the Codex VS Code extension
- optionally require the Codex Web co-author trailer for web/GitHub-tool commits
- import a PGP secret key directly into GnuPG without persisting the private material in toolkit settings
- search repositories through the linked GitHub authentication session instead of maintaining a separate repo allow-list

The patch is intentionally narrow: it does not copy or manage unrelated editor settings.

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

## Install

On macOS, double-click **Sweetiebot Installer.app** to install without typing a Terminal command. The app includes its installer files, so you can move it to your Applications folder. Close and reopen your VS Code windows afterward. Once this version is installed, supported customizations are restored automatically after VS Code and extension updates.

On the first run, macOS may require you to allow **Sweetiebot Installer** in **System Settings → Privacy & Security → App Management**. The app offers an **Open Settings** button when access is blocked; grant access and double-click the app again.

To rebuild the app from this checkout:

```sh
python3 scripts/build_installer_app.py
```

The builder reuses the **Sweetiebot Installer Local Signing** certificate in your login Keychain. On another Mac, create a self-signed **Code Signing** certificate with that name using Keychain Access → Certificate Assistant → Create a Certificate, or select an existing signing identity with `--signing-identity` (also available as `SWEETIEBOT_SIGNING_IDENTITY`). Keep the same certificate and bundle identifier across rebuilds so macOS can recognize the app and retain its permission. The builder stops if the identity is missing or ambiguous instead of using ad hoc signing. Switching an existing app to this certificate may require granting App Management once more. Signing keys stay in Keychain and are never bundled with the installer.

Clone the repository and enter it:

```sh
git clone https://github.com/JFWooten4/custom-vscode-scm-toolkit.git
cd custom-vscode-scm-toolkit
```

Automatic repair checks the project's `main` branch for Sweetie Bot updates at startup and every hour. It downloads source files into an isolated cache, updates the companion extension and tools, and restores customizations using your saved settings. If the update check or installation fails, it repairs from the installed sources. It targets the running local macOS VS Code application (including custom install locations) and the selected Codex extension. No repository checkout or retained installer app is needed. A successful update or repair offers **Reload Window**; it never reloads your work automatically. Turn it off with **Automatically update and restore app customizations** in Sweetie Bot's Startup settings, or `scmToolkit.automaticAppRepair` in VS Code Settings.

Updates and repairs are serialized across windows. Routine repair skips companion-extension installation; a new toolkit revision updates it too. Unsupported builds fail guarded validation before patch writes. See **Output → Sweetie Bot app repair** for errors; macOS may require App Management permission for VS Code/Python. Remote sessions are skipped. New upstream layouts may still require a compatible Sweetie Bot release, which is fetched automatically once published to `main`.

The signed installer app includes the update bootstrap for first-time installation. Existing installations with this bootstrap update themselves; you do not need to retain or rerun the installer. Older installations need the bootstrap installed once.

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

## Configuration

Toolkit settings live in your global Git config under the `scm-toolkit` section. This keeps feature settings in the normal `~/.gitconfig` file and leaves room for new options later.

### Local web configurator

Run the configurator without installing anything:

```sh
python3 scripts/configure.py
```

It opens an app-like settings page in the default browser, prefilled with the current Git configuration. The page includes every toolkit switch plus the Ollama model choices and low-memory threshold. Changes save automatically to global Git config after you edit a setting, with an inline status showing whether the latest values were saved. A dedicated **Startup** section exposes **Open Sweetie Bot on startup**; when opened through VS Code, that checkbox also updates the real `scmToolkit.openPanelOnStartup` global user setting. The **Branch names** section lets you toggle individual packs, add custom names, and paste third-party packs as JSON. If Ollama is running on `127.0.0.1:11434`, locally installed models appear as suggestions; model tags can still be entered manually when it is offline. PGP secret-key import remains tied to the final action instead of autosaving private key material while it is being entered.

After installation, the gear at the right end of the Source Control message row opens the same local settings page directly. The companion extension starts the loopback configurator and opens it in VS Code’s native Integrated Browser in the current window. Clicking the gear again focuses the existing settings tab. This requires a VS Code version with the Integrated Browser; older versions show an update message. The repository checkout and manual URL entry are not required.

Every toolkit setting and companion-extension preference is available on this gear page. **Automatically publish new branches** controls the saved publishing preference; **Auto-publish toggle** controls whether the cloud icon appears. Publishing works even when the icon is hidden. The page loads the current VS Code preferences and saves publishing, startup, keep-awake, inline suggestions, post-commit actions, and search options to global user settings immediately. **Automatically pull clean branches** is also available independently of blank-state refresh.

With **Automatically pull clean branches** enabled, `main` fetches its tracked upstream once a minute through the extension host, even when the commit input row is hidden. It pulls only with a fast-forward and preserves nonconflicting staged and unstaged edits. Sweetiebot pauses these ref-moving pulls for the full lifetime of a VS Code commit so background syncing cannot advance `HEAD` between Git reading and updating the branch ref. Git refuses to pull when incoming files would overwrite local work; merge conflicts, divergent commits, changed branch tips or upstreams also pause pulling.

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
git config --global scm-toolkit.hide-outgoing-sync-count true
git config --global scm-toolkit.blank-state-refresh true
git config --global scm-toolkit.auto-pull-clean true
git config --global scm-toolkit.cmd-click-close-others false
git config --global scm-toolkit.browser-chatgpt-home true
git config --global scm-toolkit.graph-open-working-file true
git config --global scm-toolkit.ai-commit true
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
    hide-outgoing-sync-count = true
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

Random branch names are data-driven. Built-in packs live in `scripts/branch_name_packs.json`, and every pack uses the same small schema: The G4 pony roster is split into mares, stallions, fillies, colts, creatures, and a dedicated **G4 founders & Power Ponies** pack containing the six Equestrian founders, six Power Ponies, and Humdrum; background and minor ponies remain included.

```json
{
  "id": "friends",
  "label": "Friends",
  "description": "Optional human-readable description.",
  "names": ["name-one", "name-two"]
}
```

Pack IDs and names are lowercase branch-safe slugs containing letters, numbers, and hyphens. Built-in packs keep each branch-name slug unique across packs; shared characters use one canonical slug rather than duplicate entries. The G4 catalog also strips import-only role and episode descriptors (for example, `Knowledgeable ShopperRainbowshine` becomes `rainbowshine`) while retaining genuine multiword names such as `fleur-de-lis`. A pack may also include a `sources` object keyed by a name when a naming choice needs provenance. This keeps contributed lists as data instead of picker logic.

Built-in community packs also include a dedicated **Convention mascots** set and a **4chan /mlp/** set; the latter intentionally includes Anonfilly but excludes generic `anon`, `anonpony`, and Aryanne. Most packs, including **G4 founders & Power Ponies**, are enabled by default; **Pony Life**, **IDW comics**, and **G5 remaining** are opt-in and start disabled. Disabling a pack stores its ID in `scm-toolkit.branch-name-disabled-packs`. Custom names are stored in `scm-toolkit.branch-custom-names`. Third-party packs can be pasted into **Imported packs** as one pack object, an array of packs, or a `{"packs":[...]}` object and are stored in `scm-toolkit.branch-name-imports`.

### Workspace Search

The normal installer also installs a small companion VS Code extension into `~/.vscode/extensions`. By default, after reloading VS Code, Source Control contains a **Workspace Search** section with an in-sidebar query box, Hybrid/Semantic/Exact modes, ranked snippets, click-to-open results, and an optional **Ask Ollama** action. It does not open Open WebUI or a separate browser window.

Set `scm-toolkit.workspace-search-activity-bar` to `true` to move the same Workspace Search view into its own Activity Bar container. The panel title and container label use `scm-toolkit.workspace-search-label` and default to **EFS**. Rerun `python3 scripts/install.py` and reload VS Code after changing either setting.

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

When `ai-commit` is enabled, clicking VS Code's normal Commit button with a blank message summarizes the staged diff through the configured local Ollama model. On the configured `default-branch` (normally `main`), `ai-default-branch-description = true` asks the model for a subject plus one or two substantive sentences describing what changed and, when clear from the diff, its purpose or effect. Other branches keep the subject-only format. A manually entered message is never replaced by generated commit content or silently spellchecked. Use the explicit spelling-preview control when you want a correction reviewed first. Amend/fixup/squash/reuse-message mode, path-limited blank commits, or `--all` keep their existing behavior.

Sweetiebot treats GitHub's 100 MiB regular-repository file ceiling as the large-commit split target. When a blank automatic commit contains multiple staged files whose final Git blobs total more than 100 MiB, Sweetiebot splits them at file boundaries into smaller commits through temporary indexes, leaving the real staged index intact while the split runs. If one staged file itself exceeds 100 MiB, Sweetiebot does **not** change it automatically: VS Code shows a modal confirmation with **Split file**, **Git LFS docs**, and **Cancel**. Only after **Split file** is chosen does Sweetiebot replace the oversized working-tree file with numbered `.part001`, `.part002`, … files of at most 95 MiB and stage that replacement. It refuses the automatic file split when the file has unstaged changes or when a target part already exists, and restores the original if splitting or staging fails. GitHub's softer diff-view ceilings (20,000 lines or 1 MB total raw diff, 20,000 lines or 500 KB for one file, 300 files, and 25 renderable files) produce a VS Code warning with a clickable **Commit anyway** bypass instead of forcing a split. Files over 50 MiB also receive GitHub's large-file warning with the same bypass. Existing legacy `~/.local/bin/git-auto-title` installations are refreshed alongside `scm-toolkit-git`, so older VS Code configurations receive the current binary-safe Git output handling.

**Ollama is required for this feature.** Run a local Ollama server and install the models you select before relying on AI-generated subjects. The wrapper talks only to Ollama on `127.0.0.1:11434`, bypasses proxy settings for that local request, and checks the local model inventory before generation. If the selected model or Ollama is unavailable, it uses a deterministic fallback subject.

Both normal and Codex-context generation read the `Commit titles should …` preference directly from `~/.codex/AGENTS.md` on each request (`SCM_TOOLKIT_CODEX_HOME` can override that directory). Other global instructions stay excluded by default. Enable **Sync AI commits with Codex instructions** on the Sweetiebot settings page, or set `scm-toolkit.ai-commit-custom-instructions = true`, to reread the rest of that global custom-instructions file for every generated commit. Synced instructions may shape commit wording and style, but staged changes remain authoritative and the generator still refuses instruction-driven trailers, metadata, or output-format changes.

Without a dedicated title preference, titles default to one professional emoji followed by a concise imperative title; fallback subjects also include an emoji. Recent repository subjects supply style examples only. Sync titles are excluded from those examples and rejected from generated output, regardless of diff size or file count. Only the dedicated Sync button supplies the branch-sync message.

### Concurrent PDF OCR and commit generation

On macOS, install a dedicated local commit worker so long PDF OCR jobs on port 11434 do not occupy the commit worker's queue:

```sh
python3 scripts/ollama_concurrency.py
```

This starts a login LaunchAgent on `127.0.0.1:11435`, shares the existing models in `~/.ollama/models`, and sets `scm-toolkit.ai-ollama-url` after the worker is ready. It leaves the existing Ollama service and active OCR jobs running. Each worker processes one request at a time; different workers can run concurrently when both models fit in memory. The commit worker uses a 4096-token default context and quantized context cache to limit memory use. The API setting `SCM_TOOLKIT_AI_OLLAMA_URL` overrides the Git endpoint setting; only local HTTP endpoints are accepted.

Remove the dedicated worker and restore the default commit endpoint with `python3 scripts/ollama_concurrency.py --uninstall`. Installing the normal VS Code toolkit alone does not change Ollama services.

The wrapper supports two independently configurable models:

- `ai-commit-model` is the normal/default model
- `ai-commit-low-memory-model` is used when macOS reports less available memory than `ai-low-memory-gib`

The low-memory path never escalates to the larger primary model when the fallback is missing. During normal-memory operation, the smaller model may be used if the primary model is not installed.

### Manual commit spellcheck preview

The Source Control message controls include a checkmark action for **Preview spelling correction**.
It sends only the current subject line to the configured local Ollama model and never changes the
message until you approve the suggestion. If the suggestion differs, Sweetiebot shows the original
and corrected subjects in a modal with **Apply correction** and **Keep original**.

The model must return a structured `{"subject":"..."}` response. Sweetiebot rejects malformed
output, added or removed words, changed punctuation/emoji structure, and unrelated rewrites before
the preview is shown. Commit bodies are left byte-for-byte in place. Codex-attributed messages are
excluded from the manual spellcheck path, and blank-message AI generation never enters it.

The former `scm-toolkit.spellcheck-manual-commit` automatic rewrite setting is no longer used, so
an older global Git value cannot silently mutate a manually entered commit subject.

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

### Codex composer appearance

Enable **Hide access label** in the configurator's **Codex** section to show only
the permission icon instead of text such as **Full access**. It defaults to off
and preserves the access menu and the current mode for screen readers. The Git
setting is `scm-toolkit.codex-hide-access-label`.

The send button and composer labels have separate color controls in the local
configurator's **Codex** section. Set `scm-toolkit.codex-send-background` for the
button background, `scm-toolkit.codex-send-foreground` for its icon, and
`scm-toolkit.codex-composer-label-color` for the **Full access**, **Work locally**,
and **+** add-context controls. Use a hexadecimal color such as Studio green `#43AF49`; blank values
restore the theme. All three settings default to blank.

Run `python3 scripts/install.py` after changing them and reopen the VS Code window.
These overrides apply only to the Codex composer controls, independently of
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
and run **Sweetiebot Installer.app** from this checkout. The companion Workspace
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
promotional cards such as the `Enable Fast mode` / `Enable now` upsell. The
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
conversation date/time separators such as `Today 6:44 PM`. The filter only hides
small separator containers whose entire text looks like a date/time label; message
content, buttons, links, inputs, and other chat UI remain untouched.

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
roughly 1.5-second refreshes while VS Code is visible. The polling stops as soon
as SCM reports a change and automatically resumes after the repository becomes
clean again. Hidden windows back off instead of polling at the foreground rate.

This uses VS Code's existing `git.refresh` command; the toolkit does not run its
own Git status implementation. The SCM progress bar stays hidden, including during
background Git fetches, so updates do not flash a distracting animation.

When `auto-pull-clean` is enabled, the toolkit checks the current branch against its
tracked upstream on the same polling schedule, even when `blank-state-refresh` is
disabled. Disabling blank-state refresh skips the extra `git.refresh` calls while
automatic pulling continues. The toolkit pulls only when the working tree is
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

### Integrated Browser ChatGPT home

When `browser-chatgpt-home` is enabled, a blank Integrated Browser tab starts at
`https://chatgpt.com/`. Explicit URLs continue to win, so commands and extensions
that open a specific page are unchanged. The toggle is applied by the installer,
so rerun `python3 scripts/install.py` and reload VS Code after changing it.

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
It appends this trailer to the current message and then runs VS Code's normal
`git.commit` command:

```text
Co-authored-by: Codex <noreply@openai.com>
```

The trailer is added after a blank line and is not duplicated if it is already
present. If the commit fails and VS Code leaves the message untouched, the toolkit
restores the original message.

### ChatGPT project context for GitHub PR actions

In Sweetie Bot settings → **GitHub**, set **ChatGPT project for PR actions** to a project address such as `https://chatgpt.com/g/g-p-6ac73804b6b081918ef8d1f0c88d4ba0/project`. You can also use VS Code's `scmToolkit.chatgptProjectUrl` setting (including a workspace override), or `git config --global scm-toolkit.chatgpt-project-url "https://chatgpt.com/g/g-p-.../project"` followed by syncing settings through the configurator. An empty value retains normal ChatGPT chats. This affects **PR drafting** and **Squash Selected Pull Requests with ChatGPT**; the direct GitHub CLI quick-merge button does not open a chat and is unchanged.

Sweetie Bot appends the prepared prompt as the URL's `q` parameter within the chosen project. ChatGPT's project-scoped `q` behavior is not a documented API, so verify the draft appears in the project composer before submitting; if it does not, paste the prepared prompt manually. The project must already be accessible to the signed-in ChatGPT account. Project instructions and files are supplied by ChatGPT, not by Sweetie Bot.

### Pull requests through Kafania

The pull-request button immediately left of the new-branch button opens ChatGPT in VS Code's Integrated Browser with the selected branch, GitHub repository, and base branch. Sweetiebot no longer owns the long drafting prompt: it reads `PULL_REQUEST.md` from a sibling `kefania` checkout and includes those canonical rules in the request.

The request directs ChatGPT to publish through the configured Kafania MCP server and tool (by default `codex-drafter` / `github_create_pull_request`). If that Kafania tool is unavailable, the prompt asks ChatGPT not to substitute another GitHub writer.

When the Integrated Browser is already showing a private ChatGPT conversation, Sweetiebot records its `/c/<uuid>` URL as the source. Otherwise it asks the patched Codex extension for the active local conversation UUID and a read-only context snapshot. The Codex UUID is linked through a Sweetiebot VS Code deep link so the author can reopen the local session even though it is not public.

That source metadata is passed to Kafania. Kafania formats it as a separate pull-request comment and can include a short conversation-intent summary, which is intentionally distinct from the diff-based PR description. Source UUIDs are never invented when neither ChatGPT nor Codex exposes one.

The two repositories are expected to be checked out beside each other so Sweetiebot can read `../kefania/PULL_REQUEST.md`. Opening the drafting chat does not stage, commit, or push local changes.

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
and configured-remote branch names are excluded before the random choice.

Disable the button without changing the rest of the toolkit:

```sh
git config --global scm-toolkit.pony-branch false
```

### Branch cleanup

When `branch-cleanup` is enabled, the trash control appears for local branches other than the configured `default-branch`.

Before deletion, the control:

1. fetches with prune
2. verifies that the current branch no longer exists under `refs/remotes/<remote>/`
3. refuses to delete if the configured remote cannot be verified
4. checks out and syncs the configured default branch
5. deletes the old local branch without forcing, stopping if Git rejects deletion

This does not delete the remote branch.

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

Sweetiebot checks open local repositories when VS Code starts and every ten minutes. It looks up merged PRs for each outstanding local branch on `origin`, including older PRs outside the repository's recent history. It uses authenticated `gh` to verify that a same-repository PR merged into the default branch. A local branch is removed only if its tip still equals the recorded PR head and no PR for that branch is open. If the merged branch is active, Sweetiebot switches to the local default branch (normally `main`) before removing it, provided there are no uncommitted changes or Git operations in progress. Branches checked out in other worktrees are preserved. Git removes the reference with the expected SHA, preserving a branch that moves during cleanup. Closing a PR without merging leaves its local branch alone. Remote branches are left to GitHub’s repository setting.

Preview one repository without deleting branches:

```sh
python3 scripts/prune_merged_branches.py --repo /path/to/repository --force --dry-run
```

The installer also applies reversible fixes to supported GitHub Pull Requests extension builds. It suppresses the automatic cleanup prompt when the repository already deletes branches on merge, while retaining the manual Delete Branch action and explicitly configured native automatic deletion. The PR-number link keeps its existing click handler as its sole opening path. Rerun the installer after updating that extension; unsupported assets are skipped with a warning.

The GitHub Pull Requests list refreshes when it becomes visible or the window regains focus, then every 5 seconds while active. Hover over a PR to use **Squash and Merge into main** without opening its description. The button uses the authenticated GitHub CLI, verifies that the PR is open, ready for review, and targets `main`, and merges only the freshly fetched head commit. GitHub branch protections remain in effect. After a completed merge, guarded cleanup returns an eligible clean local PR branch to the default branch and removes it; dirty worktrees and changed local heads are preserved. Queued merges wait for completion before cleanup. Both features can be toggled in the gear page using `pull-request-auto-refresh` and `pull-request-quick-merge`.


Automatic staged commits remove trailing spaces and tabs from added or changed text lines and normalize the final newline. Existing untouched lines, LF/CRLF style, file modes, cached attribute exclusions, and unstaged edits are preserved. Explicit-message commits keep their existing behavior.

### Post-commit Markdown spellcheck

Enable **Post-commit Markdown spellcheck** in SweetieBot settings under Ollama, or run:

```sh
git config --global scm-toolkit.post-commit-spellcheck true
```

This toggle is off by default. After a successful automatic staged commit, the local Ollama model reviews changed Markdown prose and proposes conservative spelling, grammar, and ASCII punctuation corrections. Fenced code, inline code, URLs, Markdown prefixes, and line endings are protected. Unavailable models and unchanged text produce no dialog.

Proposals appear as unstaged edits in Source Control. Choose **Keep edits** to review them or **Discard** to remove untouched proposals. The original commit and index remain unchanged. The job skips repositories with local work or new staged changes, a changed HEAD, and corrections to files edited while it runs. Explicit-message commits retain their existing behavior.
