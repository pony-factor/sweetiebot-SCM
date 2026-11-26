# Branches and managed worktrees

Sweetiebot's topic workspaces are **linked Git worktrees** sharing one repository history, not independent clones. The managed parent is:

```text
~/Library/Application Support/Sweetiebot/Workspaces/
```

The branch selector can be a horizontal popup or native picker. **Branch names** settings manage built-in packs, imported/custom names and disabled lists. Each worktree owns its own working directory/index and ordinarily can check out a branch only once. Home and the branch selector reuse the current VS Code window, including when the destination worktree is open in another window. Saved workspaces replace their repository folder in place, preserving the workspace identity and Codex chat handoff. Each worktree keeps its staged and unstaged changes.

**Open a Window on Shared Main** provides a managed main window. The ordinary new-branch action starts at the resolved default branch where possible; the **stacked branch** action starts at the current topic branch. If GitHub metadata or remote synchronization times out, New Branch can use an existing, verified local default-branch commit without changing or publishing main. It warns that the remote may be newer; missing local commits, authentication errors, and merge conflicts remain blocking failures. Optional `gh-stack` manages native stacks. Creating a stacked branch is not publishing a PR; verify parent/base relationships before merging.

If the original repository folder is on a topic branch and `main` is already checked out in a linked worktree, Home and **Open a Window on Shared Main** use that existing `main` worktree.

Unsent Codex new-chat text and attachments belong to the saved window and Git branch. Separate windows on the same main checkout have independent drafts. Reloading restores that window's draft; switching branches selects that branch's slot. Delayed updates from the previous branch cannot populate the new one.

An explicit checkout handoff transfers the captured draft once and retires the matching source copy after saving the destination. Retrying a handoff cannot restore text or attachments already sent, and an existing destination draft is preserved. Older checkout-wide caches remain stored but do not automatically seed new windows.

**New Branch** moves staged, unstaged, partially staged, and untracked changes into the new worktree, preserving the index even when no Codex chat is open. It verifies the copied changes before cleaning the source. A `.sweetiebot-handoff-backup` directory beside the destination repository retains the original index/worktree patches and untracked files for recovery. Switching to an existing branch leaves each worktree's pending edits in place.

## Prepared branch worktrees

Trusted local repositories prepare up to three detached checkouts at their local default-branch tip while VS Code is open. These checkouts share the Git object database; they are not remote clones, temporary named branches, or new GitHub refs. A clean standby advances incrementally as local main advances. When New Branch requests exactly that commit, Sweetiebot atomically reserves and moves the checkout into the normal branch-named directory. It still saves editor changes, backs up pending files, verifies their transfer, and preserves the existing Codex handoff. Pending-title forks, unavailable, stale or contaminated slots, and stacked adoption continue through their established paths.

The existing background pull and a fetch-only topic-base refresh can establish a recent fetch receipt. New Branch skips a foreground synchronization only if the configured remote and both base refs still match that receipt, which expires after one minute. Missing, outdated, ahead, behind or divergent refs use the ordinary synchronization and offline handling. This intentionally permits a remote change during that freshness window; it is not a guarantee of the latest remote tip at click time.

Settings (VS Code Settings, search for Sweetiebot):

- `sweetiebot.prewarmBranchWorktrees`: on by default.
- `sweetiebot.preparedWorktreesPerRepository`: 3 by default, 1–6.
- `sweetiebot.replenishPreparedWorktrees`: on by default; refill and refresh on the background scan.
- `sweetiebot.preparedWorktreeIdleMinutes`: 30 by default, 5–1440. Reclaim verified clean, reachable detached slots while an extension host is running.

Standby directories are internal, not development workspaces. Do not edit or open them directly. Unexpected files, unreachable detached commits, failed or interrupted operations are conservatively preserved rather than forcibly removed; they may reduce the number of available slots until inspected. No dependency installation or checkout hooks run during standby preparation, although normal Git checkout filters still apply. Only the final branch adoption runs the normal checkout hook.

Open **Output → Sweetiebot Branch Performance** for base synchronization, standby preparation/adoption, pending-edit transfer and workspace handoff timings. A workspace handoff request is not the same as completion of VS Code reload or Codex startup; actual perceived performance must be measured locally.

## Launch development environments

Use the play icon in Source Control or **Sweetiebot: Launch Development Environment** to run the selected local checkout. The first launch asks you to choose a preset and configure it; subsequent launches can reuse or edit the preset. Saved configurations live in Sweetiebot's local extension state, keyed by the origin remote (or checkout path when there is no origin), not in repository files.

