# Sweetiebot companion extension

The `extension/` directory contains Sweetiebot's VS Code companion extension. It powers Source Control actions, Git worktrees, commit flows, GitHub integration, merge dashboards, Codex handoffs, and workspace search.

## Credits

### EFS Activity Bar icon

`media/efs.svg` is an Activity Bar adaptation of the Eyes Forward Sparkle / PipBuck imagery in a Fallout: Equestria Game Wave 3 (Public Pre-Alpha) screenshot credited to The Overmare Studios.

Original source:
http://theovermare.com/blog/2016/02/wave-3-demo-better-late-than-never-edition

Reference mirror:
https://manebooru.art/images/1095883

The original imagery is credited to The Overmare Studios. This attribution does not place the underlying third-party imagery under this repository's AGPL-3.0 license.

### Codex rate-limit Twilight sticker

The optional small Codex notice links to the original Twilight Sparkle STOP illustration by **CaptainPudgeMuffin**, uploaded to Know Your Meme by **Twist** on November 5, 2016.

Attribution and original image page: https://knowyourmeme.com/photos/1188081-jack-blacks-octagon

The image is included in this repository as `assets/imgs/twi-stop.png` and embedded by the installer as a PNG data URI, rather than downloaded from an external image host at runtime. The artwork is not licensed under this repository's AGPL-3.0 license; inclusion does not imply a copyright license from the artist. If Codex blocks the embedded image, the native rate-limit notice remains visible.

## Feature modules

| Directory | Responsibility |
| --- | --- |
| `search/` | Workspace Search indexing, extraction, search UI, and Ollama helpers |
| `branches/` | Branches, worktrees, workspace state, cleanup, and sync |
| `commits/` | Commit flows, publishing, limits, and spellchecking |
| `github/` | GitHub API, pull request discovery, drafting, and sessions |
| `merge/` | Merge dashboards, Lindsey integration, review, and conflict resolution |
| `codex/` | Codex, Kefania, ChatGPT handoffs, and pony metadata |
| `ui/` | Shared UI helpers, draft confirmation, notifications, and runtime utilities |

`package.json` remains at the root. Its entry point, `trust-activation.js`, gates startup on VS Code workspace trust and then activates `extension.js`. The `media/` paths also remain rooted here; third-party image credits are documented above. The SVG files in `media/` are development mirrors of `assets/imgs/` artwork; installed icons are synchronized from those shared assets to preserve VS Code's stable `media/` icon paths.

The installer uses `scripts/workspace-search.py` to **recursively package** these directories. Runtime Python helpers are installed at the extension root, whereas development-time fallback helpers live in `scripts/` at the repository root. Modules using `__dirname` must account for both layouts, and cross-directory imports must be relative to their own module directory.

Run the tests described in the repository README after changing module paths or packaging logic. Avoid introducing additional root-level feature modules without a compatibility reason.
