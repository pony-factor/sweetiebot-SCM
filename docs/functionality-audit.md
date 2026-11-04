# Comprehensive functionality audit

**Audited baseline:** [`main` at 4515636](https://github.com/pony-factor/sweetiebot-SCM/commit/45156363d259a007a6d20258c4f08f53a109004a) (2026-10-26). Examined the [README](../README.md), [extension manifest](../extension/package.json), [activation code](../extension/extension.js), major source modules, the [CI test inventory](../scripts/ci/ci-test-groups.json), and the [workflow](../.github/workflows/check.yml). This is a **source-and-documentation audit**, not an executed macOS end-to-end certification.

## Feature and regression inventory

| Surface / behavior | Source evidence | Test evidence | Constraints / guide |
| --- | --- | --- | --- |
| macOS app patching, installer and automatic repair | [install](../scripts/install.py), [repair](../scripts/repair.py), [update](../scripts/update.py) | [install test](../tests/install.py), [repair test](../tests/repair.py) | Supported app anchors and macOS permissions; [guide](installation-and-repair.md) |
| Magic Settings, Git/VS Code persistence, Source Control message bar | [configurator](../scripts/configurator.py), [manifest](../extension/package.json), [message bar](../scripts/message-bar.py) | [settings tests](../tests/settings-browser.js), [message bar tests](../tests/message-bar.py) | Live UI is source of effective values; [guide](settings-reference.md) |
| AI/local commits, limits, attribution, signing/hook boundaries | [AI wrapper](../scripts/ai-commit.py), [commit limits](../extension/commits/limits.js), [attribution](../extension/codex/attribution.js) | [AI tests](../tests/ai-commit.py), [attribution tests](../tests/codex-attribution.js) | Ollama optional, Git safeguards remain; [guide](commits-and-spellcheck.md) |
| Durable background commit/finalization, push recovery, timed Codex auto-commit | [worker](../scripts/background-commit.py), [bridge](../extension/commits/background-commit.js), [auto-commit](../extension/commits/auto-codex-commit.js), [recovery](../extension/commits/push-recovery.js) | [background test](../tests/background-commit.py), [auto-commit test](../tests/auto-codex-commit.js), [recovery test](../tests/push-recovery.js) | **Opt-in** and distinct from direct commit; [guide](commits-and-spellcheck.md) |
| Draft, filename, post-commit Markdown and manual spellcheck | [preview](../extension/commits/spellcheck-preview.js), [filenames](../extension/commits/filename-spellcheck.js), [post-commit](../scripts/post-commit-spellcheck.py), [native bridge](../extension/commits/native-spellcheck-bridge.js) | [preview tests](../tests/spellcheck-preview.js), [Markdown test](../tests/post-commit-spellcheck.py) | Independent modes and per-repo gate; [guide](commits-and-spellcheck.md) |
| Branch names, branch picker, shared main, linked worktrees, stacks | [branch actions](../extension/branches/actions.js), [names](../scripts/branch-names.py), [shared main](../extension/branches/shared-main.js), [stack](../extension/branches/stacked-branch.js) | [branch test](../tests/branch-actions.js), [main test](../tests/shared-main.js), [stack test](../tests/stacked-branch.js) | Worktree exclusivity and optional `gh-stack`; [guide](branches-and-worktrees.md) |
| Auto-pull, eligible main sync and workspace/branch cleanup | [branch actions](../extension/branches/actions.js), [sync](../scripts/cloud-repo-sync.py), [workspace cleanup](../extension/branches/workspace-prune.js) | [main sync test](../tests/main-sync.js), [prune test](../tests/workspace-prune.js) | Clean/verified work only, no blind deletion; [guide](branches-and-worktrees.md) |
| Kefania PR drafting, publication handoff, pony profile side flow | [PR flow](../extension/github/pull-request.js), [Kefania runner](../extension/codex/kefania-runner.js), [pony profile](../extension/codex/pony-profile.js) | [PR test](../tests/pull-request.js), [profile test](../tests/pony-profile.js) | Authenticated separate local runner; [guide](pull-requests-and-merges.md) |
| Lindsey dashboard, grouped merge, conflict/check repair, attribution | [dashboard](../extension/merge/dashboard.js), [batch](../extension/merge/batch.js), [resolution](../extension/merge/resolution.js), [attribution](../extension/merge/squash-attribution.js) | [dashboard test](../tests/merge-dashboard.js), [batch test](../tests/merge-batch.js), [resolution test](../tests/merge-resolution.js) | Reverify head/base and passing checks; [guide](pull-requests-and-merges.md) |
| GitHub App separation, read-only Lindsey API and guarded AI review replies | [identity](../extension/github/app-identity.js), [read API](../extension/github/read-api.js), [review reply](../extension/codex/ai-review-reply.js) | [identity test](../tests/github-app-identity.js), [read API test](../tests/github-read-api.js), [review test](../tests/ai-review-reply.js) | Legacy default, credentials external; [App guide](distinct-github-apps.md), [review guide](ai-review-reply.md) |
| Local search, text extraction, indexing and user interface | [index](../extension/search/index.js), [extraction](../extension/search/extract.js), [view](../extension/search/view.js), [Python search](../scripts/workspace-search.py) | [index test](../tests/workspace-search-index.js), [view test](../tests/workspace-search-view.js) | Semantic search needs local embeddings; [guide](workspace-search.md) |
| Codex composer, usage, attachments, workbench picker and browser patches | [Codex assets](../assets/codex/), [workbench assets](../assets/workbench/), [installer](../scripts/install.py) | [queue test](../tests/codex-queued-edit.js), [browser test](../tests/codex-webview-browser.py) | Version-specific DOM/patch support; [guide](codex-and-interface.md) |

**Interpretation:** source and relevant test files exist; **no test results are asserted**. There are additional unit tests beyond those linked above. The CI workflow's group inventory is the authoritative complete mapping.

## Gaps and corrections addressed

1. The former docs directory held only two uppercase-named guides. Both were preserved under lowercase names; a new documentation index and topic guides cover the other major feature families.
2. README references now target lowercase paths. Guides cross-link to source and tests.
3. Separate **30-second auto Codex commits** (off), **durable background commits** (off), **15-minute background clean-main sync** (off), and **automatic PR publication of completed drafts** (manifest default on). They do different things.
4. Repository `sweetiebot.postCommitSpellcheck=true` is a **repository-level allowance**, not global activation of the post-commit Markdown feature.
5. PR draft, publication, bulk request, merge verification, user identity, and bot identity are separate states and trust boundaries.
6. The previous GitHub App guide incorrectly implied `scripts/bulk-merge.js` was in this repo. Sweetiebot uses `extension/lindsey-bulk-merge.js` to find that script **in an external Lindsey checkout**.
7. Documented that compatibility guards may skip unsupported VS Code/Codex patches and that a visual success notification is not proof of a Git/PR write.

## Manual end-to-end audit checklist

Run on a supported macOS machine in disposable branches/repos where changes will be published:

- [ ] Installer: `python3 scripts/install.py --check`, install, reload, update, and review **Output → Sweetie Bot app repair**.
- [ ] Settings: change, persist, and reset a harmless toggle; verify repository-level Markdown opt-out independently of global Spellcheck Changes.
- [ ] Commits: stage a known diff; check blank AI vs explicit title, commit authorship, co-author trailer, hooks and size check. On a disposable branch test durable finalization and avoid editing pending placeholder history.
- [ ] Branches: create a managed worktree, inspect `git worktree list --porcelain`, test an already-active branch, dirty worktree protection, and stack parent selection.
- [ ] Sync: test eligible clean fast-forward and divergent/dirty skip; inspect logs. Never override local edits to make a test pass.
- [ ] PR: draft without publishing, publish with real authorization, verify opener/head/base and parent stack; test non-`main` base and required checks.
- [ ] AI review: apply a single change to the reviewed file, push, confirm the exact inline thread receives one substantiated reply; verify unrelated changes cannot trigger resolution.
- [ ] Search: try exact/hybrid/semantic with and without Ollama; test an excluded file, index clear and reindex.
- [ ] UI: test workbench/Codex controls after an app update and confirm incompatible anchors are safely rejected.
- [ ] CI: run inventory verification and relevant suites, then inspect the live PR-head checks.

## Limitations and residual review items

The inspected source cannot establish a particular user's credentials, Ollama health, supported macOS app build, running GUI behavior, external Kefania/Lindsey deployment, CI status on a future branch, or protected-branch acceptance. These require the manual checks above. This PR changes **documentation only**; it does not repair bugs or certify tests. Revisit this matrix whenever source, settings, or CI assignments change.
