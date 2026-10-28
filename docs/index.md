# Sweetiebot documentation

The [root README](../README.md) provides a short overview. These guides document the current source tree, its user-visible workflows, limits, and safe recovery. Documentation filenames use **lowercase kebab-case**.

| Guide | Coverage |
| --- | --- |
| [Functionality audit](functionality-audit.md) | Evidence for implemented features, regressions, limitations, manual test plan |
| [Installation and repair](installation-and-repair.md) | macOS requirements, installer, update/repair, Workspace Trust |
| [Settings reference](settings-reference.md) | Magic Settings, persistence and important defaults |
| [Commits and spellchecking](commits-and-spellcheck.md) | AI messages, co-authors, durable background jobs, spellcheck paths |
| [Branches and worktrees](branches-and-worktrees.md) | Branch picker, linked worktrees, stacks, sync and cleanup |
| [Pull requests and merges](pull-requests-and-merges.md) | Kefania, Lindsey, guarded PR publication and merges |
| [Workspace Search / EFS](workspace-search.md) | Exact/semantic/hybrid indexing, limits and privacy |
| [Codex and interface](codex-and-interface.md) | Composer, Integrated Browser and workbench customizations |
| [Troubleshooting](troubleshooting.md) | Diagnostics and non-destructive first steps |
| [Development and testing](development-and-testing.md) | Source map, CI inventory and documentation standards |

Specialized guides: [AI review thread replies](ai-review-reply.md) and [distinct GitHub App identities](distinct-github-apps.md).

**Status:** Documentation describes features present in the audited revision, not unmerged proposals. Some functionality is opt-in or depends on Ollama, `gh`, separate local runners, GitHub permissions, supported VS Code/Codex patch anchors or macOS integration. A source file or test file is not proof of a passing live execution. Prefer current Magic Settings for effective configuration.