- **Isolated Brave extension** (macOS, extension manifest at the checkout root): opens the selected checkout as an unpacked extension in a persistent checkout-specific browser profile. Sign in separately by default, or choose **Copy normal Brave cookies** to seed fresh checkout profiles. Every seed requires explicit confirmation; a local Python 3 SQLite snapshot preserves the encrypted cookie store without reading or displaying cookie values. Existing test cookies and extension settings are never overwritten. The copy can expose authenticated sessions to the test extension according to its permissions; enable it only for trusted code. Authentication may still require manual sign-in. Close the test browser manually and reload its extension after edits.
- **Localhost server**: enter an executable and arguments as a JSON array, e.g. `["npm","run","dev"]`, and the local HTTP(S) URL. The task runs in the checkout and opens the URL only after it responds while the task is active. An already responding URL is rejected before launch. Canceling the readiness wait leaves the task running. Choose the external browser or the native VS Code Integrated Browser with its existing persistent global/workspace browser session. No cross-application cookie transfer or storage preference changes are performed.
- **Custom process**: run an explicit executable and arguments in a VS Code task terminal. Package scripts named `dev` or `start` are suggested, not executed automatically.

Click the play icon again to manage a running task, stop it, or restart it. Install project dependencies yourself. Only trusted local workspaces are supported; there is no automatic execution during checkout or startup.

## Source Control Graph in worktree windows

VS Code's built-in Source Control Graph can initially appear empty while Git discovers a newly opened linked worktree. Sweetiebot requests a bounded status refresh after discovery and follows up once for linked worktrees or missing HEAD metadata. This does not fetch, check out, or modify any branch.

If the graph is still blank, check the graph's repository selector and select the active worktree rather than an unrelated checkout. VS Code does not always follow the selected worktree automatically; see [the upstream graph selection issue](https://github.com/microsoft/vscode/issues/262880). In windows listing several worktrees, VS Code's single-repository Source Control mode can also make the active checkout clearer. A valid linked worktree shares the main repository's Git history, so an empty graph does not mean its commits have been deleted.

## Isolated experiments

Use **Open Experimental Workspace** (the beaker button in Source Control) to create a separate clone of the current branch on a random `trial-<hex>` branch under `/var/tmp/Sweetiebot/<repo>/<branch>-<color>/<repo>`. VS Code opens the experiment in a new window. The original Codex chat stays in its window with its drafts, attachments, and queued messages. The source repository, staged/index state, worktree, and branch remain unchanged. This clone includes tracked staged/unstaged modifications and non-ignored untracked regular files, but not Git-ignored build outputs. Conflicted indexes, unsafe untracked symlinks and special files fail closed rather than silently creating an incomplete experiment.

Add `/var/tmp/Sweetiebot` (macOS may display `/private/var/tmp/Sweetiebot`) to **Manage Workspace Trust** once; trust is controlled by VS Code, never bypassed by Sweetiebot. The parent directory is created with private owner-only permissions. An existing unsafe or symlinked parent is rejected.

After the trial window opens, Sweetiebot sends the original chat a notice containing the trial path and instructions to use it for experiments. An active turn receives the notice immediately through native steering; its queued messages stay in place. An idle chat receives a new turn. The chat's working directory is not rebound. Snapshot verification cancels creation if the source changes while copying. If no Codex chat is open, the experimental workspace still opens. If opening fails, Sweetiebot removes its incomplete clone. If only notification fails, the trial stays open and a warning includes its path. Experiments are not registered for automatic managed-worktree pruning; review and remove them manually when no longer needed.

## Sync and cleanup

**Automatically pull clean branches** uses guarded fast-forward behavior and does not silently merge divergent histories. The distinct `sweetiebot.cloudRepositorySync=false` option schedules eligible clean-main checkouts every 15 minutes via macOS; it skips dirty/divergent work. `sweetiebot.autoPublishNewBranches=false` controls publishing newly created branches, not PR creation. Contributor PR inspection branches (`pr/<contributor>/<number>`) remain local even when automatic publication is enabled; explicit manual publishing remains available.

Branch cleanup (`sweetiebot.automaticBranchCleanup=true`) and managed workspace cleanup (`sweetiebot.automaticWorkspaceCleanup=true`) require **eligibility**. Active windows, dirty/unknown files, unpushed work and missing verified merge evidence prevent **branch deletion**. Unavailable GitHub evidence is not permission to prune. After a managed window closes, a detached check runs following a two-minute grace period: it detaches only inactive, fully clean linked worktrees **without deleting their local branches**, including unmerged or unpublished commits. Reloads, other active windows, edited or saved workspace references, stashes, and pending or ignored files prevent automatic detachment. The existing one-hour merged-workspace pruning remains separate; a preserved checkout is reopened in place by the branch picker.

Manual deletion keeps the topic selected while origin removes its remote branch. When shared main occupies another worktree, detachment happens after remote deletion and immediately before returning home. Other windows on that same clean worktree follow the completed deletion to shared main. An explicit later checkout, a surviving local branch, or new working-tree edits prevents that automatic return.

Check **Output → Sweetiebot Workspace Cleanup** and:

```sh
git status --short
git branch -vv
git worktree list --porcelain
```

Never directly remove registered Git metadata. Use Git's worktree operations after establishing safety. Evidence: [branch actions](../extension/branches/actions.js), [shared main](../extension/branches/shared-main.js), [stack logic](../extension/branches/stacked-branch.js), [cleanup](../extension/branches/workspace/prune.js), [sync](../scripts/cloud-repo-sync.py).

See [PR workflow](pull-requests-and-merges.md) for stack merging and [troubleshooting](troubleshooting.md) for blocked branch changes.
