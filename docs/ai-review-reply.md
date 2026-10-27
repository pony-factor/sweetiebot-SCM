# Reply to an AI code review after commit and push

Use the **Respond to AI Review** button in Source Control. Select the open pull request and the exact unresolved inline review thread (author, file, line, comment are shown). Make your code changes and use Sweetiebot's **normal Commit & Push** flow. The selection is saved across editor restarts.

Once the final one-commit change is visible on the remote branch, Sweetiebot verifies the PR head and that the commit actually modifies the reviewed file. It then asks the local Ollama chat model (or `qwen2.5-coder:7b` by default) to compare **the selected review text with the published diff**. A positive, bounded explanation becomes a reply *in the original inline review thread*, with a link to the exact commit; only after that reply does Sweetiebot resolve the thread.

**Safeguards:** It does not post while a commit title is pending finalization, before the push lands, if the PR/branch changes, if multiple commits intervened, if the reviewed file was untouched, if the diff is too large, or when Ollama cannot substantiate the resolution. It does not rewrite existing GitHub comments. Failed reply/resolution operations can be retried through the same button, without intentionally duplicating the inline reply. One selection may be pending per checkout/branch. The user-authenticated GitHub account performs the writes; Lindsey read tokens are never used to reply.

If a review requires changes in files other than its commented file, respond manually on GitHub instead of falsely treating unrelated changes as proof. VS Code must be running to post the reply after a detached background push; the selected task resumes on restart. Ollama runs locally; no GitHub AI service receives the patch.

See also [commit workflows](commits-and-spellcheck.md) and [PR review and merge](pull-requests-and-merges.md). This guarded feature does not promise that every review issue can be substantiated or resolved by an AI assessment.
