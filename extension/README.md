# Sweetiebot companion extension

The `extension/` directory contains Sweetiebot's VS Code companion extension. It powers Source Control actions, Git worktrees, commit flows, GitHub integration, merge dashboards, Codex handoffs, and workspace search.

## Feature modules

| Directory | Responsibility |
| --- | --- |
| `search/` | Workspace Search indexing, extraction, search UI, and Ollama helpers |
| `branches/` | Branches, worktrees, workspace state, cleanup, and sync |
| `commits/` | Commit flows, publishing, limits, and spellchecking |
| `github/` | GitHub API, pull request discovery, drafting, and sessions |
| `merge/` | Merge dashboards, Lindsey integration, review, and conflict resolution |
| `codex/` | Codex, Kefania, ChatGPT handoffs, and pony metadata |
| `ui/` | Shared UI helpers, draft confirmation, notifications, and runtime utilities |

`package.json` remains at the root. Its entry point, `trust_activation.js`, gates startup on VS Code workspace trust and then activates `extension.js`. The `media/` paths and third-party notices also remain rooted here. The SVG files in `media/` are development mirrors of `assets/imgs/` artwork; installed icons are synchronized from those shared assets to preserve VS Code's stable `media/` icon paths.

The installer uses `scripts/workspace_search.py` to **recursively package** these directories. Runtime Python helpers are installed at the extension root, whereas development-time fallback helpers live in `scripts/` at the repository root. Modules using `__dirname` must account for both layouts, and cross-directory imports must be relative to their own module directory.

Run the tests described in the repository README after changing module paths or packaging logic. Avoid introducing additional root-level feature modules without a compatibility reason.
