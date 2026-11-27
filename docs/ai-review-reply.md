# Reply to an AI code review after commit and push

Use the **Respond to AI Review** button in Source Control. Select the open pull request and the exact unresolved inline review thread (author, file, line, comment are shown). Make your code changes and use Sweetiebot's **normal Commit & Push** flow. The selection is saved across editor restarts.

For a fork checkout, the button searches both the configured remote repository and its GitHub-verified parent for PRs whose head matches that fork and branch. Replies go to the selected PR's repository; publishing is still checked against the checkout's configured remote.

Once the final one-commit change is visible on the remote branch, Sweetiebot verifies the PR head and that the commit actually modifies the reviewed file. It then asks the local Ollama chat model (or `qwen2.5-coder:7b` by default) to compare **the selected review text with the published diff**. A positive, bounded explanation becomes a reply *in the original inline review thread*, with a link to the exact commit; only after that reply does Sweetiebot resolve the thread.

**Safeguards:** It does not post while a commit title is pending finalization, before the push lands, if the PR/branch changes, if multiple commits intervened, if the reviewed file was untouched, if the diff is too large, or when Ollama cannot substantiate the resolution. It does not rewrite existing GitHub comments. Failed reply/resolution operations can be retried through the same button, without intentionally duplicating the inline reply. One selection may be pending per checkout/branch. The configured dedicated AI reviewer performs the writes; neither the normal VS Code session nor Lindsey read tokens are used to reply.

## Dedicated AI reviewer account

Authenticate a separate GitHub machine user with `gh auth login --hostname github.com`, then open Magic Settings → AI Review Responder, enter its GitHub username and click Test connection. Alternatively set the same local user-level preference:

```sh
git config --global sweetiebot.ai-review-account YOUR_REVIEWER_USERNAME
```

The value is a GitHub login, not a token. Give the machine user access to the relevant repositories and verify its permissions to reply and resolve threads. Sweetiebot explicitly selects that user's stored GitHub CLI credential, independently verifies the authenticated login, and never switches the active account or falls back to the normal VS Code session. Missing credentials, a changed reviewer, or insufficient permissions stop publication. Cancel and re-select any pending review created before this setting existed.

For cross-repository upstream PRs, Kefania's App remains the first choice. If the App has no access to the upstream repository, Sweetiebot uses this verified dedicated account for the same upstream head/base comparison and publication, never the active human CLI account. Missing credentials or verification failures stop that fallback; no automatic retargeting or human-account retry occurs.

For Codex-generated standalone reviews or conversation comments, run from the Sweetiebot checkout:

```sh
node scripts/codex-review-gh.js review 123 --repo OWNER/REPO --body-file review.md
node scripts/codex-review-gh.js comment 123 --repo OWNER/REPO --body-file reply.md
```

Tell Codex to use this command for AI-authored PR reviews and comments, not the ordinary `gh pr review` or `gh pr comment`. The command permits only new comments and comment-only reviews, not approvals, changes-requested reviews, edits, merges, or Git pushes. Ordinary human GitHub commands remain unchanged. This is an explicit tool, not a global interception of all Codex terminal or connector requests.

If a review requires changes in files other than its commented file, respond manually on GitHub instead of falsely treating unrelated changes as proof. VS Code must be running to post the reply after a detached background push; the selected task resumes on restart. Ollama runs locally; no GitHub AI service receives the patch.

See also [commit workflows](commits-and-spellcheck.md) and [PR review and merge](pull-requests-and-merges.md). This guarded feature does not promise that every review issue can be substantiated or resolved by an AI assessment.
