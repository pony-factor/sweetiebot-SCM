# Settings reference

Open **Source Control → gear at the right of the commit message** for **Sweetiebot Settings / Magic Settings**. Changes auto-save. `python3 scripts/configure.py` can open the configurator from a checkout. Git-backed preferences are under `scm-toolkit.*` in `~/.gitconfig`; VS Code settings use `sweetiebot.*`, sometimes with resource-level overrides. The [manifest](../extension/package.json), [configurator](../scripts/configurator.py), and [settings store](../scripts/toolkit-settings.py) define current options.

| Section | What it changes |
| --- | --- |
| Message bar, Source control | Commit buttons/hotkeys, push toggle, branch strip, sync counts/arrows, labels, whitespace |
| Ollama | Commit-title models, budgets, low-memory options, direct/background workflows |
| Spellcheck Changes | Draft-title suggestions, filename proposals, post-commit Markdown, manual Spellcheck Only |
| Branch names, Workspaces | Name packs, worktree windows, cleanup, stack selection, trust |
| Search | EFS index scope, mode, model, limits, exclusions and Ask Ollama |
| Pull requests, Kefania, Lindsey, GitHub | Drafts, publication, dashboard, auto-refresh, checks, rate-limit handling, App identities |
| Codex, Browser, Window, Initialization | UI injection and labels, composer options, wake behavior, repair/reload |

## Sidebar navigation

Magic Settings organizes its existing pages under **Source Control & Commits**, **Branches & Workspaces**, **AI & Spellcheck**, **GitHub & Pull Requests**, **Interface & Customization**, and **System & Diagnostics**. Group headings do not change settings or saved preferences. Individual pages remain keyboard navigable, with scrolling and a responsive layout for smaller windows.

## Key manifest defaults (not current saved user values)

| Setting | Default | Meaning |
| --- | --- | --- |
| `sweetiebot.autoCommitWithCodex` | `false` | Optional 30-second local co-authored commits, **never auto-push** |
| `sweetiebot.durableBackgroundCommits` | `false` | Temporary title, ordered finalization, guarded push |
| `scm-toolkit.placeholder-prefix` | `hoof_` | Custom prefix for temporary background commit titles; configure in the Source control settings panel. |
| `scm-toolkit.graph-prefer-open-commit` | `false` | Switch the built-in Source Control Graph's inline action from Open Changes to Open Commit, displaying native commit metadata; right-click Open Changes remains available |
| `sweetiebot.cloudRepositorySync` | `false` | 15-minute clean-main sync |
| `sweetiebot.gitGraphRelativeDates` | `false` | Enforce `git-graph.date.format = Relative` for the separate Git Graph extension; disabling stops enforcement without reverting the format |
| `sweetiebot.automaticBranchCleanup` | `true` | Eligible merged branch cleanup |
| `sweetiebot.automaticWorkspaceCleanup` | `true` | Guarded managed workspace/worktree pruning |
| `sweetiebot.autoPublishNewBranches` | `false` | Publish newly selected branches |
| `sweetiebot.autoPublishPullRequests` | `true` | Publish *completed eligible* Kefania drafts |
| `sweetiebot.kefaniaAutoShareCodexChat` | `false` | Opt in to making a public snapshot of the active Codex chat when clicking Kefania |
| `sweetiebot.postCommitSpellcheck` | `true` | Permit a globally enabled post-commit spellcheck in this repo |
| `sweetiebot.workspaceSearch.mode` | `hybrid` | Blend text and semantic ranking |
| `sweetiebot.workspaceSearch.embeddingModel` | `qwen3-embedding:0.6b` | Local embedding model name |
| `sweetiebot.workspaceSearch.autoReindex` | `true` | Reindex approximately every 2 minutes |
| `sweetiebot.workspaceSearch.maxFiles` | `5000` | Index candidate-file limit |
| `sweetiebot.workspaceSearch.maxFileSizeMB` | `10` | Maximum direct file indexing size |
| `sweetiebot.workspaceSearch.resultLimit` | `100` | Result passage limit |
| `sweetiebot.workspaceSearch.askOllama` | `false` | Optional chat action; chat model required |
| `sweetiebot.pullRequestQuickMerge` | `true` | Show guarded squash action |
| `sweetiebot.automaticAppRepair` | `true` | Restore compatible patches |
| `sweetiebot.codexKeepAwake` | `true` | Hold macOS awake while Codex works |
| `scm-toolkit.codex-continue-at-reset` | `false` | Drag **Resume at reset** from SCM Settings → Message bar → Available buttons into either message-bar row. The live checkbox is compact, with its explanatory wording in a tooltip |

**Kefania chat privacy:** In Magic Settings → Kefania, **Publicly share Codex chat when launching Kefania** is off by default. When enabled, clicking Kefania uses native Share on whichever Codex conversation is active, publicly exposing a snapshot of prompts and AI replies to anyone with the link; the link is also included in the PR's final expandable Source details block. Sweetiebot cannot unpublish or revoke a shared chat, so treat the action as permanent. This preference governs public links, not the separate transmission of captured conversation text to the AI preparing the PR draft.

The retired `scm-toolkit.ai-commit-async` Git setting is ignored. Use `sweetiebot.durableBackgroundCommits` for background finalization, including commit-only actions; it does not require automatic pushing. Pending legacy commits retain recovery protection.

The repo-level `sweetiebot.postCommitSpellcheck` **does not turn the global spellcheck feature on**. To exclude one project from post-commit Markdown changes only, add to that project's `.vscode/settings.json`:

```json
{ "sweetiebot.postCommitSpellcheck": false }
```

Use the live settings page for remaining settings and effective values; a manual edit may require app repair/reload before a patched control updates.
