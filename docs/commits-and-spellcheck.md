# Commit and spellcheck workflows

## Normal and AI-assisted commit

Stage and review the exact diff. Sweetiebot retains VS Code's Git commit behavior. **Commit (Same as Source Control Button)** and **Commit with Codex Co-author** have independent initially unbound shortcuts. Existing commit text is not overwritten by the commit action; local Ollama can produce a title when the message is **blank** and AI commits are enabled. Local commit instructions come from `~/.config/sweetiebot/commit-instructions.md`, seeded by [this template](../assets/commit-instructions.md). Git hooks, GPG signing, conflicts, remote limits and primary authorship remain relevant.

| Mode | Behavior | Default |
| --- | --- | --- |
| Direct commit | Native commit flow, optional generated blank title | Baseline |
| Durable background Commit & Push | Commit staged tree with temporary title, finalize in order, then optionally push | Opt-in, **off** |
| Auto-commit with Codex | Every 30 seconds when opted in: stage changed files and commit locally with co-author; no automatic push | Opt-in, **off** |

Legacy provisional commit creation is retired. The saved `scm-toolkit.ai-commit-async` Git setting is ignored for new commits; unfinished legacy jobs retain their recovery and push barriers. Use **Durable background Commit and Push** for commit-first title generation, including when using **Commit** without pushing.

Background recovery is in [worker](../scripts/background_commit.py), [extension bridge](../extension/commits/background_commit.js) and [push recovery](../extension/commits/push_recovery.js). macOS session/login agent and an awake machine matter while VS Code is closed. **Never amend, reset, squash, or force-push a branch with an unresolved placeholder job**; inspect recorded status first. A "pending push" indicator is not proof of a successful remote write. New placeholder titles use the configurable `scm-toolkit.placeholder-prefix` setting (default `hoof_`) followed by an 11-character Base58 job ID, separate from the Git commit SHA. Change it in Sweetiebot Settings / Magic Settings under Source control. The prefix must start with a letter, use only ASCII letters, digits, hyphens, or underscores, and end with an underscore. Each pending job records the prefix it started with, so changing the setting cannot strand an in-flight commit. Recovery continues to recognize older `placeholder_` titles and legacy hexadecimal placeholders.

When durable background mode is enabled, a queued job retains the staged tree captured at submission; changes staged afterward belong to a later operation. The worker resumes interrupted title generation and optional publication using the completed commit rather than staging current workspace files again. An offline remote can delay the push without requiring a new commit. Branch movement, authentication failures, and rejected pushes require guarded recovery; the worker does not force-push or merge remote history automatically. The login agent can retry only while the Mac is awake and the user session permits it.

Sweetiebot Settings → Diagnostics shows the complete queued job ID and its Git commit SHA so you can match an unfinished commit to the Source Control Graph. New diagnostic events include the repository name and durable job ID when available, without saving absolute checkout paths or commit bodies. The event table can display relative timestamps (default) or absolute local times; hovering a relative time shows the exact timestamp. Finalized job events retain their Git SHA so the graph association remains available even after a job leaves the pending queue. Previously saved events cannot retroactively acquire job IDs, and the built-in VS Code Git graph does not itself display Sweetiebot's diagnostic fields.

A co-author action adds `Co-authored-by` after a **blank line**, without replacing the Git author. Optional Codex draft/context features may read a local conversation snapshot for text generation but do not authorize unstaged changes.

## Four separate spellcheck paths

1. **Draft title** — proposes a conservative correction to the message field; confirm before using.
2. **Spellcheck Filenames** — preview-only rename suggestions; does not silently change/stage/commit files.
3. **Post-commit Markdown Spellcheck Changes** — globally opt-in, proposes **unstaged** prose edits in **Spellchecks Performed**. Repository `scmToolkit.postCommitSpellcheck=true` only permits it; `false` opts the repository out.
4. **Review Text with ChatGPT Spellcheck Only** — separate manual native ChatGPT bridge.

Markdown code, links, author quotes, protected terminology, file paths and model suggestions need manual review. For a PR review thread, use [the dedicated AI-review workflow](ai-review-reply.md), not a generic spellcheck action.

Evidence: [commit wrapper](../scripts/ai_commit.py), [co-author bridge](../extension/commits/codex_commit.js), [filename preview](../extension/commits/filename_spellcheck.js), [post-commit implementation](../scripts/post_commit_spellcheck.py). See [troubleshooting](troubleshooting.md).
