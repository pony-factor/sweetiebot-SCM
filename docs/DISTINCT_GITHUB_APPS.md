# Separate Kefania and Lindsey GitHub App identities

Sweetiebot can route **local** PR publication through a dedicated Kefania installation
and the optional **headless** Lindsey bulk-merge runner through a different installation.
GitHub displays the actual installation's `kefania-pony[bot]` or
`lindsey-pony[bot]` account; a display-name change or a Co-authored-by trailer
cannot accomplish this.

## Provision the apps

Register two independent GitHub Apps in GitHub Developer Settings and install
them on the intended repositories. Choose the actual app slugs yourself.

| App | Contents | Pull requests | Issues |
| --- | --- | --- | --- |
| Kefania | Read | Read and write | Read and write |
| Lindsey | Read and write | Read and write | Read and write |

Grant only the repositories and privileges needed. Each app needs its **App ID**
(not OAuth client ID), its own generated PEM private key and an installation
covering the repository. Keep keys out of source control, logs, issue bodies
and public review comments.

## Configure in Magic Settings

Open **Magic Settings → GitHub Apps**. Each App has an **Install App** link;
select your organization and include the intended repositories. Use **Manage
organization installations** to review access later.

Enter each App's numeric **App ID** and actual **App slug**, choose its downloaded
PEM, and click **Save App**. On macOS the private key goes directly into Keychain;
only public configuration is saved in global Git config. The page never reads a
saved key back. Choose another PEM and save to replace a key. Keychain may ask
permission when a local runner first accesses it.

Enter an `owner/repository` and click **Check connection** for each App. This
verifies the App identity, installation and requested repository permissions
without creating PRs, comments or merges. It temporarily obtains an installation
token without returning it to the page. After both checks succeed, choose
**Separate Kefania and Lindsey Apps** and click **Apply mode**. New local actions
read this configuration immediately. Choose **Legacy** to roll back.

Credential imports use a separate save action and never enter normal settings
autosave. Environment variables take precedence over saved configuration.
The Keychain import UI currently requires macOS; other platforms can use the
environment configuration below. Hosted services still require their own setup.

## Environment configuration

Alternatively, set the following in the **Sweetiebot extension host's environment**, then
restart VS Code. A private key can be provided as PEM text or the path to a
secret file (one form per app); keep key files private (e.g. mode 0600).
Use the real app slugs; the names below are examples:

```sh
export SWEETIEBOT_KEFANIA_APP_ID='123456'
export SWEETIEBOT_KEFANIA_APP_SLUG='kefania-pony'
export SWEETIEBOT_KEFANIA_APP_PRIVATE_KEY_FILE='/private/path/kefania.pem'

export SWEETIEBOT_LINDSEY_APP_ID='567890'
export SWEETIEBOT_LINDSEY_APP_SLUG='lindsey-pony'
export SWEETIEBOT_LINDSEY_APP_PRIVATE_KEY_FILE='/private/path/lindsey.pem'

export SWEETIEBOT_BOT_IDENTITY_MODE='separate-apps'
```

`SWEETIEBOT_*_APP_PRIVATE_KEY` can be used instead of `*_PRIVATE_KEY_FILE`
for a PEM in a securely provisioned environment. Do not put live keys in
VS Code `settings.json`, `launch.json`, or shell-history commands.

When enabled, Sweetiebot validates `GET /app` against the configured slug
and ID, resolves the selected repository's active installation, and requests
an installation token **limited to that repository**. It does not send the App
private key to either local runner. Missing permissions, missing installation,
slug mismatch or an expired token **fail closed**: no user-token fallback.

Kefania's local `src/local-pr.js` is invoked in its existing `cli` transport
mode with this short-lived installation token via `GH_TOKEN`. This bypasses
Kefania's **currently codex-pony-only** internal App slug check without
editing its separate repository. The `gh` CLI must be installed and usable.
The old Kefania hosted/MCP flows in `pony-factor/kefania` are **not migrated**
by this PR; they must be updated separately to accept the new App slug and
credentials before using those entry points with the Kefania identity.

The optional headless Lindsey `scripts/bulk-merge.js` receives Lindsey's own
installation token. Its current safety restrictions (including linked/native
stacks and ambiguous attribution) still apply; authentication does not relax
merge policy.

## What this does not change

- **ChatGPT-based bulk merging** remains a separate user-authenticated workflow:
  GitHub connector comments and merges made from ChatGPT are attributed to the
  connected **user**, not magically to Lindsey. To get bot-authored review
  comments, deploy `pony-factor/lindsey-sync` with Lindsey's App credentials
  and webhook, and request reviews through that App. Its hosted webhook already
  supports an App installation and does not need credentials from Sweetiebot.
- Installing an App does not create a command processor for `@kefania` or
  `@lindsey` issue comments. Implement and deploy an `issue_comment` webhook
  handler with HMAC verification, authorization, loop prevention and queueing
  before advertising mention-triggered tasks.
- A PR opened by Kefania shows **Kefania as PR opener**, not necessarily as its
  Git commit author. Existing human-author and squash guards remain active.
- The `codex-pony[bot]` noreply co-author identity remains the **default for
  post-commit spellchecking**. Historic, independently evidenced contributions
  should remain credited; opening a PR as Kefania or reviewing it as Lindsey
  alone must not add codex-pony credit.
- Existing Keychain credentials and old `codex-pony` setups remain unchanged
  in `legacy` mode, which is the default. Use
  `SWEETIEBOT_BOT_IDENTITY_MODE=legacy` to roll back.

References:
- [GitHub installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- https://github.com/pony-factor/kefania/blob/main/src/github.js
- https://github.com/pony-factor/lindsey-sync/blob/main/README.md
