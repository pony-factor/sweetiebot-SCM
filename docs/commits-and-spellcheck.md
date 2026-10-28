# Commit and spellcheck workflows

## Normal and AI-assisted commit

Stage and review the exact diff. Sweetiebot retains VS Code's Git commit behavior. **Commit (Same as Source Control Button)** and **Commit with Codex Co-author** have independent initially unbound shortcuts. Existing commit text is not overwritten by the commit action; local Ollama can produce a title when the message is **blank** and AI commits are enabled. Local commit instructions come from `~/.config/sweetiebot/commit-instructions.md`, seeded by [this template](../assets/commit-instructions.md). Git hooks, GPG signing, conflicts, remote limits and primary authorship remain relevant.

| Mode | Behavior | Default |
| --- | --- | --- |
| Direct commit | Native commit flow, optional generated blank title | Baseline |
| Durable background Commit & Push | Commit staged tree with temporary title, finalize in order, then optionally push | Opt-in, **off** |
| Legacy provisional title finalization | Distinct older mode | Do not conflate with durable mode |
| Auto-commit with Codex | Every 30 seconds when opted in: stage changed files and commit locally with co-author; no automatic push | Opt-in, **off** |

Background recovery is in [worker](../scripts/background_commit.py), [extension bridge](../extension/commits/background_commit.js) and [push recovery](../extension/commits/push_recovery.js). macOS session/login agent and an awake machine matter while VS Code is closed. **Never amend, reset, squash, or force-push a branch with an unresolved placeholder job**; inspect recorded status first. A "pending push" indicator is not proof of a successful remote write.

A co-author action adds `Co-authored-by` after a **blank line**, without replacing the Git author. Optional Codex draft/context features may read a local conversation snapshot for text generation but do not authorize unstaged changes.

## Four separate spellcheck paths

1. **Draft title** — proposes a conservative correction to the message field; confirm before using.
2. **Spellcheck Filenames** — preview-only rename suggestions; does not silently change/stage/commit files.
3. **Post-commit Markdown Spellcheck Changes** — globally opt-in, proposes **unstaged** prose edits in **Spellchecks Performed**. Repository `scmToolkit.postCommitSpellcheck=true` only permits it; `false` opts the repository out.
4. **Review Text with ChatGPT Spellcheck Only** — separate manual native ChatGPT bridge.

Markdown code, links, author quotes, protected terminology, file paths and model suggestions need manual review. For a PR review thread, use [the dedicated AI-review workflow](ai-review-reply.md), not a generic spellcheck action.

Evidence: [commit wrapper](../scripts/ai_commit.py), [co-author bridge](../extension/commits/codex_commit.js), [filename preview](../extension/commits/filename_spellcheck.js), [post-commit implementation](../scripts/post_commit_spellcheck.py). See [troubleshooting](troubleshooting.md).
