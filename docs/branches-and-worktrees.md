# Branches and managed worktrees

Sweetiebot's topic workspaces are **linked Git worktrees** sharing one repository history, not independent clones. The managed parent is:

```text
~/Library/Application Support/Sweetiebot/Workspaces/
```

The branch selector can be a horizontal popup or native picker. **Branch names** settings manage built-in packs, imported/custom names and disabled lists. Each worktree owns its own working directory/index and ordinarily can check out a branch only once. If a target branch is already active elsewhere, inspect/focus its existing window instead of using forced checkout; preserve staged/unstaged changes.

**Open a Window on Shared Main** provides a managed main window. The ordinary new-branch action starts at the resolved default branch where possible; the **stacked branch** action starts at the current topic branch. Optional `gh-stack` manages native stacks. Creating a stacked branch is not publishing a PR; verify parent/base relationships before merging.

## Sync and cleanup

**Automatically pull clean branches** uses guarded fast-forward behavior and does not silently merge divergent histories. The distinct `scmToolkit.cloudRepositorySync=false` option schedules eligible clean-main checkouts every 15 minutes via macOS; it skips dirty/divergent work. `scmToolkit.autoPublishNewBranches=false` controls publishing newly created branches, not PR creation.

Branch cleanup (`scmToolkit.automaticBranchCleanup=true`) and managed workspace cleanup (`scmToolkit.automaticWorkspaceCleanup=true`) require **eligibility**. Active windows, dirty/unknown files, unpushed work and missing verified merge evidence prevent deletion. Unavailable GitHub evidence is not permission to prune.

Check **Output → Sweetiebot Workspace Cleanup** and:

```sh
git status --short
git branch -vv
git worktree list --porcelain
```

Never directly remove registered Git metadata. Use Git's worktree operations after establishing safety. Evidence: [branch actions](../extension/branches/branch_actions.js), [shared main](../extension/branches/shared_main.js), [stack logic](../extension/branches/stacked_branch.js), [cleanup](../extension/branches/workspace_prune.js), [sync](../scripts/cloud_repo_sync.py).

See [PR workflow](pull-requests-and-merges.md) for stack merging and [troubleshooting](troubleshooting.md) for blocked branch changes.
