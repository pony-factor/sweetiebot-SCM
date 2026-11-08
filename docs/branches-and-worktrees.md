# Branches and managed worktrees

Sweetiebot's topic workspaces are **linked Git worktrees** sharing one repository history, not independent clones. The managed parent is:

```text
~/Library/Application Support/Sweetiebot/Workspaces/
```

The branch selector can be a horizontal popup or native picker. **Branch names** settings manage built-in packs, imported/custom names and disabled lists. Each worktree owns its own working directory/index and ordinarily can check out a branch only once. Home and the branch selector reuse the current VS Code window, including when the destination worktree is open in another window. Saved workspaces replace their repository folder in place, preserving the workspace identity and Codex chat handoff. Each worktree keeps its staged and unstaged changes.

**Open a Window on Shared Main** provides a managed main window. The ordinary new-branch action starts at the resolved default branch where possible; the **stacked branch** action starts at the current topic branch. If GitHub metadata or remote synchronization times out, New Branch can use an existing, verified local default-branch commit without changing or publishing main. It warns that the remote may be newer; missing local commits, authentication errors, and merge conflicts remain blocking failures. Optional `gh-stack` manages native stacks. Creating a stacked branch is not publishing a PR; verify parent/base relationships before merging.

Unsent Codex new-chat text and attachments belong to the saved window and Git branch. Separate windows on the same main checkout have independent drafts. Reloading restores that window's draft; switching branches selects that branch's slot. Delayed updates from the previous branch cannot populate the new one.

An explicit checkout handoff transfers the captured draft once and retires the matching source copy after saving the destination. Retrying a handoff cannot restore text or attachments already sent, and an existing destination draft is preserved. Older checkout-wide caches remain stored but do not automatically seed new windows.

**New Branch** moves staged, unstaged, partially staged, and untracked changes into the new worktree, preserving the index even when no Codex chat is open. It verifies the copied changes before cleaning the source. A `.sweetiebot-handoff-backup` directory beside the destination repository retains the original index/worktree patches and untracked files for recovery. Switching to an existing branch leaves each worktree's pending edits in place.

## Source Control Graph in worktree windows

VS Code's built-in Source Control Graph can initially appear empty while Git discovers a newly opened linked worktree. Sweetiebot requests a bounded status refresh after discovery and follows up once for linked worktrees or missing HEAD metadata. This does not fetch, check out, or modify any branch.

If the graph is still blank, check the graph's repository selector and select the active worktree rather than an unrelated checkout. VS Code does not always follow the selected worktree automatically; see [the upstream graph selection issue](https://github.com/microsoft/vscode/issues/262880). In windows listing several worktrees, VS Code's single-repository Source Control mode can also make the active checkout clearer. A valid linked worktree shares the main repository's Git history, so an empty graph does not mean its commits have been deleted.

## Isolated experiments

Use **Open Experimental Workspace** (the beaker button in Source Control) to create a separate clone of the current branch on a random `trial-<hex>` branch under `/var/tmp/Sweetiebot/<repo>/<branch>-<color>/<repo>`. VS Code opens the experiment in a new window. The original Codex chat stays in its window with its drafts, attachments, and queued messages. The source repository, staged/index state, worktree, and branch remain unchanged. This clone includes tracked staged/unstaged modifications and non-ignored untracked regular files, but not Git-ignored build outputs. Conflicted indexes, unsafe untracked symlinks and special files fail closed rather than silently creating an incomplete experiment.

Add `/var/tmp/Sweetiebot` (macOS may display `/private/var/tmp/Sweetiebot`) to **Manage Workspace Trust** once; trust is controlled by VS Code, never bypassed by Sweetiebot. The parent directory is created with private owner-only permissions. An existing unsafe or symlinked parent is rejected.

After the trial window opens, Sweetiebot sends the original chat a notice containing the trial path and instructions to use it for experiments. An active turn receives the notice immediately through native steering; its queued messages stay in place. An idle chat receives a new turn. The chat's working directory is not rebound. Snapshot verification cancels creation if the source changes while copying. If no Codex chat is open, the experimental workspace still opens. If opening fails, Sweetiebot removes its incomplete clone. If only notification fails, the trial stays open and a warning includes its path. Experiments are not registered for automatic managed-worktree pruning; review and remove them manually when no longer needed.

## Sync and cleanup

**Automatically pull clean branches** uses guarded fast-forward behavior and does not silently merge divergent histories. The distinct `sweetiebot.cloudRepositorySync=false` option schedules eligible clean-main checkouts every 15 minutes via macOS; it skips dirty/divergent work. `sweetiebot.autoPublishNewBranches=false` controls publishing newly created branches, not PR creation.

Branch cleanup (`sweetiebot.automaticBranchCleanup=true`) and managed workspace cleanup (`sweetiebot.automaticWorkspaceCleanup=true`) require **eligibility**. Active windows, dirty/unknown files, unpushed work and missing verified merge evidence prevent **branch deletion**. Unavailable GitHub evidence is not permission to prune. After a managed window closes, a detached check runs following a two-minute grace period: it detaches only inactive, fully clean linked worktrees **without deleting their local branches**, including unmerged or unpublished commits. Reloads, other active windows, edited or saved workspace references, stashes, and pending or ignored files prevent automatic detachment. The existing one-hour merged-workspace pruning remains separate; a preserved checkout is reopened in place by the branch picker.

Manual deletion keeps the topic selected while origin removes its remote branch. When shared main occupies another worktree, detachment happens after remote deletion and immediately before returning home. Other windows on that same clean worktree follow the completed deletion to shared main. An explicit later checkout, a surviving local branch, or new working-tree edits prevents that automatic return.

Check **Output → Sweetiebot Workspace Cleanup** and:

```sh
git status --short
git branch -vv
git worktree list --porcelain
```

Never directly remove registered Git metadata. Use Git's worktree operations after establishing safety. Evidence: [branch actions](../extension/branches/actions.js), [shared main](../extension/branches/shared-main.js), [stack logic](../extension/branches/stacked-branch.js), [cleanup](../extension/branches/workspace-prune.js), [sync](../scripts/cloud-repo-sync.py).

See [PR workflow](pull-requests-and-merges.md) for stack merging and [troubleshooting](troubleshooting.md) for blocked branch changes.
