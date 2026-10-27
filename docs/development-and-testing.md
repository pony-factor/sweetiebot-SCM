# Development and verification

The [scripts guide](../scripts/README.md) explains installed Python tools. The entry points are [extension activation](../efs/extension.js), [installer](../scripts/install.py), [configurator](../scripts/configurator.py), [workbench assets](../assets/workbench/), [Codex assets](../assets/codex/), and [browser assets](../assets/browser/).

The [CI workflow](../.github/workflows/check.yml) groups tests into **commit**, **branches**, **branch-names**, **github-pr**, **codex**, **kefania**, **lindsey**, **browser-ui**, **efs-search**, **installation** and **security**, with additional browser/App checks. [Test inventory](../scripts/ci/ci_test_groups.json) owns assignments; adding a test may require updating that inventory.

From the repo root:

```sh
python3 scripts/ci/ci_test_runner.py verify
PYTHONPATH=scripts python3 -m unittest discover -s tests
python3 scripts/ci/ci_test_runner.py run efs-search
# macOS with compatible VS Code only:
python3 scripts/install.py --check
```

Node and browser jobs may require additional dependencies and Playwright/Chromium; see CI. Linux CI cannot validate macOS signing, permissions, workbench injection or window geometry. Do not report a test as passing merely because its file exists.

## Documentation maintenance

- Keep **all documentation filenames lowercase kebab-case** and update incoming links in the same change.
- Use [the index](index.md) to navigate; keep user workflows in their topic guide, with a concise root README.
- Verify sources, defaults, opt-ins, failure paths, and security boundaries before documenting a feature as shipped.
- Link to repo files **relatively**; don't point to renamed uppercase files.
- Update [the audit matrix](functionality-audit.md) and manual verification checklist when significant functionality changes.
- Avoid embedding credentials, private logs, tokens, hidden repository contents or speculative fixes.

Minimal local filename/link check:

```sh
python3 - <<'PY'
from pathlib import Path
import re
docs = Path("docs")
errors = []
for doc in docs.glob("*.md"):
    if doc.name != doc.name.lower():
        errors.append(f"uppercase: {doc}")
    for target in re.findall(r"(?<!!)\[[^\]]*\]\(([^)]+)\)", doc.read_text()):
        target = target.split("#", 1)[0]
        if target and "://" not in target and not target.startswith("mailto:"):
            if not (doc.parent / target).exists():
                errors.append(f"{doc}: broken {target}")
print("\n".join(errors) if errors else "Docs naming and links OK")
raise SystemExit(bool(errors))
PY
```

This simple check covers standard inline relative links, not complex Markdown formats or anchor validation.
