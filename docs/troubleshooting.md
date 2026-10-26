# Troubleshooting and recovery

Use non-destructive inspection first; do not force-push, reset history, delete worktrees or leak credentials to diagnose a UI issue.

| Symptom | Inspect | Safe next step |
| --- | --- | --- |
| Patch missing after VS Code update | **Output → Sweetie Bot app repair**, `python3 scripts/install.py --check`, permissions | Repair/reload only supported anchors |
| Settings tab missing | Source Control gear, authenticated local configurator | Retry `python3 scripts/configure.py`; inspect extension startup |
| Ollama commit title fails | Local model, memory, staging and `~/Library/Logs/Sweetiebot/sweetiebot.log` | Keep staged changes; use manual title if necessary |
| Background commit/push pending | Job finalization state, remote head and Git credentials | **Do not amend/reset/force-push** pending placeholder history |
| Branch already checked out | `git worktree list --porcelain`, other VS Code windows | Focus owning worktree, never force checkout |
| Cleanup skipped | **Output → Sweetiebot Workspace Cleanup**, dirty/active/unmerged evidence | Keep data until merge and cleanliness are verified |
| Sync skipped | Upstream, divergence, clean state, opt-in setting | Preserve work; only fast-forward when eligible |
| PR not published | Kefania runner, exact head/base, `gh`/App auth | Check actual PR on GitHub before retrying |
| Merge blocked | Live head/base, checks, rules, stack relationship | Repair on PR head without bypassing checks |
| EFS incomplete | Scope, mode, exclusions, model, file-size/file-count limits | Try Exact, correct model/scope, then reindex if needed |
| Codex toggle ineffective | Installed Codex/VS Code version, patch anchors | Treat unsupported patch as skipped |

Safe initial commands:

```sh
git status --short
git branch -vv
git worktree list --porcelain
python3 scripts/install.py --check
python3 scripts/ci/ci_test_runner.py verify
```

For bug reports, include VS Code/Codex version, affected control, recent update, effective settings and **redacted** diagnostics. Never paste tokens, private keys, sensitive diffs or entire private logs. See [App identity boundaries](distinct-github-apps.md), [installation](installation-and-repair.md) and [the manual audit plan](functionality-audit.md).
