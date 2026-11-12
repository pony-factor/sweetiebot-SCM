"""Run real Electron cookie checks in two processes with disposable profiles."""

import sys as _sb_sys
from pathlib import Path as _sb_path
for _sb_parent in _sb_path(__file__).resolve().parents:
    _sb_scripts = (_sb_parent if (_sb_parent / 'importaliases.py').is_file()
                   else _sb_parent / 'scripts')
    if (_sb_scripts / 'importaliases.py').is_file():
        if str(_sb_scripts) not in _sb_sys.path:
            _sb_sys.path.insert(0, str(_sb_scripts))
        import importaliases
        importaliases.install()
        break

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT))
import browser_pr
from tests.pr.browser_pr.core import BrowserPullRequestPatchTests


def main():
    with tempfile.TemporaryDirectory(prefix='sweetiebot-cookie-ci-') as directory:
        root = Path(directory)
        injections = []
        for fixture in (BrowserPullRequestPatchTests.STORAGE_FIXTURE,
                        BrowserPullRequestPatchTests.AFFINITY_STORAGE_FIXTURE):
            patched = browser_pr.transform_storage(fixture)
            injections.append(patched.split(browser_pr.STORAGE_START)[1].split(browser_pr.STORAGE_END)[0])
        config = root / 'routing.json'
        config.write_text(json.dumps({'root': str(root), 'injections': injections}))
        env = os.environ.copy()
        env.pop('ELECTRON_RUN_AS_NODE', None)
        for phase in ('seed', 'restart'):
            subprocess.run([sys.argv[1], str(Path(__file__).with_suffix('.cjs')), str(config), phase],
                           cwd=ROOT, env=env, check=True, timeout=45)


if __name__ == '__main__':
    main()
